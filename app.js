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

function playAlarm() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [0, 0.35, 0.7].forEach((t) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.32);
    });
  } catch (e) {
    console.warn("Alarme indisponible", e);
  }
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
    await supabaseClient
      .from("children")
      .update({
        consumed_seconds: 0,
        bonus_seconds: 0,
        is_running: false,
        started_at: null,
        reset_date: today,
      })
      .eq("id", c.id);
    c.consumed_seconds = 0;
    c.bonus_seconds = 0;
    c.is_running = false;
    c.started_at = null;
    c.reset_date = today;
  }
}

setInterval(() => {
  maybeResetDaily();
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
    } else {
      display.classList.remove("time-up");
      row.classList.remove("time-up");
      if (rem > 1) alarmedIds.delete(child.id);
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
  } else {
    const nowIso = new Date().toISOString();
    child.is_running = true;
    child.started_at = nowIso;
    alarmedIds.delete(child.id);
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
const adjustMinutes = document.getElementById("adjustMinutes");
const adjustNote = document.getElementById("adjustNote");

function openAdjustModal(child) {
  currentAdjustId = child.id;
  document.getElementById("adjustTitle").textContent = `Ajuster le temps — ${child.name}`;
  adjustMinutes.value = "";
  adjustNote.value = "";
  adjustModal.showModal();
}

document.getElementById("cancelAdjustBtn").addEventListener("click", () => adjustModal.close());

document.querySelectorAll(".btn-quick").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const delta = parseInt(btn.dataset.delta, 10);
    await applyAdjustment(delta, adjustNote.value.trim());
  });
});

document.getElementById("applyAdjustBtn").addEventListener("click", async () => {
  const mins = parseInt(adjustMinutes.value, 10);
  if (!mins) { adjustModal.close(); return; }
  await applyAdjustment(mins * 60, adjustNote.value.trim());
});

async function applyAdjustment(deltaSeconds, note) {
  const child = children.find((c) => c.id === currentAdjustId);
  if (!child) return;
  const newBonus = (child.bonus_seconds || 0) + deltaSeconds;
  await supabaseClient.from("children").update({ bonus_seconds: newBonus }).eq("id", child.id);
  await supabaseClient.from("adjustments").insert({ child_id: child.id, delta_seconds: deltaSeconds, note: note || null });
  child.bonus_seconds = newBonus;
  alarmedIds.delete(child.id);
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

// ---------- Démarrage ----------

loadChildren();
loadPinSettings();

supabaseClient
  .channel("app-settings-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, () => {
    loadPinSettings();
  })
  .subscribe();
