// Assigned tasks: task managers (TASK_MANAGER_USERS, Maxi by default) create tasks for the team;
// every other user only sees the tasks assigned to them and moves them between statuses.
// People are Supabase Auth accounts: assignee, createdBy and event authors hold the account id.
// Tables come from src/lib/migrations.ts.
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { listAccounts } from "@/lib/supabase-auth";
import { runMigrations } from "@/lib/migrations";
import { createUploadUrl, fileExists, MAX_TASK_FILE_BYTES, removeFiles, safeFileName, signedLinks } from "@/lib/task-files";

export const TASK_STATUSES = ["asignada", "en_proceso", "completada"] as const;
export const TASK_PRIORITIES = ["baja", "media", "alta", "urgente"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type Actor = { id: string; email: string; name: string; isManager: boolean };

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  assignee: string;
  priority: string;
  status: string;
  dueDate: Date | string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  commentCount?: number | bigint;
  attachmentCount?: number | bigint;
};

type EventRow = {
  id: string;
  taskId: string;
  author: string;
  authorName: string;
  kind: string;
  body: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: Date;
};

export class TaskError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function ensureTaskTables() {
  await runMigrations();
}

/** People a task can be assigned to: every active Supabase account. */
export async function listAssignees() {
  const accounts = await listAccounts();
  return accounts
    .filter((account) => account.status === "activo")
    .map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      isManager: account.isTaskManager
    }));
}

export async function listTasks(actor: Actor) {
  await ensureTaskTables();
  const rows = actor.isManager
    ? await prisma.$queryRaw<TaskRow[]>`
        SELECT t.*, (SELECT COUNT(*) FROM "assigned_task_events" e WHERE e."taskId" = t."id" AND e."kind" = 'comment') AS "commentCount",
               (SELECT COUNT(*) FROM "assigned_task_attachments" a WHERE a."taskId" = t."id") AS "attachmentCount"
        FROM "assigned_tasks" t ORDER BY t."createdAt" DESC`
    : await prisma.$queryRaw<TaskRow[]>`
        SELECT t.*, (SELECT COUNT(*) FROM "assigned_task_events" e WHERE e."taskId" = t."id" AND e."kind" = 'comment') AS "commentCount",
               (SELECT COUNT(*) FROM "assigned_task_attachments" a WHERE a."taskId" = t."id") AS "attachmentCount"
        FROM "assigned_tasks" t WHERE t."assignee" = ${actor.id} ORDER BY t."createdAt" DESC`;
  const names = await accountNames();
  return rows.map((row) => toPublicTask(row, names));
}

// account id -> display name, so members (who do not get the assignee list) still see names.
async function accountNames() {
  const accounts = await listAccounts();
  return new Map(accounts.map((account) => [account.id, account.name || account.email]));
}

export async function getTaskWithEvents(actor: Actor, id: string) {
  const task = await getVisibleTask(actor, id);
  const events = await prisma.$queryRaw<EventRow[]>`
    SELECT * FROM "assigned_task_events" WHERE "taskId" = ${id} ORDER BY "createdAt" ASC
  `;
  return { task: toPublicTask(task, await accountNames()), events: events.map(toPublicEvent), attachments: await listAttachments(actor, id) };
}

/* ---------- Attachments ---------- */

const MAX_ATTACHMENTS = 40;

type AttachmentRow = {
  id: string;
  kind: "file" | "link";
  name: string;
  url: string | null;
  storagePath: string | null;
  mimeType: string | null;
  size: bigint | number | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
};

async function listAttachments(actor: Actor, taskId: string) {
  const rows = await prisma.$queryRaw<AttachmentRow[]>`
    SELECT * FROM "assigned_task_attachments" WHERE "taskId" = ${taskId} ORDER BY "createdAt" ASC
  `;
  const links = await signedLinks(rows.filter((row) => row.storagePath).map((row) => row.storagePath as string)).catch(() => new Map<string, string>());
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.kind === "link" ? row.url : links.get(row.storagePath || "") || null,
    mimeType: row.mimeType || "",
    isImage: row.kind === "file" && /^image\//.test(row.mimeType || ""),
    size: row.size === null ? null : Number(row.size),
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByName,
    createdAt: iso(row.createdAt),
    canDelete: actor.isManager || row.uploadedBy === actor.id
  }));
}

async function attachmentCount(taskId: string) {
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM "assigned_task_attachments" WHERE "taskId" = ${taskId}`;
  return Number(count);
}

/** Step 1 of a file upload: permission + limits, then a one-time upload URL for the browser. */
export async function prepareAttachmentUpload(actor: Actor, taskId: string, input: Record<string, unknown>) {
  await getVisibleTask(actor, taskId);
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) throw new TaskError("El archivo está vacío.");
  if (size > MAX_TASK_FILE_BYTES) throw new TaskError("El archivo supera los 25 MB.");
  if ((await attachmentCount(taskId)) >= MAX_ATTACHMENTS) throw new TaskError(`Una tarea puede tener hasta ${MAX_ATTACHMENTS} adjuntos.`);
  const path = `${taskId}/${randomUUID()}-${safeFileName(String(input.name || "archivo"))}`;
  const upload = await createUploadUrl(path);
  return { path, maxBytes: MAX_TASK_FILE_BYTES, ...upload };
}

/** Step 2 (files) or the only step (links): register the attachment. */
export async function addAttachment(actor: Actor, taskId: string, input: Record<string, unknown>) {
  await getVisibleTask(actor, taskId);
  if ((await attachmentCount(taskId)) >= MAX_ATTACHMENTS) throw new TaskError(`Una tarea puede tener hasta ${MAX_ATTACHMENTS} adjuntos.`);
  const id = randomUUID();
  let name: string;

  if (input.kind === "link") {
    const url = cleanLink(input.url);
    name = String(input.name || input.title || "").trim().slice(0, 160) || new URL(url).hostname.replace(/^www\./, "");
    await prisma.$executeRaw`
      INSERT INTO "assigned_task_attachments" ("id", "taskId", "kind", "name", "url", "uploadedBy", "uploadedByName")
      VALUES (${id}, ${taskId}, 'link', ${name}, ${url}, ${actor.id}, ${actor.name || actor.email})
    `;
  } else {
    const path = String(input.path || "");
    if (!path.startsWith(`${taskId}/`) || path.includes("..")) throw new TaskError("Archivo inválido.");
    if (!(await fileExists(path))) throw new TaskError("El archivo no terminó de subirse. Probá de nuevo.");
    name = String(input.name || "archivo").trim().slice(0, 160) || "archivo";
    const size = Math.min(Number(input.size) || 0, MAX_TASK_FILE_BYTES);
    const mimeType = String(input.mimeType || input.type || "application/octet-stream").slice(0, 120);
    await prisma.$executeRaw`
      INSERT INTO "assigned_task_attachments" ("id", "taskId", "kind", "name", "storagePath", "mimeType", "size", "uploadedBy", "uploadedByName")
      VALUES (${id}, ${taskId}, 'file', ${name}, ${path}, ${mimeType}, ${size}, ${actor.id}, ${actor.name || actor.email})
    `;
  }
  await addEvent(taskId, actor, "attachment", name, null, null);
  await prisma.$executeRaw`UPDATE "assigned_tasks" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${taskId}`;
  return getTaskWithEvents(actor, taskId);
}

export async function removeAttachment(actor: Actor, taskId: string, attachmentId: string) {
  await getVisibleTask(actor, taskId);
  const [row] = await prisma.$queryRaw<AttachmentRow[]>`
    SELECT * FROM "assigned_task_attachments" WHERE "id" = ${attachmentId} AND "taskId" = ${taskId} LIMIT 1
  `;
  if (!row) throw new TaskError("Adjunto no encontrado.", 404);
  if (!actor.isManager && row.uploadedBy !== actor.id) throw new TaskError("Solo quien lo subió (o Maxi) puede quitar este adjunto.", 403);
  await prisma.$executeRaw`DELETE FROM "assigned_task_attachments" WHERE "id" = ${attachmentId}`;
  if (row.storagePath) await removeFiles([row.storagePath]);
  await addEvent(taskId, actor, "attachment_removed", row.name, null, null);
  return getTaskWithEvents(actor, taskId);
}

function cleanLink(value: unknown) {
  let text = String(value ?? "").trim();
  if (text && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString().slice(0, 2000);
  } catch {
    throw new TaskError("El link no es válido.");
  }
}

export async function createTask(actor: Actor, input: Record<string, unknown>) {
  assertManager(actor);
  await ensureTaskTables();
  const title = cleanTitle(input.title);
  const assignee = await cleanAssignee(input.assignee);
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "assigned_tasks" ("id", "title", "description", "assignee", "priority", "status", "dueDate", "createdBy")
    VALUES (${id}, ${title}, ${cleanDescription(input.description)}, ${assignee}, ${cleanPriority(input.priority)},
            'asignada', ${cleanDueDate(input.dueDate)}::date, ${actor.id})
  `;
  await addEvent(id, actor, "created", null, null, "asignada");
  return getTaskWithEvents(actor, id);
}

export async function updateTask(actor: Actor, id: string, input: Record<string, unknown>) {
  const current = await getVisibleTask(actor, id);
  const manager = actor.isManager;

  if (!manager) {
    const editsOtherFields = ["title", "description", "assignee", "priority", "dueDate"].some((key) => input[key] !== undefined);
    if (editsOtherFields) throw new TaskError("Solo quien asigna las tareas puede editarlas. Vos podés cambiar el estado.", 403);
  }

  const status = input.status === undefined ? (current.status as TaskStatus) : cleanStatus(input.status);
  const statusChanged = status !== current.status;
  const changes: string[] = [];

  let title = current.title;
  let description = current.description;
  let assignee = current.assignee;
  let priority = current.priority;
  let dueDate = dateOnly(current.dueDate);

  if (manager) {
    if (input.title !== undefined && cleanTitle(input.title) !== current.title) {
      title = cleanTitle(input.title);
      changes.push("título");
    }
    if (input.description !== undefined && cleanDescription(input.description) !== (current.description ?? null)) {
      description = cleanDescription(input.description);
      changes.push("descripción");
    }
    if (input.priority !== undefined && cleanPriority(input.priority) !== current.priority) {
      priority = cleanPriority(input.priority);
      changes.push("prioridad");
    }
    if (input.dueDate !== undefined && cleanDueDate(input.dueDate) !== dueDate) {
      dueDate = cleanDueDate(input.dueDate);
      changes.push("fecha límite");
    }
    if (input.assignee !== undefined) {
      const next = await cleanAssignee(input.assignee);
      if (next !== current.assignee) {
        assignee = next;
        changes.push("responsable");
      }
    }
  }

  if (!statusChanged && !changes.length) return getTaskWithEvents(actor, id);

  // Timestamps follow the status: startedAt is kept once set, completedAt only while completed.
  await prisma.$executeRaw`
    UPDATE "assigned_tasks" SET
      "title" = ${title}, "description" = ${description}, "assignee" = ${assignee}, "priority" = ${priority},
      "dueDate" = ${dueDate}::date, "status" = ${status}, "updatedAt" = CURRENT_TIMESTAMP,
      "startedAt" = CASE WHEN ${status}::text <> 'asignada' THEN COALESCE("startedAt", CURRENT_TIMESTAMP) ELSE "startedAt" END,
      "completedAt" = CASE WHEN ${status}::text = 'completada' THEN COALESCE("completedAt", CURRENT_TIMESTAMP) ELSE NULL END
    WHERE "id" = ${id}
  `;
  if (statusChanged) await addEvent(id, actor, "status", null, current.status, status);
  if (changes.length) {
    const names = await accountNames();
    const reassigned = changes.includes("responsable") ? ` Nuevo responsable: ${names.get(assignee) ?? "otra persona"}.` : "";
    await addEvent(id, actor, "edited", `Cambió ${changes.join(", ")}.${reassigned}`, null, null);
  }
  return getTaskWithEvents(actor, id);
}

export async function deleteTask(actor: Actor, id: string) {
  assertManager(actor);
  await getVisibleTask(actor, id);
  const files = await prisma.$queryRaw<{ storagePath: string }[]>`
    SELECT "storagePath" FROM "assigned_task_attachments" WHERE "taskId" = ${id} AND "storagePath" IS NOT NULL
  `;
  await prisma.$executeRaw`DELETE FROM "assigned_tasks" WHERE "id" = ${id}`;
  await removeFiles(files.map((file) => file.storagePath));
}

export async function addComment(actor: Actor, id: string, input: Record<string, unknown>) {
  await getVisibleTask(actor, id);
  const body = String(input.body ?? "").trim().slice(0, 2000);
  if (!body) throw new TaskError("Escribí un comentario.");
  await addEvent(id, actor, "comment", body, null, null);
  await prisma.$executeRaw`UPDATE "assigned_tasks" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`;
  return getTaskWithEvents(actor, id);
}

async function getVisibleTask(actor: Actor, id: string) {
  await ensureTaskTables();
  const rows = await prisma.$queryRaw<TaskRow[]>`SELECT * FROM "assigned_tasks" WHERE "id" = ${id} LIMIT 1`;
  const task = rows[0];
  const visible = task && (actor.isManager || task.assignee === actor.id);
  if (!visible) throw new TaskError("Tarea no encontrada.", 404);
  return task;
}

async function addEvent(taskId: string, actor: Actor, kind: string, body: string | null, fromStatus: string | null, toStatus: string | null) {
  await prisma.$executeRaw`
    INSERT INTO "assigned_task_events" ("id", "taskId", "author", "authorName", "kind", "body", "fromStatus", "toStatus")
    VALUES (${randomUUID()}, ${taskId}, ${actor.id}, ${actor.name || actor.email}, ${kind}, ${body}, ${fromStatus}, ${toStatus})
  `;
}

function assertManager(actor: Actor) {
  if (!actor.isManager) throw new TaskError("Solo Maxi puede crear, editar o eliminar tareas.", 403);
}

async function cleanAssignee(value: unknown) {
  const id = String(value ?? "").trim();
  if (!id) throw new TaskError("Elegí a quién se asigna la tarea.");
  const assignees = await listAssignees();
  if (!assignees.some((item) => item.id === id)) {
    throw new TaskError("El responsable elegido no existe o está inactivo.");
  }
  return id;
}

function cleanTitle(value: unknown) {
  const title = String(value ?? "").trim().slice(0, 160);
  if (title.length < 3) throw new TaskError("El título debe tener al menos 3 caracteres.");
  return title;
}

function cleanDescription(value: unknown) {
  return String(value ?? "").trim().slice(0, 4000) || null;
}

function cleanPriority(value: unknown): TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(String(value)) ? (value as TaskPriority) : "media";
}

function cleanStatus(value: unknown): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(String(value))) {
    throw new TaskError("Estado inválido. Usa asignada, en_proceso o completada.");
  }
  return value as TaskStatus;
}

function cleanDueDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) {
    throw new TaskError("Fecha límite inválida.");
  }
  return text;
}

function dateOnly(value: Date | string | null) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function iso(value: Date | null) {
  return value ? new Date(value).toISOString() : null;
}

function toPublicTask(row: TaskRow, names: Map<string, string> = new Map()) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    assignee: row.assignee,
    assigneeName: names.get(row.assignee) ?? row.assignee,
    priority: cleanPriority(row.priority),
    status: (TASK_STATUSES as readonly string[]).includes(row.status) ? (row.status as TaskStatus) : "asignada",
    dueDate: dateOnly(row.dueDate),
    createdBy: row.createdBy,
    createdByName: names.get(row.createdBy) ?? row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    commentCount: Number(row.commentCount ?? 0),
    attachmentCount: Number(row.attachmentCount ?? 0)
  };
}

function toPublicEvent(row: EventRow) {
  return {
    id: row.id,
    author: row.author,
    authorName: row.authorName,
    kind: row.kind,
    body: row.body ?? "",
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    createdAt: iso(row.createdAt)
  };
}
