// Business rules of each form: extra fields, defaults, suggestions, live previews and helpers
// (budget items editor, invoice totals, payment from invoice, subscription costs...).
import { state } from "./state.js";
import { dom, formatMoney, getClient, getInvoice, getProject } from "./render.js";
import { fillDatalist, registerPreview, refreshPreview, setSelectValue, todayKey } from "./forms.js";

/* ---------- Extra fields per form (record field -> element id) ---------- */

const EXTRA = {
  client: { taxId: "clientTaxId", taxCondition: "clientTaxCondition", industry: "clientIndustry", serviceType: "clientServiceType", source: "clientSource", nextFollowUp: "clientNextFollowUp" },
  project: { type: "projectType", priority: "projectPriority", estimatedHours: "projectEstimatedHours", repoUrl: "projectRepo", designUrl: "projectDesign", deployUrl: "projectDeploy" },
  invoice: { type: "invoiceType", concept: "invoiceConcept", subtotal: "invoiceSubtotal", taxRate: "invoiceTaxRate" },
  payment: { exchangeRate: "paymentExchangeRate", reference: "paymentReference" },
  movement: { method: "movementMethod", clientId: "movementClient", projectId: "movementProject", reference: "movementReference", recurring: "movementRecurring" },
  subscription: { cycle: "subscriptionCycle", account: "subscriptionAccount", url: "subscriptionUrl", paymentMethod: "subscriptionPaymentMethod", autoRenew: "subscriptionAutoRenew", notes: "subscriptionNotes" },
  task: { startDate: "taskStartDate", estimatedHours: "taskEstimatedHours" },
  goal: { unit: "goalUnit", startDate: "goalStartDate", responsible: "goalResponsible", notes: "goalNotes" },
  request: { channel: "requestChannel", estimatedHours: "requestEstimatedHours", billable: "requestBillable", cost: "requestCost" },
  note: { date: "noteDate" },
  action: { type: "actionType", responsible: "actionResponsible", notes: "actionNotes" },
  opportunity: { contact: "opportunityContact", source: "opportunitySource", expectedClose: "opportunityExpectedClose", nextActionDate: "opportunityNextActionDate" },
  budget: { paymentTerms: "budgetPaymentTerms", deliveryTime: "budgetDeliveryTime" },
  calendarEvent: { allDay: "calendarEventAllDay", location: "calendarEventLocation", reminder: "calendarEventReminder" },
  document: { date: "documentDate", expiry: "documentExpiry", visibleToClient: "documentVisibleToClient" },
  support: { domainProvider: "supportDomainProvider", includedHours: "supportIncludedHours", responseTime: "supportResponseTime", billingDay: "supportBillingDay", startDate: "supportStartDate" },
  team: { phone: "teamPhone", area: "teamArea", startDate: "teamStartDate", skills: "teamSkills", rate: "teamRate", rateCurrency: "teamRateCurrency" },
  marketing: { channel: "marketingChannel", responsible: "marketingResponsible", endDate: "marketingEndDate", budget: "marketingBudget", currency: "marketingCurrency" }
};

// Checkboxes that start ticked on a new record.
const CHECKED_BY_DEFAULT = new Set(["subscriptionAutoRenew", "documentVisibleToClient"]);

export function readExtra(form) {
  const result = {};
  for (const [field, id] of Object.entries(EXTRA[form] || {})) {
    const control = document.getElementById(id);
    if (!control) continue;
    if (control.type === "checkbox") result[field] = control.checked;
    else if (control.type === "number") result[field] = control.value === "" ? "" : Number(control.value);
    else result[field] = String(control.value || "").trim();
  }
  return result;
}

export function fillExtra(form, record = {}) {
  for (const [field, id] of Object.entries(EXTRA[form] || {})) {
    const control = document.getElementById(id);
    if (!control) continue;
    const value = record[field];
    if (control.type === "checkbox") control.checked = value === undefined ? CHECKED_BY_DEFAULT.has(id) : Boolean(value);
    else if (control.tagName === "SELECT") setSelectValue(control, value ?? control.options[0]?.value ?? "");
    else control.value = value ?? "";
  }
}

export function resetExtra(form) {
  fillExtra(form, {});
}

/* ---------- Defaults ---------- */

export function mainCurrency() {
  return state.companySettings?.mainCurrency || "ARS";
}

export function nextInvoiceNumber() {
  const prefix = state.companySettings?.invoicePrefix || "F-";
  const numbers = (state.invoices || []).map((invoice) => Number(String(invoice.number || "").replace(/\D/g, "")) || 0);
  return `${prefix}${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}`;
}

export function invoiceDueDays() {
  const days = Number(state.companySettings?.invoiceDueDays);
  return Number.isFinite(days) && days >= 0 ? days : 10;
}

export function budgetValidityDays() {
  const days = Number(state.companySettings?.budgetValidity);
  return Number.isFinite(days) && days > 0 ? days : 15;
}

export { todayKey };

/* ---------- Suggestions ---------- */

const SUBSCRIPTION_CATEGORIES = ["Hosting", "Dominio", "Software", "Diseño", "Marketing", "Infraestructura", "Comunicación", "Contabilidad", "Otro"];
const INDUSTRIES = ["Gastronomía", "Salud", "Inmobiliaria", "Estudio contable", "Estudio jurídico", "Arquitectura", "Educación", "Turismo / hotelería", "Comercio", "Industria", "Tecnología", "Deportes / gimnasios", "Belleza / estética", "ONG"];

const lines = (text) => String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);

export function refreshSuggestions() {
  const accountsNames = (state.users || []).map((user) => user.name);
  fillDatalist("dlTeam", [...(state.teamMembers || []).map((member) => member.name), ...accountsNames]);
  fillDatalist("dlServices", [...lines(state.companySettings?.services), ...(state.clients || []).map((client) => client.service)]);
  fillDatalist("dlCategories", [...lines(state.companySettings?.financeCategories), ...(state.movements || []).map((item) => item.category)]);
  fillDatalist("dlProviders", [
    ...(state.subscriptions || []).map((item) => item.provider),
    ...(state.supportPlans || []).flatMap((item) => [item.hosting, item.domainProvider]),
    "Hostinger", "Vercel", "Netlify", "DonWeb", "NIC.ar", "GoDaddy", "Cloudflare", "Google", "Adobe", "Figma"
  ]);
  fillDatalist("dlIndustries", [...INDUSTRIES, ...(state.clients || []).map((client) => client.industry), ...(state.marketingCampaigns || []).map((item) => item.target)]);
  fillDatalist("dlSubscriptionCategories", [...SUBSCRIPTION_CATEGORIES, ...(state.subscriptions || []).map((item) => item.category)]);
}

/* ---------- Budget items editor ---------- */

export function parseBudgetItems(text) {
  return lines(text).map((line) => {
    const parts = line.split(":");
    const price = Number(parts.pop());
    const maybeQty = Number(parts[parts.length - 1]);
    const hasQty = parts.length > 1 && Number.isFinite(maybeQty);
    if (hasQty) parts.pop();
    return { name: parts.join(":").trim(), quantity: hasQty ? maybeQty : 1, price: Number.isFinite(price) ? price : 0 };
  });
}

function serializeBudgetItems() {
  return [...document.querySelectorAll("#budgetItemRows .item-row")]
    .map((row) => {
      const name = row.querySelector("[data-item='name']").value.trim().replace(/:/g, " -");
      const quantity = Number(row.querySelector("[data-item='quantity']").value) || 0;
      const price = Number(row.querySelector("[data-item='price']").value) || 0;
      return name ? `${name}:${quantity}:${price}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function itemRow(item = { name: "", quantity: 1, price: "" }) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <input data-item="name" type="text" maxlength="160" placeholder="Concepto" aria-label="Concepto">
    <input data-item="quantity" type="number" min="0" step="0.5" inputmode="decimal" aria-label="Cantidad">
    <input data-item="price" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" aria-label="Precio unitario">
    <span class="item-amount"></span>
    <button class="icon-button" type="button" data-item-remove aria-label="Quitar ítem"><svg><use href="#i-close"/></svg></button>`;
  row.querySelector("[data-item='name']").value = item.name || "";
  row.querySelector("[data-item='quantity']").value = item.quantity ?? 1;
  row.querySelector("[data-item='price']").value = item.price ?? "";
  return row;
}

export function loadBudgetItems(text) {
  const container = document.getElementById("budgetItemRows");
  if (!container) return;
  container.innerHTML = "";
  const items = parseBudgetItems(text);
  (items.length ? items : [{ name: "", quantity: 1, price: "" }]).forEach((item) => container.appendChild(itemRow(item)));
  syncBudgetItems();
}

function syncBudgetItems() {
  if (dom.budgetServices) dom.budgetServices.value = serializeBudgetItems();
  document.querySelectorAll("#budgetItemRows .item-row").forEach((row) => {
    const amount = (Number(row.querySelector("[data-item='quantity']").value) || 0) * (Number(row.querySelector("[data-item='price']").value) || 0);
    row.querySelector(".item-amount").textContent = formatMoney(amount, dom.budgetCurrency?.value || "ARS");
  });
  refreshPreview(dom.budgetForm);
}

/** Validation helper for the budget: at least one priced item. */
export function budgetItemErrors() {
  syncBudgetItems();
  const first = document.querySelector("#budgetItemRows [data-item='name']");
  return dom.budgetServices.value ? [] : [[first, "Agregá al menos un ítem con concepto."]];
}

/* ---------- Payment helpers ---------- */

export function paidForInvoice(invoiceId, exceptPaymentId = "") {
  return (state.payments || [])
    .filter((payment) => payment.invoiceId === invoiceId && payment.status === "pagado" && payment.id !== exceptPaymentId)
    .reduce((total, payment) => total + Number(payment.amount || 0), 0);
}

/** When an invoice is chosen, fill client, project, currency and the amount still owed. */
export function applyInvoiceToPayment() {
  const invoice = getInvoice(dom.paymentInvoice.value);
  if (!invoice) return refreshPreview(dom.paymentForm);
  dom.paymentClient.value = invoice.clientId;
  dom.paymentClient.dispatchEvent(new Event("change", { bubbles: true }));
  dom.paymentProject.value = invoice.projectId || "";
  dom.paymentCurrency.value = invoice.currency;
  const pending = Math.max(Number(invoice.amount || 0) - paidForInvoice(invoice.id, dom.paymentId.value), 0);
  if (!dom.paymentId.value) dom.paymentAmount.value = pending ? Number(pending.toFixed(2)) : "";
  if (!dom.paymentDueDate.value) dom.paymentDueDate.value = invoice.dueDate || "";
  refreshPreview(dom.paymentForm);
}

/* ---------- Wiring ---------- */

let wired = false;

export function setupFormBehaviors() {
  if (wired) return;
  wired = true;
  const money = (value, currency) => formatMoney(Number(value) || 0, currency || mainCurrency());
  const box = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  const warn = (text) => `<p class="warn">${text}</p>`;

  // Project: profit, margin and collected %.
  registerPreview(dom.projectForm, () => {
    const budget = Number(dom.projectBudget.value) || 0;
    const paid = Number(dom.projectPaid.value) || 0;
    const expenses = Number(dom.projectExpenses.value) || 0;
    const currency = dom.projectCurrency.value;
    const profit = budget - expenses;
    const linked = dom.projectId.value ? (state.movements || []).filter((item) => item.projectId === dom.projectId.value && item.type === "salida").length : 0;
    dom.projectPreview.innerHTML = budget || paid || expenses
      ? box("Ganancia estimada", money(profit, currency)) + box("Margen", `${budget ? Math.round((profit / budget) * 100) : 0}%`) + box("Cobrado", `${budget ? Math.min(Math.round((paid / budget) * 100), 999) : 0}%`) + box("Falta cobrar", money(Math.max(budget - paid, 0), currency))
        + (paid > budget ? warn("Lo cobrado supera el presupuesto.") : "") + (linked ? warn(`${linked} gasto(s) de Movimientos están vinculados a este proyecto.`) : "")
      : "";
  });
  dom.projectProgress?.addEventListener("input", () => {
    if (dom.projectProgressRange) dom.projectProgressRange.value = dom.projectProgress.value;
  });

  // Invoice: total from net + VAT, duplicate number, payments so far.
  const invoiceTotal = () => {
    const subtotal = Number(dom.invoiceSubtotal.value);
    if (!dom.invoiceSubtotal.value || !Number.isFinite(subtotal)) return;
    const rate = Number(dom.invoiceTaxRate.value) || 0;
    dom.invoiceAmount.value = Number((subtotal * (1 + rate / 100)).toFixed(2));
  };
  dom.invoiceSubtotal?.addEventListener("input", invoiceTotal);
  dom.invoiceTaxRate?.addEventListener("change", invoiceTotal);
  registerPreview(dom.invoiceForm, () => {
    const currency = dom.invoiceCurrency.value;
    const total = Number(dom.invoiceAmount.value) || 0;
    const subtotal = Number(dom.invoiceSubtotal.value) || 0;
    const rate = Number(dom.invoiceTaxRate.value) || 0;
    const paid = dom.invoiceId.value ? paidForInvoice(dom.invoiceId.value) : 0;
    const duplicate = duplicateInvoiceNumber();
    dom.invoicePreview.innerHTML = (subtotal && rate ? box("IVA", money(subtotal * rate / 100, currency)) : "")
      + (total ? box("Total", money(total, currency)) : "")
      + (dom.invoiceId.value ? box("Cobrado", money(paid, currency)) + box("Saldo", money(Math.max(total - paid, 0), currency)) : "")
      + (duplicate ? warn(`Ya existe otra factura con el número ${dom.invoiceNumber.value.trim()}.`) : "");
  });

  // Payment: choose invoice -> fill; show invoice balance; warn on overpayment.
  dom.paymentInvoice?.addEventListener("change", applyInvoiceToPayment);
  registerPreview(dom.paymentForm, () => {
    const invoice = getInvoice(dom.paymentInvoice.value);
    if (!invoice) {
      dom.paymentPreview.innerHTML = "";
      return;
    }
    const paid = paidForInvoice(invoice.id, dom.paymentId.value);
    const pending = Math.max(Number(invoice.amount || 0) - paid, 0);
    const amount = Number(dom.paymentAmount.value) || 0;
    dom.paymentPreview.innerHTML = box("Total factura", money(invoice.amount, invoice.currency)) + box("Ya cobrado", money(paid, invoice.currency)) + box("Saldo", money(pending, invoice.currency))
      + (amount > pending + 0.009 ? warn("Este pago supera el saldo de la factura.") : "")
      + (dom.paymentCurrency.value !== invoice.currency ? warn(`La factura está en ${invoice.currency}.`) : "");
  });

  // Subscription: monthly <-> annual.
  const syncCost = (from) => {
    const monthly = Number(dom.subscriptionMonthly.value);
    const annual = Number(dom.subscriptionAnnual.value);
    if (from === "monthly" && dom.subscriptionMonthly.value !== "") dom.subscriptionAnnual.value = Number((monthly * 12).toFixed(2));
    if (from === "annual" && dom.subscriptionAnnual.value !== "") dom.subscriptionMonthly.value = Number((annual / 12).toFixed(2));
  };
  dom.subscriptionMonthly?.addEventListener("input", () => syncCost("monthly"));
  dom.subscriptionAnnual?.addEventListener("input", () => syncCost("annual"));

  // Goal progress.
  registerPreview(dom.goalForm, () => {
    const target = Number(dom.goalTarget.value) || 0;
    const current = Number(dom.goalCurrent.value) || 0;
    dom.goalPreview.innerHTML = target ? box("Avance", `${Math.round((current / target) * 100)}%`) + box("Falta", String(Math.max(target - current, 0).toLocaleString("es-AR"))) : "";
  });

  // Opportunity weighted value.
  registerPreview(dom.opportunityForm, () => {
    const value = Number(dom.opportunityValue.value) || 0;
    const probability = Math.min(Math.max(Number(dom.opportunityProbability.value) || 0, 0), 100);
    dom.opportunityPreview.innerHTML = value ? box("Valor ponderado", money(value * probability / 100, dom.opportunityCurrency.value)) + box("Si se gana", money(value, dom.opportunityCurrency.value)) : "";
  });

  // Marketing conversion.
  registerPreview(dom.marketingForm, () => {
    const contacts = Number(dom.marketingContacts.value) || 0;
    const responses = Number(dom.marketingResponses.value) || 0;
    const meetings = Number(dom.marketingMeetings.value) || 0;
    const sales = Number(dom.marketingSales.value) || 0;
    const budget = Number(dom.marketingBudget.value) || 0;
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
    dom.marketingPreview.innerHTML = contacts
      ? box("Respuesta", pct(responses, contacts)) + box("A reunión", pct(meetings, responses)) + box("Cierre", pct(sales, contacts)) + (budget && sales ? box("Costo por venta", money(budget / sales, dom.marketingCurrency.value)) : "")
        + (responses > contacts || meetings > responses || sales > contacts ? warn("Revisá los números: cada etapa no puede superar a la anterior.") : "")
      : "";
  });

  // Budget items editor + totals.
  dom.budgetAddItem?.addEventListener("click", () => {
    const row = itemRow();
    document.getElementById("budgetItemRows").appendChild(row);
    row.querySelector("input").focus();
    syncBudgetItems();
  });
  document.getElementById("budgetItemRows")?.addEventListener("input", syncBudgetItems);
  document.getElementById("budgetItemRows")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-item-remove]");
    if (!button) return;
    const rows = document.querySelectorAll("#budgetItemRows .item-row");
    if (rows.length === 1) {
      rows[0].querySelectorAll("input").forEach((input) => {
        input.value = input.dataset.item === "quantity" ? 1 : "";
      });
    } else button.closest(".item-row").remove();
    syncBudgetItems();
  });
  dom.budgetCurrency?.addEventListener("change", syncBudgetItems);
  registerPreview(dom.budgetForm, () => {
    const currency = dom.budgetCurrency.value;
    const subtotal = parseBudgetItems(dom.budgetServices.value).reduce((total, item) => total + item.quantity * item.price, 0);
    const discount = Number(dom.budgetDiscount.value) || 0;
    const taxes = Number(dom.budgetTaxes.value) || 0;
    dom.budgetPreview.innerHTML = subtotal || discount || taxes
      ? box("Subtotal", money(subtotal, currency)) + (discount ? box("Descuento", `- ${money(discount, currency)}`) : "") + (taxes ? box("Impuestos", money(taxes, currency)) : "") + box("Total", money(Math.max(subtotal - discount + taxes, 0), currency))
      : "";
  });

  // Calendar: all-day hides times.
  dom.calendarEventAllDay?.addEventListener("change", syncAllDay);
}

export function syncAllDay() {
  if (!dom.calendarEventAllDay) return;
  const allDay = dom.calendarEventAllDay.checked;
  [dom.calendarEventStart, dom.calendarEventEnd].forEach((input) => {
    input.disabled = allDay;
    if (allDay) input.value = "";
    input.closest("label").hidden = allDay;
  });
}

export function duplicateInvoiceNumber() {
  const number = String(dom.invoiceNumber?.value || "").trim().toLowerCase();
  return Boolean(number) && (state.invoices || []).some((invoice) => invoice.id !== dom.invoiceId.value && String(invoice.number || "").trim().toLowerCase() === number);
}

export function clientLabel(id) {
  return getClient(id)?.company || "";
}

export function projectLabel(id) {
  return getProject(id)?.name || "";
}
