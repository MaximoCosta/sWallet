// Shared form behaviour: validation with a message next to each field, date shortcuts,
// suggestion lists (datalists), links without "https://", live previews, Ctrl+Enter to save.
//
// Validation rules come from the markup:
//   required                      the field must have a value
//   type="email" / type="url"     format check (urls get "https://" added)
//   type="number" min / max       numeric range
//   data-min-date="otherId"       date cannot be before the other date
//   data-after-time="otherId"     time must be later than the other time
//   data-one-of="otherId"         this field or the other one must have a value

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateForm(form, extraErrors = []) {
  clearFieldErrors(form);
  const errors = [];
  const controls = [...form.querySelectorAll("input, select, textarea")].filter((control) => !control.disabled && !control.closest("[hidden]") && control.type !== "hidden");

  for (const control of controls) {
    const value = control.type === "checkbox" ? (control.checked ? "on" : "") : String(control.value || "").trim();
    if (control.required && !value) {
      errors.push([control, "Completá este campo."]);
      continue;
    }
    if (!value) {
      const other = control.dataset.oneOf && document.getElementById(control.dataset.oneOf);
      if (other && !String(other.value || "").trim()) errors.push([control, `Completá este campo o ${labelOf(other).toLowerCase()}.`]);
      continue;
    }
    if (control.type === "email" && !EMAIL.test(value)) errors.push([control, "El email no es válido."]);
    if (control.type === "url") {
      const fixed = withProtocol(value);
      try {
        new URL(fixed);
        control.value = fixed;
      } catch {
        errors.push([control, "El link no es válido."]);
      }
    }
    if (control.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) errors.push([control, "Ingresá un número."]);
      else if (control.min !== "" && number < Number(control.min)) errors.push([control, `No puede ser menor a ${control.min}.`]);
      else if (control.max !== "" && number > Number(control.max)) errors.push([control, `No puede ser mayor a ${control.max}.`]);
    }
    if (control.dataset.minDate) {
      const other = document.getElementById(control.dataset.minDate);
      if (other?.value && value < other.value) errors.push([control, `No puede ser anterior a ${labelOf(other).toLowerCase()}.`]);
    }
    if (control.dataset.afterTime) {
      const other = document.getElementById(control.dataset.afterTime);
      if (other?.value && value <= other.value) errors.push([control, `Tiene que ser después de ${labelOf(other).toLowerCase()}.`]);
    }
  }

  for (const [control, message] of extraErrors) if (control) errors.push([control, message]);
  if (!errors.length) return true;

  errors.forEach(([control, message]) => showFieldError(control, message));
  const [first] = errors;
  openSectionOf(first[0]);
  first[0].focus({ preventScroll: false });
  first[0].scrollIntoView({ block: "center", behavior: "smooth" });
  return false;
}

export function showFieldError(control, message) {
  control.classList.add("field-error");
  control.setAttribute("aria-invalid", "true");
  const holder = control.closest("label") || control.parentElement;
  let note = holder.querySelector(":scope > .field-message");
  if (!note) {
    note = document.createElement("small");
    note.className = "field-message";
    holder.appendChild(note);
  }
  note.textContent = message;
}

export function clearFieldErrors(form) {
  form.querySelectorAll(".field-error").forEach((control) => {
    control.classList.remove("field-error");
    control.removeAttribute("aria-invalid");
  });
  form.querySelectorAll(".field-message").forEach((note) => note.remove());
}

function clearOne(control) {
  if (!control.classList?.contains("field-error")) return;
  control.classList.remove("field-error");
  control.removeAttribute("aria-invalid");
  (control.closest("label") || control.parentElement)?.querySelector(":scope > .field-message")?.remove();
}

function openSectionOf(control) {
  const details = control.closest("details");
  if (details) details.open = true;
}

function labelOf(control) {
  const label = control.closest("label");
  const text = label ? [...label.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join(" ").trim() : "";
  return (control.dataset.label || text || control.name || "el otro campo").replace(/\s*\*$/, "");
}

export function withProtocol(value) {
  const text = String(value || "").trim();
  if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return `https://${text}`;
}

/* ---------- Dates ---------- */

export function todayKey(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateKey, days) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const date = y ? new Date(y, m - 1, d) : new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/* ---------- Suggestion lists ---------- */

/** Fills <datalist id="..."> elements; called on every render, only touches the DOM when something changed. */
export function fillDatalist(id, values) {
  const list = document.getElementById(id);
  if (!list) return;
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  const html = unique.map((value) => `<option value="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"></option>`).join("");
  if (list.dataset.html !== html) {
    list.innerHTML = html;
    list.dataset.html = html;
  }
}

/** A select whose stored value is not among its options (older data): keep it selectable. */
export function setSelectValue(select, value) {
  if (!select) return;
  const text = String(value ?? "");
  if (text && ![...select.options].some((option) => option.value === text)) {
    const option = document.createElement("option");
    option.value = text;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = text;
}

/* ---------- Live previews ---------- */

const previews = new Map();

/** Registers a function that recomputes a summary box when the form changes. */
export function registerPreview(form, render) {
  if (!form) return;
  previews.set(form.id, render);
}

export function refreshPreview(form) {
  const render = form && previews.get(form.id);
  if (render) render();
}

/* ---------- Global wiring (once) ---------- */

let wired = false;

export function enhanceForms() {
  if (wired) return;
  wired = true;

  document.addEventListener("input", (event) => {
    const control = event.target;
    if (!(control instanceof HTMLElement)) return;
    clearOne(control);
    const form = control.closest("form");
    if (form) refreshPreview(form);
    if (control.dataset.syncWith) {
      const twin = document.getElementById(control.dataset.syncWith);
      if (twin) twin.value = control.value;
    }
  });

  document.addEventListener("change", (event) => {
    const control = event.target;
    if (!(control instanceof HTMLElement)) return;
    clearOne(control);
    const form = control.closest("form");
    if (form) refreshPreview(form);
  });

  // Links: accept "misitio.com" and store "https://misitio.com".
  document.addEventListener("focusout", (event) => {
    const control = event.target;
    if (control instanceof HTMLInputElement && control.type === "url" && control.value.trim()) {
      control.value = withProtocol(control.value);
    }
  });

  // Date shortcuts: <button data-date-target="dueId" data-date-base="issueId" data-days="30">.
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-date-target]") : null;
    if (!button) return;
    event.preventDefault();
    const target = document.getElementById(button.dataset.dateTarget);
    if (!target) return;
    const base = button.dataset.dateBase ? document.getElementById(button.dataset.dateBase)?.value : "";
    target.value = addDays(base || todayKey(), Number(button.dataset.days || 0));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Ctrl/Cmd + Enter saves the form you are in.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    const form = event.target instanceof Element ? event.target.closest("form") : null;
    if (!form) return;
    event.preventDefault();
    form.requestSubmit();
  });
}
