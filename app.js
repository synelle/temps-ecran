// ============================================================
// Temps d'écran — logique app
// ============================================================

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = { mon: "Lun", tue: "Mar", wed: "Mer", thu: "Jeu", fri: "Ven", sat: "Sam", sun: "Dim" };

const supabaseClient = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey
);

let children = [];          // dernier état connu (depuis Supabase)
let currentSettingsId = null;
let currentAdjustId = null;
let audioCtx = null;
const alarmedIds = new Set(); // pour ne jouer l'alarme qu'une fois par enfant tant qu'il n'a pas été relancé/reset
const fiveMinAlertedIds = new Set(); // alerte "5 minutes restantes" déjà jouée
const twoMinAlertedIds = new Set();  // alerte "2 minutes restantes" déjà jouée
const overtimeTicks = new Map();     // dernier palier de 30s (en négatif) déjà sonné, par enfant

// ---------- Code PIN ----------
const PIN_UNLOCK_MS = 10 * 60 * 1000; // une fois entré, pas redemandé pendant 10 min
let pinHash = null;
let unlockedAt = 0;

function isUnlocked() {
  return !!pinHash && Date.now() - unlockedAt < PIN_UNLOCK_MS;
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadPinSettings() {
  const { data } = await supabaseClient.from("app_settings").select("*").eq("id", 1).maybeSingle();
  pinHash = (data && data.pin_hash) || null;
}

async function savePinHash(hash) {
  await supabaseClient.from("app_settings").upsert({ id: 1, pin_hash: hash, updated_at: new Date().toISOString() });
  pinHash = hash;
}

// ---- Modale saisie PIN (réutilisée pour saisie et création) ----
const pinModal = document.getElementById("pinModal");
const pinDots = document.getElementById("pinDots");
const pinModalTitle = document.getElementById("pinModalTitle");
const pinModalSub = document.getElementById("pinModalSub");
let pinValue = "";
let pinResolver = null;

function renderPinDots() {
  const len = Math.max(pinValue.length, 4);
  pinDots.innerHTML = "";
  for (let i = 0; i < Math.max(4, pinValue.length); i++) {
    const span = document.createElement("span");
    if (i < pinValue.length) span.classList.add("filled");
    pinDots.appendChild(span);
  }
}

function askPin(title, sub) {
  pinValue = "";
  pinModalTitle.textContent = title;
  pinModalSub.textContent = sub || "";
  renderPinDots();
  pinModal.showModal();
  return new Promise((resolve) => {
    pinResolver = resolve;
  });
}

document.querySelectorAll(".pin-key").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    if (key === "clear") {
      pinValue = pinValue.slice(0, -1);
    } else if (key === "ok") {
      pinModal.close();
      if (pinResolver) pinResolver(pinValue.length >= 4 ? pinValue : null);
      pinResolver = null;
      return;
    } else if (pinValue.length < 8) {
      pinValue += key;
    }
    renderPinDots();
  });
});

document.getElementById("pinCancelBtn").addEventListener("click", () => {
  pinModal.close();
  if (pinResolver) pinResolver(null);
  pinResolver = null;
});

// Crée un nouveau PIN (demande + confirmation), l'enregistre, renvoie true/false
async function setupPinFlow() {
  const first = await askPin("Crée un code PIN", "4 chiffres minimum, pour protéger les réglages");
  if (!first) return false;
  const confirm1 = await askPin("Confirme le code PIN", "Retape le même code");
  if (!confirm1) return false;
  if (first !== confirm1) {
    alert("Les deux codes ne correspondent pas, réessaie.");
    return setupPinFlow();
  }
  const hash = await sha256Hex(first);
  await savePinHash(hash);
  return true;
}

// Vérifie le PIN existant (ou laisse passer si aucun n'est configuré)
async function verifyPin() {
  if (!pinHash) return true;
  if (isUnlocked()) return true;
  const val = await askPin("Code PIN", "Réservé aux parents");
  if (val == null) return false;
  const hash = await sha256Hex(val);
  if (hash === pinHash) {
    unlockedAt = Date.now();
    return true;
  }
  alert("Code PIN incorrect.");
  return false;
}

// Exécute `action` seulement après vérification (ou création si aucun PIN n'existe encore)
async function withPinProtection(action) {
  if (!pinHash) {
    const ok = await setupPinFlow();
    if (!ok) return;
    unlockedAt = Date.now();
    action();
    return;
  }
  const ok = await verifyPin();
  if (ok) action();
}

// ---- Gestion du PIN (bouton 🔒 dans le header) ----
const pinManageModal = document.getElementById("pinManageModal");

document.getElementById("pinManageBtn").addEventListener("click", async () => {
  if (!pinHash) {
    await setupPinFlow();
    return;
  }
  const ok = await verifyPin();
  if (ok) pinManageModal.showModal();
});

document.getElementById("pinManageCloseBtn").addEventListener("click", () => pinManageModal.close());

document.getElementById("pinChangeBtn").addEventListener("click", async () => {
  pinManageModal.close();
  await setupPinFlow();
});

document.getElementById("pinRemoveBtn").addEventListener("click", async () => {
  if (!confirm("Supprimer le code PIN ? Les réglages ne seront plus protégés.")) return;
  await savePinHash(null);
  pinManageModal.close();
});

const rowsEl = document.getElementById("rows");
const emptyMsg = document.getElementById("emptyMsg");

// ---------- Utilitaires temps ----------

function todayKey() {
  return DAY_KEYS[(new Date().getDay() + 6) % 7]; // getDay(): 0=dim -> on veut 0=lun
}

function todayIsoDate() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

// Clé du jour de la semaine ("mon".."sun") pour une date "YYYY-MM-DD" donnée
function weekdayKeyForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return DAY_KEYS[(date.getDay() + 6) % 7];
}

// Budget "de base" (sans ajustement ponctuel) pour un enfant à une date donnée,
// d'après le temps hebdomadaire réglé pour ce jour de la semaine.
function defaultBudgetSecondsForDate(child, dateStr) {
  const key = weekdayKeyForDate(dateStr);
  return ((child.weekly_limits && child.weekly_limits[key]) || 0) * 60;
}

function fmt(seconds) {
  const neg = seconds < 0;
  const s = Math.round(Math.abs(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
  return (neg ? "-" : "") + body;
}

function todayBudgetSeconds(child) {
  const key = todayKey();
  const minutes = (child.weekly_limits && child.weekly_limits[key]) || 0;
  return minutes * 60 + (child.bonus_seconds || 0);
}

function remainingSeconds(child) {
  const budget = todayBudgetSeconds(child);
  let consumed = child.consumed_seconds || 0;
  if (child.is_running && child.started_at) {
    const elapsed = (Date.now() - new Date(child.started_at).getTime()) / 1000;
    consumed += Math.max(0, elapsed);
  }
  return budget - consumed;
}

// ---------- Historique quotidien (pour le calendrier de stats) ----------

// Enregistre/actualise la ligne d'historique du jour `date` pour cet enfant.
// `consumedSeconds` : valeur à figer (par défaut le compteur actuel de l'enfant,
// en incluant la session en cours si elle tourne).
async function syncDailyStat(child, date, consumedSeconds) {
  const dateStr = date || child.reset_date;
  const budget = todayBudgetSeconds(child);
  let consumed = consumedSeconds;
  if (consumed == null) {
    consumed = child.consumed_seconds || 0;
    if (child.is_running && child.started_at) {
      consumed += Math.max(0, (Date.now() - new Date(child.started_at).getTime()) / 1000);
    }
  }
  try {
    await supabaseClient.from("daily_stats").upsert(
      {
        child_id: child.id,
        date: dateStr,
        consumed_seconds: Math.round(consumed),
        budget_seconds: Math.round(budget),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "child_id,date" }
    );
  } catch (e) {
    console.warn("Historique indisponible", e);
  }
}

// Joue `count` bips de fréquence `freq`, espacés de `gap` secondes.
function playTone(freq, count, gap) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    for (let i = 0; i < count; i++) {
      const t = i * gap;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.32);
    }
  } catch (e) {
    console.warn("Son indisponible", e);
  }
}

// Sonnerie "il reste 5 minutes" : un bip calme
function playFiveMinWarning() {
  playTone(660, 1, 0.35);
}

// Sonnerie "il reste 2 minutes" : deux bips, un peu plus aigus/pressants
function playTwoMinWarning() {
  playTone(784, 2, 0.25);
}

// Sonnerie "le temps est écoulé" (et répétée toutes les 30s en négatif) :
// trois bips plus insistants
function playAlarm() {
  playTone(880, 3, 0.35);
}

// ---------- Chargement + realtime ----------

async function loadChildren() {
  const { data, error } = await supabaseClient
    .from("children")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    alert("Erreur de chargement depuis Supabase : " + error.message);
    return;
  }
  children = data || [];
  await maybeResetDaily();
  render();
}

supabaseClient
  .channel("children-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "children" }, () => {
    loadChildren();
  })
  .subscribe();

// ---------- Reset quotidien ----------

async function maybeResetDaily() {
  const today = todayIsoDate();
  const toReset = children.filter((c) => c.reset_date !== today);
  for (const c of toReset) {
    alarmedIds.delete(c.id);
    fiveMinAlertedIds.delete(c.id);
    twoMinAlertedIds.delete(c.id);
    overtimeTicks.delete(c.id);
    // on fige l'historique du jour qui se termine (session en cours incluse)
    // avant de remettre les compteurs à zéro
    await syncDailyStat(c, c.reset_date);

    // si un ajustement a déjà été programmé à l'avance pour le nouveau jour
    // (ex: "-15 min demain"), on en tient compte dès le reset au lieu de
    // l'écraser
    let newBonus = 0;
    const { data: preset } = await supabaseClient
      .from("daily_stats")
      .select("budget_seconds")
      .eq("child_id", c.id)
      .eq("date", today)
      .maybeSingle();
    if (preset) {
      newBonus = preset.budget_seconds - defaultBudgetSecondsForDate(c, today);
    }

    await supabaseClient
      .from("children")
      .update({
        consumed_seconds: 0,
        bonus_seconds: newBonus,
        is_running: false,
        started_at: null,
        reset_date: today,
      })
      .eq("id", c.id);
    c.consumed_seconds = 0;
    c.bonus_seconds = newBonus;
    c.is_running = false;
    c.started_at = null;
    c.reset_date = today;
    syncDailyStat(c, today);
  }
}

setInterval(() => {
  maybeResetDaily();
  // garde l'historique du jour à peu près à jour même si un enfant reste
  // en train de jouer sans jamais mettre pause
  children.filter((c) => c.is_running).forEach((c) => syncDailyStat(c, c.reset_date));
}, 30000);

// ---------- Rendu ----------

function render() {
  emptyMsg.hidden = children.length > 0;
  rowsEl.classList.toggle("is-empty", children.length === 0);
  rowsEl.querySelectorAll(".child-row").forEach((el) => el.remove());

  for (const child of children) {
    const row = document.createElement("div");
    row.className = "child-row";
    row.style.setProperty("--child-color", child.color || "#4f46e5");
    row.dataset.id = child.id;

    row.innerHTML = `
      <div class="child-identity">
        <div class="child-avatar">${child.emoji || "🧒"}</div>
        <div>
          <div class="child-name">${escapeHtml(child.name)}</div>
          <div class="child-sub">${todayBudgetSeconds(child) / 60} min aujourd'hui</div>
        </div>
      </div>
      <div class="timer-display">${fmt(remainingSeconds(child))}</div>
      <div class="row-actions">
        <button class="btn btn-play ${child.is_running ? "running" : ""}" data-action="toggle" title="${child.is_running ? "Pause" : "Démarrer"}">
          ${child.is_running ? "⏸️" : "▶️"}
        </button>
        <button class="btn btn-icon" data-action="adjust" title="Ajouter/retirer du temps">➕➖</button>
        <button class="btn btn-icon" data-action="settings" title="Réglages">⚙️</button>
      </div>
    `;

    row.querySelector('[data-action="toggle"]').addEventListener("click", () => toggleTimer(child));
    row.querySelector('[data-action="adjust"]').addEventListener("click", () => openAdjustModal(child));
    row.querySelector('[data-action="settings"]').addEventListener("click", () => withPinProtection(() => openSettingsModal(child)));

    rowsEl.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// boucle d'affichage (chaque seconde), + détection fin de temps
setInterval(() => {
  for (const child of children) {
    const row = rowsEl.querySelector(`.child-row[data-id="${child.id}"]`);
    if (!row) continue;
    const rem = remainingSeconds(child);
    const display = row.querySelector(".timer-display");
    display.textContent = fmt(rem);

    if (rem <= 0) {
      display.classList.add("time-up");
      row.classList.add("time-up");
      if (child.is_running && !alarmedIds.has(child.id)) {
        alarmedIds.add(child.id);
        playAlarm();
        // le temps est écoulé, mais le chrono continue de tourner en négatif
        // (pas d'arrêt automatique) pour que le parent voie le dépassement
      }
      // sonnerie répétée toutes les 30s tant que le dépassement continue
      if (child.is_running) {
        const tick = Math.floor(Math.abs(rem) / 30);
        if (tick >= 1 && tick > (overtimeTicks.get(child.id) || 0)) {
          overtimeTicks.set(child.id, tick);
          playAlarm();
        }
      } else {
        overtimeTicks.delete(child.id);
      }
    } else {
      display.classList.remove("time-up");
      row.classList.remove("time-up");
      if (rem > 1) alarmedIds.delete(child.id);
      overtimeTicks.delete(child.id);

      // alertes "il reste 5 min" / "il reste 2 min"
      if (child.is_running) {
        if (rem <= 300 && !fiveMinAlertedIds.has(child.id)) {
          fiveMinAlertedIds.add(child.id);
          playFiveMinWarning();
        }
        if (rem <= 120 && !twoMinAlertedIds.has(child.id)) {
          twoMinAlertedIds.add(child.id);
          playTwoMinWarning();
        }
      }
      if (rem > 300) fiveMinAlertedIds.delete(child.id);
      if (rem > 120) twoMinAlertedIds.delete(child.id);
    }
  }
}, 1000);

// ---------- Actions timer ----------

async function toggleTimer(child) {
  if (child.is_running) {
    const elapsed = (Date.now() - new Date(child.started_at).getTime()) / 1000;
    const newConsumed = Math.max(0, (child.consumed_seconds || 0) + elapsed);
    child.is_running = false;
    child.started_at = null;
    child.consumed_seconds = newConsumed;
    await supabaseClient
      .from("children")
      .update({ is_running: false, started_at: null, consumed_seconds: Math.round(newConsumed) })
      .eq("id", child.id);
    syncDailyStat(child, child.reset_date, newConsumed);
  } else {
    const nowIso = new Date().toISOString();
    child.is_running = true;
    child.started_at = nowIso;
    alarmedIds.delete(child.id);
    fiveMinAlertedIds.delete(child.id);
    twoMinAlertedIds.delete(child.id);
    overtimeTicks.delete(child.id);
    await supabaseClient
      .from("children")
      .update({ is_running: true, started_at: nowIso })
      .eq("id", child.id);
  }
  render();
}

// ---------- Modale réglages (jours + temps) ----------

const settingsModal = document.getElementById("settingsModal");
const daysGrid = document.getElementById("daysGrid");
const colorPick = document.getElementById("colorPick");
const emojiPick = document.getElementById("emojiPick");

function openSettingsModal(child) {
  currentSettingsId = child.id;
  document.getElementById("settingsTitle").textContent = `Réglages — ${child.name}`;
  colorPick.value = child.color || "#4f46e5";
  emojiPick.value = child.emoji || "🧒";
  daysGrid.innerHTML = DAY_KEYS.map((k) => `
    <div class="day-field">
      <label>${DAY_LABELS[k]}</label>
      <input type="number" min="0" max="600" data-day="${k}" value="${(child.weekly_limits && child.weekly_limits[k]) ?? 60}" />
    </div>
  `).join("");
  settingsModal.showModal();
}

document.getElementById("cancelSettingsBtn").addEventListener("click", () => settingsModal.close());

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const child = children.find((c) => c.id === currentSettingsId);
  if (!child) return;
  const weekly_limits = {};
  daysGrid.querySelectorAll("input[data-day]").forEach((inp) => {
    weekly_limits[inp.dataset.day] = Math.max(0, parseInt(inp.value, 10) || 0);
  });
  const color = colorPick.value;
  const emoji = emojiPick.value;
  await supabaseClient
    .from("children")
    .update({ weekly_limits, color, emoji })
    .eq("id", child.id);
  child.weekly_limits = weekly_limits;
  child.color = color;
  child.emoji = emoji;
  settingsModal.close();
  render();
});

document.getElementById("deleteChildBtn").addEventListener("click", async () => {
  const child = children.find((c) => c.id === currentSettingsId);
  if (!child) return;
  if (!confirm(`Supprimer ${child.name} ? Cette action est définitive.`)) return;
  await supabaseClient.from("children").delete().eq("id", child.id);
  children = children.filter((c) => c.id !== child.id);
  settingsModal.close();
  render();
});

// ---------- Modale ajustement ponctuel ----------

const adjustModal = document.getElementById("adjustModal");
const adjustDate = document.getElementById("adjustDate");
const adjustMinutes = document.getElementById("adjustMinutes");
const adjustMinutesLabel = document.getElementById("adjustMinutesLabel");
const adjustNote = document.getElementById("adjustNote");
const adjustModeHint = document.getElementById("adjustModeHint");
let adjustMode = "budget"; // "budget" (offrir/retirer du temps disponible) | "used" (temps oublié déjà utilisé)

const ADJUST_MODE_INFO = {
  budget: {
    hint: "Change le temps disponible pour la journée choisie (récompense ou punition).",
    minutesLabel: "Minutes personnalisées (+ ou -)",
  },
  used: {
    hint: "Enregistre du temps d'écran réellement utilisé mais non chronométré (bouton oublié). Le temps disponible ne change pas, seul le temps déjà consommé est mis à jour.",
    minutesLabel: "Minutes réellement utilisées (+ pour ajouter, - pour corriger)",
  },
};

function setAdjustMode(mode) {
  adjustMode = mode;
  document.querySelectorAll("#adjustModeSwitch .segmented-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  adjustModeHint.textContent = ADJUST_MODE_INFO[mode].hint;
  adjustMinutesLabel.textContent = ADJUST_MODE_INFO[mode].minutesLabel;
}

document.querySelectorAll("#adjustModeSwitch .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => setAdjustMode(btn.dataset.mode));
});

function openAdjustModal(child) {
  currentAdjustId = child.id;
  document.getElementById("adjustTitle").textContent = `Ajuster le temps — ${child.name}`;
  adjustDate.value = todayIsoDate();
  adjustMinutes.value = "";
  adjustNote.value = "";
  setAdjustMode("budget");
  adjustModal.showModal();
}

document.getElementById("cancelAdjustBtn").addEventListener("click", () => adjustModal.close());

document.querySelectorAll(".btn-quick").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const delta = parseInt(btn.dataset.delta, 10);
    await applyAdjustment(delta, adjustNote.value.trim(), adjustDate.value, adjustMode);
  });
});

document.getElementById("applyAdjustBtn").addEventListener("click", async () => {
  const mins = parseInt(adjustMinutes.value, 10);
  if (!mins) { adjustModal.close(); return; }
  await applyAdjustment(mins * 60, adjustNote.value.trim(), adjustDate.value, adjustMode);
});

// Applique un ajustement ponctuel au jour `dateStr` (aujourd'hui par défaut,
// mais peut être un jour passé ou futur) :
// - mode "budget" : change le temps DISPONIBLE (offert/retiré) pour ce jour.
// - mode "used"   : enregistre du temps déjà CONSOMMÉ mais jamais chronométré
//   (bouton démarrer/arrêter oublié) — le budget du jour ne change pas.
// Jour passé ou futur : seul l'historique (daily_stats) est corrigé/pré-réglé.
// Aujourd'hui : en plus, le compteur en direct de l'enfant est mis à jour.
async function applyAdjustment(deltaSeconds, note, dateStr, kind) {
  const child = children.find((c) => c.id === currentAdjustId);
  if (!child) return;
  const targetDate = dateStr || todayIsoDate();
  const isToday = targetDate === todayIsoDate();
  const mode = kind || "budget";

  const { data: existing } = await supabaseClient
    .from("daily_stats")
    .select("budget_seconds, consumed_seconds")
    .eq("child_id", child.id)
    .eq("date", targetDate)
    .maybeSingle();

  const currentBudget = existing ? existing.budget_seconds : defaultBudgetSecondsForDate(child, targetDate);
  const currentConsumed = existing ? existing.consumed_seconds : 0;

  const newBudget = mode === "budget" ? Math.max(0, currentBudget + deltaSeconds) : currentBudget;
  const newConsumed = mode === "used" ? Math.max(0, currentConsumed + deltaSeconds) : currentConsumed;

  await supabaseClient.from("daily_stats").upsert(
    {
      child_id: child.id,
      date: targetDate,
      budget_seconds: newBudget,
      consumed_seconds: newConsumed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "child_id,date" }
  );

  await supabaseClient.from("adjustments").insert({ child_id: child.id, delta_seconds: deltaSeconds, note: note || null, date: targetDate, kind: mode });

  if (isToday) {
    if (mode === "budget") {
      const defaultToday = defaultBudgetSecondsForDate(child, targetDate);
      const newBonus = newBudget - defaultToday;
      await supabaseClient.from("children").update({ bonus_seconds: newBonus }).eq("id", child.id);
      child.bonus_seconds = newBonus;
    } else {
      // temps oublié : on l'ajoute directement au temps déjà consommé
      // aujourd'hui (une session en cours continue de tourner normalement)
      const newChildConsumed = Math.max(0, (child.consumed_seconds || 0) + deltaSeconds);
      await supabaseClient.from("children").update({ consumed_seconds: Math.round(newChildConsumed) }).eq("id", child.id);
      child.consumed_seconds = newChildConsumed;
    }
    alarmedIds.delete(child.id);
    fiveMinAlertedIds.delete(child.id);
    twoMinAlertedIds.delete(child.id);
    overtimeTicks.delete(child.id);
    syncDailyStat(child, child.reset_date);
  }

  adjustModal.close();
  render();
}

// ---------- Ajout enfant ----------

const addChildModal = document.getElementById("addChildModal");
document.getElementById("addChildBtn").addEventListener("click", () => {
  withPinProtection(() => {
    document.getElementById("newChildName").value = "";
    addChildModal.showModal();
  });
});
document.getElementById("cancelAddChildBtn").addEventListener("click", () => addChildModal.close());
document.getElementById("confirmAddChildBtn").addEventListener("click", async () => {
  const name = document.getElementById("newChildName").value.trim();
  if (!name) return;
  const { data, error } = await supabaseClient
    .from("children")
    .insert({ name, sort_order: children.length })
    .select()
    .single();
  if (error) {
    alert("Erreur : " + error.message);
    return;
  }
  children.push(data);
  addChildModal.close();
  render();
});

// ---------- PWA : installation & mise en cache de la coquille ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW indisponible", e));
  });
}

// ---------- Statistiques (calendrier mensuel) ----------

const statsModal = document.getElementById("statsModal");
const statsChildSelect = document.getElementById("statsChildSelect");
const statsMonthLabel = document.getElementById("statsMonthLabel");
const statsGrid = document.getElementById("statsGrid");
const statsDayDetail = document.getElementById("statsDayDetail");
const MONTH_LABELS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

let statsYear = null;
let statsMonth = null; // 0-11

function openStatsModal() {
  if (children.length === 0) {
    alert("Ajoute au moins un enfant pour voir des statistiques.");
    return;
  }
  const keepId = statsChildSelect.value && children.some((c) => c.id === statsChildSelect.value)
    ? statsChildSelect.value
    : children[0].id;
  statsChildSelect.innerHTML = children
    .map((c) => `<option value="${c.id}">${c.emoji || "🧒"} ${escapeHtml(c.name)}</option>`)
    .join("");
  statsChildSelect.value = keepId;

  const now = new Date();
  statsYear = now.getFullYear();
  statsMonth = now.getMonth();

  renderStatsMonth();
  statsModal.showModal();
}

function shiftStatsMonth(delta) {
  statsMonth += delta;
  if (statsMonth < 0) { statsMonth = 11; statsYear--; }
  if (statsMonth > 11) { statsMonth = 0; statsYear++; }
  renderStatsMonth();
}

async function renderStatsMonth() {
  const childId = statsChildSelect.value;
  const child = children.find((c) => c.id === childId);
  statsMonthLabel.textContent = `${MONTH_LABELS[statsMonth]} ${statsYear}`;
  statsGrid.innerHTML = "";
  statsDayDetail.hidden = true;
  statsDayDetail.innerHTML = "";
  if (!child) return;

  const firstOfMonth = new Date(statsYear, statsMonth, 1);
  const lastOfMonth = new Date(statsYear, statsMonth + 1, 0);
  const firstStr = firstOfMonth.toISOString().slice(0, 10);
  const lastStr = lastOfMonth.toISOString().slice(0, 10);

  const { data, error } = await supabaseClient
    .from("daily_stats")
    .select("*")
    .eq("child_id", childId)
    .gte("date", firstStr)
    .lte("date", lastStr);

  const byDate = {};
  if (!error && data) {
    for (const row of data) byDate[row.date] = row;
  }

  // Si le mois affiché est le mois en cours, on ajoute la valeur du jour
  // même si elle n'a pas encore été synchronisée en base (session en cours).
  const todayStr = todayIsoDate();
  if (firstStr <= todayStr && todayStr <= lastStr) {
    byDate[todayStr] = {
      consumed_seconds: Math.round(
        (child.consumed_seconds || 0) +
          (child.is_running && child.started_at ? Math.max(0, (Date.now() - new Date(child.started_at).getTime()) / 1000) : 0)
      ),
      budget_seconds: Math.round(todayBudgetSeconds(child)),
    };
  }

  // Lundi = 0 ... Dimanche = 6
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = lastOfMonth.getDate();

  for (let i = 0; i < firstWeekday; i++) {
    const filler = document.createElement("div");
    filler.className = "stats-day stats-empty";
    statsGrid.appendChild(filler);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${statsYear}-${String(statsMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "stats-day";
    if (dateStr === todayStr) cell.classList.add("stats-today");

    const stat = byDate[dateStr];
    let minLabel = "";
    if (stat && (stat.consumed_seconds > 0 || stat.budget_seconds > 0)) {
      const usedMin = Math.round(stat.consumed_seconds / 60);
      minLabel = `${usedMin}m`;
      cell.classList.add(stat.consumed_seconds > stat.budget_seconds ? "stats-over" : "stats-ok");
    }

    cell.innerHTML = `<span class="stats-day-num">${day}</span><span class="stats-day-min">${minLabel}</span>`;
    cell.addEventListener("click", () => showStatsDayDetail(cell, child, dateStr, stat));
    statsGrid.appendChild(cell);
  }
}

// Affiche le détail d'un jour (temps utilisé/budget + liste des ajustements
// ponctuels appliqués à ce jour-là) sous le calendrier.
async function showStatsDayDetail(cell, child, dateStr, stat) {
  statsGrid.querySelectorAll(".stats-day.stats-selected").forEach((el) => el.classList.remove("stats-selected"));
  cell.classList.add("stats-selected");

  const [y, m, d] = dateStr.split("-");
  const niceDate = `${d}/${m}/${y}`;
  const usedMin = stat ? Math.round(stat.consumed_seconds / 60) : 0;
  const budgetMin = stat ? Math.round(stat.budget_seconds / 60) : Math.round(defaultBudgetSecondsForDate(child, dateStr) / 60);

  statsDayDetail.innerHTML = `<h4>${niceDate}</h4><div>${usedMin} / ${budgetMin} min utilisées</div><p class="modal-sub" style="margin:6px 0 0">Chargement des ajustements…</p>`;
  statsDayDetail.hidden = false;

  const { data, error } = await supabaseClient
    .from("adjustments")
    .select("*")
    .eq("child_id", child.id)
    .eq("date", dateStr)
    .order("created_at", { ascending: true });

  const listHtml = !error && data && data.length
    ? `<ul>${data
        .map((a) => {
          const mins = Math.round(a.delta_seconds / 60);
          const sign = mins > 0 ? "stats-adj-plus" : "stats-adj-minus";
          const label = `${mins > 0 ? "+" : ""}${mins} min`;
          const kindLabel = a.kind === "used" ? "⏱️ temps oublié" : "🎁 temps offert/retiré";
          return `<li><span class="${sign}">${label}</span> — ${kindLabel}${a.note ? " — " + escapeHtml(a.note) : ""}</li>`;
        })
        .join("")}</ul>`
    : `<p class="modal-sub" style="margin:6px 0 0">Aucun ajustement ponctuel ce jour-là.</p>`;

  statsDayDetail.innerHTML = `<h4>${niceDate}</h4><div>${usedMin} / ${budgetMin} min utilisées</div>${listHtml}`;
}

document.getElementById("statsBtn").addEventListener("click", openStatsModal);
document.getElementById("statsCloseBtn").addEventListener("click", () => statsModal.close());
document.getElementById("statsPrevBtn").addEventListener("click", () => shiftStatsMonth(-1));
document.getElementById("statsNextBtn").addEventListener("click", () => shiftStatsMonth(1));
statsChildSelect.addEventListener("change", renderStatsMonth);

// ---------- Démarrage ----------

loadChildren();
loadPinSettings();

supabaseClient
  .channel("app-settings-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
    loadPinSettings();
  })
  .subscribe();
