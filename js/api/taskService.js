import { apiRequest } from "./http.js";

export const taskService = {
  list() {
    return apiRequest("/tasks");
  },

  get(id) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}`);
  },

  create(input) {
    return apiRequest("/tasks", { method: "POST", body: input });
  },

  update(id, input) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
  },

  remove(id) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  comment(id, body) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: { body } });
  }
};
