// Users created from the app (Configuracion > Usuarios y roles), each with their own password.
// They live in their own table, created on demand like AppSnapshot, so no migration is needed in production.
// Users listed in ALLOWED_LOGIN_USERS keep working with the shared password and are always admins.
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { allowedLoginUsers, matchAllowedUsername } from "@/lib/login-credentials";

export const APP_USER_ROLES = ["admin", "finanzas", "solo_lectura"] as const;
export const APP_USER_STATUSES = ["activo", "inactivo"] as const;
export const APP_USER_MODULES = ["clients", "finance", "projects", "reports", "settings"] as const;
export const MIN_PASSWORD_LENGTH = 8;

export type AppUserRole = (typeof APP_USER_ROLES)[number];
export type AppUserStatus = (typeof APP_USER_STATUSES)[number];

type AppUserRow = {
  id: string;
  username: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  status: string;
  permissions: unknown;
  phone: string | null;
  area: string | null;
  notes: string | null;
  avatar: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicAppUser = {
  id: string;
  username: string;
  name: string;
  email: string;
  role: AppUserRole;
  status: AppUserStatus;
  permissions: string[];
  phone: string;
  area: string;
  notes: string;
  avatar: string;
  source: "database" | "env";
  createdAt: string | null;
};

export class AppUserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

let tableReady = false;

async function ensureAppUserTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppLoginUser" (
      "id" TEXT PRIMARY KEY,
      "username" TEXT NOT NULL UNIQUE,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'solo_lectura',
      "status" TEXT NOT NULL DEFAULT 'activo',
      "permissions" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "phone" TEXT,
      "area" TEXT,
      "notes" TEXT,
      "avatar" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  tableReady = true;
}

/** Role and permission list as the static app understands them (canWrite / canDelete). */
export function accessFor(role: AppUserRole) {
  if (role === "admin") return ["read", "write", "delete", "admin"];
  if (role === "finanzas") return ["read", "write"];
  return ["read"];
}

export function canWriteRole(role: AppUserRole) {
  return role === "admin" || role === "finanzas";
}

export async function findActiveUserByCredential(credential: string) {
  const normalized = credential.trim().toLowerCase();
  if (!normalized) return null;
  await ensureAppUserTable();
  const rows = await prisma.$queryRaw<AppUserRow[]>`
    SELECT * FROM "AppLoginUser"
    WHERE ("username" = ${normalized} OR "email" = ${normalized}) AND "status" = 'activo'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Hash used when the user does not exist, so a failed lookup costs the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("swallet-dummy-password", 10);

/** Returns the user when credential + password match an active database user. */
export async function verifyDatabaseLogin(credential: string, password: string) {
  const user = await findActiveUserByCredential(credential);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return user && ok ? user : null;
}

export async function listAppUsers(): Promise<PublicAppUser[]> {
  await ensureAppUserTable();
  const rows = await prisma.$queryRaw<AppUserRow[]>`
    SELECT * FROM "AppLoginUser" ORDER BY "createdAt" ASC
  `;
  const envUsers = allowedLoginUsers().map(envUserPayload);
  return [...envUsers, ...rows.map(toPublicUser)];
}

export async function createAppUser(input: Record<string, unknown>) {
  await ensureAppUserTable();
  const username = cleanUsername(input.username);
  const email = cleanEmail(input.email);
  const name = cleanText(input.name, 80) || username;
  const password = String(input.password ?? "");
  validatePassword(password);
  await assertIdentityAvailable(username, email);

  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const fields = profileFields(input);
  try {
    await prisma.$executeRaw`
      INSERT INTO "AppLoginUser"
        ("id", "username", "name", "email", "passwordHash", "role", "status", "permissions", "phone", "area", "notes", "avatar")
      VALUES
        (${id}, ${username}, ${name}, ${email}, ${passwordHash}, ${cleanRole(input.role)}, ${cleanStatus(input.status)},
         ${JSON.stringify(fields.permissions)}::jsonb, ${fields.phone}, ${fields.area}, ${fields.notes}, ${fields.avatar})
    `;
  } catch (error) {
    if (String((error as Error).message).includes("unique")) {
      throw new AppUserError("Ya existe un usuario con ese nombre de usuario o email.", 409);
    }
    throw error;
  }
  return getAppUser(id);
}

export async function updateAppUser(id: string, input: Record<string, unknown>) {
  const current = await getAppUserRow(id);
  const role = input.role === undefined ? (current.role as AppUserRole) : cleanRole(input.role);
  const status = input.status === undefined ? (current.status as AppUserStatus) : cleanStatus(input.status);
  const name = input.name === undefined ? current.name : cleanText(input.name, 80) || current.username;
  const fields = profileFields({
    permissions: input.permissions ?? current.permissions,
    phone: input.phone ?? current.phone,
    area: input.area ?? current.area,
    notes: input.notes ?? current.notes,
    avatar: input.avatar ?? current.avatar
  });
  let passwordHash = current.passwordHash;
  if (input.password !== undefined && input.password !== "") {
    const password = String(input.password);
    validatePassword(password);
    passwordHash = await bcrypt.hash(password, 10);
  }

  await prisma.$executeRaw`
    UPDATE "AppLoginUser" SET
      "name" = ${name}, "role" = ${role}, "status" = ${status}, "passwordHash" = ${passwordHash},
      "permissions" = ${JSON.stringify(fields.permissions)}::jsonb, "phone" = ${fields.phone}, "area" = ${fields.area},
      "notes" = ${fields.notes}, "avatar" = ${fields.avatar}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
  `;
  return getAppUser(id);
}

export async function deleteAppUser(id: string) {
  await getAppUserRow(id);
  await prisma.$executeRaw`DELETE FROM "AppLoginUser" WHERE "id" = ${id}`;
}

export async function changeOwnPassword(username: string, currentPassword: string, newPassword: string) {
  const user = await findActiveUserByCredential(username);
  if (!user) {
    throw new AppUserError("Tu usuario usa la contrasena compartida del servidor: se cambia en Vercel (ALLOWED_LOGIN_PASSWORD).", 400);
  }
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppUserError("La contrasena actual no es correcta.", 400);
  }
  validatePassword(newPassword);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.$executeRaw`
    UPDATE "AppLoginUser" SET "passwordHash" = ${passwordHash}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${user.id}
  `;
}

export function toPublicUser(row: AppUserRow): PublicAppUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    role: cleanRole(row.role),
    status: cleanStatus(row.status),
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
    phone: row.phone ?? "",
    area: row.area ?? "",
    notes: row.notes ?? "",
    avatar: row.avatar ?? "",
    source: "database",
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
  };
}

function envUserPayload(username: string): PublicAppUser {
  return {
    id: `env:${username.toLowerCase()}`,
    username,
    name: username,
    email: username.includes("@") ? username.toLowerCase() : "",
    role: "admin",
    status: "activo",
    permissions: [],
    phone: "",
    area: "",
    notes: "Definido en el servidor (ALLOWED_LOGIN_USERS). Usa la contrasena compartida.",
    avatar: "",
    source: "env",
    createdAt: null
  };
}

async function getAppUserRow(id: string) {
  await ensureAppUserTable();
  const rows = await prisma.$queryRaw<AppUserRow[]>`SELECT * FROM "AppLoginUser" WHERE "id" = ${id} LIMIT 1`;
  if (!rows[0]) {
    throw new AppUserError(
      id.startsWith("env:")
        ? "Este usuario esta definido en el servidor (ALLOWED_LOGIN_USERS) y no se puede editar desde la app."
        : "Usuario no encontrado.",
      id.startsWith("env:") ? 400 : 404
    );
  }
  return rows[0];
}

async function getAppUser(id: string) {
  return toPublicUser(await getAppUserRow(id));
}

async function assertIdentityAvailable(username: string, email: string) {
  if (matchAllowedUsername(username) || matchAllowedUsername(email)) {
    throw new AppUserError("Ese usuario ya existe en la configuracion del servidor.", 409);
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "AppLoginUser"
    WHERE "username" = ${username} OR "email" = ${email} OR "username" = ${email} OR "email" = ${username}
    LIMIT 1
  `;
  if (rows.length) throw new AppUserError("Ya existe un usuario con ese nombre de usuario o email.", 409);
}

function cleanUsername(value: unknown) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new AppUserError("El usuario debe tener 3 a 40 caracteres: letras, numeros, punto, guion o guion bajo.");
  }
  return username;
}

function cleanEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    throw new AppUserError("Ingresa un email valido.");
  }
  return email;
}

function cleanRole(value: unknown): AppUserRole {
  return (APP_USER_ROLES as readonly string[]).includes(String(value)) ? (value as AppUserRole) : "solo_lectura";
}

function cleanStatus(value: unknown): AppUserStatus {
  return value === "inactivo" ? "inactivo" : "activo";
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
    throw new AppUserError(`La contrasena debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

function profileFields(input: Record<string, unknown>) {
  const permissions = Array.isArray(input.permissions)
    ? input.permissions.map(String).filter((item) => (APP_USER_MODULES as readonly string[]).includes(item))
    : [];
  const avatar = cleanText(input.avatar, 500);
  return {
    permissions: [...new Set(permissions)],
    phone: cleanText(input.phone, 40) || null,
    area: cleanText(input.area, 80) || null,
    notes: cleanText(input.notes, 1000) || null,
    avatar: /^https?:\/\//i.test(avatar) ? avatar : null
  };
}
