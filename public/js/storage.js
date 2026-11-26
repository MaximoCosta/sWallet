// Record-level sync with the server (/api/v1/data).
//
// The UI keeps editing plain arrays in `state` and calls saveState(). Here we compare each record
// with the last version the server confirmed (`baseline`) and send only what changed: new records,
// edited records (with the version `_v` they were based on) and deletions. If someone else changed
// the same record first, the server keeps theirs and we load it; other records are not affected.
import { SCHEMA_VERSION, state, STORAGE_KEY } from "./state.js";
import { getAccessToken } from "./api/http.js";
import { dataService } from "./api/dataService.js";

export const SYNC_EVENT = "swallet:sync";

export const COLLECTIONS = [
  "clients", "projects", "invoices", "payments", "movements", "subscriptions", "tasks", "goals",
  "requests", "notes", "actions", "opportunities", "budgets", "calendarEvents", "documents",
  "supportPlans", "teamMembers", "marketingCampaigns", "clientPortalItems"
];
const SETTINGS_KEYS = ["companySettings", "exchangeRate"];
const CACHE_KEY = `${STORAGE_KEY}:records-v1`;
const LEGACY_KEYS = [STORAGE_KEY, `${STORAGE_KEY}:conflictBackup`, `${STORAGE_KEY}:mergeConflicts`];
const RETRY_MS = 15000;
const POLL_MS = 20000;

const LABELS = {
  clients: "Cliente", projects: "Proyecto", invoices: "Factura", payments: "Pago", movements: "Movimiento",
  subscriptions: "Suscripción", tasks: "Tarea", goals: "Meta", requests: "Pedido", notes: "Nota", actions: "Acción",
  opportunities: "Oportunidad", budgets: "Presupuesto", calendarEvents: "Evento", documents: "Documento",
  supportPlans: "Mantenimiento", teamMembers: "Miembro del equipo", marketingCampaigns: "Campaña",
  clientPortalItems: "Recurso del portal"
};

// collection -> Map(id -> JSON the server confirmed). Settings use the same idea.
let baseline = emptyBaseline();
let settingsBaseline = {};
let serverTime = null;
let loadedFromServer = false;

export const syncStatus = { pending: 0, failing: false, lastSyncAt: null, lastError: "" };

/* ---------- Local cache ---------- */

export function loadState() {
  LEGACY_KEYS.forEach((key) => safeRemove(key));
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  } catch {
    cached = null;
  }
  if (!cached || cached.schemaVersion !== SCHEMA_VERSION) return;
  state.session = cached.session || null;
  state.users = Array.isArray(cached.users) ? cached.users : [];
  COLLECTIONS.forEach((key) => {
    state[key] = Array.isArray(cached.collections?.[key]) ? cached.collections[key] : [];
  });
  applySettings(cached.settings || {});
  baseline = reviveBaseline(cached.baseline);
  settingsBaseline = cached.settingsBaseline || {};
  serverTime = cached.serverTime || null;
}

function writeCache() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    session: state.session,
    users: state.users,
    collections: Object.fromEntries(COLLECTIONS.map((key) => [key, state[key] || []])),
    settings: currentSettings(),
    baseline: Object.fromEntries(COLLECTIONS.map((key) => [key, Object.fromEntries(baseline[key])])),
    settingsBaseline,
    serverTime
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Cache is a convenience (offline/fast start); the server is the source of truth.
  }
}

/** Called by the UI after any change. */
export function saveState() {
  writeCache();
  schedulePush();
}

export function clearLocalData() {
  COLLECTIONS.forEach((key) => {
    state[key] = [];
  });
  baseline = emptyBaseline();
  settingsBaseline = {};
  serverTime = null;
  loadedFromServer = false;
  loadAttempts = 0;
  if (loadRetryTimer) window.clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
  state.activityLogs = [];
  stopPolling();
  writeCache();
}

export function resetStorage() {
  safeRemove(CACHE_KEY);
  location.reload();
}

/* ---------- Pull ---------- */

/** Full load after login. Local edits that were never sent are kept and pushed right after.
 *  If it fails, it keeps retrying: nothing is sent until the server copy is known. */
let loadingRemote = null;
let loadRetryTimer = null;
let loadAttempts = 0;

export function loadRemoteState() {
  if (loadingRemote) return loadingRemote;
  if (loadRetryTimer) {
    window.clearTimeout(loadRetryTimer);
    loadRetryTimer = null;
  }
  loadingRemote = dataService.load()
    .then((payload) => {
      applyServerPayload(payload, { full: true });
      loadedFromServer = true;
      loadAttempts = 0;
      const recovered = syncStatus.failing;
      syncStatus.failing = false;
      syncStatus.lastError = "";
      writeCache();
      startPolling();
      if (recovered) emitSync("recovered", "Conexión recuperada: los datos están al día.");
      else emitSync("changed", "");
      if (hasLocalChanges()) schedulePush(0);
    })
    .catch((error) => {
      console.error("No se pudieron cargar los datos del servidor", error);
      loadAttempts += 1;
      const firstFailure = !syncStatus.failing;
      syncStatus.failing = true;
      syncStatus.lastError = error?.message || "No se pudo conectar con el servidor.";
      if (firstFailure) emitSync("error", `${syncStatus.lastError} Se reintenta solo; lo que cargues queda guardado en este navegador hasta que se conecte.`);
      if (getAccessToken()) {
        loadRetryTimer = window.setTimeout(loadRemoteState, Math.min(5000 * loadAttempts, 30000));
      }
    })
    .finally(() => {
      loadingRemote = null;
    });
  return loadingRemote;
}

async function pullChanges() {
  if (!loadedFromServer || !getAccessToken() || pushing) return;
  try {
    const payload = await dataService.load(serverTime);
    if (applyServerPayload(payload, { full: false })) {
      writeCache();
      emitSync("changed", "");
    }
  } catch {
    // Polling is best effort; the next tick retries.
  }
}

function applyServerPayload(payload, { full }) {
  let changed = false;
  for (const key of COLLECTIONS) {
    const incoming = Array.isArray(payload?.collections?.[key]) ? payload.collections[key] : [];
    const local = new Map((state[key] || []).map((record) => [record.id, record]));
    const incomingIds = new Set();

    for (const record of incoming) {
      incomingIds.add(record.id);
      const json = stableJson(record);
      if (baseline[key].get(record.id) === json) continue;
      const mine = local.get(record.id);
      const editedHere = mine && isLocallyModified(key, mine);
      baseline[key].set(record.id, json);
      if (editedHere) {
        mine._v = record._v; // keep my edit, but base it on the newest version
      } else {
        local.set(record.id, record);
        changed = true;
      }
    }

    if (full) {
      // Records that are gone from the server, unless they were created here and not sent yet.
      for (const [id, record] of local) {
        if (incomingIds.has(id)) continue;
        if (baseline[key].has(id) || record._v) {
          local.delete(id);
          baseline[key].delete(id);
          changed = true;
        }
      }
      for (const id of [...baseline[key].keys()]) if (!incomingIds.has(id)) baseline[key].delete(id);
    }
    state[key] = [...local.values()];
  }

  for (const item of payload?.deletions || []) {
    if (!baseline[item.collection]) continue;
    baseline[item.collection].delete(item.id);
    const before = state[item.collection].length;
    state[item.collection] = state[item.collection].filter((record) => record.id !== item.id);
    if (state[item.collection].length !== before) changed = true;
  }

  const settings = payload?.settings || {};
  for (const key of SETTINGS_KEYS) {
    if (!(key in settings)) continue;
    const json = stableJson(settings[key]);
    if (settingsBaseline[key] === json) continue;
    const editedHere = settingsBaseline[key] !== undefined && stableJson(currentSettings()[key]) !== settingsBaseline[key];
    settingsBaseline[key] = json;
    if (!editedHere) {
      applySettings({ [key]: settings[key] });
      changed = true;
    }
  }
  if (full) {
    // First run on an empty database: what this browser has is the starting point.
    SETTINGS_KEYS.forEach((key) => {
      if (!(key in settings)) delete settingsBaseline[key];
    });
  }

  if (Array.isArray(payload?.activity)) {
    if (stableJson(payload.activity) !== stableJson(state.activityLogs || [])) changed = true;
    state.activityLogs = payload.activity;
  }
  if (payload?.serverTime) serverTime = payload.serverTime;
  return changed;
}

/* ---------- Push ---------- */

let pushTimer = null;
let pushing = null;
let pushAgain = false;

function schedulePush(delay = 300) {
  if (!getAccessToken()) return;
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    pushChanges();
  }, delay);
}

export function hasLocalChanges() {
  return Boolean(collectChanges().count);
}

function isLocallyModified(key, record) {
  const synced = baseline[key].get(record.id);
  return synced === undefined || synced !== stableJson(record);
}

function collectChanges() {
  const upserts = [];
  const deletes = [];
  for (const key of COLLECTIONS) {
    const ids = new Set();
    for (const record of state[key] || []) {
      if (!record?.id) continue;
      ids.add(record.id);
      if (isLocallyModified(key, record)) upserts.push({ collection: key, record });
    }
    for (const id of baseline[key].keys()) if (!ids.has(id)) deletes.push({ collection: key, id });
  }
  const settings = {};
  const current = currentSettings();
  for (const key of SETTINGS_KEYS) {
    if (stableJson(current[key]) !== settingsBaseline[key]) settings[key] = current[key];
  }
  const hasSettings = Object.keys(settings).length > 0;
  return { upserts, deletes, settings: hasSettings ? settings : null, count: upserts.length + deletes.length + (hasSettings ? 1 : 0) };
}

// Mirrors canWrite() in auth.js (not imported: auth.js imports this module).
function currentUserCanWrite() {
  const user = state.users.find((item) => item.id === state.session?.userId);
  return Boolean(user && (user.role === "admin" || user.role === "finanzas" || user.permissions?.includes("write")));
}

async function pushChanges() {
  if (!currentUserCanWrite()) return;
  if (!loadedFromServer) {
    // Never send before the server copy is known: load it first (the load pushes pending edits).
    if (getAccessToken()) loadRemoteState();
    return;
  }
  if (pushing) {
    pushAgain = true;
    return;
  }
  const changes = collectChanges();
  syncStatus.pending = changes.count;
  if (!changes.count) return;

  const sent = new Map(changes.upserts.map((op) => [`${op.collection}:${op.record.id}`, stableJson(op.record)]));
  pushing = dataService.save({ upserts: changes.upserts, deletes: changes.deletes, settings: changes.settings })
    .then((response) => {
      handlePushResponse(response, changes, sent);
      const recovered = syncStatus.failing;
      syncStatus.failing = false;
      syncStatus.lastError = "";
      syncStatus.lastSyncAt = new Date().toISOString();
      if (recovered) emitSync("recovered", "Los cambios pendientes se guardaron.");
    })
    .catch((error) => {
      if (error?.status === 403 || error?.status === 400) {
        // The server will never accept this batch as is: go back to what it has.
        revertAll();
        emitSync("error", error.message || "No tenés permiso para guardar estos cambios.");
        return;
      }
      const firstFailure = !syncStatus.failing;
      syncStatus.failing = true;
      syncStatus.lastError = error?.message || "Sin conexión con el servidor.";
      if (firstFailure) emitSync("error", `${syncStatus.lastError} Los cambios quedan en este navegador y se reintenta solo.`);
      schedulePush(RETRY_MS);
    })
    .finally(() => {
      pushing = null;
      writeCache();
      syncStatus.pending = collectChanges().count;
      if (pushAgain) {
        pushAgain = false;
        schedulePush(0);
      }
    });
  return pushing;
}

function handlePushResponse(response, changes, sent) {
  const notices = [];
  let visibleChange = false;

  for (const result of response?.results || []) {
    const key = result.collection;
    if (!baseline[key]) continue;
    const isDelete = changes.deletes.some((op) => op.collection === key && op.id === result.id);

    if (result.status === "ok") {
      if (isDelete) continue;
      acceptServerRecord(key, result.record, sent.get(`${key}:${result.id}`));
    } else if (result.status === "conflict") {
      baseline[key].set(result.id, stableJson(result.record));
      replaceLocal(key, result.record);
      notices.push(`${LABELS[key] || key} "${recordName(result.record)}" lo cambió otra persona: se cargó su versión.`);
      visibleChange = true;
    } else if (result.status === "deleted") {
      baseline[key].delete(result.id);
      state[key] = state[key].filter((record) => record.id !== result.id);
      notices.push(`${LABELS[key] || key}: otra persona lo eliminó.`);
      visibleChange = true;
    } else {
      revertRecord(key, result.id);
      notices.push(result.message || "No se pudo guardar un registro.");
      visibleChange = true;
    }
  }

  for (const item of response?.changed || []) {
    if (!baseline[item.collection]) continue;
    baseline[item.collection].set(item.record.id, stableJson(item.record));
    replaceLocal(item.collection, item.record);
    visibleChange = true;
  }

  if (changes.settings) {
    Object.entries(changes.settings).forEach(([key, value]) => {
      settingsBaseline[key] = stableJson(value);
    });
  }
  if (response?.serverTime && !serverTime) serverTime = response.serverTime;

  if (notices.length) emitSync("conflict", notices.slice(0, 3).join(" "));
  else if (visibleChange) emitSync("changed", "");
  // Refresh the activity log and anything others saved meanwhile.
  window.setTimeout(pullChanges, 500);
}

// Server confirmed my write. If I edited the record again while it was in flight, keep that edit.
function acceptServerRecord(key, record, sentJson) {
  baseline[key].set(record.id, stableJson(record));
  const mine = state[key].find((item) => item.id === record.id);
  if (!mine) return;
  const { _v, ...mineData } = mine;
  const { _v: _sentV, ...sentData } = JSON.parse(sentJson || "{}");
  if (stableJson(mineData) === stableJson(sentData)) replaceLocal(key, record);
  else mine._v = record._v;
}

function replaceLocal(key, record) {
  const index = state[key].findIndex((item) => item.id === record.id);
  if (index === -1) state[key].push(record);
  else state[key][index] = record;
}

function revertRecord(key, id) {
  const synced = baseline[key].get(id);
  if (synced === undefined) state[key] = state[key].filter((record) => record.id !== id);
  else replaceLocal(key, JSON.parse(synced));
}

function revertAll() {
  for (const key of COLLECTIONS) {
    state[key] = [...baseline[key].values()].map((json) => JSON.parse(json));
  }
  for (const key of SETTINGS_KEYS) {
    if (settingsBaseline[key] !== undefined) applySettings({ [key]: JSON.parse(settingsBaseline[key]) });
  }
  emitSync("changed", "");
}

/* ---------- Polling ---------- */

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") pullChanges();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (document.visibilityState === "visible") pullChanges();
}

window.addEventListener("beforeunload", (event) => {
  if (!loadedFromServer || !hasLocalChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

/* ---------- Backup ---------- */

export function exportBackup() {
  return JSON.stringify({
    app: "sWallet",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    collections: Object.fromEntries(COLLECTIONS.map((key) => [key, (state[key] || []).map(({ _v, ...record }) => record)])),
    settings: currentSettings()
  }, null, 2);
}

/** Replaces all data with the file's content (records not in the file are deleted). */
export function importBackup(json) {
  const parsed = JSON.parse(json);
  const source = parsed?.collections || parsed; // also accepts old exports with top-level arrays
  if (!source || typeof source !== "object") throw new Error("Archivo inválido.");
  let total = 0;
  for (const key of COLLECTIONS) {
    const records = Array.isArray(source[key]) ? source[key].filter((record) => record && typeof record === "object" && record.id) : [];
    const current = new Map((state[key] || []).map((record) => [record.id, record]));
    state[key] = records.map(({ _v, ...record }) => (current.get(record.id)?._v ? { ...record, _v: current.get(record.id)._v } : record));
    total += records.length;
  }
  const settings = parsed?.settings || parsed;
  if (settings?.companySettings) applySettings({ companySettings: settings.companySettings });
  if (settings?.exchangeRate) applySettings({ exchangeRate: settings.exchangeRate });
  saveState();
  return total;
}

/* ---------- Helpers ---------- */

function currentSettings() {
  return { companySettings: state.companySettings, exchangeRate: state.exchangeRate };
}

function applySettings(settings) {
  if (settings.companySettings && typeof settings.companySettings === "object") {
    state.companySettings = { ...state.companySettings, ...settings.companySettings };
  }
  if (settings.exchangeRate !== undefined) state.exchangeRate = Number(settings.exchangeRate) || state.exchangeRate;
}

function emptyBaseline() {
  return Object.fromEntries(COLLECTIONS.map((key) => [key, new Map()]));
}

function reviveBaseline(raw) {
  const result = emptyBaseline();
  if (!raw || typeof raw !== "object") return result;
  COLLECTIONS.forEach((key) => {
    Object.entries(raw[key] || {}).forEach(([id, json]) => result[key].set(id, json));
  });
  return result;
}

function recordName(record) {
  return String(record?.company || record?.name || record?.title || record?.projectName || record?.number || record?.description || record?.category || "sin nombre").slice(0, 60);
}

function emitSync(type, message) {
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { type, message } }));
}

// Key order does not matter: Postgres (jsonb) returns keys sorted differently than the browser built them.
function stableJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortKeys(value[key]);
    return acc;
  }, {});
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
