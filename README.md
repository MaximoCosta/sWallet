# sWallet

Sistema interno de sCode Digital Solutions: finanzas, clientes, proyectos, facturación y tareas del equipo.

- **App**: página estática (`index.html`, `style.css`, `app.js`, `js/`) servida por Next en `/app`.
- **API**: una sola ruta de Next en `src/app/api/v1/[[...path]]/route.ts`.
- **Datos**: Postgres de Supabase, una tabla por entidad.
- **Login**: Supabase Auth (email + contraseña).

Producción: https://s-wallet-theta.vercel.app/app

## Estructura

```
index.html, style.css, app.js, js/   La app (se edita acá; `npm run sync:public` la copia a public/)
src/app/api/v1/[[...path]]/route.ts  API: login, datos, usuarios, tareas
src/lib/supabase-auth.ts             Supabase Auth: sesiones, roles, alta/baja de usuarios, fotos
src/lib/collections.ts               Entidades y sus relaciones (cliente, proyecto, factura)
src/lib/data-store.ts                Lectura y escritura por registro, versiones, historial
src/lib/migrations.ts                Esquema de la base (se aplica solo, una vez por paso)
src/lib/app-tasks.ts                 Tareas que asigna Maxi al equipo
```

`public/` es una copia generada: `npm run build` y `npm run dev` la actualizan solos.

## Cómo se guardan los datos

Cada entidad (clientes, proyectos, facturas, pagos, movimientos, presupuestos, etc.) es una tabla con:

- `id`, `data` (el registro), `version`, `created_at`, `updated_at`, `created_by`, `updated_by`
- columnas `client_id`, `project_id`, `invoice_id` con **claves foráneas**: la base no acepta un registro que apunte a algo que no existe.

Reglas:

- **Se guarda registro por registro.** Dos personas editando cosas distintas no se pisan.
- **Versión por registro.** Si dos personas editan el mismo registro, gana la primera; la segunda recibe un aviso y ve la versión guardada.
- **Borrar un cliente** con proyectos, facturas u otros registros asociados está bloqueado.
- **Borrar un proyecto o una factura** deja a los registros que la usaban sin ese vínculo (quedan como "General").
- **Historial**: cada alta, edición y baja queda en `audit_log` y se ve en Configuración.
- **Fotos de perfil** en Supabase Storage (bucket `avatars`), no dentro de los datos.
- **RLS activado** en todas las tablas sin políticas: solo el servidor accede, la API pública de Supabase no.

El navegador guarda una copia en `localStorage` para abrir rápido y no perder cambios sin conexión; cada 20 segundos trae lo que cambiaron los demás.

## Usuarios y roles

Las cuentas viven en Supabase Auth (Authentication > Users).

- `app_metadata`: rol (`admin`, `finanzas`, `solo_lectura`), estado y módulos. Solo lo escribe el servidor.
- `user_metadata`: nombre, teléfono, área, notas, foto.
- **admin**: todo, incluido borrar y administrar usuarios. **finanzas**: crea y edita. **solo_lectura**: solo ve.
- La cuenta de `TASK_MANAGER_USERS` (Maxi) es siempre admin, la única que asigna tareas, y no se puede desactivar ni borrar.
- Los demás usuarios los crea un admin en Configuración > Usuarios y roles, con contraseña temporal.
- Desactivar un usuario lo bloquea en Supabase (ban): no puede entrar ni renovar la sesión.

## Variables de entorno (Vercel)

```env
DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://...pooler.supabase.com:5432/postgres"
SUPABASE_URL="https://<project-ref>.supabase.co"
SUPABASE_ANON_KEY="..."
SUPABASE_SERVICE_ROLE_KEY="..."        # secreta: solo en Vercel
TASK_MANAGER_USERS="maximonewps@gmail.com"
```

Opcional: `API_CORS_ORIGINS` (solo si la app se sirve desde otro dominio).

## Desarrollo local

```bash
npm install
docker compose up -d          # Postgres local (opcional)
cp .env.example .env          # completar
npm run dev                   # http://localhost:3000/app
```

Chequeos: `npm run typecheck`, `npm run validate:static`, `npm run build`.
