// Record-level storage for the business entities (see collections.ts).
//
// Every record carries a `version`. A write sends the version it was based on; if someone else
// changed that record in the meantime the write is refused for that record only (a "conflict")
// and the current version is returned. Different records never block each other.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { COLLECTIONS, COLLECTION_BY_KEY, dependents, type CollectionDef } from "@/lib/collections";
import { runMigrations } from "@/lib/migrations";

const MAX_OPERATIONS = 500;
const MAX_RECORD_BYTES = 100_000;
const AUDIT_LIMIT = 60;
const SETTINGS_KEYS = ["companySettings", "exchangeRate"] as const;

export type Actor = { id: string; name: string; canWrite: boolean; canDelete: boolean; isAdmin: boolean };

type Row = { id: string; data: Record<string, unknown>; version: number; updated_at: Date };

export class DataError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/* ---------- Read ---------- */

/** Everything (since = null) or only what changed after `since`, plus deletions and recent activity.
 *  One SQL statement (one round trip): the app server and the database are in different places. */
export async function readData(since: Date | null) {
  await runMigrations();
  const serverTime = new Date();
  // Overlap so a write committed while we read is not missed; the client applies changes idempotently.
  const from = since ? new Date(since.getTime() - 5000) : new Date(0);
  const parts = COLLECTIONS.map((def) => `'${def.key}', (
      SELECT COALESCE(json_agg(json_build_object('id', "id", 'data', "data", 'version', "version") ORDER BY "created_at"), '[]'::json)
      FROM "${def.table}" WHERE "updated_at" > $1)`);
  const [row] = await prisma.$queryRawUnsafe<{ collections: Record<string, { id: string; data: Record<string, unknown>; version: number }[]>; deletions: { collection: string; id: string }[]; settings: Record<string, unknown> }[]>(
    `SELECT
       json_build_object(${parts.join(",\n")}) AS "collections",
       (SELECT COALESCE(json_agg(json_build_object('collection', "collection", 'id', "id")), '[]'::json) FROM "data_deletions" WHERE "deleted_at" > $1 AND $2) AS "deletions",
       (SELECT COALESCE(json_object_agg("key", "value"), '{}'::json) FROM "app_settings" WHERE "updated_at" > $1) AS "settings"`,
    from,
    Boolean(since)
  );

  const collections: Record<string, unknown[]> = {};
  for (const def of COLLECTIONS) {
    collections[def.key] = (row?.collections?.[def.key] || []).map((item) => ({ ...item.data, id: item.id, _v: item.version }));
  }
  return {
    serverTime: serverTime.toISOString(),
    full: !since,
    collections,
    deletions: row?.deletions || [],
    settings: row?.settings || {},
    activity: await readActivity()
  };
}

async function readActivity() {
  const rows = await prisma.$queryRaw<{ id: bigint; at: Date; actor_name: string | null; action: string; collection: string | null; title: string | null }[]>`
    SELECT "id", "at", "actor_name", "action", "collection", "title" FROM "audit_log" ORDER BY "at" DESC LIMIT ${AUDIT_LIMIT}
  `;
  return rows.map((row) => {
    const label = row.collection ? COLLECTION_BY_KEY.get(row.collection)?.label || row.collection : "Configuración";
    const verb = row.action === "create" ? "creó" : row.action === "update" ? "editó" : row.action === "delete" ? "eliminó" : row.action;
    return {
      id: String(row.id),
      title: `${label}: ${row.title || "sin nombre"}`,
      message: `${row.actor_name || "Alguien"} ${verb}`,
      createdAt: row.at.toISOString(),
      view: label
    };
  });
}

// `_v` is the record version the browser sends back on its next write.
function toRecord(_def: CollectionDef, row: Row): Record<string, unknown> {
  return { ...row.data, id: row.id, _v: row.version };
}

/* ---------- Write ---------- */

type UpsertOp = { collection: string; record: Record<string, unknown> };
type DeleteOp = { collection: string; id: string };

export async function applyBatch(actor: Actor, body: Record<string, unknown>) {
  await runMigrations();
  const upserts = Array.isArray(body.upserts) ? (body.upserts as UpsertOp[]) : [];
  const deletes = Array.isArray(body.deletes) ? (body.deletes as DeleteOp[]) : [];
  const settings = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : null;

  if (upserts.length + deletes.length > MAX_OPERATIONS) throw new DataError("Demasiados cambios juntos. Intenta de nuevo.");
  if ((upserts.length || settings) && !actor.canWrite) throw new DataError("Tu usuario es de solo lectura: no puede guardar cambios.", 403);
  if (deletes.length && !actor.canDelete) throw new DataError("Solo un admin puede eliminar registros.", 403);

  const results: unknown[] = [];
  const changed: { collection: string; record: unknown }[] = [];

  const order = (key: string) => COLLECTIONS.findIndex((def) => def.key === key);
  const sortedUpserts = [...upserts].sort((a, b) => order(a.collection) - order(b.collection));
  const sortedDeletes = [...deletes].sort((a, b) => order(b.collection) - order(a.collection));

  for (const op of sortedUpserts) results.push(await upsertOne(actor, op));
  for (const op of sortedDeletes) results.push(await deleteOne(actor, op, changed));
  if (settings) await saveSettings(actor, settings);

  return { serverTime: new Date().toISOString(), results, changed };
}

async function upsertOne(actor: Actor, op: UpsertOp) {
  const def = COLLECTION_BY_KEY.get(String(op.collection));
  const record = op.record;
  const id = typeof record?.id === "string" ? record.id : "";
  if (!def) return { collection: op.collection, id, status: "error", message: "Coleccion desconocida." };
  if (!record || typeof record !== "object" || Array.isArray(record) || !id || id.length > 100) {
    return { collection: def.key, id, status: "error", message: "Registro invalido." };
  }

  const { _v, ...data } = record;
  const json = JSON.stringify(data);
  if (json.length > MAX_RECORD_BYTES) {
    return { collection: def.key, id, status: "error", message: "El registro es demasiado grande (¿tiene una imagen pegada?)." };
  }
  const relationValues = def.relations.map((relation) => {
    const value = data[relation.field];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  });
  const base = Number.isInteger(_v) ? Number(_v) : null;

  try {
    let row: Row | undefined;
    if (base === null) {
      const columns = ["id", "data", ...def.relations.map((relation) => relation.column), "created_by", "updated_by"];
      const values = [id, json, ...relationValues, actor.id, actor.id];
      const placeholders = values.map((_, index) => (index === 1 ? `$${index + 1}::jsonb` : `$${index + 1}`));
      [row] = await prisma.$queryRawUnsafe<Row[]>(
        `INSERT INTO "${def.table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${placeholders.join(", ")})
         ON CONFLICT ("id") DO NOTHING RETURNING "id", "data", "version", "updated_at"`,
        ...values
      );
      if (row) {
        await prisma.$executeRaw`DELETE FROM "data_deletions" WHERE "collection" = ${def.key} AND "id" = ${id}`;
        await audit(actor, "create", def.key, id, data);
      }
    } else {
      const sets = ['"data" = $2::jsonb', ...def.relations.map((relation, index) => `"${relation.column}" = $${index + 3}`)];
      const next = def.relations.length + 3;
      [row] = await prisma.$queryRawUnsafe<Row[]>(
        `UPDATE "${def.table}" SET ${sets.join(", ")}, "version" = "version" + 1, "updated_at" = clock_timestamp(), "updated_by" = $${next}
         WHERE "id" = $1 AND "version" = $${next + 1} RETURNING "id", "data", "version", "updated_at"`,
        id, json, ...relationValues, actor.id, base
      );
      if (row) await audit(actor, "update", def.key, id, data);
    }

    if (row) return { collection: def.key, id, status: "ok", record: toRecord(def, row) };

    // Not written: someone else changed or deleted it first.
    const [current] = await prisma.$queryRawUnsafe<Row[]>(`SELECT "id", "data", "version", "updated_at" FROM "${def.table}" WHERE "id" = $1`, id);
    return current
      ? { collection: def.key, id, status: "conflict", record: toRecord(def, current) }
      : { collection: def.key, id, status: "deleted" };
  } catch (error) {
    return { collection: def.key, id, status: "error", message: friendlyError(error, def) };
  }
}

async function deleteOne(actor: Actor, op: DeleteOp, changed: { collection: string; record: unknown }[]) {
  const def = COLLECTION_BY_KEY.get(String(op.collection));
  const id = String(op.id || "");
  if (!def || !id) return { collection: op.collection, id, status: "error", message: "Registro invalido." };

  try {
    return await prisma.$transaction(async (tx) => {
      // Optional links (project, invoice) are cleared on the records that point here, so those
      // records survive as "General" instead of blocking the delete. Clients are required: blocked.
      if (def.key === "projects" || def.key === "invoices") {
        for (const { def: child, relation } of dependents(def.key)) {
          const rows = await tx.$queryRawUnsafe<Row[]>(
            `UPDATE "${child.table}" SET "${relation.column}" = NULL, "data" = jsonb_set("data", '{${relation.field}}', '""'),
               "version" = "version" + 1, "updated_at" = clock_timestamp(), "updated_by" = $2
             WHERE "${relation.column}" = $1 RETURNING "id", "data", "version", "updated_at"`,
            id, actor.id
          );
          rows.forEach((row) => changed.push({ collection: child.key, record: toRecord(child, row) }));
        }
      }
      const [row] = await tx.$queryRawUnsafe<Row[]>(`DELETE FROM "${def.table}" WHERE "id" = $1 RETURNING "id", "data", "version", "updated_at"`, id);
      await tx.$executeRaw`
        INSERT INTO "data_deletions" ("collection", "id", "deleted_by") VALUES (${def.key}, ${id}, ${actor.id})
        ON CONFLICT ("collection", "id") DO UPDATE SET "deleted_at" = clock_timestamp(), "deleted_by" = EXCLUDED."deleted_by"
      `;
      if (row) await auditWith(tx, actor, "delete", def.key, id, row.data);
      return { collection: def.key, id, status: "ok" };
    });
  } catch (error) {
    if (isForeignKeyError(error) && def.key === "clients") {
      return { collection: def.key, id, status: "error", message: await blockedClientMessage(id) };
    }
    return { collection: def.key, id, status: "error", message: friendlyError(error, def) };
  }
}

async function blockedClientMessage(clientId: string) {
  const parts: string[] = [];
  for (const { def } of dependents("clients")) {
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*) AS count FROM "${def.table}" WHERE "client_id" = $1`, clientId);
    if (Number(count)) parts.push(`${Number(count)} ${def.label.toLowerCase()}${Number(count) === 1 ? "" : "s"}`);
  }
  return `No se puede eliminar el cliente: tiene ${parts.join(", ") || "registros asociados"}. Eliminalos o reasignalos primero.`;
}

async function saveSettings(actor: Actor, settings: Record<string, unknown>) {
  for (const key of SETTINGS_KEYS) {
    if (!(key in settings)) continue;
    let value = settings[key];
    if (key === "exchangeRate") {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) throw new DataError("La cotizacion debe ser un numero mayor a cero.");
      value = rate;
    } else if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DataError("Configuracion invalida.");
    }
    await prisma.$executeRaw`
      INSERT INTO "app_settings" ("key", "value", "updated_by") VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actor.id})
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = clock_timestamp(), "updated_by" = EXCLUDED."updated_by"
    `;
  }
  await audit(actor, "update", null, null, { name: "keys" in settings ? "" : Object.keys(settings).map((key) => (key === "exchangeRate" ? "cotización del dólar" : "datos de la empresa")).join(" y ") });
}

export async function clearActivity(actor: Actor) {
  if (!actor.isAdmin) throw new DataError("Solo un admin puede limpiar el historial.", 403);
  await runMigrations();
  await prisma.$executeRaw`DELETE FROM "audit_log"`;
  await audit(actor, "limpió el historial", null, null, { name: "historial de cambios" });
}

/* ---------- Helpers ---------- */

function recordTitle(data: Record<string, unknown>) {
  const value = data.company || data.name || data.title || data.projectName || data.number || data.description || data.category || "";
  return String(value).slice(0, 120);
}

async function audit(actor: Actor, action: string, collection: string | null, id: string | null, data: Record<string, unknown>) {
  await auditWith(prisma, actor, action, collection, id, data);
}

async function auditWith(client: Prisma.TransactionClient | typeof prisma, actor: Actor, action: string, collection: string | null, id: string | null, data: Record<string, unknown>) {
  await client.$executeRaw`
    INSERT INTO "audit_log" ("actor_id", "actor_name", "action", "collection", "record_id", "title")
    VALUES (${actor.id}, ${actor.name}, ${action}, ${collection}, ${id}, ${recordTitle(data)})
  `;
}

function pgCode(error: unknown) {
  const meta = (error as { meta?: { code?: string } })?.meta;
  return meta?.code || String((error as { message?: string })?.message || "").match(/SQLSTATE (\w+)|code: "(\w+)"/)?.slice(1).find(Boolean) || "";
}

function isForeignKeyError(error: unknown) {
  return pgCode(error) === "23503" || /foreign key/i.test(String((error as Error)?.message));
}

function friendlyError(error: unknown, def: CollectionDef) {
  if (isForeignKeyError(error)) {
    const names = def.relations.map((relation) => COLLECTION_BY_KEY.get(relation.references)?.label.toLowerCase()).filter(Boolean);
    return `El ${names.join(" / ") || "registro"} asociado no existe (puede haber sido eliminado).`;
  }
  console.error(error);
  return "No se pudo guardar este registro.";
}
