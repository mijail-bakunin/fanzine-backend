# Contrato HTTP — La Guillotina API v1

Base URL local:

```text
http://localhost:3001/laguillotina/api/v1
```

Las respuestas JSON de error siguen esta forma:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "El pedido contiene datos inválidos.",
    "details": {},
    "requestId": "req-1"
  }
}
```

Las rutas autenticadas usan la cookie `httpOnly` emitida por login/registro y requieren `credentials: "include"`. Las mutaciones autenticadas deben enviar `x-csrf-token`, obtenido en login, registro o `GET /auth/me`.

## Sistema

```text
GET /health
GET /health/ready
```

## Autenticación y perfil

En desarrollo, CORS acepta credenciales desde `http://localhost:5173` y `http://127.0.0.1:5173` para `GET`, `HEAD`, `POST`, `PATCH`, `DELETE` y `OPTIONS`. Los orígenes de producción se configuran mediante `FRONTEND_ORIGINS`.

```text
POST   /auth/register
POST   /auth/login
POST   /auth/logout
GET    /auth/me
PATCH  /auth/profile
PATCH  /auth/preferences
POST   /auth/saved-notes/:noteId/toggle
DELETE /auth/saved-notes
POST   /auth/password/forgot
POST   /auth/password/reset
DELETE /auth/account
GET    /auth/oauth/:provider
GET    /auth/oauth/:provider/callback
```

Registro:

```json
{ "name": "Alias", "email": "alias@example.org", "password": "mínimo 8 caracteres" }
```

Login:

```json
{ "email": "alias@example.org", "password": "..." }
```

Respuesta de registro/login:

```json
{
  "user": {
    "id": "uuid",
    "name": "Alias",
    "email": "alias@example.org",
    "avatarUrl": "",
    "role": "reader",
    "status": "active",
    "savedNoteIds": [],
    "preferences": null
  },
  "csrfToken": "token opaco"
}
```

`POST /auth/password/forgot` siempre devuelve el mismo mensaje. En desarrollo, el enlace queda en `.dev-mailbox/`. OAuth acepta `google` o `x`, pero responde `501` mientras no se active la integración.

## Contenido público

```text
GET /site/settings
GET /catalog?section=all&page=1&pageSize=12&search=&tag=&type=
GET /editions?kind=magazine&page=1&pageSize=12
GET /resources?types=image,video&page=1&pageSize=12
GET /editions/:slug/home
GET /notes/:noteId
GET /notes/:noteId/comments
POST /notes/:noteId/comments
POST /notes/:noteId/comments/:commentId/upvote
POST /notes/:noteId/comments/:commentId/report
POST /notes/:noteId/rating
POST /contacts
POST /analytics/events
```

`GET /site/settings` devuelve marca, consigna, encabezado, navegación, pie y vínculos sociales desde PostgreSQL.

`GET /catalog` está diseñado para la pantalla Archivo y devuelve cuatro colecciones paginadas independientemente: `magazines`, `books`, `showcase` y `multimedia`. `section` evita consultar colecciones innecesarias; `search`, `tag` y `type` filtran contenido publicado con carga completa.

`GET /resources` devuelve solo recursos publicados cuya carga esté completa. `types` es opcional y admite una lista separada por comas: `image`, `video`, `audio`, `pdf` y `link`. Cada recurso incluye `uploadStatus` (`complete` en las respuestas públicas; el dashboard también puede mostrar `pending`, `uploading`, `failed` o `aborted`).

`GET /editions/:slug/home` mantiene el contrato del frontend:

```json
{
  "edition": {
    "id": "uuid",
    "slug": "n-012-la-libertad",
    "number": "Nº 12",
    "title": "La libertad no se pide",
    "date": "Mayo 2024",
    "publication": "La Guillotina",
    "headerLine": "REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD"
  },
  "masthead": { "image": "https://...", "alt": "..." },
  "notes": []
}
```

Cada nota pública incluye `id` público igual al slug, `databaseId`, `fragment`, `x`, `y`, `w`, `h`, `tone`, `title`, `thumbnailText`, `paragraphs`, `tags`, `gallery`, `video`, `rating` y `ratingsCount`.

Comentario:

```json
{ "author": "Anónima", "body": "Texto del comentario" }
```

Se crea como `pending`. Solo `visible` aparece en el listado público.

Rating:

```json
{ "score": 5 }
```

Respuesta:

```json
{ "rating": 4.6, "ratingsCount": 18 }
```

La misma cuenta o cookie funcional actualiza su puntuación en vez de crear otra.

Contacto:

```json
{ "name": "Nombre", "email": "correo@example.org", "subject": "Opcional", "body": "Mensaje" }
```

Analítica, hasta 20 eventos:

```json
{
  "sessionId": "uuid de sessionStorage",
  "events": [
    {
      "type": "page_view",
      "editionSlug": "n-012-la-libertad",
      "source": "https://referencia.example.org",
      "occurredAt": "2026-08-10T12:00:00.000Z"
    }
  ]
}
```

Tipos: `page_view`, `reading_started`, `reading_completed`, `reading_time`, `attention`, `download`, `referral`.

## Administración

Todas requieren una sesión de personal y las mutaciones también CSRF.

| Rol | Acceso |
|---|---|
| `admin` | Todo el tablero, configuración, contenido, moderación y cuentas. |
| `editor` | Configuración editorial, ediciones, notas, categorías, recursos y analítica. |
| `moderator` | Comentarios, reportes y contactos. |

Una sección específica del dashboard fuera del rol responde `403`; `section=all` devuelve únicamente las colecciones permitidas.

```text
GET   /admin/dashboard
GET   /admin/settings
PATCH /admin/settings
POST  /admin/editions
PATCH /admin/editions/:id
POST  /admin/notes
PATCH /admin/notes/:id
POST  /admin/resources
PATCH /admin/resources/:id
POST  /admin/resources/upload
POST  /admin/resources/uploads
POST  /admin/resources/uploads/:id/part
POST  /admin/resources/uploads/:id/complete
DELETE /admin/resources/uploads/:id
POST  /admin/categories
PATCH /admin/categories/:id
PATCH /admin/contacts/:id
PATCH /admin/comments/:id
PATCH /admin/users/:id
```

`PATCH /admin/settings` acepta cualquier subconjunto de `brandName`, `publicationType`, `statement`, `headerLine`, `navigation`, `footerStatement`, `socialPrompt` y `socialLinks`. Cada navegación usa `{ "label", "to", "sortOrder" }`; cada vínculo social usa `{ "label", "url" }`.

### Dashboard

```text
GET /admin/dashboard?page=1&pageSize=25&section=all&status=published&search=libertad&from=2026-07-01T00:00:00.000Z
```

- `pageSize`: 1–100, por defecto 25.
- `section`: `all`, `editions`, `notes`, `resources`, `categories`, `contacts`, `comments`, `users`, `logs`, `analytics`.
- `status`: `draft`, `review`, `scheduled`, `published`, `archived`, `deleted`.
- Respuesta compatible: `editions`, `notes`, `resources`, `categories`, `contacts`, `comments`, `users`, `analytics`, `logs`.
- `pagination` incluye una entrada independiente por colección.

### Ediciones

```json
{
  "title": "Título",
  "subtitle": "Consigna",
  "date": "Agosto 2026",
  "status": "draft",
  "cover": "https://...",
  "noteIds": []
}
```

El número siguiente se calcula dentro de una transacción. Cambiar a `deleted` establece `deletedAt`; no borra la fila.

### Notas

```json
{
  "title": "Título",
  "slug": "opcional",
  "excerpt": "Bajada",
  "body": "Markdown sin HTML crudo",
  "status": "draft",
  "editionId": "uuid o vacío",
  "categoryIds": [],
  "resourceIds": [],
  "author": "Redacción",
  "readingMinutes": 3
}
```

`body` admite hasta 500 KB. La API pública deriva `paragraphs[]` separando bloques Markdown por líneas vacías.

### Recursos externos

```json
{
  "type": "image",
  "name": "Título obligatorio",
  "url": "https://...",
  "alt": "Descripción obligatoria",
  "credit": "Créditos obligatorios",
  "license": "Licencia obligatoria",
  "status": "draft",
  "date": "2026-08-10T00:00:00.000Z"
}
```

Tipos: `image`, `video`, `audio`, `pdf`, `link`.

`PATCH /admin/resources/:id` permite editar `type`, `name`, `url`, `alt`, `credit`, `license`, `status` y `date`. `fileName`, `fileSize`, `mimeType`, `storageDriver` y `uploadStatus` son metadatos de solo lectura derivados al crear o cargar el recurso.

### Carga local

`POST /admin/resources/upload` usa `multipart/form-data` con parte `file` y campos `type`, `name`, `alt`, `credit`, `license`, `status` y `date` opcional.

### Carga S3/R2

Iniciar:

```json
{
  "type": "video",
  "name": "Registro",
  "alt": "Descripción",
  "credit": "Archivo común",
  "license": "Licencia",
  "status": "draft",
  "fileName": "registro.mp4",
  "fileSize": 250000000,
  "mimeType": "video/mp4"
}
```

La respuesta indica `mode: "single"` o `mode: "multipart"`. En multipart, pedir cada URL con `{ "partNumber": 1 }` y completar con:

```json
{ "parts": [{ "partNumber": 1, "etag": "..." }] }
```

### Moderación y cuentas

```json
{ "status": "visible", "moderationNote": "Opcional" }
```

Estados de comentario: `pending`, `visible`, `hidden`, `reported`.

```json
{ "status": "suspended", "role": "moderator" }
```

Estados de cuenta: `active`, `suspended`. Roles: `reader`, `admin`, `editor`, `moderator`. No se permite bloquear la cuenta administradora actual ni dejar el sistema sin una administradora activa.

Respuesta de contacto:

```json
{
  "status": "answered",
  "reply": "Texto de la respuesta",
  "send": true
}
```

`send` es opcional. `status: "answered"` envía automáticamente la respuesta. En desarrollo queda en `.dev-mailbox/`; con `MAIL_MODE=smtp` se entrega por SMTP. La entrega queda registrada como `queued`, `sent` o `failed`.

## Tarea interna

```text
POST /internal/analytics/aggregate
Authorization: Bearer <CRON_SECRET>
```

Agrega eventos de días cerrados en `analytics_daily` y elimina eventos crudos anteriores a la retención configurada.
