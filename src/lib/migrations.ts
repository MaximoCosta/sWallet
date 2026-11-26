// Database schema, applied in order and recorded in "AppMigration" so each step runs exactly once.
// The server connects as the table owner; RLS is enabled on every table with no policies, so
// Supabase's public Data API (anon/authenticated keys) cannot read or write any of it.
import { prisma } from "@/lib/prisma";
import { COLLECTIONS } from "@/lib/collections";

function collectionTables() {
  return COLLECTIONS.map((def) => {
    const relationColumns = def.relations
      .map((relation) => `"${relation.column}" TEXT REFERENCES "${relation.references}"("id") ON DELETE RESTRICT`)
      .join(",\n  ");
    return [
      `CREATE TABLE "${def.table}" (
  "id" TEXT PRIMARY KEY CHECK (length("id") BETWEEN 1 AND 100),
  ${relationColumns ? `${relationColumns},\n  ` : ""}"data" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "created_by" TEXT,
  "updated_by" TEXT
)`,
      `CREATE INDEX "${def.table}_updated_at_idx" ON "${def.table}" ("updated_at")`,
      ...def.relations.map((relation) => `CREATE INDEX "${def.table}_${relation.column}_idx" ON "${def.table}" ("${relation.column}")`),
      `ALTER TABLE "${def.table}" ENABLE ROW LEVEL SECURITY`
    ];
  }).flat();
}

const MIGRATIONS: { id: string; statements: () => string[] }[] = [
  {
    // Login moved to Supabase Auth: old in-app accounts and tasks were cleared.
    id: "2026-11-supabase-auth",
    statements: () => [
      `DROP TABLE IF EXISTS "AppLoginUser"`,
      `DO $$ BEGIN
         IF to_regclass('"AppTaskEvent"') IS NOT NULL THEN DELETE FROM "AppTaskEvent"; END IF;
         IF to_regclass('"AppTask"') IS NOT NULL THEN DELETE FROM "AppTask"; END IF;
       END $$`
    ]
  },
  {
    // Start over with one table per entity instead of a single shared JSON document.
    // Agreed with the owners: existing data is discarded, not migrated.
    id: "2026-11-relational-schema",
    statements: () => [
      `DROP TABLE IF EXISTS "AppSnapshot", "AppTaskEvent", "AppTask", "AppLoginUser" CASCADE`,
      ...collectionTables(),
      `CREATE TABLE "data_deletions" (
  "collection" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "deleted_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "deleted_by" TEXT,
  PRIMARY KEY ("collection", "id")
)`,
      `CREATE INDEX "data_deletions_deleted_at_idx" ON "data_deletions" ("deleted_at")`,
      `CREATE TABLE "app_settings" (
  "key" TEXT PRIMARY KEY,
  "value" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updated_by" TEXT
)`,
      `CREATE TABLE "audit_log" (
  "id" BIGSERIAL PRIMARY KEY,
  "at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "actor_id" TEXT,
  "actor_name" TEXT,
  "action" TEXT NOT NULL,
  "collection" TEXT,
  "record_id" TEXT,
  "title" TEXT
)`,
      `CREATE INDEX "audit_log_at_idx" ON "audit_log" ("at" DESC)`,
      `CREATE TABLE "assigned_tasks" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "assignee" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'media' CHECK ("priority" IN ('baja', 'media', 'alta', 'urgente')),
  "status" TEXT NOT NULL DEFAULT 'asignada' CHECK ("status" IN ('asignada', 'en_proceso', 'completada')),
  "dueDate" DATE,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3)
)`,
      `CREATE INDEX "assigned_tasks_assignee_idx" ON "assigned_tasks" ("assignee")`,
      `CREATE TABLE "assigned_task_events" (
  "id" TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES "assigned_tasks"("id") ON DELETE CASCADE,
  "author" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "body" TEXT,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
      `CREATE INDEX "assigned_task_events_task_idx" ON "assigned_task_events" ("taskId")`,
      ...["data_deletions", "app_settings", "audit_log", "assigned_tasks", "assigned_task_events", "AppMigration"]
        .map((table) => `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
    ]
  }
];

let done: Promise<void> | null = null;

export function runMigrations() {
  if (!done) {
    done = apply().catch((error) => {
      done = null;
      throw error;
    });
  }
  return done;
}

async function apply() {
  // Fast path (every cold start): one query tells whether anything is pending.
  const [state] = await prisma.$queryRaw<{ ready: boolean; applied: string[] | null }[]>`
    SELECT to_regclass('"AppMigration"') IS NOT NULL AS "ready",
           (SELECT array_agg("id") FROM "AppMigration" WHERE to_regclass('"AppMigration"') IS NOT NULL) AS "applied"
  `.catch(() => [{ ready: false, applied: null }]);
  if (state?.ready && MIGRATIONS.every((migration) => state.applied?.includes(migration.id))) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppMigration" (
      "id" TEXT PRIMARY KEY,
      "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  for (const migration of MIGRATIONS) {
    await prisma.$transaction(async (tx) => {
      // The insert doubles as a lock: a concurrent instance waits here, then sees the row and skips.
      const inserted = await tx.$executeRaw`
        INSERT INTO "AppMigration" ("id") VALUES (${migration.id}) ON CONFLICT ("id") DO NOTHING
      `;
      if (!inserted) return;
      for (const statement of migration.statements()) await tx.$executeRawUnsafe(statement);
    }, { timeout: 30000 });
  }
}
