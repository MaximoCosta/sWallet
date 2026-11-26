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

  prepareUpload(id, file) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}/attachments/upload`, { method: "POST", body: file });
  },

  addAttachment(id, attachment) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}/attachments`, { method: "POST", body: attachment, timeout: 30000 });
  },

  removeAttachment(id, attachmentId) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
  },

  comment(id, body) {
    return apiRequest(`/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: { body } });
  }
};
