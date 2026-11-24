import { apiRequest } from "./http.js";

export const snapshotService = {
  async load() {
    return apiRequest("/state");
  },

  async save(snapshot, baseUpdatedAt) {
    return apiRequest("/state", {
      method: "PUT",
      body: { snapshot, baseUpdatedAt: baseUpdatedAt || null }
    });
  }
};
