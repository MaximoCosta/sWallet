import { SCHEMA_VERSION, state, STORAGE_KEY } from "./state.js";
import { getAccessToken } from "./api/http.js";
import { authService } from "./api/authService.js";
import { snapshotService } from "./api/snapshotService.js";
import { mergeSnapshots } from "./sync-merge.js";

export const SYNC_EVENT = "swallet:sync";
const CONFLICT_BACKUP_KEY = `${STORAGE_KEY}:conflictBackup`;
const MERGE_CONFLICTS_KEY = `${STORAGE_KEY}:mergeConflicts`;
const MAX_STORED_CONFLICTS = 200;
const MAX_MERGE_ATTEMPTS = 5;

// Version of the server snapshot this tab last saw. Saves are rejected (409) if it is stale.
let remoteUpdatedAt = null;
// Content of that server version, used as the common ancestor when merging concurrent edits.
let remoteBase = null;

const persistedArrays = [
  "clients",
  "projects",
  "invoices",
  "payments",
  "movements",
  "subscriptions",
  "tasks",
  "goals",
  "requests",
  "notes",
  "actions",
  "opportunities",
  "budgets",
  "calendarEvents",
  "documents",
  "supportPlans",
  "teamMembers",
  "marketingCampaigns",
  "clientPortalItems",
  "activityLogs"
];

export function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  try {
    const parsed = migrateSnapshot(JSON.parse(saved));
    state.schemaVersion = parsed.schemaVersion;
    state.savedAt = parsed.savedAt || "";
    state.session = parsed.session || null;
    state.users = Array.isArray(parsed.users) ? parsed.users : [];
    state.userProfiles = normalizeProfiles(parsed.userProfiles);
    persistedArrays.forEach((key) => {
      state[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
    });
    state.companySettings = { ...state.companySettings, ...(parsed.companySettings || {}) };
    state.exchangeRate = Number(parsed.exchangeRate) || 1200;
    // Persist migrations locally only: the cache must never be pushed before the remote state is loaded.
    saveLocalState();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function saveState() {
  queueRemoteSave(saveLocalState());
}

function saveLocalState() {
  state.savedAt = new Date().toISOString();
  const payload = stateSnapshot();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

export function exportSnapshot() {
  return localStorage.getItem(STORAGE_KEY) || JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    companySettings: state.companySettings,
    exchangeRate: state.exchangeRate
  });
}

export function importSnapshot(json) {
  const parsed = migrateSnapshot(JSON.parse(json));
  if (!parsed || typeof parsed !== "object") throw new Error("Archivo invalido.");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
}

export function resetStorage() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

export async function loadRemoteState() {
  let payload;
  try {
    payload = await snapshotService.load();
  } catch (error) {
    console.error("No se pudo cargar Supabase, usando cache local", error);
    return;
  }

  remoteUpdatedAt = payload?.updatedAt || null;
  if (!payload?.snapshot) {
    remoteBase = {};
    return;
  }

  applySnapshot(payload.snapshot);
  const snapshot = stateSnapshot();
  remoteBase = cloneSnapshot(snapshot);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

export function stateSnapshot() {
  return persistedArrays.reduce((acc, key) => {
    acc[key] = normalizeCollection(state[key]);
    return acc;
  }, {
    schemaVersion: SCHEMA_VERSION,
    savedAt: state.savedAt || new Date().toISOString(),
    userProfiles: normalizeProfiles(state.userProfiles),
    companySettings: state.companySettings,
    exchangeRate: state.exchangeRate
  });
}

function applySnapshot(snapshot) {
  const parsed = migrateSnapshot(snapshot);
  state.schemaVersion = parsed.schemaVersion;
  state.savedAt = parsed.savedAt || "";
  persistedArrays.forEach((key) => {
    state[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
  });
  state.userProfiles = normalizeProfiles(parsed.userProfiles);
  applyCurrentUserProfile();
  state.companySettings = { ...state.companySettings, ...(parsed.companySettings || {}) };
  state.exchangeRate = Number(parsed.exchangeRate) || 1200;
}

export function migrateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Archivo invalido.");
  const migrated = {
    ...snapshot,
    schemaVersion: SCHEMA_VERSION,
    savedAt: snapshot.savedAt || new Date().toISOString(),
    session: snapshot.session || null,
    userProfiles: normalizeProfiles(snapshot.userProfiles),
    companySettings: migrateCompanySettings(snapshot.companySettings),
    exchangeRate: Number(snapshot.exchangeRate) || 1200
  };

  persistedArrays.forEach((key) => {
    migrated[key] = normalizeCollection(snapshot[key]);
  });
  migrated.users = normalizeCollection(snapshot.users);

  migrated.clients = migrated.clients.map(migrateClient);
  migrated.projects = migrated.projects.map(migrateProject);
  migrated.invoices = migrated.invoices.map(migrateInvoice);
  migrated.payments = migrated.payments.map(migratePayment);
  migrated.tasks = migrated.tasks.map(migrateTask);
  migrated.goals = migrated.goals.map(migrateGoal);
  migrated.users = migrated.users.map(migrateUser);

  return migrated;
}

function migrateCompanySettings(settings = {}) {
  const migrated = { ...settings };
  if (!migrated.email || migrated.email === "admin@scode.com") migrated.email = "contact@scodedigital.com";
  if (!migrated.website || migrated.website === "https://scode.com" || migrated.website === "scode.com") migrated.website = "https://scodedigital.com";
  return migrated;
}

// Only the latest full snapshot matters, so pending saves are coalesced into one.
let pendingPayload = null;
let flushing = null;
let retryPayload = null;
let retryTimer = null;
const RETRY_DELAY_MS = 15000;

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsyncedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

export function hasUnsyncedChanges() {
  return Boolean(pendingPayload || flushing || retryPayload);
}

function queueRemoteSave(payload) {
  if (!getAccessToken() || !currentUserCanWrite()) return;
  pendingPayload = payload;
  clearRetry();
  if (flushing) return;
  flushing = flushRemoteSaves().finally(() => {
    flushing = null;
    if (pendingPayload) queueRemoteSave(pendingPayload);
  });
}

async function flushRemoteSaves() {
  let mergeAttempts = 0;
  while (pendingPayload) {
    const payload = pendingPayload;
    pendingPayload = null;
    try {
      await pushSnapshot(payload);
    } catch (error) {
      if (error?.status === 409) {
        // Merge the newest local state (anything queued supersedes the rejected payload) with the server's.
        const latestLocal = pendingPayload || payload;
        mergeAttempts += 1;
        if (mergeAttempts > MAX_MERGE_ATTEMPTS) {
          handleConflict(latestLocal, error.details);
          pendingPayload = null;
          return;
        }
        pendingPayload = mergeWithRemote(latestLocal, error.details);
        continue;
      }
      if (error?.status === 403) {
        // The role changed to read-only: the server will never accept this write, so do not retry it.
        pendingPayload = null;
        emitSync("error", error.message || "Tu usuario no tiene permiso para guardar cambios.");
        return;
      }
      console.error("No se pudo sincronizar con Supabase", error);
      const firstFailure = !syncFailing;
      scheduleRetry(pendingPayload || payload);
      pendingPayload = null;
      if (firstFailure) {
        emitSync("error", `${error?.message || "No se pudo guardar en el servidor."} Los cambios quedan en este navegador y se reintenta automaticamente.`);
      }
      return;
    }
  }
  if (retryPayload === null) emitSyncRecovered();
}

let syncFailing = false;

function scheduleRetry(payload) {
  retryPayload = payload;
  syncFailing = true;
  if (retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    const next = retryPayload;
    if (next) queueRemoteSave(next);
  }, RETRY_DELAY_MS);
}

function clearRetry() {
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = null;
  retryPayload = null;
}

function emitSyncRecovered() {
  if (!syncFailing) return;
  syncFailing = false;
  emitSync("recovered", "Los cambios pendientes se guardaron en el servidor.");
}

async function pushSnapshot(payload) {
  let result;
  try {
    result = await snapshotService.save(payload, remoteUpdatedAt);
  } catch (error) {
    if (error?.status !== 401) throw error;
    const session = await authService.refresh().catch(() => null);
    if (!session) throw error;
    result = await snapshotService.save(payload, remoteUpdatedAt);
  }
  remoteUpdatedAt = result?.updatedAt || remoteUpdatedAt;
  remoteBase = cloneSnapshot(payload);
}

// Three-way merge of this browser's state with the version another user saved first.
// Applies the result locally and returns the payload to push (on top of the server's version).
function mergeWithRemote(localPayload, remote) {
  remoteUpdatedAt = remote?.updatedAt || null;
  if (!remote?.snapshot) {
    remoteBase = {};
    return localPayload;
  }

  const remoteSnapshot = comparable(remote.snapshot);
  const { merged, conflicts } = mergeSnapshots({
    base: remoteBase ? comparable(remoteBase) : {},
    local: comparable(localPayload),
    remote: remoteSnapshot,
    collections: persistedArrays
  });

  applySnapshot(merged);
  state.savedAt = merged.savedAt;
  const payload = stateSnapshot();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  remoteBase = remoteSnapshot;
  storeMergeConflicts(conflicts);
  syncFailing = false;

  const detail = conflicts.length
    ? `Se combinaron tus cambios con los de otro usuario. Hay ${conflicts.length} diferencia(s) para revisar en Configuración > Persistencia.`
    : "Se combinaron tus cambios con los que guardo otro usuario.";
  emitSync("merged", detail);
  return payload;
}

function comparable(snapshot) {
  const migrated = migrateSnapshot(cloneSnapshot(snapshot));
  delete migrated.session;
  delete migrated.users;
  return migrated;
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function storeMergeConflicts(conflicts) {
  if (!conflicts.length) return;
  const at = new Date().toISOString();
  const entries = conflicts.map((conflict) => ({
    ...conflict,
    key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at
  }));
  try {
    const stored = [...entries, ...readSyncConflicts()].slice(0, MAX_STORED_CONFLICTS);
    localStorage.setItem(MERGE_CONFLICTS_KEY, JSON.stringify(stored));
  } catch (error) {
    console.error("No se pudieron guardar las diferencias de la fusión", error);
  }
}

export function readSyncConflicts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MERGE_CONFLICTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSyncConflicts(conflicts) {
  if (conflicts.length) localStorage.setItem(MERGE_CONFLICTS_KEY, JSON.stringify(conflicts));
  else localStorage.removeItem(MERGE_CONFLICTS_KEY);
}

/**
 * Resolves one stored merge difference.
 * choice "keep": keep the current value. "remote": use the other user's value.
 * "delete": delete the record that was kept because one side deleted it.
 * Returns false when the record no longer exists (the difference is dismissed anyway).
 */
export function resolveSyncConflict(key, choice) {
  const conflicts = readSyncConflicts();
  const conflict = conflicts.find((item) => item.key === key);
  if (!conflict) return false;
  writeSyncConflicts(conflicts.filter((item) => item.key !== key));
  if (choice === "keep") return true;

  const applied = choice === "delete" ? deleteConflictRecord(conflict) : applyRemoteValue(conflict);
  if (applied) saveState();
  return applied;
}

export function dismissAllSyncConflicts() {
  writeSyncConflicts([]);
}

function applyRemoteValue(conflict) {
  const value = conflict.remoteValue === null ? undefined : conflict.remoteValue;
  if (conflict.collection === "exchangeRate") {
    state.exchangeRate = Number(value) || state.exchangeRate;
    return true;
  }
  if (conflict.collection === "companySettings") {
    state.companySettings = setField(state.companySettings, conflict.field, value);
    return true;
  }
  if (conflict.collection === "userProfiles") {
    const profiles = { ...(state.userProfiles || {}) };
    if (conflict.field) profiles[conflict.id] = setField(profiles[conflict.id] || {}, conflict.field, value);
    else if (value === undefined) delete profiles[conflict.id];
    else profiles[conflict.id] = value;
    state.userProfiles = profiles;
    return true;
  }
  const collection = state[conflict.collection];
  if (!Array.isArray(collection)) return false;
  const index = collection.findIndex((item) => item.id === conflict.id);
  if (index === -1) return false;
  collection[index] = { ...setField(collection[index], conflict.field, value), updatedAt: new Date().toISOString() };
  return true;
}

function deleteConflictRecord(conflict) {
  const collection = state[conflict.collection];
  if (!Array.isArray(collection)) return false;
  const index = collection.findIndex((item) => item.id === conflict.id);
  if (index === -1) return false;
  collection.splice(index, 1);
  return true;
}

function setField(record, field, value) {
  const next = { ...(record || {}) };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

export function clearConflictBackup() {
  localStorage.removeItem(CONFLICT_BACKUP_KEY);
}

// Last resort when merging keeps failing: load the server version and keep a full local backup.
function handleConflict(rejectedPayload, remote) {
  try {
    localStorage.setItem(CONFLICT_BACKUP_KEY, JSON.stringify({
      rejectedAt: new Date().toISOString(),
      snapshot: rejectedPayload
    }));
  } catch (error) {
    console.error("No se pudo guardar el respaldo del conflicto", error);
  }

  syncFailing = false;
  remoteUpdatedAt = remote?.updatedAt || null;
  remoteBase = remote?.snapshot ? comparable(remote.snapshot) : {};
  if (remote?.snapshot) {
    applySnapshot(remote.snapshot);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateSnapshot()));
  }
  emitSync("conflict", "No se pudieron combinar los cambios. Se cargó la versión del servidor y tu versión quedó respaldada en Configuración > Persistencia.");
}

export function readConflictBackup() {
  return localStorage.getItem(CONFLICT_BACKUP_KEY);
}

function emitSync(type, message) {
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { type, message } }));
}

function normalizeCollection(collection) {
  return Array.isArray(collection) ? collection.map(normalizeRecord) : [];
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return {};
  const now = new Date().toISOString();
  return {
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || record.createdAt || now,
    ...record
  };
}

function normalizeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return {};
  return Object.entries(profiles).reduce((acc, [key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) acc[key] = { ...value };
    return acc;
  }, {});
}

// Mirrors canWrite() in auth.js (not imported to avoid a circular dependency).
function currentUserCanWrite() {
  const user = state.users.find((item) => item.id === state.session?.userId);
  if (!user) return false;
  return user.role === "admin" || user.role === "finanzas" || Boolean(user.permissions?.includes("write"));
}

function applyCurrentUserProfile() {
  const current = state.users.find((user) => user.id === state.session?.userId);
  if (!current) return;
  const username = String(current.username || "").toLowerCase();
  const profile = state.userProfiles?.[current.username] || state.userProfiles?.[username] || state.userProfiles?.[current.id];
  if (profile?.avatar !== undefined) current.avatar = profile.avatar;
}

function migrateClient(client) {
  const statusMap = {
    activo: "cliente_activo",
    pendiente: "en_negociacion",
    finalizado: "proyecto_finalizado"
  };
  return {
    priority: "media",
    firstContact: client.firstContact || client.startDate || "",
    lastContact: client.lastContact || "",
    observations: client.observations || "",
    ...client,
    status: statusMap[client.status] || client.status || "lead"
  };
}

function migrateProject(project) {
  const statusMap = {
    pendiente: "planificacion",
    en_progreso: "en_desarrollo",
    revision: "en_revision",
    entregado: "finalizado"
  };
  return {
    paid: 0,
    expenses: 0,
    progress: 0,
    responsible: "",
    technologies: "",
    links: "",
    notes: "",
    tasks: [],
    ...project,
    status: statusMap[project.status] || project.status || "planificacion"
  };
}

function migrateInvoice(invoice) {
  return {
    projectId: "",
    notes: "",
    ...invoice,
    status: invoice.status || "pendiente"
  };
}

function migratePayment(payment) {
  return {
    invoiceId: "",
    projectId: "",
    notes: "",
    ...payment,
    status: payment.status || "pagado"
  };
}

function migrateTask(task) {
  return {
    projectId: "",
    checklist: [],
    comments: "",
    ...task,
    status: task.status || "pendiente",
    priority: task.priority || "media"
  };
}

function migrateGoal(goal) {
  return {
    current: 0,
    status: "en_progreso",
    priority: "media",
    ...goal
  };
}

function migrateUser(user) {
  const username = user.username || String(user.email || user.name || "usuario").split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, ".");
  const status = user.status === "active" ? "activo" : user.status;
  return {
    username,
    status: "activo",
    permissions: defaultPermissionsForRole(user.role),
    avatar: "",
    phone: "",
    area: "",
    notes: "",
    ...user,
    status: status || "activo"
  };
}

function defaultPermissionsForRole(role) {
  if (role === "admin") return ["clients", "finance", "projects", "reports", "settings", "write", "delete"];
  if (role === "finanzas") return ["clients", "finance", "reports", "write"];
  return ["reports"];
}
