// Supabase Auth (GoTrue) over its REST API. Only fetch is used, so this also runs in the Edge middleware.
//
// Accounts live in Supabase (Authentication > Users). App data per account:
//   app_metadata  (only the service key can write it): role, status, modules
//   user_metadata: name, phone, area, notes, avatar
// Emails in TASK_MANAGER_USERS (maximonewp@gmail.com by default) are always admin and the only ones who assign tasks.

export const APP_ROLES = ["admin", "finanzas", "solo_lectura"] as const;
export const APP_STATUSES = ["activo", "inactivo"] as const;
export const APP_MODULES = ["clients", "finance", "projects", "reports", "settings"] as const;
export const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_TASK_MANAGERS = ["maximonewp@gmail.com"];
const BAN_FOREVER = "876000h";

export type AppRole = (typeof APP_ROLES)[number];
export type AppStatus = (typeof APP_STATUSES)[number];

export type AppAccount = {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  status: AppStatus;
  modules: string[];
  phone: string;
  area: string;
  notes: string;
  avatar: string;
  isTaskManager: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
};

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

type GoTrueUser = {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  banned_until?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
};

type GoTrueSession = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  user: GoTrueUser;
};

/** Missing configuration: the API answers 503 instead of failing open. */
export class AuthConfigError extends Error {}

/** A failure the user should see (bad input, duplicate email...). */
export class AccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/* ---------- Configuration ---------- */

function config() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) {
    throw new AuthConfigError("Faltan SUPABASE_URL y SUPABASE_ANON_KEY: el login esta deshabilitado.");
  }
  return { url, anonKey };
}

function serviceKey() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!key) throw new AuthConfigError("Falta SUPABASE_SERVICE_ROLE_KEY: no se pueden administrar usuarios.");
  return key;
}

// Legacy keys are JWTs and go in Authorization too; the new sb_publishable_/sb_secret_ keys only go in apikey.
function keyHeaders(key: string, bearer?: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function taskManagerEmails() {
  return (process.env.TASK_MANAGER_USERS || DEFAULT_TASK_MANAGERS.join(","))
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isTaskManagerEmail(email: string) {
  return taskManagerEmails().includes(email.trim().toLowerCase());
}

/* ---------- HTTP ---------- */

async function gotrue<T>(path: string, init: { method?: string; headers: Record<string, string>; body?: unknown }): Promise<{ ok: boolean; status: number; data: T & { msg?: string; message?: string; error_description?: string; error?: string; error_code?: string; code?: string | number } }> {
  const { url } = config();
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1${path}`, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store"
    });
  } catch {
    throw new AccountError("No se pudo conectar con Supabase Auth. Revisa que el proyecto este activo.", 503);
  }
  let data: unknown = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { ok: response.ok, status: response.status, data: data as never };
}

function goTrueMessage(data: { msg?: string; message?: string; error_description?: string; error?: string }) {
  return String(data.msg || data.message || data.error_description || data.error || "");
}

/* ---------- Sessions ---------- */

function toTokens(session: GoTrueSession): AuthTokens {
  const expiresAtSeconds = session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

/** Email + password login. Returns null for wrong credentials, banned or inactive accounts. */
export async function signInWithPassword(email: string, password: string) {
  const { anonKey } = config();
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) return null;
  const result = await gotrue<GoTrueSession>("/token?grant_type=password", {
    method: "POST",
    headers: keyHeaders(anonKey),
    body: { email: normalized, password }
  });
  if (!result.ok) {
    if (result.status >= 500) throw new AccountError("Supabase Auth no respondio. Intenta de nuevo en unos minutos.", 503);
    return null;
  }
  const account = toAccount(result.data.user);
  if (account.status !== "activo") return null;
  rememberToken(result.data.access_token, account);
  return { account, tokens: toTokens(result.data) };
}

export async function refreshSession(refreshToken: string) {
  const { anonKey } = config();
  if (!refreshToken) return null;
  const result = await gotrue<GoTrueSession>("/token?grant_type=refresh_token", {
    method: "POST",
    headers: keyHeaders(anonKey),
    body: { refresh_token: refreshToken }
  });
  if (!result.ok) return null;
  const account = toAccount(result.data.user);
  if (account.status !== "activo") return null;
  rememberToken(result.data.access_token, account);
  return { account, tokens: toTokens(result.data) };
}

export async function signOut(accessToken: string) {
  const { anonKey } = config();
  tokenCache.delete(accessToken);
  await gotrue("/logout", { method: "POST", headers: keyHeaders(anonKey, accessToken) }).catch(() => null);
}

// Short cache so every API call does not ask Supabase who the token belongs to.
const TOKEN_CACHE_MS = 30_000;
const tokenCache = new Map<string, { account: AppAccount; until: number }>();

function rememberToken(token: string, account: AppAccount) {
  tokenCache.set(token, { account, until: Date.now() + TOKEN_CACHE_MS });
  if (tokenCache.size > 2000) {
    const now = Date.now();
    for (const [key, value] of tokenCache) if (value.until < now) tokenCache.delete(key);
  }
}

/** Account for a Supabase access token, or null when it is invalid, expired, banned or inactive. */
export async function accountFromToken(accessToken: string) {
  if (!accessToken) return null;
  const cached = tokenCache.get(accessToken);
  if (cached && cached.until > Date.now()) return cached.account;
  const { anonKey } = config();
  const result = await gotrue<GoTrueUser>("/user", { headers: keyHeaders(anonKey, accessToken) });
  if (!result.ok) {
    tokenCache.delete(accessToken);
    if (result.status >= 500) throw new AccountError("Supabase Auth no respondio. Intenta de nuevo en unos minutos.", 503);
    return null;
  }
  const account = toAccount(result.data);
  if (account.status !== "activo") return null;
  rememberToken(accessToken, account);
  return account;
}

export async function changePassword(account: AppAccount, currentPassword: string, newPassword: string) {
  const check = await signInWithPassword(account.email, currentPassword);
  if (!check) throw new AccountError("La contraseña actual no es correcta.");
  validatePassword(newPassword);
  await adminUpdate(account.id, { password: newPassword });
}

/* ---------- Admin (service key) ---------- */

let listCache: { accounts: AppAccount[]; until: number } | null = null;

export async function listAccounts({ fresh = false } = {}) {
  if (!fresh && listCache && listCache.until > Date.now()) return listCache.accounts;
  const key = serviceKey();
  const accounts: AppAccount[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await gotrue<{ users: GoTrueUser[] }>(`/admin/users?page=${page}&per_page=100`, { headers: keyHeaders(key) });
    if (!result.ok) throw adminError(result.status, result.data);
    const users = result.data.users || [];
    accounts.push(...users.map(toAccount));
    if (users.length < 100) break;
  }
  accounts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  listCache = { accounts, until: Date.now() + 30_000 };
  return accounts;
}

export async function createAccount(input: Record<string, unknown>) {
  const email = cleanEmail(input.email);
  const password = String(input.password ?? "");
  validatePassword(password);
  const role = isTaskManagerEmail(email) ? "admin" : cleanRole(input.role);
  const status = cleanStatus(input.status);
  const profile = profileFields(input);
  const result = await gotrue<GoTrueUser>("/admin/users", {
    method: "POST",
    headers: keyHeaders(serviceKey()),
    body: {
      email,
      password,
      email_confirm: true,
      app_metadata: { role, status, modules: profile.modules },
      user_metadata: { name: cleanText(input.name, 80) || email.split("@")[0], phone: profile.phone, area: profile.area, notes: profile.notes, avatar: profile.avatar },
      ...(status === "inactivo" ? { ban_duration: BAN_FOREVER } : {})
    }
  });
  if (!result.ok) throw adminError(result.status, result.data);
  listCache = null;
  return toAccount(result.data);
}

export async function updateAccount(id: string, input: Record<string, unknown>) {
  const current = (await listAccounts({ fresh: true })).find((account) => account.id === id);
  if (!current) throw new AccountError("Usuario no encontrado.", 404);
  const protectedAdmin = current.isTaskManager;
  const role = protectedAdmin ? "admin" : input.role === undefined ? current.role : cleanRole(input.role);
  const status = protectedAdmin ? "activo" : input.status === undefined ? current.status : cleanStatus(input.status);
  if (protectedAdmin && ((input.role !== undefined && input.role !== "admin") || input.status === "inactivo")) {
    throw new AccountError("Esta cuenta es la que asigna tareas: siempre es admin y no se puede desactivar.");
  }
  const profile = profileFields({
    permissions: input.permissions ?? current.modules,
    phone: input.phone ?? current.phone,
    area: input.area ?? current.area,
    notes: input.notes ?? current.notes,
    avatar: input.avatar ?? current.avatar
  });
  const body: Record<string, unknown> = {
    app_metadata: { role, status, modules: profile.modules },
    user_metadata: { name: input.name === undefined ? current.name : cleanText(input.name, 80) || current.name, phone: profile.phone, area: profile.area, notes: profile.notes, avatar: profile.avatar },
    ban_duration: status === "inactivo" ? BAN_FOREVER : "none"
  };
  if (input.password !== undefined && input.password !== "") {
    const password = String(input.password);
    validatePassword(password);
    body.password = password;
  }
  const updated = await adminUpdate(id, body);
  return updated;
}

export async function deleteAccount(id: string) {
  const current = (await listAccounts({ fresh: true })).find((account) => account.id === id);
  if (!current) throw new AccountError("Usuario no encontrado.", 404);
  if (current.isTaskManager) throw new AccountError("La cuenta que asigna tareas no se puede eliminar.");
  const result = await gotrue(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", headers: keyHeaders(serviceKey()) });
  if (!result.ok) throw adminError(result.status, result.data);
  listCache = null;
  forgetAccount(id);
}

async function adminUpdate(id: string, body: Record<string, unknown>) {
  const result = await gotrue<GoTrueUser>(`/admin/users/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: keyHeaders(serviceKey()),
    body
  });
  if (!result.ok) throw adminError(result.status, result.data);
  listCache = null;
  forgetAccount(id);
  return toAccount(result.data);
}

// Drop cached tokens of an account so a role/status change applies on its next request.
function forgetAccount(id: string) {
  for (const [token, value] of tokenCache) if (value.account.id === id) tokenCache.delete(token);
}

function adminError(status: number, data: { msg?: string; message?: string; error_description?: string; error?: string; error_code?: string; code?: string | number }) {
  const text = goTrueMessage(data).toLowerCase();
  if (status === 422 && (text.includes("already") || String(data.error_code || data.code).includes("exists"))) {
    return new AccountError("Ya existe un usuario con ese email.", 409);
  }
  if (status === 422 && text.includes("password")) {
    return new AccountError("Supabase rechazo la contraseña: usa una mas larga o menos comun.", 400);
  }
  if (status === 401 || status === 403) {
    return new AccountError("La clave de servicio de Supabase no es valida (SUPABASE_SERVICE_ROLE_KEY).", 503);
  }
  if (status === 404) return new AccountError("Usuario no encontrado.", 404);
  return new AccountError(`Supabase Auth rechazo la operacion (${status}${goTrueMessage(data) ? `: ${goTrueMessage(data)}` : ""}).`, status >= 500 ? 503 : 400);
}

/* ---------- Mapping & validation ---------- */

export function toAccount(user: GoTrueUser): AppAccount {
  const app = user.app_metadata || {};
  const meta = user.user_metadata || {};
  const email = String(user.email || "").toLowerCase();
  const manager = isTaskManagerEmail(email);
  const bannedUntil = user.banned_until ? new Date(user.banned_until).getTime() : 0;
  const banned = bannedUntil > Date.now();
  return {
    id: user.id,
    email,
    name: String(meta.name || meta.full_name || email.split("@")[0] || "Usuario"),
    role: manager ? "admin" : cleanRole(app.role),
    status: manager ? "activo" : banned || app.status === "inactivo" ? "inactivo" : "activo",
    modules: Array.isArray(app.modules) ? app.modules.map(String) : [],
    phone: String(meta.phone || ""),
    area: String(meta.area || ""),
    notes: String(meta.notes || ""),
    avatar: String(meta.avatar || ""),
    isTaskManager: manager,
    createdAt: user.created_at || null,
    lastSignInAt: user.last_sign_in_at || null
  };
}

export function canWriteRole(role: AppRole) {
  return role === "admin" || role === "finanzas";
}

export function accessFor(role: AppRole) {
  if (role === "admin") return ["read", "write", "delete", "admin"];
  if (role === "finanzas") return ["read", "write"];
  return ["read"];
}

function cleanEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new AccountError("Ingresa un email valido.");
  return email;
}

function cleanRole(value: unknown): AppRole {
  return (APP_ROLES as readonly string[]).includes(String(value)) ? (value as AppRole) : "solo_lectura";
}

function cleanStatus(value: unknown): AppStatus {
  return value === "inactivo" ? "inactivo" : "activo";
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

export function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 72) {
    throw new AccountError(`La contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y 72 caracteres.`);
  }
}

function profileFields(input: Record<string, unknown>) {
  const modules = Array.isArray(input.permissions)
    ? input.permissions.map(String).filter((item) => (APP_MODULES as readonly string[]).includes(item))
    : [];
  const avatar = cleanText(input.avatar, 500);
  return {
    modules: [...new Set(modules)],
    phone: cleanText(input.phone, 40),
    area: cleanText(input.area, 80),
    notes: cleanText(input.notes, 1000),
    avatar: /^https?:\/\//i.test(avatar) ? avatar : ""
  };
}
