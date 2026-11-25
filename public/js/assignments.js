// Tareas asignadas: Maxi (task manager) creates tasks for the team; everyone else sees only theirs and moves
// them between asignada / en proceso / completada. Data lives on the server (/api/v1/tasks), not in the snapshot.
import { taskService } from "./api/taskService.js";
import { currentUser, isAuthenticated } from "./auth.js";
import { closeModal, openModal } from "./events.js";
import { dom, escapeAttribute, escapeHTML, notify } from "./render.js";

const STATUSES = [
  { key: "asignada", label: "Asignadas", single: "Asignada", empty: "Nada pendiente de empezar." },
  { key: "en_proceso", label: "En proceso", single: "En proceso", empty: "Nada en curso ahora." },
  { key: "completada", label: "Completadas", single: "Completada", empty: "Todavía no hay tareas terminadas." }
];
const PRIORITY_LABELS = { baja: "Baja", media: "Media", alta: "Alta", urgente: "Urgente" };
const PRIORITY_ORDER = { urgente: 0, alta: 1, media: 2, baja: 3 };
const POLL_MS = 60000;
const LAYOUT_KEY = "swalletTasksLayout";

export const assignments = {
  tasks: [],
  assignees: [],
  isManager: false,
  loaded: false,
  loading: null,
  error: "",
  lastLoadedAt: null,
  filters: { person: "", priority: "", due: "", term: "", hideDone: false },
  layout: readLayout(),
  detail: { id: "", events: [], loading: false }
};

let pollTimer = null;
let bound = false;

/* ---------- Data ---------- */

export function loadAssignments({ silent = false } = {}) {
  if (!isAuthenticated()) return Promise.resolve();
  if (assignments.loading) return assignments.loading;
  assignments.loading = taskService.list()
    .then((payload) => {
      assignments.tasks = payload.tasks || [];
      assignments.assignees = payload.assignees || [];
      assignments.isManager = Boolean(payload.isManager);
      assignments.error = "";
      assignments.lastLoadedAt = new Date();
      if (!pollTimer) startAssignmentsPolling();
    })
    .catch((error) => {
      assignments.error = error?.message || "No se pudieron cargar las tareas.";
      if (!silent) notify("Tareas", assignments.error);
    })
    .finally(() => {
      assignments.loaded = true;
      assignments.loading = null;
      renderAssignments();
    });
  return assignments.loading;
}

export function resetAssignments() {
  assignments.tasks = [];
  assignments.assignees = [];
  assignments.isManager = false;
  assignments.loaded = false;
  assignments.loading = null;
  assignments.error = "";
  assignments.lastLoadedAt = null;
  assignments.filters = { person: "", priority: "", due: "", term: "", hideDone: false };
  stopPolling();
}

export function startAssignmentsPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && isAuthenticated()) loadAssignments({ silent: true });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}

function me() {
  return String(currentUser()?.username || "").toLowerCase();
}

function canManage() {
  return assignments.isManager || Boolean(currentUser()?.canAssignTasks);
}

function replaceTask(task) {
  const index = assignments.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) assignments.tasks.unshift(task);
  else assignments.tasks[index] = task;
}

async function changeStatus(id, status) {
  const task = assignments.tasks.find((item) => item.id === id);
  if (!task || task.status === status) return;
  const previous = { ...task };
  // Optimistic: move the card right away, roll back if the server refuses.
  Object.assign(task, {
    status,
    completedAt: status === "completada" ? new Date().toISOString() : null,
    startedAt: task.startedAt || (status !== "asignada" ? new Date().toISOString() : null)
  });
  renderAssignments();
  try {
    const payload = await taskService.update(id, { status });
    replaceTask(payload.task);
    if (assignments.detail.id === id) assignments.detail.events = payload.events || [];
    renderAssignments();
    notify(statusToastTitle(status), payload.task.title);
  } catch (error) {
    replaceTask(previous);
    renderAssignments();
    notify("No se pudo cambiar el estado", error.message);
  }
}

function statusToastTitle(status) {
  if (status === "en_proceso") return "Tarea en proceso";
  if (status === "completada") return "Tarea completada";
  return "Tarea marcada como asignada";
}

/* ---------- Derived data ---------- */

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysUntil(dateKey) {
  if (!dateKey) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

function isOverdue(task) {
  return task.status !== "completada" && Boolean(task.dueDate) && task.dueDate < todayKey();
}

function dueInfo(task) {
  if (!task.dueDate) return { text: "Sin fecha", tone: "" };
  const days = daysUntil(task.dueDate);
  const date = formatShortDate(task.dueDate);
  if (task.status === "completada") return { text: `Vencía ${date}`, tone: "" };
  if (days < 0) return { text: days === -1 ? "Venció ayer" : `Venció hace ${-days} días`, tone: "due-overdue" };
  if (days === 0) return { text: "Vence hoy", tone: "due-soon" };
  if (days === 1) return { text: "Vence mañana", tone: "due-soon" };
  if (days <= 7) return { text: `Vence en ${days} días`, tone: "" };
  return { text: `Vence ${date}`, tone: "" };
}

function formatShortDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

function formatDateTime(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "recién";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return formatDateTime(iso);
}

function personName(username) {
  const key = String(username || "").toLowerCase();
  const fromTask = assignments.tasks.find((task) => task.assignee === key && task.assigneeName)?.assigneeName
    || assignments.tasks.find((task) => task.createdBy === key && task.createdByName)?.createdByName;
  const found = assignments.assignees.find((item) => item.username === key);
  if (found) return found.name || found.username;
  const user = currentUser();
  if (user && String(user.username).toLowerCase() === key) return user.name || user.username;
  return fromTask || username || "-";
}

function initials(name) {
  return escapeHTML(String(name || "?").trim().charAt(0).toUpperCase() || "?");
}

function avatar(username) {
  return `<span class="user-avatar" aria-hidden="true">${initials(personName(username))}</span>`;
}

function sortTasks(list) {
  return [...list].sort((a, b) => {
    if (a.status === "completada" && b.status === "completada") {
      return String(b.completedAt || "").localeCompare(String(a.completedAt || ""));
    }
    const overdue = Number(isOverdue(b)) - Number(isOverdue(a));
    if (overdue) return overdue;
    const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priority) return priority;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate !== b.dueDate) return a.dueDate ? -1 : 1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

function visibleTasks({ ignoreDoneFilter = false } = {}) {
  const { person, priority, due, term, hideDone } = assignments.filters;
  const needle = term.trim().toLowerCase();
  return assignments.tasks.filter((task) => {
    if (person && task.assignee !== person) return false;
    if (priority && task.priority !== priority) return false;
    if (!ignoreDoneFilter && hideDone && task.status === "completada") return false;
    if (due === "vencidas" && !isOverdue(task)) return false;
    if (due === "semana") {
      const days = daysUntil(task.dueDate);
      if (task.status === "completada" || days === null || days < 0 || days > 7) return false;
    }
    if (due === "sin_fecha" && task.dueDate) return false;
    if (needle && !`${task.title} ${task.description}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/* ---------- Rendering ---------- */

export function renderAssignments() {
  bindAssignmentEvents();
  renderNavCount();
  renderDashboardWidget();
  if (!dom.asignacionesView) return;

  const manager = canManage();
  dom.assignmentRoleNote.hidden = manager;
  dom.assignmentNew.hidden = !manager;
  dom.assignmentPersonField.hidden = !manager;
  dom.assignmentTeamPanel.hidden = !manager;
  dom.assignmentShortcutHint.hidden = window.matchMedia("(max-width: 860px)").matches;
  document.querySelectorAll("[data-assignment-layout]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.assignmentLayout === assignments.layout));
  });
  syncPersonOptions();

  if (!assignments.loaded) {
    dom.assignmentStats.innerHTML = "";
    dom.assignmentBoard.innerHTML = `<div class="task-empty">Cargando tareas...</div>`;
    dom.assignmentStatus.textContent = "Cargando tareas...";
    if (isAuthenticated()) loadAssignments();
    return;
  }

  if (assignments.error && !assignments.tasks.length) {
    dom.assignmentStats.innerHTML = "";
    dom.assignmentBoard.innerHTML = `<div class="task-empty"><strong>No se pudieron cargar las tareas</strong>${escapeHTML(assignments.error)}<button class="ghost-button compact" type="button" data-assignment-retry>Reintentar</button></div>`;
    dom.assignmentStatus.textContent = "";
    return;
  }

  renderStats();
  if (manager) renderTeam();
  dom.assignmentBoard.innerHTML = assignments.layout === "list" ? listMarkup() : boardMarkup();
  dom.assignmentStatus.textContent = assignments.lastLoadedAt
    ? `Actualizado ${timeAgo(assignments.lastLoadedAt.toISOString())}. Se actualiza solo cada minuto.`
    : "";
  if (assignments.detail.id && dom.assignmentDetailModal.classList.contains("modal-open")) renderDetail();
}

function renderStats() {
  const scope = visibleTasks({ ignoreDoneFilter: true });
  const count = (status) => scope.filter((task) => task.status === status).length;
  const overdue = scope.filter(isOverdue).length;
  const done = count("completada");
  const rate = scope.length ? Math.round((done / scope.length) * 100) : 0;
  dom.assignmentStats.innerHTML = `
    <article class="stat-card blue"><span>Asignadas</span><strong>${count("asignada")}</strong><small>Sin empezar</small></article>
    <article class="stat-card amber"><span>En proceso</span><strong>${count("en_proceso")}</strong><small>En curso ahora</small></article>
    <article class="stat-card green"><span>Completadas</span><strong>${done}</strong><small>${rate}% del total</small></article>
    <article class="stat-card coral"><span>Vencidas</span><strong>${overdue}</strong><small>${overdue ? "Necesitan atención" : "Todo al día"}</small></article>
  `;
}

function renderTeam() {
  const people = assignments.assignees.length
    ? assignments.assignees
    : [...new Set(assignments.tasks.map((task) => task.assignee))].map((username) => ({ username, name: username }));
  // Include people who still have tasks but are no longer active accounts.
  assignments.tasks.forEach((task) => {
    if (!people.some((person) => person.username === task.assignee)) people.push({ username: task.assignee, name: task.assignee, inactive: true });
  });

  dom.assignmentTeam.innerHTML = people.length ? people.map((person) => {
    const mine = assignments.tasks.filter((task) => task.assignee === person.username);
    const open = mine.filter((task) => task.status !== "completada").length;
    const overdue = mine.filter(isOverdue).length;
    const done = mine.filter((task) => task.status === "completada").length;
    const progress = mine.length ? Math.round((done / mine.length) * 100) : 0;
    const selected = assignments.filters.person === person.username;
    return `
      <button class="team-card" type="button" data-team-person="${escapeAttribute(person.username)}" aria-pressed="${selected}">
        <div class="team-card-head">
          ${avatar(person.username)}
          <div><strong>${escapeHTML(person.name || person.username)}</strong><span>${person.inactive ? "Cuenta inactiva" : `@${escapeHTML(person.username)}`}</span></div>
        </div>
        <div class="team-card-counts">
          <div><b>${mine.filter((task) => task.status === "asignada").length}</b><span>Asignadas</span></div>
          <div><b>${mine.filter((task) => task.status === "en_proceso").length}</b><span>En proceso</span></div>
          <div><b>${done}</b><span>Hechas</span></div>
        </div>
        <div class="progress-bar" aria-hidden="true"><i style="width:${progress}%"></i></div>
        <div class="team-card-foot"><span>${open} abiertas</span>${overdue ? `<span class="overdue">${overdue} vencida${overdue === 1 ? "" : "s"}</span>` : `<span>${progress}% completado</span>`}</div>
      </button>
    `;
  }).join("") : `<div class="task-empty">Todavía no hay personas para asignar.</div>`;
}

function boardMarkup() {
  const list = sortTasks(visibleTasks());
  const manager = canManage();
  const columns = STATUSES.filter((status) => !(assignments.filters.hideDone && status.key === "completada"));
  if (!assignments.tasks.length) return emptyBoardMarkup(manager);
  return `<div class="task-columns" style="${columns.length === 2 ? "grid-template-columns:repeat(2,minmax(0,1fr))" : ""}">${columns.map((status) => {
    const items = list.filter((task) => task.status === status.key);
    return `
      <section class="task-column" data-status="${status.key}" aria-label="${status.label}">
        <header class="task-column-head"><i aria-hidden="true"></i>${status.label}<span>${items.length}</span></header>
        <div class="task-list">
          ${items.length ? items.map((task) => cardMarkup(task, manager)).join("") : `<div class="task-empty">${status.empty}</div>`}
        </div>
      </section>
    `;
  }).join("")}</div>`;
}

function emptyBoardMarkup(manager) {
  return `<section class="panel"><div class="empty-state">
    <strong>${manager ? "Todavía no asignaste tareas" : "No tenés tareas asignadas"}</strong>
    <span>${manager ? "Creá la primera y elegí a quién se la asignás. La persona la va a ver en su panel." : "Cuando Maxi te asigne una tarea va a aparecer acá."}</span>
    ${manager ? `<button class="primary-button compact" type="button" data-assignment-create>Nueva tarea</button>` : ""}
  </div></section>`;
}

function cardMarkup(task, manager) {
  const due = dueInfo(task);
  const overdue = isOverdue(task);
  return `
    <article class="task-card ${overdue ? "is-overdue" : ""} ${task.status === "completada" ? "is-done" : ""}" tabindex="0" draggable="true" data-task-id="${escapeAttribute(task.id)}" aria-label="${escapeAttribute(task.title)}">
      <div class="task-card-top">
        <span class="task-card-title">${escapeHTML(task.title)}</span>
        <span class="priority-dot ${task.priority}" title="Prioridad ${PRIORITY_LABELS[task.priority]}">${PRIORITY_LABELS[task.priority]}</span>
      </div>
      ${task.description ? `<p class="task-card-desc">${escapeHTML(task.description)}</p>` : ""}
      <div class="task-card-meta">
        ${manager ? `<span class="task-assignee">${avatar(task.assignee)}${escapeHTML(personName(task.assignee))}</span>` : ""}
        <span class="${due.tone}"><svg aria-hidden="true"><use href="#i-clock"/></svg>${due.text}</span>
        ${task.commentCount ? `<span title="Comentarios"><svg aria-hidden="true"><use href="#i-comment"/></svg>${task.commentCount}</span>` : ""}
      </div>
      <div class="task-card-actions">${quickActions(task)}</div>
    </article>
  `;
}

function quickActions(task) {
  const button = (status, label, primary = false) => `<button class="${primary ? "primary-button" : "ghost-button"} compact" type="button" data-task-status="${status}" data-task-id="${escapeAttribute(task.id)}">${label}</button>`;
  if (task.status === "asignada") return button("en_proceso", "Empezar", true);
  if (task.status === "en_proceso") return `${button("asignada", "Pausar")}${button("completada", "Completar", true)}`;
  return button("en_proceso", "Reabrir");
}

function listMarkup() {
  const list = sortTasks(visibleTasks());
  const manager = canManage();
  if (!assignments.tasks.length) return emptyBoardMarkup(manager);
  return `<section class="panel"><div class="table-wrap"><table class="task-table">
    <thead><tr><th>Tarea</th>${manager ? "<th>Responsable</th>" : ""}<th>Prioridad</th><th>Vencimiento</th><th>Estado</th><th></th></tr></thead>
    <tbody>${list.length ? list.map((task) => {
      const due = dueInfo(task);
      return `<tr data-task-id="${escapeAttribute(task.id)}" tabindex="0">
        <td><span class="task-card-title">${escapeHTML(task.title)}</span>${task.commentCount ? `<span class="muted"> · ${task.commentCount} comentario${task.commentCount === 1 ? "" : "s"}</span>` : ""}</td>
        ${manager ? `<td><span class="task-assignee">${avatar(task.assignee)}${escapeHTML(personName(task.assignee))}</span></td>` : ""}
        <td><span class="priority-dot ${task.priority}">${PRIORITY_LABELS[task.priority]}</span></td>
        <td><span class="task-card-meta"><span class="${due.tone}">${due.text}</span></span></td>
        <td><span class="badge ${task.status}">${statusLabel(task.status)}</span></td>
        <td><div class="actions-cell">${quickActions(task)}</div></td>
      </tr>`;
    }).join("") : `<tr><td colspan="${manager ? 6 : 5}"><div class="empty-state">Ninguna tarea coincide con los filtros.</div></td></tr>`}</tbody>
  </table></div></section>`;
}

function statusLabel(status) {
  return STATUSES.find((item) => item.key === status)?.single || status;
}

function renderNavCount() {
  const badge = dom.assignmentsNavCount;
  if (!badge) return;
  const open = assignments.tasks.filter((task) => task.assignee === me() && task.status !== "completada").length;
  badge.hidden = !open;
  badge.textContent = open > 99 ? "99+" : String(open);
  badge.title = `${open} tarea(s) tuya(s) sin completar`;
}

function renderDashboardWidget() {
  const box = dom.dashboardMyTasks;
  if (!box) return;
  if (!assignments.loaded) {
    box.innerHTML = `<div class="empty-state">Cargando tareas...</div>`;
    return;
  }
  const mine = sortTasks(assignments.tasks.filter((task) => task.assignee === me() && task.status !== "completada"));
  const teamOpen = assignments.tasks.filter((task) => task.status !== "completada");
  const teamOverdue = teamOpen.filter(isOverdue).length;
  const summary = canManage() && assignments.tasks.length
    ? `<p class="muted">Equipo: ${teamOpen.length} abierta${teamOpen.length === 1 ? "" : "s"}${teamOverdue ? ` · <span class="amount-negative">${teamOverdue} vencida${teamOverdue === 1 ? "" : "s"}</span>` : ""}</p>`
    : "";
  box.innerHTML = summary + (mine.length ? mine.slice(0, 5).map((task) => {
    const due = dueInfo(task);
    return `<button class="my-task-row" type="button" data-task-id="${escapeAttribute(task.id)}">
      <div><strong>${escapeHTML(task.title)}</strong><span class="${due.tone}">${due.text}</span></div>
      <span class="badge ${task.status}">${statusLabel(task.status)}</span>
    </button>`;
  }).join("") : `<div class="empty-state">No tenés tareas pendientes.</div>`);
}

function syncPersonOptions() {
  const select = dom.assignmentFilterPerson;
  if (!select) return;
  const options = [`<option value="">Todo el equipo</option>`, ...assignments.assignees.map((person) => `<option value="${escapeAttribute(person.username)}">${escapeHTML(person.name || person.username)}</option>`)].join("");
  if (select.dataset.options !== options) {
    select.innerHTML = options;
    select.dataset.options = options;
  }
  select.value = assignments.filters.person;
}

/* ---------- Detail modal ---------- */

async function openDetail(id) {
  const task = assignments.tasks.find((item) => item.id === id);
  if (!task) return;
  assignments.detail = { id, events: [], loading: true };
  renderDetail();
  openModal("assignmentDetailModal");
  try {
    const payload = await taskService.get(id);
    if (assignments.detail.id !== id) return;
    replaceTask(payload.task);
    assignments.detail.events = payload.events || [];
  } catch (error) {
    notify("No se pudo abrir la tarea", error.message);
  } finally {
    if (assignments.detail.id === id) assignments.detail.loading = false;
    renderAssignments();
  }
}

function renderDetail() {
  const task = assignments.tasks.find((item) => item.id === assignments.detail.id);
  const body = dom.assignmentDetailBody;
  if (!body) return;
  if (!task) {
    body.innerHTML = `<div class="empty-state">Esta tarea ya no existe o fue reasignada.</div>`;
    return;
  }
  const manager = canManage();
  const due = dueInfo(task);
  const draft = body.querySelector("#assignmentCommentInput")?.value || "";
  body.innerHTML = `
    <div class="task-detail-head">
      <div class="task-detail-badges">
        <span class="badge ${task.status}">${statusLabel(task.status)}</span>
        <span class="badge ${task.priority === "urgente" ? "urgente" : "neutral"}">Prioridad ${PRIORITY_LABELS[task.priority].toLowerCase()}</span>
        ${isOverdue(task) ? `<span class="badge vencida">Vencida</span>` : ""}
      </div>
      <h2 id="assignmentDetailTitle">${escapeHTML(task.title)}</h2>
    </div>
    <div class="task-detail-desc ${task.description ? "" : "empty"}">${task.description ? escapeHTML(task.description) : "Sin descripción."}</div>
    <div class="task-facts">
      <div><span>Asignada a</span><strong class="task-assignee">${avatar(task.assignee)}${escapeHTML(personName(task.assignee))}</strong></div>
      <div><span>Asignada por</span><strong>${escapeHTML(personName(task.createdBy))}</strong></div>
      <div><span>Fecha limite</span><strong class="${due.tone}">${task.dueDate ? `${formatShortDate(task.dueDate)}${task.status !== "completada" && due.tone ? ` · ${due.text}` : ""}` : "Sin fecha"}</strong></div>
      <div><span>Creada</span><strong>${formatDateTime(task.createdAt)}</strong></div>
      ${task.startedAt ? `<div><span>Empezada</span><strong>${formatDateTime(task.startedAt)}</strong></div>` : ""}
      ${task.completedAt ? `<div><span>Completada</span><strong>${formatDateTime(task.completedAt)}</strong></div>` : ""}
    </div>
    <p class="task-detail-section-title">Estado</p>
    <div class="status-picker" role="group" aria-label="Cambiar estado">
      ${STATUSES.map((status) => `<button type="button" data-status="${status.key}" data-task-status="${status.key}" data-task-id="${escapeAttribute(task.id)}" aria-pressed="${task.status === status.key}"><i aria-hidden="true"></i>${status.single}</button>`).join("")}
    </div>
    <p class="task-detail-section-title">Actividad</p>
    <div class="timeline">${assignments.detail.loading && !assignments.detail.events.length ? `<p class="muted">Cargando actividad...</p>` : timelineMarkup(assignments.detail.events)}</div>
    <form class="task-comment-form" id="assignmentCommentForm" novalidate>
      <textarea id="assignmentCommentInput" rows="2" maxlength="2000" placeholder="Escribí un comentario o avance..." aria-label="Comentario"></textarea>
      <button class="primary-button" type="submit">Comentar</button>
    </form>
    ${manager ? `<div class="task-detail-footer">
      <button class="danger-button compact" type="button" data-task-delete="${escapeAttribute(task.id)}">Eliminar tarea</button>
      <button class="ghost-button compact" type="button" data-task-edit="${escapeAttribute(task.id)}">Editar tarea</button>
    </div>` : ""}
  `;
  const input = body.querySelector("#assignmentCommentInput");
  if (input && draft) input.value = draft;
}

function timelineMarkup(events) {
  if (!events.length) return `<p class="muted">Sin actividad todavía.</p>`;
  return events.map((event) => {
    const who = `<strong>${escapeHTML(event.authorName || event.author)}</strong>`;
    const when = `<time datetime="${escapeAttribute(event.createdAt)}" title="${escapeAttribute(formatDateTime(event.createdAt))}">${timeAgo(event.createdAt)}</time>`;
    if (event.kind === "comment") {
      return `<div class="timeline-item">${avatar(event.author)}<div class="timeline-body">${who}${when}<div class="timeline-comment">${escapeHTML(event.body)}</div></div></div>`;
    }
    let text = "";
    let icon = "i-clock";
    if (event.kind === "created") {
      text = "creó y asignó la tarea";
      icon = "i-plus";
    } else if (event.kind === "status") {
      text = `cambió el estado de <b>${statusLabel(event.fromStatus)}</b> a <b>${statusLabel(event.toStatus)}</b>`;
      icon = "i-assign";
    } else {
      text = escapeHTML(event.body || "editó la tarea").replace(/^Cambió/, "cambió");
      icon = "i-settings";
    }
    return `<div class="timeline-item"><span class="timeline-dot"><svg aria-hidden="true"><use href="#${icon}"/></svg></span><div class="timeline-body">${who} ${text}${when}</div></div>`;
  }).join("");
}

async function submitComment(event) {
  event.preventDefault();
  const input = dom.assignmentDetailBody.querySelector("#assignmentCommentInput");
  const text = input?.value.trim();
  if (!text) {
    input?.classList.add("field-error");
    return;
  }
  const id = assignments.detail.id;
  const button = event.target.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    const payload = await taskService.comment(id, text);
    input.value = "";
    replaceTask(payload.task);
    assignments.detail.events = payload.events || [];
    renderAssignments();
  } catch (error) {
    notify("No se pudo comentar", error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- Create / edit ---------- */

function openForm(task = null) {
  if (!canManage()) return;
  dom.assignmentForm.reset();
  dom.assignmentForm.querySelectorAll(".field-error").forEach((control) => control.classList.remove("field-error"));
  dom.assignmentId.value = task?.id || "";
  dom.assignmentFormTitle.textContent = task ? "Editar tarea" : "Nueva tarea";
  dom.assignmentSubmit.textContent = task ? "Guardar cambios" : "Asignar tarea";
  dom.assignmentAssignee.innerHTML = `<option value="">Elegí una persona</option>${assignments.assignees.map((person) => `<option value="${escapeAttribute(person.username)}">${escapeHTML(person.name || person.username)}${person.username === me() ? " (vos)" : ""}</option>`).join("")}`;
  dom.assignmentTitle.value = task?.title || "";
  dom.assignmentDescription.value = task?.description || "";
  dom.assignmentAssignee.value = task?.assignee || assignments.filters.person || "";
  dom.assignmentPriority.value = task?.priority || "media";
  dom.assignmentDueDate.value = task?.dueDate || "";
  openModal("assignmentFormModal");
}

async function submitForm(event) {
  event.preventDefault();
  const required = [dom.assignmentTitle, dom.assignmentAssignee];
  required.forEach((control) => control.classList.toggle("field-error", !control.value.trim()));
  if (dom.assignmentTitle.value.trim().length < 3) {
    dom.assignmentTitle.classList.add("field-error");
    notify("Falta el título", "Escribí un título de al menos 3 caracteres.");
    return;
  }
  if (!dom.assignmentAssignee.value) {
    notify("Falta el responsable", "Elegí a quién se asigna la tarea.");
    return;
  }
  const id = dom.assignmentId.value;
  const input = {
    title: dom.assignmentTitle.value.trim(),
    description: dom.assignmentDescription.value.trim(),
    assignee: dom.assignmentAssignee.value,
    priority: dom.assignmentPriority.value,
    dueDate: dom.assignmentDueDate.value
  };
  dom.assignmentSubmit.disabled = true;
  try {
    const payload = id ? await taskService.update(id, input) : await taskService.create(input);
    replaceTask(payload.task);
    closeModal();
    renderAssignments();
    notify(id ? "Tarea actualizada" : "Tarea asignada", `${payload.task.title} · ${personName(payload.task.assignee)}`);
    if (id && assignments.detail.id === id) {
      assignments.detail.events = payload.events || [];
      openDetail(id);
    }
  } catch (error) {
    notify("No se pudo guardar la tarea", error.message);
  } finally {
    dom.assignmentSubmit.disabled = false;
  }
}

async function removeTask(id) {
  const task = assignments.tasks.find((item) => item.id === id);
  if (!task || !confirm(`Eliminar "${task.title}"? Se borra también su historial y comentarios.`)) return;
  try {
    await taskService.remove(id);
    assignments.tasks = assignments.tasks.filter((item) => item.id !== id);
    assignments.detail = { id: "", events: [], loading: false };
    closeModal();
    renderAssignments();
    notify("Tarea eliminada", task.title);
  } catch (error) {
    notify("No se pudo eliminar", error.message);
  }
}

/* ---------- Events ---------- */

function bindAssignmentEvents() {
  if (bound || !dom.asignacionesView) return;
  bound = true;

  const filterControls = [
    [dom.assignmentFilterPerson, "person", "change"],
    [dom.assignmentFilterPriority, "priority", "change"],
    [dom.assignmentFilterDue, "due", "change"],
    [dom.assignmentFilterTerm, "term", "input"]
  ];
  filterControls.forEach(([control, key, type]) => control?.addEventListener(type, () => {
    assignments.filters[key] = control.value;
    renderAssignments();
  }));
  dom.assignmentHideDone?.addEventListener("change", () => {
    assignments.filters.hideDone = dom.assignmentHideDone.checked;
    renderAssignments();
  });
  document.querySelectorAll("[data-assignment-layout]").forEach((button) => button.addEventListener("click", () => {
    assignments.layout = button.dataset.assignmentLayout;
    try {
      localStorage.setItem(LAYOUT_KEY, assignments.layout);
    } catch {
      // Layout preference is optional.
    }
    renderAssignments();
  }));
  dom.assignmentRefresh?.addEventListener("click", () => loadAssignments().then(() => notify("Tareas", "Lista actualizada.")));
  dom.assignmentNew?.addEventListener("click", () => openForm());
  dom.assignmentForm?.addEventListener("submit", submitForm);

  // One delegated handler for cards, quick actions, team filters, list rows and the detail modal.
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const statusButton = target.closest("[data-task-status]");
    if (statusButton) {
      event.stopPropagation();
      changeStatus(statusButton.dataset.taskId, statusButton.dataset.taskStatus);
      return;
    }
    const editButton = target.closest("[data-task-edit]");
    if (editButton) {
      openForm(assignments.tasks.find((item) => item.id === editButton.dataset.taskEdit));
      return;
    }
    const deleteButton = target.closest("[data-task-delete]");
    if (deleteButton) {
      removeTask(deleteButton.dataset.taskDelete);
      return;
    }
    const teamButton = target.closest("[data-team-person]");
    if (teamButton) {
      const person = teamButton.dataset.teamPerson;
      assignments.filters.person = assignments.filters.person === person ? "" : person;
      renderAssignments();
      return;
    }
    if (target.closest("[data-assignment-create]")) {
      openForm();
      return;
    }
    if (target.closest("[data-assignment-retry]")) {
      loadAssignments();
      return;
    }
    const card = target.closest(".task-card[data-task-id], .task-table tr[data-task-id], .my-task-row[data-task-id]");
    if (card && !target.closest("button:not(.my-task-row), a, select, input, textarea")) {
      openDetail(card.dataset.taskId);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target instanceof Element ? event.target.closest(".task-card[data-task-id], .task-table tr[data-task-id]") : null;
    if (!card || event.target !== card) return;
    event.preventDefault();
    openDetail(card.dataset.taskId);
  });

  dom.assignmentDetailBody?.addEventListener("submit", (event) => {
    if (event.target.id === "assignmentCommentForm") submitComment(event);
  });
  dom.assignmentDetailBody?.addEventListener("keydown", (event) => {
    if (event.target.id === "assignmentCommentInput" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      dom.assignmentDetailBody.querySelector("#assignmentCommentForm")?.requestSubmit();
    }
  });

  // Drag and drop between columns.
  dom.assignmentBoard?.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.(".task-card");
    if (!card) return;
    event.dataTransfer.setData("text/plain", card.dataset.taskId);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  dom.assignmentBoard?.addEventListener("dragend", (event) => {
    event.target.closest?.(".task-card")?.classList.remove("dragging");
    dom.assignmentBoard.querySelectorAll(".drop-target").forEach((column) => column.classList.remove("drop-target"));
  });
  dom.assignmentBoard?.addEventListener("dragover", (event) => {
    const column = event.target.closest?.(".task-column");
    if (!column) return;
    event.preventDefault();
    dom.assignmentBoard.querySelectorAll(".drop-target").forEach((item) => item !== column && item.classList.remove("drop-target"));
    column.classList.add("drop-target");
  });
  dom.assignmentBoard?.addEventListener("drop", (event) => {
    const column = event.target.closest?.(".task-column");
    if (!column) return;
    event.preventDefault();
    column.classList.remove("drop-target");
    const id = event.dataTransfer.getData("text/plain");
    if (id) changeStatus(id, column.dataset.status);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && assignments.loaded && isAuthenticated()) loadAssignments({ silent: true });
  });
}

function readLayout() {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}
