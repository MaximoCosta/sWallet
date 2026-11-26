import { apiRequest } from "./http.js";

export const dataService = {
  /** Everything, or only what changed after `since` (the serverTime of the previous load). */
  load(since = null) {
    return apiRequest(since ? `/data?since=${encodeURIComponent(since)}` : "/data");
  },

  save(batch) {
    return apiRequest("/data/batch", { method: "POST", body: batch });
  },

  clearActivity() {
    return apiRequest("/data/activity", { method: "DELETE" });
  }
};
