// Shared login rules for the snapshot API and NextAuth.
// Pure JS on purpose: auth.ts is also loaded by the Edge middleware, where node:crypto is unavailable.

const DEFAULT_LOGIN_USERS = ["FranPernil", "MaxiTaxi"];

export class LoginConfigError extends Error {}

export function allowedLoginUsers() {
  return (process.env.ALLOWED_LOGIN_USERS || DEFAULT_LOGIN_USERS.join(","))
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
}

export function matchAllowedUsername(credential: string) {
  const normalized = credential.trim().toLowerCase();
  if (!normalized) return null;
  return allowedLoginUsers().find((user) => user.toLowerCase() === normalized) ?? null;
}

/** Allowed users can be plain usernames or email addresses. */
export function loginEmailFor(username: string) {
  const normalized = username.trim().toLowerCase();
  return normalized.includes("@") ? normalized : `${normalized}@swallet.local`;
}

/** Throws LoginConfigError when ALLOWED_LOGIN_PASSWORD is not configured: login fails closed. */
export function isValidLoginPassword(password: string) {
  const expected = process.env.ALLOWED_LOGIN_PASSWORD?.trim();
  if (!expected) {
    throw new LoginConfigError("ALLOWED_LOGIN_PASSWORD no esta configurada: el login queda deshabilitado.");
  }
  return constantTimeEqual(password.trim(), expected);
}

export function constantTimeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
