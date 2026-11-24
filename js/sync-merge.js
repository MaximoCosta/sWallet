// Three-way merge of full sWallet snapshots.
// base   = last version this browser saw on the server
// local  = this browser's current state
// remote = what another user saved meanwhile
// Changes from both sides are combined record by record and field by field. When both sides
// changed the same field differently, the local value wins and the remote one is reported
// as a conflict so the user can pick it back from Configuracion.

const TIMESTAMP_FIELDS = new Set(["updatedAt", "savedAt"]);

export function mergeSnapshots({ base, local, remote, collections }) {
  const conflicts = [];
  const safeBase = base || {};
  const merged = { ...remote, ...local };

  collections.forEach((key) => {
    merged[key] = mergeCollection(key, asArray(safeBase[key]), asArray(local[key]), asArray(remote[key]), conflicts);
  });

  merged.companySettings = mergeRecord(
    { collection: "companySettings", id: null, label: "Datos de la empresa" },
    safeBase.companySettings || {},
    local.companySettings || {},
    remote.companySettings || {},
    conflicts
  );

  merged.userProfiles = mergeMap("userProfiles", safeBase.userProfiles || {}, local.userProfiles || {}, remote.userProfiles || {}, conflicts);

  merged.exchangeRate = mergeValue(
    { collection: "exchangeRate", id: null, label: "Cotizacion USD", field: "exchangeRate" },
    safeBase.exchangeRate,
    local.exchangeRate,
    remote.exchangeRate,
    conflicts
  );

  merged.savedAt = new Date().toISOString();
  return { merged, conflicts };
}

function mergeCollection(collection, base, local, remote, conflicts) {
  const baseById = indexById(base);
  const localById = indexById(local);
  const remoteById = indexById(remote);
  const result = [];
  const seen = new Set();

  const resolve = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const item = mergeItem(collection, baseById.get(key), localById.get(key), remoteById.get(key), conflicts);
    if (item !== undefined) result.push(item);
  };

  // Keep the server order, then append what only exists locally.
  remoteById.forEach((_item, key) => resolve(key));
  localById.forEach((_item, key) => resolve(key));
  baseById.forEach((_item, key) => resolve(key));
  return result;
}

function mergeItem(collection, b, l, r, conflicts) {
  const localChanged = !same(b, l);
  const remoteChanged = !same(b, r);

  if (!localChanged) return r;
  if (!remoteChanged) return l;
  if (same(l, r)) return l;

  // One side deleted, the other edited: keep the edited record so nothing is lost.
  if (l === undefined || r === undefined) {
    const kept = l ?? r;
    conflicts.push({
      kind: "delete",
      collection,
      id: kept.id ?? null,
      label: recordLabel(kept),
      deletedBy: l === undefined ? "local" : "remote"
    });
    return kept;
  }

  return mergeRecord({ collection, id: l.id ?? r.id ?? null, label: recordLabel(l) }, b || {}, l, r, conflicts);
}

function mergeMap(collection, base, local, remote, conflicts) {
  const result = {};
  const keys = new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)]);
  keys.forEach((key) => {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    let value;
    if (!same(b, l) && !same(b, r) && !same(l, r) && isPlainObject(l) && isPlainObject(r)) {
      value = mergeRecord({ collection, id: key, label: key }, isPlainObject(b) ? b : {}, l, r, conflicts);
    } else {
      value = mergeValue({ collection, id: key, label: key, field: null }, b, l, r, conflicts);
    }
    if (value !== undefined) result[key] = value;
  });
  return result;
}

function mergeRecord(context, b, l, r, conflicts) {
  const result = {};
  const keys = new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)]);
  keys.forEach((field) => {
    let value;
    if (TIMESTAMP_FIELDS.has(field)) {
      value = latest(l[field], r[field]);
    } else {
      value = mergeValue({ ...context, field }, b[field], l[field], r[field], conflicts);
    }
    if (value !== undefined) result[field] = value;
  });
  return result;
}

function mergeValue(context, b, l, r, conflicts) {
  if (same(l, r)) return l;
  if (same(b, l)) return r;
  if (same(b, r)) return l;
  conflicts.push({
    kind: "field",
    collection: context.collection,
    id: context.id,
    label: context.label,
    field: context.field,
    localValue: l === undefined ? null : l,
    remoteValue: r === undefined ? null : r
  });
  return l;
}

function indexById(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = item && typeof item === "object" && item.id != null ? `id:${item.id}` : `json:${stableStringify(item)}`;
    if (!map.has(key)) map.set(key, item);
  });
  return map;
}

export function recordLabel(record) {
  if (!record || typeof record !== "object") return "";
  return String(record.name || record.title || record.company || record.number || record.description || record.id || "");
}

function latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return String(a) > String(b) ? a : b;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function same(a, b) {
  return stableStringify(a) === stableStringify(b);
}

export function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
