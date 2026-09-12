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
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
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
    row.querySelector('[data-action="settings"]').addEventListener("click", () => openSettingsModal(child));

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
        autoStop(child);
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
    if (remainingSeconds(child) <= 0) return; // plus de temps, on ne démarre pas
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

async function autoStop(child) {
  const budget = todayBudgetSeconds(child);
  child.is_running = false;
  child.started_at = null;
  child.consumed_seconds = budget;
  await supabaseClient
    .from("children")
    .update({ is_running: false, started_at: null, consumed_seconds: budget })
    .eq("id", child.id);
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
  document.getElementById("newChildName").value = "";
  addChildModal.showModal();
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

// ---------- Démarrage ----------

loadChildren();
