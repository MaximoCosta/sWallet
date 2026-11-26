// Files attached to assigned tasks, kept in a PRIVATE Supabase Storage bucket.
// The browser uploads straight to Storage with a one-time signed URL (no Vercel body limit)
// and only sees files through signed links that expire, issued after a permission check.
import { AccountError, supabaseAdminFetch, supabasePublicConfig } from "@/lib/supabase-auth";

export const TASK_FILES_BUCKET = "task-files";
export const MAX_TASK_FILE_BYTES = 25 * 1024 * 1024;
const LINK_TTL_SECONDS = 3600;

let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  const response = await supabaseAdminFetch("/storage/v1/bucket", {
    method: "POST",
    body: JSON.stringify({ id: TASK_FILES_BUCKET, name: TASK_FILES_BUCKET, public: false, file_size_limit: MAX_TASK_FILE_BYTES })
  }).catch(() => null);
  // 200 = created; 400/409 = already exists. Anything else will surface on the upload itself.
  if (response && (response.ok || response.status === 400 || response.status === 409)) bucketReady = true;
}

export function safeFileName(name: string) {
  const clean = String(name || "archivo")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-80);
  return clean || "archivo";
}

/** One-time URL the browser uses to PUT the file. */
export async function createUploadUrl(path: string) {
  await ensureBucket();
  const response = await supabaseAdminFetch(`/storage/v1/object/upload/sign/${TASK_FILES_BUCKET}/${encodePath(path)}`, { method: "POST", body: "{}" });
  const data = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
  if (!response.ok || !data.url) throw new AccountError("No se pudo preparar la subida del archivo.", 503);
  const { url, anonKey } = supabasePublicConfig();
  return { uploadUrl: `${url}/storage/v1${data.url}`, headers: { apikey: anonKey } };
}

/** Temporary download links for several stored paths at once ({path -> url}). Missing files get no link. */
export async function signedLinks(paths: string[], { download = false } = {}) {
  if (!paths.length) return new Map<string, string>();
  const response = await supabaseAdminFetch(`/storage/v1/object/sign/${TASK_FILES_BUCKET}`, {
    method: "POST",
    body: JSON.stringify({ expiresIn: LINK_TTL_SECONDS, paths })
  });
  const data = (await response.json().catch(() => [])) as { path?: string; signedURL?: string | null; error?: string | null }[];
  const { url } = supabasePublicConfig();
  const links = new Map<string, string>();
  if (!response.ok || !Array.isArray(data)) return links;
  for (const item of data) {
    if (item.path && item.signedURL && !item.error) links.set(item.path, `${url}/storage/v1${item.signedURL}${download ? "&download=" : ""}`);
  }
  return links;
}

export async function fileExists(path: string) {
  return (await signedLinks([path])).has(path);
}

export async function removeFiles(paths: string[]) {
  if (!paths.length) return;
  await supabaseAdminFetch(`/storage/v1/object/${TASK_FILES_BUCKET}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: paths })
  }).catch(() => null);
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
