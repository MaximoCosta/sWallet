// The business entities the app stores, one Postgres table each.
// `key` is the name the browser uses (state.clients, state.calendarEvents...); `table` is the SQL table.
// `relations` become real foreign-key columns, so the database rejects a record that points to
// a client, project or invoice that does not exist. The rest of each record lives in `data` (jsonb).
//
// Order matters: parents first. Writes are applied in this order and deletes in reverse.

export type Relation = { field: "clientId" | "projectId" | "invoiceId"; column: "client_id" | "project_id" | "invoice_id"; references: string };

export type CollectionDef = {
  key: string;
  table: string;
  label: string;
  relations: Relation[];
};

const client: Relation = { field: "clientId", column: "client_id", references: "clients" };
const project: Relation = { field: "projectId", column: "project_id", references: "projects" };
const invoice: Relation = { field: "invoiceId", column: "invoice_id", references: "invoices" };

export const COLLECTIONS: CollectionDef[] = [
  { key: "clients", table: "clients", label: "Cliente", relations: [] },
  { key: "projects", table: "projects", label: "Proyecto", relations: [client] },
  { key: "invoices", table: "invoices", label: "Factura", relations: [client, project] },
  { key: "payments", table: "payments", label: "Pago", relations: [client, project, invoice] },
  { key: "movements", table: "movements", label: "Movimiento", relations: [client, project] },
  { key: "subscriptions", table: "subscriptions", label: "Suscripcion", relations: [] },
  { key: "tasks", table: "project_tasks", label: "Tarea de proyecto", relations: [client, project] },
  { key: "goals", table: "goals", label: "Meta", relations: [] },
  { key: "requests", table: "client_requests", label: "Pedido", relations: [client, project] },
  { key: "notes", table: "client_notes", label: "Nota", relations: [client, project] },
  { key: "actions", table: "client_actions", label: "Accion", relations: [client, project] },
  { key: "opportunities", table: "opportunities", label: "Oportunidad", relations: [client] },
  { key: "budgets", table: "budgets", label: "Presupuesto", relations: [client] },
  { key: "calendarEvents", table: "calendar_events", label: "Evento", relations: [client, project] },
  { key: "documents", table: "documents", label: "Documento", relations: [client, project] },
  { key: "supportPlans", table: "support_plans", label: "Mantenimiento", relations: [client, project] },
  { key: "teamMembers", table: "team_members", label: "Miembro del equipo", relations: [] },
  { key: "marketingCampaigns", table: "marketing_campaigns", label: "Campana", relations: [] },
  { key: "clientPortalItems", table: "client_portal_items", label: "Recurso del portal", relations: [client] }
];

export const COLLECTION_BY_KEY = new Map(COLLECTIONS.map((def) => [def.key, def]));

/** Collections that point to a given parent, with the column they use. */
export function dependents(parentKey: string) {
  return COLLECTIONS.flatMap((def) =>
    def.relations.filter((relation) => relation.references === parentKey).map((relation) => ({ def, relation }))
  );
}
