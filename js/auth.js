import { authService } from "./api/authService.js";
import { state } from "./state.js";
import { resetAccounts } from "./accounts.js";
import { resetAssignments } from "./assignments.js";
import { clearLocalData, loadRemoteState, saveState } from "./storage.js";

export function hasUsers() {
  return state.users.length > 0;
}

export function currentUser() {
  if (!state.session?.userId) return null;
  return state.users.find((user) => user.id === state.session.userId) || null;
}

export function isAuthenticated() {
  return Boolean(currentUser());
}

export function canWrite() {
  const user = currentUser();
  return user?.role === "admin" || user?.role === "finanzas" || user?.permissions?.includes("write");
}

export function isAdmin() {
  return currentUser()?.role === "admin";
}

export function canDelete() {
  const user = currentUser();
  return user?.role === "admin" || user?.permissions?.includes("delete");
}

export async function login({ email, password }) {
  const session = await authService.login({ email, password });
  setAuthenticatedUser(session.user);
  await loadApiCollections();
  saveState();
  return session.user;
}

export async function logout() {
  await authService.logout();
  clearAuthState();
  saveState();
}

export async function restoreSession() {
  try {
    const user = await authService.me();
    setAuthenticatedUser(user);
    await loadApiCollections();
  } catch {
    try {
      const session = await authService.refresh();
      if (!session?.user) {
        clearAuthState();
        return;
      }
      setAuthenticatedUser(session.user);
      await loadApiCollections();
    } catch {
      clearAuthState();
    }
  }
}

export async function loadApiCollections() {
  await loadRemoteState();
}

/** Updates the signed-in user's profile (name, photo...) without touching the session. */
export function refreshCurrentUser(user) {
  if (user) setAuthenticatedUser(user);
}

function setAuthenticatedUser(user) {
  const previous = currentUser();
  if (previous && previous.accountId !== user.accountId) {
    // Another person on this browser: do not mix their cached data or pending edits.
    resetAccounts();
    resetAssignments();
    clearLocalData();
  }
  const normalized = normalizeUser(user);
  state.users = [normalized];
  state.session = { userId: normalized.id, createdAt: new Date().toISOString() };
}

function clearAuthState() {
  resetAccounts();
  resetAssignments();
  state.session = null;
  state.users = [];
  clearLocalData();
}

function normalizeUser(user) {
  const username = user.username || String(user.email || "").split("@")[0];
  return {
    permissions: [],
    avatar: "",
    phone: "",
    area: "",
    notes: "",
    ...user,
    name: user.name || user.email,
    username,
    status: user.status || "activo"
  };
}

