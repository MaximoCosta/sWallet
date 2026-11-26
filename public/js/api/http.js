const LOCAL_API_BASE_URL = "http://localhost:3000/api/v1";
const PRODUCTION_API_BASE_URL = "/api/v1";
const DEFAULT_API_BASE_URL = isLocalHost() ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL;
const API_BASE_URL = normalizeApiBaseUrl(window.sWalletApiBaseUrl || DEFAULT_API_BASE_URL);
const REQUEST_TIMEOUT_MS = 12000;
const ACCESS_TOKEN_KEY = "swalletAccessToken";
const REFRESH_TOKEN_KEY = "swalletRefreshToken";

export class ApiError extends Error {
  constructor(message, { status = 0, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY) || "";
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY) || "";
}

export function setSessionTokens({ accessToken, refreshToken }) {
  if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearSessionTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

let refreshInFlight = null;

// Access tokens last 15 minutes: on a 401, renew once with the refresh token and retry the request.
export async function apiRequest(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (error) {
    if (error?.status !== 401 || path.startsWith("/auth/") || !getRefreshToken()) throw error;
    const renewed = await renewSession();
    if (!renewed) throw error;
    return rawRequest(path, options);
  }
}

function renewSession() {
  if (!refreshInFlight) {
    refreshInFlight = rawRequest("/auth/refresh", { method: "POST", body: { refreshToken: getRefreshToken() } })
      .then((session) => {
        setSessionTokens(session || {});
        return Boolean(session?.accessToken);
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function rawRequest(path, options = {}) {
  let response;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const { timeout: _timeout, ...fetchOptions } = options;
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: buildHeaders(options.headers),
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
    });
  } catch {
    throw new ApiError(
      "No se pudo conectar con el servidor. Verifica que el backend este publicado y que la URL de la API apunte a /api/v1.",
      { status: 0 }
    );
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (response.status === 204) return null;

  const payload = await readJson(response);
  if (!response.ok) {
    throw new ApiError(errorMessage(payload, response.status), {
      status: response.status,
      details: payload
    });
  }

  return payload;
}

function buildHeaders(headers = {}) {
  const token = getAccessToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers
  };
}

function normalizeApiBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_API_BASE_URL;
}

function isLocalHost() {
  return ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function errorMessage(payload, status) {
  if (payload?.message) return payload.message;
  if (payload?.error?.message) return payload.error.message;
  if (status === 401) return "Sesion expirada. Inicia sesion nuevamente.";
  return `No se pudo completar la operación (error ${status || "de red"}). Si se repite, avisale al administrador.`;
}
