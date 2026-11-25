# sWallet

Sistema interno para administrar sCode Digital Solutions con frontend estatico y API de Vercel.

> Persistencia actual: todos los datos del dashboard se sincronizan contra Supabase Postgres mediante `/api/v1/state`. `localStorage` queda solo como cache local y backup de recuperacion.

## Ejecutar

En local se puede abrir `index.html` con Live Server para revisar UI. Para probar login y sincronizacion remota, correr el proyecto Next/Vercel con variables de Supabase configuradas.

El ingreso es con email y contraseña de **Supabase Auth**. No hay usuarios ni contraseñas en el codigo.

## Vercel + Supabase

Variables requeridas:

```env
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
SUPABASE_URL="https://<project-ref>.supabase.co"
SUPABASE_ANON_KEY="..."
SUPABASE_SERVICE_ROLE_KEY="..."
AUTH_SECRET="clave-larga-privada"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` son obligatorias: si faltan, la API responde 503 en el login. Estan en Supabase > Project Settings > API. La service key es secreta: solo va en Vercel. `TASK_MANAGER_USERS` (opcional, por defecto `maximonewps@gmail.com`) define quien asigna tareas. `API_CORS_ORIGINS` es opcional y solo hace falta si el frontend se sirve desde otro dominio.

Usar en `DATABASE_URL` la URL con pooler y `?pgbouncer=true`. Usar en `DIRECT_URL` la URL para migraciones que muestra Supabase.

Crear las tablas en Supabase con Prisma:

```bash
npm install
npm run db:generate
npx prisma db push
```

La API de Vercel queda expuesta en `/api/v1`:

- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/state`
- `PUT /api/v1/state`

## Estructura

- `index.html`: layout, vistas y formularios.
- `style.css`: tema claro sCode, componentes, responsive y modales.
- `app.js`: inicializador.
- `js/state.js`: estado, modelos locales y datos demo.
- `js/storage.js`: cache local y sincronizacion con Supabase.
- `js/auth.js`: sesion, roles y carga remota.
- `js/finance.js`: calculos, filtros, busqueda y alertas.
- `js/render.js`: render de vistas, tablas, cards, graficos y resets.
- `js/events.js`: eventos, validaciones, CRUD y exportacion CSV.

Documentacion ampliada:

- `docs/ARCHITECTURE.md`: arquitectura actual, capas y criterios de mantenimiento.
- `docs/MODULES.md`: mapa funcional de modulos y relaciones.
- `docs/MIGRATION.md`: ruta para migrar de `localStorage` a backend.
- `docs/QA.md`: checklist de pruebas manuales y comandos de verificacion.

## Modulos

Dashboard, Clientes, CRM/Ventas, Proyectos, Finanzas, Pagos, Facturacion, Presupuestos, Calendario, Administracion, Tareas, Metas, Documentos, Soporte, Equipo, Marketing, Portal Cliente, Movimientos, Reportes, Suscripciones y Configuracion.

## Automatizaciones Locales

El dashboard calcula automaticamente agenda de hoy, pagos vencidos, tareas vencidas, proyectos atrasados, renovaciones proximas, presupuestos por vencer e insights de reportes. Desde CRM y Presupuestos se pueden crear proyectos asociados al cliente.

## Filtros Y Acciones Rapidas

CRM, Presupuestos, Documentos, Soporte y Marketing tienen filtros propios por cliente, estado, tipo y busqueda. Los presupuestos se pueden duplicar, marcar como enviados/rechazados, convertir en proyecto e imprimir como vista PDF desde el navegador.

## Configuracion Y Backup

En `Configuracion` se editan los datos de empresa, color principal, monedas, servicios, categorias financieras y dias de recordatorio. Tambien se puede exportar un backup JSON completo e importar uno anterior.

## Usuarios Y Roles

Las cuentas viven en Supabase Auth (Authentication > Users). El rol (`admin`, `finanzas`, `solo_lectura`), el estado y los modulos se guardan en `app_metadata`, que solo puede escribir el servidor con la service key; nombre, telefono, area y foto en `user_metadata`.

- La primera cuenta (la de Maxi, `maximonewps@gmail.com`) se crea en Supabase: Authentication > Users > Add user > Create new user, con "Auto Confirm User" tildado. Esa cuenta es siempre admin y es la unica que asigna tareas.
- El resto lo crea un admin desde Configuracion > Usuarios y roles, con una contraseña temporal que la persona cambia desde Configuracion > Sesion actual.
- Desactivar un usuario lo bloquea tambien en Supabase (ban), asi que no puede volver a entrar ni renovar la sesion.

## Auditoria

Cada alta, edicion, eliminacion o cambio relevante ejecutado desde la UI queda registrado en `activityLogs`. El historial se ve en `Configuracion` y el admin puede limpiarlo.

## Validaciones

Los formularios validan campos obligatorios, emails, URLs, montos minimos/maximos, fechas coherentes, clientes/proyectos relacionados y duplicados clave como clientes por email, proyectos por nombre, facturas por numero y suscripciones por nombre.

## Flujo Basico

1. Crear cliente en `Clientes`.
2. Crear proyecto asociado en `Proyectos`.
3. Registrar facturas en `Facturacion` y cobros en `Pagos`.
4. Organizar trabajo en `Tareas`, `Administracion`, `Calendario` y `CRM`.
5. Revisar estado general en `Dashboard` y `Reportes`.

## Persistencia

La base usa Prisma sobre Supabase Postgres. La tabla `AppSnapshot` guarda el estado completo del dashboard (un unico snapshot compartido por todos los usuarios), conservando `schemaVersion` y las migraciones automaticas de `js/storage.js`.

Cada `PUT /api/v1/state` envia `baseUpdatedAt` (la version que el navegador vio por ultima vez). Si otro usuario guardo antes, la API responde `409` con la version actual y el navegador combina ambas versiones (`js/sync-merge.js`, fusion de tres vias por registro y por campo): los cambios en registros o campos distintos se suman sin perder nada. Si los dos cambiaron el mismo campo queda el valor propio, y la diferencia se lista en `Configuracion > Persistencia` para elegir "Usar el del otro". Si uno elimino un registro que el otro edito, se conserva y se ofrece "Eliminar igualmente". Si la fusion falla 5 veces seguidas, se carga la version del servidor y la propia queda como respaldo descargable en la misma pantalla. Si el guardado falla por red, se reintenta cada 15 s y el navegador avisa antes de cerrar la pestana con cambios sin sincronizar.

Documentacion tecnica nueva:

- `docs/LOCAL_STORAGE_CONTRACT.md`: shape actual de `scodeFinanceApp` y entidades detectadas.
- `docs/BACKEND_MIGRATION_PLAN.md`: arquitectura objetivo, fases y validaciones.
- `backend/README.md`: backend Express inicial, aislado del frontend.

## Verificacion Tecnica

```bash
npm run validate:static
node --check app.js
node --check js/auth.js
node --check js/events.js
node --check js/finance.js
node --check js/render.js
node --check js/state.js
node --check js/storage.js
```
