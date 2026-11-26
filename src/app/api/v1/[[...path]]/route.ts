import { NextRequest, NextResponse } from "next/server";
import {
  accessFor,
  AccountError,
  type AppAccount,
  AuthConfigError,
  accountFromToken,
  canWriteRole,
  changePassword,
  createAccount,
  deleteAccount,
  listAccounts,
  refreshSession,
  signInWithPassword,
  signOut,
  type AuthTokens,
  updateAccount,
  updateOwnProfile
} from "@/lib/supabase-auth";
import { applyBatch, clearActivity, DataError, readData, type Actor as DataActor } from "@/lib/data-store";
import { addAttachment, addComment, createTask, deleteTask, getTaskWithEvents, listAssignees, listTasks, prepareAttachmentUpload, removeAttachment, TaskError, updateTask } from "@/lib/app-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The static app keys its session by this id; every account works on the same company data.
const SHARED_SNAPSHOT_USER_ID = "shared";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const DEV_CORS_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500"];

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export async function OPTIONS(request: NextRequest) {
  return withCors(request, new NextResponse(null, { status: 204 }));
}

async function handleRequest(request: NextRequest, context: RouteContext) {
  return withCors(request, await route(request, context));
}

async function route(request: NextRequest, context: RouteContext) {
  try {
    const path = await routePath(context);
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "") {
      return json({ ok: true, service: "sWallet API", auth: "supabase" });
    }

    if (method === "POST" && path === "auth/login") {
      // await: without it a rejected login escapes this try/catch and Next answers a bare 500.
      return await login(request);
    }

    if (method === "GET" && path === "auth/me") {
      const account = await requireAccount(request);
      return json({ user: userPayload(account) });
    }

    if (method === "POST" && path === "auth/refresh") {
      const body = await readJson(request);
      const session = await refreshSession(String(body.refreshToken || ""));
      if (!session) return unauthorized("Sesion expirada. Inicia sesion nuevamente.");
      return json(sessionPayload(session.account, session.tokens));
    }

    if (method === "POST" && path === "auth/logout") {
      const token = bearerToken(request);
      if (token) await signOut(token);
      return json({ ok: true });
    }

    if (method === "POST" && path === "auth/password") {
      const account = await requireAccount(request);
      const body = await readJson(request);
      await changePassword(account, String(body.currentPassword || ""), String(body.newPassword || ""));
      return json({ ok: true });
    }

    if (method === "POST" && path === "auth/profile") {
      const account = await requireAccount(request);
      return json({ user: userPayload(await updateOwnProfile(account, await readJson(request))) });
    }

    if (method === "GET" && path === "data") {
      await requireAccount(request);
      const since = parseDate(request.nextUrl.searchParams.get("since"));
      return json(await readData(since));
    }

    if (method === "POST" && path === "data/batch") {
      const account = await requireAccount(request);
      return json(await applyBatch(dataActor(account), await readJson(request)));
    }

    if (method === "DELETE" && path === "data/activity") {
      const account = await requireAccount(request);
      await clearActivity(dataActor(account));
      return json({ ok: true });
    }

    if (path === "tasks" || path.startsWith("tasks/")) {
      const account = await requireAccount(request);
      const actor = { id: account.id, email: account.email, name: account.name, isManager: account.isTaskManager };
      const [, id, sub] = path.split("/");

      if (method === "GET" && path === "tasks") {
        return json({
          tasks: await listTasks(actor),
          isManager: account.isTaskManager,
          assignees: account.isTaskManager ? await listAssignees() : []
        });
      }
      if (method === "POST" && path === "tasks") return json(await createTask(actor, await readJson(request)), 201);
      if (id && !sub && method === "GET") return json(await getTaskWithEvents(actor, id));
      if (id && !sub && method === "PATCH") return json(await updateTask(actor, id, await readJson(request)));
      if (id && !sub && method === "DELETE") {
        await deleteTask(actor, id);
        return json({ ok: true });
      }
      if (id && sub === "comments" && method === "POST") return json(await addComment(actor, id, await readJson(request)), 201);
      if (id && sub === "attachments" && method === "POST" && path.endsWith("/attachments/upload")) {
        return json(await prepareAttachmentUpload(actor, id, await readJson(request)));
      }
      if (id && sub === "attachments" && method === "POST") return json(await addAttachment(actor, id, await readJson(request)), 201);
      const attachmentId = path.split("/")[3];
      if (id && sub === "attachments" && attachmentId && method === "DELETE") return json(await removeAttachment(actor, id, attachmentId));
    }

    if (path === "users" || path.startsWith("users/")) {
      const account = await requireAccount(request);
      if (account.role !== "admin") return json({ message: "Solo un admin puede administrar usuarios." }, 403);
      const id = path.slice("users/".length);

      if (method === "GET" && path === "users") return json({ users: (await listAccounts({ fresh: true })).map(publicAccount) });
      if (method === "POST" && path === "users") {
        return json({ user: publicAccount(await createAccount(await readJson(request))) }, 201);
      }
      if (method === "PATCH" && id) {
        const body = await readJson(request);
        if (id === account.id && (body.role !== undefined || body.status !== undefined)) {
          return json({ message: "No puedes cambiar tu propio rol o estado." }, 400);
        }
        return json({ user: publicAccount(await updateAccount(id, body)) });
      }
      if (method === "DELETE" && id) {
        if (id === account.id) return json({ message: "No puedes eliminar tu propio usuario." }, 400);
        await deleteAccount(id);
        return json({ ok: true });
      }
    }

    return json({ message: "Ruta no encontrada." }, 404);
  } catch (error) {
    if (error instanceof AccountError || error instanceof TaskError || error instanceof DataError) {
      return json({ message: error.message }, error.status);
    }
    if (error instanceof AuthError) {
      return unauthorized(error.message);
    }
    if (error instanceof AuthConfigError) {
      console.error(error.message);
      return json({ message: "El servidor no tiene configurado el acceso (Supabase Auth). Contacta al administrador." }, 503);
    }
    console.error(error);
    const code = errorCode(error);
    return json({ message: `Error interno del servidor${code ? ` (codigo ${code})` : ""}.`, code }, 500);
  }
}

async function login(request: NextRequest) {
  const clientKey = clientAddress(request);
  if (isLoginBlocked(clientKey)) {
    return json({ message: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." }, 429);
  }

  const body = await readJson(request);
  const email = String(body.email || body.credential || "").trim();
  const password = String(body.password || "");

  const session = await signInWithPassword(email, password);
  if (!session) {
    registerLoginFailure(clientKey);
    return unauthorized("Email o contraseña incorrectos.");
  }

  loginFailures.delete(clientKey);
  return json(sessionPayload(session.account, session.tokens));
}

// Best effort: counters live per server instance, so on serverless this slows attacks but is not a hard limit.
const loginFailures = new Map<string, { count: number; firstAt: number }>();

function clientAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function isLoginBlocked(key: string) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function registerLoginFailure(key: string) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
  if (loginFailures.size > 5000) {
    for (const [storedKey, stored] of loginFailures) {
      if (now - stored.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(storedKey);
    }
  }
}


function sessionPayload(account: AppAccount, tokens: AuthTokens) {
  return { user: userPayload(account), ...tokens };
}

// Shape the static app expects (js/auth.js). id stays the shared snapshot key; accountId is the Supabase user.
function userPayload(account: AppAccount) {
  return {
    id: SHARED_SNAPSHOT_USER_ID,
    accountId: account.id,
    name: account.name,
    username: account.email,
    email: account.email,
    role: account.role,
    status: account.status,
    permissions: accessFor(account.role),
    modules: account.modules,
    ...(account.phone ? { phone: account.phone } : {}),
    ...(account.area ? { area: account.area } : {}),
    ...(account.avatar ? { avatar: account.avatar } : {}),
    passwordManagedBy: "user",
    canAssignTasks: account.isTaskManager
  };
}

function publicAccount(account: AppAccount) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
    status: account.status,
    permissions: account.modules,
    phone: account.phone,
    area: account.area,
    notes: account.notes,
    avatar: account.avatar,
    isTaskManager: account.isTaskManager,
    createdAt: account.createdAt,
    lastSignInAt: account.lastSignInAt
  };
}

function bearerToken(request: NextRequest) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireAccount(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) throw unauthorizedError();
  const account = await accountFromToken(token);
  if (!account) throw unauthorizedError();
  return account;
}

function dataActor(account: AppAccount): DataActor {
  return {
    id: account.id,
    name: account.name,
    canWrite: canWriteRole(account.role),
    canDelete: account.role === "admin",
    isAdmin: account.role === "admin"
  };
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function routePath(context: RouteContext) {
  const params = await context.params;
  return (params.path || []).join("/");
}

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function unauthorized(message = "Sesion expirada. Inicia sesion nuevamente.") {
  return json({ message }, 401);
}

function unauthorizedError() {
  return new AuthError("Sesion expirada. Inicia sesion nuevamente.");
}

class AuthError extends Error {}

// Prisma / Postgres error codes only (no messages or SQL), so a failure can be identified without exposing internals.
function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const { code, meta } = error as { code?: unknown; meta?: { code?: unknown } };
  const parts = [code, meta?.code].filter((part): part is string => typeof part === "string" && /^[A-Z0-9]{1,10}$/i.test(part));
  if (parts.length) return parts.join("/");
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.startsWith("Prisma") ? name : undefined;
}

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status });
}

// The app is served from the same origin as the API in production, so CORS is only opened
// for explicitly allowed origins (API_CORS_ORIGINS) or, in development, for Live Server.
function withCors(request: NextRequest, response: NextResponse) {
  const origin = request.headers.get("origin");
  if (origin && allowedCorsOrigins().includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

function allowedCorsOrigins() {
  const configured = (process.env.API_CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return process.env.NODE_ENV === "production" ? [] : DEV_CORS_ORIGINS;
}
