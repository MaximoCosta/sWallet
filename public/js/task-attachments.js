// Attachments of assigned tasks: files, screenshots (paste with Ctrl+V or drag & drop) and links.
// Files go straight from the browser to a private Supabase Storage bucket with a one-time signed
// URL from our API; the API then registers them. Viewing uses links that expire after an hour.
import { taskService } from "./api/taskService.js";
import { escapeAttribute, escapeHTML, notify } from "./render.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/* ---------- Upload ---------- */

/** Uploads files to a task. `onProgress(list)` is called with the in-flight uploads. Returns the last API payload. */
export async function uploadFiles(taskId, files, onProgress = () => {}) {
  const queue = [...files].map((file) => ({ key: `${Date.now()}-${Math.random()}`, name: file.name || "archivo", file, progress: 0, error: "" }));
  const report = () => onProgress(queue.filter((item) => item.progress < 100 || item.error));
  let lastPayload = null;
  report();
  for (const item of queue) {
    if (item.file.size > MAX_FILE_BYTES) {
      item.error = "Supera los 25 MB";
      notify("Archivo muy grande", `${item.name} supera los 25 MB.`);
      report();
      continue;
    }
    try {
      const target = await taskService.prepareUpload(taskId, { name: item.name, type: item.file.type, size: item.file.size });
      await putFile(target, item.file, (percent) => {
        item.progress = Math.min(percent, 99);
        report();
      });
      lastPayload = await taskService.addAttachment(taskId, { kind: "file", path: target.path, name: item.name, mimeType: item.file.type || "application/octet-stream", size: item.file.size });
      item.progress = 100;
    } catch (error) {
      item.error = error?.message || "No se pudo subir";
      notify("No se pudo subir", `${item.name}: ${item.error}`);
    }
    report();
  }
  // Failed items stay visible a few seconds so the person sees what happened.
  setTimeout(() => onProgress([]), 4000);
  return lastPayload;
}

// Same request Supabase's own client uses for signed uploads (multipart, PUT).
function putFile(target, file, onPercent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.uploadUrl);
    Object.entries(target.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    if (target.headers?.apikey?.startsWith("eyJ")) xhr.setRequestHeader("Authorization", `Bearer ${target.headers.apikey}`);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onPercent(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage respondió ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("Sin conexión con el almacenamiento"));
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file, file.name || "archivo");
    xhr.send(body);
  });
}

export function addLink(taskId, url, name) {
  return taskService.addAttachment(taskId, { kind: "link", url, name });
}

export function removeAttachment(taskId, attachmentId) {
  return taskService.removeAttachment(taskId, attachmentId);
}

/** Files from a paste event (screenshots copied to the clipboard), renamed with a readable name. */
export function filesFromClipboard(event) {
  const items = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return items.map((item, index) => {
    const file = item.getAsFile();
    if (!file) return null;
    if (file.name && file.name !== "image.png") return file;
    const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return new File([file], `captura-${stamp}${index ? `-${index + 1}` : ""}.${extension}`, { type: file.type });
  }).filter(Boolean);
}

/* ---------- Markup ---------- */

export function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function extension(name) {
  const match = String(name || "").match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toUpperCase() : "ARCH";
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The "Adjuntos" block of the task detail. */
export function attachmentsMarkup(attachments = [], uploads = [], { prefix = "detail", emptyText = "Todavía no hay archivos ni links." } = {}) {
  // Inside another <form> (the new-task form) a nested <form> is not allowed.
  const tag = prefix === "detail" ? "form" : "div";
  const items = attachments.map((item) => {
    const remove = item.canDelete
      ? `<button class="icon-button attachment-remove" type="button" data-attachment-remove="${escapeAttribute(item.id)}" aria-label="Quitar ${escapeAttribute(item.name)}" title="Quitar"><svg><use href="#i-close"/></svg></button>`
      : "";
    const meta = `<span>${escapeHTML([item.kind === "link" ? host(item.url) : formatSize(item.size), item.uploadedByName].filter(Boolean).join(" · "))}</span>`;
    if (item.isImage && item.url) {
      return `<figure class="attachment attachment-image">
        <button class="attachment-thumb" type="button" data-attachment-preview="${escapeAttribute(item.url)}" data-attachment-name="${escapeAttribute(item.name)}" aria-label="Ver ${escapeAttribute(item.name)}"><img src="${escapeAttribute(item.url)}" alt="" loading="lazy"></button>
        <figcaption><a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener">${escapeHTML(item.name)}</a>${meta}</figcaption>${remove}
      </figure>`;
    }
    const icon = item.kind === "link" ? "i-link" : "i-file";
    const badge = item.kind === "link" ? "" : `<b>${escapeHTML(extension(item.name))}</b>`;
    const href = item.url ? `href="${escapeAttribute(item.url)}" target="_blank" rel="noopener"` : "";
    return `<div class="attachment attachment-row">
      <span class="attachment-icon"><svg aria-hidden="true"><use href="#${icon}"/></svg>${badge}</span>
      <div class="attachment-info"><a ${href}>${escapeHTML(item.name)}</a>${meta}</div>${remove}
    </div>`;
  }).join("");

  const progress = uploads.map((item) => `<div class="attachment attachment-row is-uploading">
      <span class="attachment-icon"><svg aria-hidden="true"><use href="#i-upload"/></svg></span>
      <div class="attachment-info"><strong>${escapeHTML(item.name)}</strong><span>${item.error ? `<em class="amount-negative">${escapeHTML(item.error)}</em>` : `Subiendo ${item.progress}%`}</span>
      ${item.error ? "" : `<div class="progress-bar"><i style="width:${item.progress}%"></i></div>`}</div>
    </div>`).join("");

  return `
    <div class="attachment-drop" data-attachment-drop="${prefix}">
      <svg aria-hidden="true"><use href="#i-upload"/></svg>
      <div><strong>Arrastrá archivos o pegá una captura (Ctrl+V)</strong><span>Imágenes, PDF, documentos, videos cortos. Hasta 25 MB cada uno.</span></div>
      <label class="ghost-button compact">Elegir archivos<input type="file" multiple hidden data-attachment-input="${prefix}"></label>
    </div>
    <${tag} class="attachment-link-form" data-attachment-link-form="${prefix}"${tag === "form" ? " novalidate" : ""}>
      <input type="url" name="url" data-link-url placeholder="Pegá un link (Figma, Drive, Loom, sitio...)" aria-label="Link">
      <input type="text" name="name" data-link-name maxlength="160" placeholder="Título (opcional)" aria-label="Título del link">
      <button class="ghost-button compact" type="${tag === "form" ? "submit" : "button"}" data-link-add><svg><use href="#i-link"/></svg>Agregar link</button>
    </${tag}>
    <div class="attachment-list">${progress}${items || (progress ? "" : `<p class="muted">${escapeHTML(emptyText)}</p>`)}</div>`;
}

/* ---------- Lightbox ---------- */

export function openLightbox(url, name) {
  closeLightbox();
  const box = document.createElement("div");
  box.className = "lightbox";
  box.id = "attachmentLightbox";
  box.innerHTML = `<button class="icon-button lightbox-close" type="button" aria-label="Cerrar"><svg><use href="#i-close"/></svg></button>
    <img src="${escapeAttribute(url)}" alt="${escapeAttribute(name)}">
    <div class="lightbox-bar"><span>${escapeHTML(name)}</span><a class="ghost-button compact" href="${escapeAttribute(url)}" target="_blank" rel="noopener"><svg><use href="#i-download"/></svg>Abrir original</a></div>`;
  box.addEventListener("click", (event) => {
    if (event.target === box || event.target.closest(".lightbox-close")) closeLightbox();
  });
  document.body.appendChild(box);
}

export function closeLightbox() {
  document.getElementById("attachmentLightbox")?.remove();
}

export function lightboxOpen() {
  return Boolean(document.getElementById("attachmentLightbox"));
}
