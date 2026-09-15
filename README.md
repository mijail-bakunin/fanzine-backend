# Backend de La Guillotina

API externa para la revista/fanzine **La Guillotina**. Vive en un proyecto independiente del frontend y conserva los contratos que consumen los adaptadores de React.

Base local:

```text
http://localhost:3001/laguillotina/api/v1
```

Documentación OpenAPI en desarrollo:

```text
http://localhost:3001/documentation
http://localhost:3001/documentation/json
http://localhost:3001/documentation/yaml
```

El contrato documenta todas las operaciones con parámetros de ruta y consulta, headers, cookie de sesión, CSRF, cuerpos JSON o multipart, restricciones, ejemplos, respuestas de éxito y errores uniformes. La suite falla si aparece una ruta sin documentación centralizada.

## Arquitectura

- Node.js 20 o superior, TypeScript y Fastify 5.
- PostgreSQL 17 y Prisma ORM 7 con el adaptador `pg`.
- Sesiones opacas revocables guardadas en PostgreSQL y cookie `httpOnly`.
- Argon2id para contraseñas y token CSRF rotado por sesión.
- Validación de entrada con Zod y errores HTTP uniformes.
- Recursos reutilizables con proveedor local o S3-compatible.
- Analítica anónima separada de las cuentas y agregación diaria.
- Migraciones reales, seed idempotente y pruebas de integración sobre PostgreSQL.
- Catálogo público paginado y configuración editorial administrable.
- Permisos por capacidad para administración, edición y moderación.

La aplicación se organiza por módulos en `src/modules`: autenticación, contenido público, administración, recursos y analítica. `src/build-app.ts` construye la aplicación sin abrir un puerto, lo que permite pruebas con `Fastify.inject`; `src/app.ts` es el punto de entrada de Docker, Vercel y desarrollo local.

## Requisitos

- Node.js 20+; se probó con Node 24.
- npm 10+.
- Docker Desktop, o instancias accesibles de PostgreSQL y un proveedor S3-compatible para ejecutar la suite integral.

## Inicio local

Desde PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:migrate -- --name init
npm run db:seed
npm run dev
```

La migración inicial ya está incluida. En una instalación nueva también puede aplicarse sin crear otra migración:

```powershell
npm run db:deploy
npm run db:seed
```

Comprobaciones:

```powershell
Invoke-RestMethod http://localhost:3001/laguillotina/api/v1/health
Invoke-RestMethod http://localhost:3001/laguillotina/api/v1/health/ready
```

El frontend debe tener:

```env
VITE_API_BASE_URL=http://localhost:3001/laguillotina/api/v1
```

## Cuentas de desarrollo

El seed crea o actualiza estas cuentas. Las contraseñas se hashean al ejecutarlo.

| Rol | Correo | Contraseña |
|---|---|---|
| Administradora | `admin@laguillotina.local` | `guillotina-admin` |
| Lectora | `prueba@laguillotina.local` | `guillotina` |
| Editora | `editor@laguillotina.local` | `guillotina-editor` |
| Moderadora | `moderador@laguillotina.local` | `guillotina-moderator` |

No deben usarse estas credenciales en producción.

## Migraciones y seed

```powershell
# Crear una migración durante desarrollo
npm run db:migrate -- --name nombre-del-cambio

# Aplicar migraciones existentes en despliegue
npm run db:deploy

# Regenerar el cliente Prisma
npm run db:generate

# Datos de demostración idempotentes
npm run db:seed
```

El seed incluye la edición `n-012-la-libertad`, 16 notas, categorías, recursos de muestra, comentarios, ratings, contactos y métricas.

## Pruebas

Docker crea la base aislada `laguillotina_test`, un servidor MinIO S3-compatible y el bucket `laguillotina-test`. Que el contenedor `minio-init` termine con código `0` es normal: es una tarea de inicialización de una sola ejecución. La suite aplica migraciones automáticamente y nunca trunca la base de desarrollo:

```powershell
npm test
```

La batería contiene **206 escenarios** en dieciséis archivos. No simula éxitos de infraestructura: usa PostgreSQL real, bytes reales en filesystem, archivos reales en el buzón de desarrollo, SMTP por TCP, sockets HTTP y solicitudes firmadas reales contra MinIO, incluidos PUT simples y multipart. La exportación editorial genera y vuelve a abrir PDFs binarios reales para comprobar formato A4, portada, paginación, texto, Unicode, marcadores y enlaces internos. También prueba publicación, fallback, permisos, búsqueda y medios editoriales ES/EN/RU, cobertura visual de las dieciséis notas del seed, cuerpos editoriales multilingües sincronizados, deduplicación de lecturas públicas simultáneas, el Manifiesto desplegable localizado y el asistente simulado público, validado y limitado por cliente. Cada prueba restablece solamente la base y el almacenamiento exclusivos del entorno de test.

Para usar otra base:

```powershell
$env:TEST_DATABASE_URL='postgresql://usuario:clave@host:5432/laguillotina_test?schema=public'
npm test
```

Cobertura funcional incluida:

- salud, readiness, 404, headers de seguridad y CORS permitido/rechazado;
- registro, Argon2id persistido, login, logout, sesión, CSRF, perfil, preferencias, guardadas, baja y recuperación de contraseña;
- cuentas activas, suspendidas y eliminadas, límite de cinco sesiones y rate limiting observado;
- roles `reader`, `admin`, `editor` y `moderator`, permisos por sección y revocación efectiva de sesiones;
- configuración pública, ediciones, notas, catálogo y recursos con paginación, búsquedas, filtros y exclusión de borradores/eliminados;
- creación, actualización, publicación, selección automática de edición vigente, relaciones, estados editoriales, auditoría, numeración concurrente y borrado lógico;
- descarga PDF de ediciones publicadas con portada, índice enlazado, destinos por nota y fallbacks seguros ante recursos ausentes o incompletos;
- comentarios y respuestas anónimas/autenticadas, moderación, reportes, reacciones reversibles, votos idempotentes compatibles y ratings corregibles por identidad;
- contacto, borradores, envío real al buzón de desarrollo, validaciones y límites de abuso;
- cargas locales con comprobación byte a byte, MIME, tamaños, limpieza ante error y servicio HTTP del archivo;
- cargas S3 simples y multipart reales, URLs firmadas, ETags, finalización, mismatch de tamaño, expiración y cancelación;
- analítica anónima, opt-out, DNT/GPC, agregación diaria, retención, idempotencia y dashboard de métricas;
- contrato OpenAPI: todas las rutas registradas deben tener definición, operación, parámetros, bodies y respuestas documentadas.

Para generar el informe de cobertura del código productivo (texto y HTML en `coverage/`):

```powershell
npm run test:coverage
```

La configuración exige **100%** de sentencias, ramas, funciones y líneas. La medición verificada es 1466/1466 sentencias, 1121/1121 ramas, 350/350 funciones y 1294/1294 líneas, con 206 escenarios aprobados. Se incluye el bootstrap `src/app.ts`; sólo se excluyen el cliente Prisma generado y declaraciones TypeScript sin código ejecutable.

Las capas también pueden ejecutarse por separado:

```powershell
npm run test:architecture # 4 restricciones estructurales y de contrato
npm run test:integration  # 107 escenarios con PostgreSQL/filesystem/MinIO/PDF
npm run test:e2e          # 4 recorridos por socket HTTP y bootstrap reales
npm run test:stress       # 3 cargas concurrentes con reporte y umbrales
npm run test:edge         # 41 fallos, fallbacks y estados extremos
```

La última ejecución de estrés local procesó 160 lecturas concurrentes sin fallos, 40 altas editoriales concurrentes sin colisiones y 24 votos simultáneos de una identidad conservando una única fila. El reporte detallado se regenera en `test-results/stress-latest.json` y queda fuera de Git. La metodología, los umbrales y los límites de interpretación están en [docs/TESTING.md](docs/TESTING.md).

También se recomienda ejecutar:

```powershell
npm run typecheck
npm run build
```

## Variables

Todas están descritas en `.env.example`. Las esenciales son:

| Variable | Uso |
|---|---|
| `POSTGRES_PORT` | Puerto local publicado por Docker Compose; por defecto `5432` y configurable cuando otro PostgreSQL ya lo usa. |
| `DATABASE_URL` | PostgreSQL; en serverless debe ser una URL con pooler. |
| `API_PREFIX` | Por defecto `/laguillotina/api/v1`. |
| `FRONTEND_ORIGINS` | Orígenes CORS separados por coma. |
| `COOKIE_SECRET` | Firma de la cookie funcional anónima. |
| `ANONYMOUS_HMAC_SECRET` | Deriva claves de votos y ratings anónimos. |
| `ANALYTICS_HMAC_SECRET` | Deriva identificadores diarios de sesiones analíticas. |
| `CRON_SECRET` | Protege la agregación/limpieza de métricas. |
| `STORAGE_DRIVER` | `local` o `s3`. `local` está prohibido en producción. |
| `PUBLIC_STORAGE_BASE_URL` | URL pública de archivos locales. |
| `MODERATION_EMAIL_IMAGE_URL` | URL pública opcional del panorama del correo de moderación; por defecto usa el recurso seed servido por la API. |
| `S3_*` | Endpoint, región, bucket, credenciales y URL pública S3/R2. |
| `COOKIE_SECURE` | Debe ser `true` con HTTPS. |
| `COOKIE_SAME_SITE` | `lax` bajo el mismo sitio; `none` si el frontend es cross-site. |
| `COOKIE_DOMAIN` | Opcional para compartir sesión entre subdominios. |

Los secretos deben ser diferentes entre entornos y generarse con entropía criptográfica. No se registran contraseñas, cookies, cabeceras de autorización ni tokens de recuperación.

## Autenticación y seguridad

- Registro público siempre crea rol `reader`; el payload no puede autoasignar roles.
- Roles operativos: `reader`, `admin`, `editor`, `moderator`.
- `admin` gestiona todo; `editor` gestiona contenido, recursos, configuración y analítica; `moderator` gestiona comentarios y contactos.
- Se permiten hasta cinco sesiones activas por cuenta; cambiar contraseña revoca las restantes.
- Recuperación de contraseña responde siempre de forma genérica para evitar enumeración.
- En desarrollo, los correos quedan como archivos ignorados por Git en `.dev-mailbox/`; no aparecen en logs.
- El borrado moderado conserva el comentario para auditoría: los anónimos dejan un tombstone público sin cuerpo y los asociados a cuenta desaparecen del público y disparan un aviso por correo. El seed publica la imagen panorámica del aviso como `assets.moderationEmail`.
- Las respuestas de contacto pueden guardarse como borrador o enviarse. En desarrollo quedan en `.dev-mailbox/`; con `MAIL_MODE=smtp` se entregan y registran como `sent` o `failed`.
- La suspensión administrativa es reversible. La baja solicitada anonimiza datos personales, revoca sesiones y conserva comentarios como “Cuenta eliminada”.
- Google y X tienen rutas y variables reservadas, pero responden `501` hasta completar la integración OAuth.
- Login, comentarios, contacto, votos, ratings y analítica tienen límites de frecuencia.

## Recursos y videos

En desarrollo, `POST /admin/resources/upload` recibe `multipart/form-data` y guarda dentro de `storage/`. En producción se usa:

El seed copia la portada editorial incluida en `prisma/assets/` a `storage/seed/` y persiste su URL usando `PUBLIC_STORAGE_BASE_URL`; por eso la API no depende del servidor Vite para mostrar el facsímil.

1. `POST /admin/resources/uploads` para iniciar.
2. PUT directo con URL firmada, o partes firmadas si supera `MULTIPART_THRESHOLD_BYTES`.
3. `POST /admin/resources/uploads/:id/complete` para verificar tamaño y registrar la URL.
4. `DELETE /admin/resources/uploads/:id` para abortar una carga incompleta.

Los videos admiten hasta 500 MB. Otros archivos usan `MAX_DEFAULT_FILE_BYTES`. Un recurso puede enlazarse a muchas notas y ediciones mediante tablas intermedias.

Para R2/S3, el CORS del bucket debe permitir el origen del frontend, métodos `PUT`, `GET`, `HEAD` y exponer `ETag`. Ejemplo conceptual:

```json
[
  {
    "AllowedOrigins": ["https://frontend.example.org"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Las URLs firmadas deben vencer rápido. El backend nunca entrega credenciales del bucket al navegador.

## Analítica y privacidad

El frontend genera un UUID en `sessionStorage`, no en almacenamiento persistente. La API guarda únicamente un HMAC rotado diariamente y nunca persiste IP, correo, ID de cuenta o user-agent. Respeta `Sec-GPC: 1`, `DNT: 1` y la preferencia `analyticsOptOut`.

La tarea protegida agrega días cerrados y elimina eventos crudos según `ANALYTICS_RAW_RETENTION_DAYS`:

```http
POST /laguillotina/api/v1/internal/analytics/aggregate
Authorization: Bearer <CRON_SECRET>
```

Puede ejecutarse mediante Vercel Cron o un cron del hosting.

## Catálogo y configuración pública

- `GET /site/settings?locale=es|en|ru` publica identidad, navegación, pie, autenticación, archivo, páginas institucionales, recursos de estado y SEO guardados en PostgreSQL.
- `GET /catalog` entrega revistas, libros, muestras y multimedia con paginación y filtros.
- `GET /resources` entrega una lista pública simple filtrable por tipo.
- `GET /search` busca y agrupa notas, ediciones y recursos publicados con rutas listas para el frontend.
- `GET /auth/saved-notes` entrega las guardadas enriquecidas y paginadas, sin consultas nota-por-nota.
- `GET/PATCH /admin/settings` administra marca, navegación, pie, páginas y SEO por idioma.

El frontend con `VITE_API_BASE_URL` debe consumir estos contratos como fuente editorial única. Textos técnicos puros (por ejemplo, un aviso de red o un indicador de carga) pueden permanecer en la capa UI, pero imágenes, videos, audio, PDFs, vínculos, cuerpos, resúmenes, comentarios, reacciones y valoraciones proceden de la API.

El catálogo excluye borradores, cargas incompletas y contenido `deleted`.

## Borrado lógico

Ediciones, notas, categorías y recursos usan el estado `deleted` y `deletedAt`. La API pública no ofrece `DELETE` físico para esas entidades. Las relaciones usan restricciones que impiden borrar accidentalmente recursos compartidos.

## Despliegue

### Docker

```powershell
docker build -t backend-guillotina .
docker run --env-file .env -p 3001:3001 backend-guillotina
```

Ejecutar `npm run db:deploy` como paso previo del release. El contenedor de aplicación no modifica el esquema automáticamente.

### Vercel

- Crear un proyecto separado apuntando a la raíz `backend-guillotina`.
- Fastify se detecta desde `src/app.ts` y se despliega como una función.
- Usar PostgreSQL administrado con pooler y backups.
- Configurar `STORAGE_DRIVER=s3`; el filesystem local no es persistente.
- Configurar `COOKIE_SECURE=true`.
- Si frontend y API son cross-site, usar `COOKIE_SAME_SITE=none` y un `FRONTEND_ORIGINS` exacto.
- Ejecutar migraciones fuera de las invocaciones web, como paso de CI/release.

## Contrato HTTP

El listado completo, payloads y formato de errores están en [docs/API.md](docs/API.md). `GET /admin/dashboard` devuelve como máximo una página por colección y agrega metadatos en `pagination`; nunca devuelve tablas completas sin límite.

## Pendientes para producción

- Elegir PostgreSQL administrado y configurar backups/restauración.
- Crear el bucket R2/S3, CORS, dominio público y políticas de ciclo de vida.
- Conectar SMTP y probar entregabilidad, SPF, DKIM y DMARC.
- Completar OAuth Google/X con validación `state`, PKCE y cifrado de tokens.
- Añadir antivirus o pipeline de análisis para archivos propios y derivados WebP/AVIF.
- Configurar observabilidad externa, alertas y retención de logs.
- Reemplazar el rate limiting en memoria por un almacén compartido o protección equivalente del proveedor serverless.
- Definir política editorial de moderación, privacidad y tiempos de retención con asesoramiento legal local.
- Rotar todas las claves y reemplazar las cuentas de demostración.

No quedan funcionalidades locales pendientes en el backend; esta lista depende de proveedores, credenciales, dominios o decisiones operativas de producción.
