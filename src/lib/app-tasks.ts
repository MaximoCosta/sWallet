// Assigned tasks: task managers (TASK_MANAGER_USERS, Maxi by default) create tasks for the team;
// every other user only sees the tasks assigned to them and moves them between statuses.
// Tables are created on demand, like AppSnapshot and AppLoginUser.
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { listAppUsers } from "@/lib/app-users";

export const TASK_STATUSES = ["asignada", "en_proceso", "completada"] as const;
export const TASK_PRIORITIES = ["baja", "media", "alta", "urgente"] as const;
const DEFAULT_TASK_MANAGERS = ["MaxiTaxi", "maximonewp@gmail.com"];

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type Actor = { username: string; name: string };

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

export function taskManagers() {
  return (process.env.TASK_MANAGER_USERS || DEFAULT_TASK_MANAGERS.join(","))
    .split(",")
    .map((user) => user.trim().toLowerCase())
    .filter(Boolean);
}

export function isTaskManager(username: string) {
  return taskManagers().includes(username.trim().toLowerCase());
}

let tablesReady = false;

async function ensureTaskTables() {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppTask" (
      "id" TEXT PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT,
      "assignee" TEXT NOT NULL,
      "priority" TEXT NOT NULL DEFAULT 'media',
      "status" TEXT NOT NULL DEFAULT 'asignada',
      "dueDate" DATE,
      "createdBy" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "startedAt" TIMESTAMP(3),
      "completedAt" TIMESTAMP(3)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AppTask_assignee_idx" ON "AppTask" ("assignee")`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppTaskEvent" (
      "id" TEXT PRIMARY KEY,
      "taskId" TEXT NOT NULL REFERENCES "AppTask"("id") ON DELETE CASCADE,
      "author" TEXT NOT NULL,
      "authorName" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "body" TEXT,
      "fromStatus" TEXT,
      "toStatus" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AppTaskEvent_taskId_idx" ON "AppTaskEvent" ("taskId")`);
  tablesReady = true;
}

/** People a task can be assigned to: every active account, server-defined or created in the app. */
export async function listAssignees() {
  const users = await listAppUsers();
  return users
    .filter((user) => user.status === "activo")
    .map((user) => ({
      username: user.username.toLowerCase(),
      name: user.name,
      email: user.email,
      role: user.role,
      isManager: isTaskManager(user.username)
    }));
}

export async function listTasks(actor: Actor) {
  await ensureTaskTables();
  const manager = isTaskManager(actor.username);
  const me = actor.username.toLowerCase();
  const rows = manager
    ? await prisma.$queryRaw<TaskRow[]>`
        SELECT t.*, (SELECT COUNT(*) FROM "AppTaskEvent" e WHERE e."taskId" = t."id" AND e."kind" = 'comment') AS "commentCount"
        FROM "AppTask" t ORDER BY t."createdAt" DESC`
    : await prisma.$queryRaw<TaskRow[]>`
        SELECT t.*, (SELECT COUNT(*) FROM "AppTaskEvent" e WHERE e."taskId" = t."id" AND e."kind" = 'comment') AS "commentCount"
        FROM "AppTask" t WHERE t."assignee" = ${me} ORDER BY t."createdAt" DESC`;
  const names = await accountNames();
  return rows.map((row) => toPublicTask(row, names));
}

// username -> display name, so every viewer sees "Maxi" instead of "maxitaxi" (members do not get the assignee list).
async function accountNames() {
  const users = await listAppUsers();
  return new Map(users.map((user) => [user.username.toLowerCase(), user.name || user.username]));
}

export async function getTaskWithEvents(actor: Actor, id: string) {
  const task = await getVisibleTask(actor, id);
  const events = await prisma.$queryRaw<EventRow[]>`
    SELECT * FROM "AppTaskEvent" WHERE "taskId" = ${id} ORDER BY "createdAt" ASC
  `;
  return { task: toPublicTask(task, await accountNames()), events: events.map(toPublicEvent) };
}

export async function createTask(actor: Actor, input: Record<string, unknown>) {
  assertManager(actor);
  await ensureTaskTables();
  const title = cleanTitle(input.title);
  const assignee = await cleanAssignee(input.assignee);
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "AppTask" ("id", "title", "description", "assignee", "priority", "status", "dueDate", "createdBy")
    VALUES (${id}, ${title}, ${cleanDescription(input.description)}, ${assignee}, ${cleanPriority(input.priority)},
            'asignada', ${cleanDueDate(input.dueDate)}::date, ${actor.username.toLowerCase()})
  `;
  await addEvent(id, actor, "created", null, null, "asignada");
  return getTaskWithEvents(actor, id);
}

export async function updateTask(actor: Actor, id: string, input: Record<string, unknown>) {
  const current = await getVisibleTask(actor, id);
  const manager = isTaskManager(actor.username);

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
    UPDATE "AppTask" SET
      "title" = ${title}, "description" = ${description}, "assignee" = ${assignee}, "priority" = ${priority},
      "dueDate" = ${dueDate}::date, "status" = ${status}, "updatedAt" = CURRENT_TIMESTAMP,
      "startedAt" = CASE WHEN ${status}::text <> 'asignada' THEN COALESCE("startedAt", CURRENT_TIMESTAMP) ELSE "startedAt" END,
      "completedAt" = CASE WHEN ${status}::text = 'completada' THEN COALESCE("completedAt", CURRENT_TIMESTAMP) ELSE NULL END
    WHERE "id" = ${id}
  `;
  if (statusChanged) await addEvent(id, actor, "status", null, current.status, status);
  if (changes.length) {
    const reassigned = changes.includes("responsable") ? ` Nuevo responsable: @${assignee}.` : "";
    await addEvent(id, actor, "edited", `Cambió ${changes.join(", ")}.${reassigned}`, null, null);
  }
  return getTaskWithEvents(actor, id);
}

export async function deleteTask(actor: Actor, id: string) {
  assertManager(actor);
  await getVisibleTask(actor, id);
  await prisma.$executeRaw`DELETE FROM "AppTask" WHERE "id" = ${id}`;
}

export async function addComment(actor: Actor, id: string, input: Record<string, unknown>) {
  await getVisibleTask(actor, id);
  const body = String(input.body ?? "").trim().slice(0, 2000);
  if (!body) throw new TaskError("Escribí un comentario.");
  await addEvent(id, actor, "comment", body, null, null);
  await prisma.$executeRaw`UPDATE "AppTask" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`;
  return getTaskWithEvents(actor, id);
}

async function getVisibleTask(actor: Actor, id: string) {
  await ensureTaskTables();
  const rows = await prisma.$queryRaw<TaskRow[]>`SELECT * FROM "AppTask" WHERE "id" = ${id} LIMIT 1`;
  const task = rows[0];
  const visible = task && (isTaskManager(actor.username) || task.assignee === actor.username.toLowerCase());
  if (!visible) throw new TaskError("Tarea no encontrada.", 404);
  return task;
}

async function addEvent(taskId: string, actor: Actor, kind: string, body: string | null, fromStatus: string | null, toStatus: string | null) {
  await prisma.$executeRaw`
    INSERT INTO "AppTaskEvent" ("id", "taskId", "author", "authorName", "kind", "body", "fromStatus", "toStatus")
    VALUES (${randomUUID()}, ${taskId}, ${actor.username.toLowerCase()}, ${actor.name || actor.username}, ${kind}, ${body}, ${fromStatus}, ${toStatus})
  `;
}

function assertManager(actor: Actor) {
  if (!isTaskManager(actor.username)) throw new TaskError("Solo Maxi puede crear, editar o eliminar tareas.", 403);
}

async function cleanAssignee(value: unknown) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!username) throw new TaskError("Elegí a quién se asigna la tarea.");
  const assignees = await listAssignees();
  if (!assignees.some((item) => item.username === username)) {
    throw new TaskError("El responsable elegido no existe o está inactivo.");
  }
  return username;
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
    commentCount: Number(row.commentCount ?? 0)
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
