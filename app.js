import { restoreSession } from "./js/auth.js";
import { loadState, SYNC_EVENT } from "./js/storage.js";
import { bindDom, notify, renderAll, resetActionForm, resetBudgetForm, resetClientForm, resetGoalForm, resetInvoiceForm, resetMovementForm, resetNoteForm, resetPaymentForm, resetProjectForm, resetRequestForm, resetSubscriptionForm, resetTaskForm } from "./js/render.js";
import { bindEvents } from "./js/events.js";

document.addEventListener("DOMContentLoaded", async () => {
  bindDom();
  loadState();
  renderAll();
  bindEvents();
  window.addEventListener(SYNC_EVENT, (event) => {
    const { type, message } = event.detail || {};
    if (type === "merged") {
      renderAll();
      notify("Cambios combinados", message);
    } else if (type === "conflict") {
      renderAll();
      notify("Datos actualizados", message);
    } else if (type === "error") {
      notify("Sin sincronizar", message);
    } else if (type === "recovered") {
      notify("Sincronizado", message);
    }
  });
  restoreSession().then(() => {
    renderAll();
    if (!document.getElementById("appShell").hidden) {
      resetForms();
    }
  });
});

function resetForms() {
  resetPaymentForm();
  resetClientForm();
  resetProjectForm();
  resetInvoiceForm();
  resetMovementForm();
  resetSubscriptionForm();
  resetTaskForm();
  resetGoalForm();
  resetRequestForm();
  resetNoteForm();
  resetActionForm();
  resetBudgetForm();
  renderAll();
}
