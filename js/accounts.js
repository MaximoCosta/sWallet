// Login accounts managed by admins (Configuracion > Usuarios y roles). Kept on the server, never in the snapshot.
import { userService } from "./api/userService.js";
import { loadAssignments } from "./assignments.js";

export const accounts = {
  list: [],
  loaded: false,
  loading: null,
  error: ""
};

export function loadAccounts({ force = false } = {}) {
  if (accounts.loading) return accounts.loading;
  if (accounts.loaded && !force) return Promise.resolve(accounts.list);
  accounts.loading = userService.list()
    .then((list) => {
      accounts.list = list;
      accounts.error = "";
      return list;
    })
    .catch((error) => {
      accounts.error = error?.message || "No se pudieron cargar los usuarios.";
      return accounts.list;
    })
    .finally(() => {
      accounts.loaded = true;
      accounts.loading = null;
    });
  return accounts.loading;
}

export function resetAccounts() {
  accounts.list = [];
  accounts.loaded = false;
  accounts.loading = null;
  accounts.error = "";
}

export async function createAccount(input) {
  const user = await userService.create(input);
  accounts.list = [...accounts.list, user];
  loadAssignments({ silent: true }); // the new person must show up in "Asignar a" right away
  return user;
}

export async function updateAccount(id, input) {
  const user = await userService.update(id, input);
  accounts.list = accounts.list.map((item) => (item.id === id ? user : item));
  loadAssignments({ silent: true });
  return user;
}

export async function deleteAccount(id) {
  await userService.remove(id);
  accounts.list = accounts.list.filter((item) => item.id !== id);
  loadAssignments({ silent: true });
}

export function changeOwnPassword(currentPassword, newPassword) {
  return userService.changePassword(currentPassword, newPassword);
}
