import { apiRequest } from "./http.js";

export const userService = {
  async list() {
    const payload = await apiRequest("/users");
    return payload.users || [];
  },

  async create(input) {
    const payload = await apiRequest("/users", { method: "POST", body: input });
    return payload.user;
  },

  async update(id, input) {
    const payload = await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
    return payload.user;
  },

  async remove(id) {
    await apiRequest(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async changePassword(currentPassword, newPassword) {
    await apiRequest("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
  }
};
