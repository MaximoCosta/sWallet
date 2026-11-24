import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidLoginPassword, LoginConfigError, loginEmailFor, matchAllowedUsername } from "@/lib/login-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHARED_SNAPSHOT_USER_ID = "shared";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const DEV_CORS_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500"];

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

type TokenPayload = {
  userId: string;
  username: string;
  type: "access" | "refresh";
  exp: number;
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
      return json({ ok: true, service: "sWallet Supabase API" });
    }

    if (method === "POST" && path === "auth/login") {
      return login(request);
    }

    if (method === "GET" && path === "auth/me") {
      const session = await requireSession(request, "access");
      return json({ user: userPayload(session) });
    }

    if (method === "POST" && path === "auth/refresh") {
      const body = await readJson(request);
      const session = await verifyToken(String(body.refreshToken || ""), "refresh");
      if (!session) return unauthorized("Sesion expirada. Inicia sesion nuevamente.");
      return json(sessionPayload(session));
    }

    if (method === "POST" && path === "auth/logout") {
      return json({ ok: true });
    }

    if (method === "GET" && path === "state") {
      const session = await requireSession(request, "access");
      await ensureSnapshotTable();
      const snapshot = await prisma.appSnapshot.findUnique({
        where: { userId: session.userId }
      });
      return json({ snapshot: snapshot?.data ?? null, updatedAt: snapshot?.updatedAt ?? null });
    }

    if ((method === "POST" || method === "PUT") && path === "state") {
      const session = await requireSession(request, "access");
      const body = await readJson(request);
      const snapshot = sanitizeSnapshot(body.snapshot ?? body);
      const baseUpdatedAt = parseBaseUpdatedAt(body.baseUpdatedAt);
      await ensureSnapshotTable();

      const savedAt = await saveSnapshot(session.userId, snapshot, baseUpdatedAt);
      if (!savedAt) {
        const current = await prisma.appSnapshot.findUnique({
          where: { userId: session.userId }
        });
        return json({
          message: "Otro usuario guardo cambios antes. Se cargo la version mas reciente.",
          snapshot: current?.data ?? null,
          updatedAt: current?.updatedAt ?? null
        }, 409);
      }
      return json({ ok: true, updatedAt: savedAt });
    }

    return json({ message: "Ruta no encontrada." }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return unauthorized(error.message);
    }
    if (error instanceof LoginConfigError) {
      console.error(error.message);
      return json({ message: "El servidor no tiene configurado el acceso. Contacta al administrador." }, 503);
    }
    console.error(error);
    return json({ message: "Error interno del servidor." }, 500);
  }
}

async function login(request: NextRequest) {
  const clientKey = clientAddress(request);
  if (isLoginBlocked(clientKey)) {
    return json({ message: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." }, 429);
  }

  const body = await readJson(request);
  const credential = String(body.credential || body.email || body.username || "").trim();
  const password = String(body.password || "");
  tokenSecret(); // fail closed before issuing tokens if the signing secret is missing
  const passwordOk = isValidLoginPassword(password);
  const username = matchAllowedUsername(credential);

  if (!username || !passwordOk) {
    registerLoginFailure(clientKey);
    return unauthorized("Usuario o contrasena incorrectos.");
  }

  loginFailures.delete(clientKey);
  return json(sessionPayload({ userId: userIdFor(username), username }));
}

// Optimistic concurrency: a write only lands if the client saw the latest version.
// Returns the new updatedAt, or null when the stored snapshot changed in the meantime.
async function saveSnapshot(userId: string, snapshot: Prisma.InputJsonObject, baseUpdatedAt: Date | null) {
  const updatedAt = new Date();

  if (baseUpdatedAt) {
    const { count } = await prisma.appSnapshot.updateMany({
      where: { userId, updatedAt: baseUpdatedAt },
      data: { data: snapshot, updatedAt }
    });
    return count === 1 ? updatedAt : null;
  }

  try {
    await prisma.appSnapshot.create({
      data: { userId, data: snapshot, updatedAt }
    });
    return updatedAt;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

function parseBaseUpdatedAt(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function sessionPayload(session: { userId: string; username: string }) {
  return {
    user: userPayload(session),
    accessToken: createToken({ ...session, type: "access" }, ACCESS_TTL_SECONDS),
    refreshToken: createToken({ ...session, type: "refresh" }, REFRESH_TTL_SECONDS),
    expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString()
  };
}

function userPayload(session: { userId: string; username: string }) {
  return {
    id: session.userId,
    name: session.username,
    username: session.username,
    email: loginEmailFor(session.username),
    role: "admin",
    status: "activo",
    permissions: ["read", "write", "delete", "admin"]
  };
}

async function requireSession(request: NextRequest, type: "access" | "refresh") {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw unauthorizedError();
  const session = await verifyToken(match[1], type);
  if (!session) throw unauthorizedError();
  return session;
}

async function verifyToken(token: string, type: "access" | "refresh") {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  if (!safeEqual(signature, sign(encodedPayload))) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.type !== type || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!matchAllowedUsername(payload.username)) return null;

  return { userId: payload.userId, username: payload.username };
}

function createToken(payload: Omit<TokenPayload, "exp">, ttlSeconds: number) {
  const encodedPayload = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  })).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function sign(value: string) {
  return createHmac("sha256", tokenSecret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenSecret() {
  const secret = process.env.AUTH_SECRET?.trim() || process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret) {
    throw new LoginConfigError("AUTH_SECRET no esta configurada: no se pueden firmar ni validar sesiones.");
  }
  return secret;
}

function sanitizeSnapshot(snapshot: unknown): Prisma.InputJsonObject {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {};
  }
  return {
    ...(snapshot as Prisma.InputJsonObject),
    savedAt: new Date().toISOString()
  };
}

function userIdFor(_username: string) {
  return SHARED_SNAPSHOT_USER_ID;
}

let snapshotTableReady = false;

async function ensureSnapshotTable() {
  if (snapshotTableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppSnapshot" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL UNIQUE,
      "data" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "AppSnapshot_updatedAt_idx"
    ON "AppSnapshot" ("updatedAt")
  `);
  snapshotTableReady = true;
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
