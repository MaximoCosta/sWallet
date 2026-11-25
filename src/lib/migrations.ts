// One-time data changes, recorded in "AppMigration" so each one runs exactly once per database.
import { prisma } from "@/lib/prisma";

const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    // Login moved to Supabase Auth: the old in-app accounts go away, and the existing tasks
    // (assigned to the old usernames) are cleared, as agreed when switching.
    id: "2026-11-supabase-auth",
    statements: [
      `DROP TABLE IF EXISTS "AppLoginUser"`,
      `DO $$ BEGIN
         IF to_regclass('"AppTaskEvent"') IS NOT NULL THEN DELETE FROM "AppTaskEvent"; END IF;
         IF to_regclass('"AppTask"') IS NOT NULL THEN DELETE FROM "AppTask"; END IF;
       END $$`
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
      for (const statement of migration.statements) await tx.$executeRawUnsafe(statement);
    });
  }
}
