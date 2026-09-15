# Contrato HTTP — La Guillotina API v1

## Composición visual de portada

Las coordenadas de las notas usan la escala nominal completa de la maqueta: `1055 × 1492`. El masthead ocupa las primeras `440` unidades verticales, por lo que los fragmentos editoriales admiten `x` entre `0` y `1054`, `y` entre `440` y `1491`, `w` entre `1` y `1055` y `h` entre `1` y `1052`. Además, el rectángulo final debe cumplir `x + w <= 1055` y `y + h <= 1492`. La respuesta pública repite esta geometría en `masthead.canvas`; el cliente debe escalar `masthead.referenceImage` a ese lienzo nominal antes de recortar, sin asumir que las dimensiones intrínsecas del archivo coinciden píxel a píxel.

`PATCH /admin/notes/:id` acepta cambios parciales de `fragment`, `x`, `y`, `w`, `h`, `tone`, `coverDepth`, `sortOrder` y `coverButtonPosition`. La API valida la composición resultante con los valores ya persistidos; no aplica clamping silencioso. Una composición fuera del lienzo responde `400 VALIDATION_ERROR`. Los endpoints públicos de edición ordenan las notas por `sortOrder` ascendente y luego por fecha de creación ascendente.

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

El contrato OpenAPI ejecutable se publica en `/documentation` (interfaz), `/documentation/json` y `/documentation/yaml`. Incluye parámetros, cuerpos, headers, seguridad, ejemplos, esquemas de respuesta y errores por operación; este documento narrativo complementa las decisiones y los flujos.

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
GET    /auth/saved-notes?locale=es&page=1&pageSize=12
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
GET /site/settings?locale=es
GET /catalog?section=all&page=1&pageSize=12&search=&tag=&type=&locale=es
GET /editions?kind=magazine&page=1&pageSize=12&locale=es
GET /resources?types=image,video&page=1&pageSize=12&locale=es
GET /search?q=memoria&locale=es&page=1&pageSize=12
GET /editions/current/home?locale=es
GET /editions/:slug/home?locale=es
GET /editions/:slug/pdf?locale=es
GET /notes/:noteId?locale=es
GET /notes/:noteId/comments
POST /notes/:noteId/comments
POST /notes/:noteId/comments/:commentId/replies
POST /notes/:noteId/comments/:commentId/reactions
POST /notes/:noteId/comments/:commentId/upvote
POST /notes/:noteId/comments/:commentId/report
POST /notes/:noteId/rating
POST /contacts
POST /analytics/events
```

Los endpoints editoriales aceptan `locale=es|en|ru`; el valor por defecto es `es`. La localización se resuelve en el backend y una traducción ausente o no publicada usa el texto editorial base, sin intervención ni traducción recursiva del frontend. La respuesta informa `requestedLocale`, `locale` y `translationFallback`.

Las mutaciones administrativas de ediciones, notas, recursos y categorías aceptan `translations.es|en|ru`. Cada variante usa exclusivamente `draft`, `review` o `published`; el ciclo editorial completo continúa en el `status` raíz. El español raíz sigue siendo canónico por compatibilidad. Una edición localizada publicada exige además `masthead.image` y `masthead.alt`, lo que permite servir portadas gráficas distintas para «La Guillotina», «The Guillotine» y «Гильотина». Opcionalmente acepta `masthead.referenceImage`, que identifica la lámina completa destinada a recortes; cuando se omite, la API usa `masthead.image` como referencia.

## Asistente simulado

`POST /assistant/messages` es público y anónimo. Acepta `{ message, locale?, conversationId? }`, no requiere cookie ni CSRF, no persiste conversaciones y no utiliza OpenAI ni credenciales externas. Devuelve `{ conversationId, reply: { id, role, text, createdAt }, requestId }`. Las respuestas son deterministas y están localizadas en ES/EN/RU. El límite es de 10 solicitudes por minuto por cliente; al superarlo responde `429 RATE_LIMIT_EXCEEDED` con `Retry-After` y headers `X-RateLimit-*`.

`GET /site/settings` es la fuente única del contenido global visible. Conserva los campos planos compatibles (`brandName`, `publicationType`, `statement`, `headerLine`, `navigation`, `footerStatement`, `socialPrompt`, `socialLinks`) y agrega `brand`, `footer`, `authentication`, `archive`, `pages`, `assets` y `seo`. `pages` incluye `about`, `manifesto`, `collaborate`, `contact`, `help`, `soon` y `notFound`; URLs, etiquetas de formulario, donación y textos de estado se almacenan en PostgreSQL. `pages.manifesto` mantiene `statements` y agrega opcionalmente `items`, cuyos bloques tienen `id`, `title` y entre dos y tres `paragraphs`; las variantes se resuelven mediante `locale=es|en|ru`.

`GET /search` reemplaza el índice editorial local. Devuelve `items`, los grupos derivados `groups.notes|editions|resources`, `pagination` y `filters`. Cada resultado contiene `id`, `slug`, `type`, `title`, `description`, `tags`, `route`, `editionSlug` e `image`; sólo busca contenido publicado y recursos con carga completa.

`GET /catalog` está diseñado para la pantalla Archivo y devuelve cuatro colecciones paginadas independientemente: `magazines`, `books`, `showcase` y `multimedia`. `section` evita consultar colecciones innecesarias; `search`, `tag` y `type` filtran contenido publicado con carga completa.

`GET /resources` devuelve solo recursos publicados cuya carga esté completa. `types` es opcional y admite una lista separada por comas: `image`, `video`, `audio`, `pdf` y `link`. Cada recurso incluye `uploadStatus` (`complete` en las respuestas públicas; el dashboard también puede mostrar `pending`, `uploading`, `failed` o `aborted`).

`GET /editions/current/home` devuelve la revista `published` con `publishedAt` más reciente. Publicar una edición con `PATCH /admin/editions/:id` y `{ "status": "published" }` asigna `publishedAt` en el servidor y hace que esa edición alimente la portada vigente. Si no existe ninguna revista publicada, responde `404 CURRENT_EDITION_NOT_FOUND`.

`GET /editions/:slug/pdf` sólo admite ediciones publicadas y responde `application/pdf` descargable. El documento A4 se genera en el backend con portada, índice clickeable, marcadores del visor, destinos internos y una sección por nota publicada. `locale=es|en|ru` localiza el contenido disponible y las etiquetas del documento. Una portada ausente, incompleta o inaccesible no rompe la descarga: se usa una cubierta técnica neutra, nunca contenido editorial inventado.

`GET /editions/:slug/home` mantiene el contrato del frontend:

```json
{
  "edition": {
    "id": "uuid",
    "slug": "n-012-la-libertad",
    "number": 12,
    "title": "La libertad no se pide",
    "date": "Mayo 2024",
    "publication": "La Guillotina",
    "headerLine": "REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD",
    "coverArt": { "preset": "archive", "elements": [] }
  },
  "masthead": { "image": "https://...", "referenceImage": "https://...", "alt": "...", "canvas": { "width": 1055, "height": 1492, "mastheadHeight": 440 } },
  "notes": []
}
```

Cada nota pública incluye `id` público igual al slug, `databaseId`, `fragment`, `x`, `y`, `w`, `h`, `tone`, `title`, `subtitle`, `summary`, `excerpt`, `thumbnailText`, `bodyMarkdown`, `paragraphs`, `author`, `readingMinutes`, `tags`, `categoryIds`, `resources`, `thumbnail`, `gallery`, `video`, `rating`, `ratingsCount` y los metadatos opcionales de composición `coverTitleLines`, `coverExcerpt`, `coverButtonPosition`, `coverDepth`/`cover`.

`resources` normaliza imagen, video, audio, PDF y vínculo con `id`, `type`, `name`/`title`, `url`, `alt`, `credit`, `license`, `status`, `uploadStatus`, `fileName`, `fileSize`, `mimeType`, `storageDriver`, dimensiones/duración disponibles y fechas. Audio y video pueden incluir `poster`; `thumbnail`, `gallery` y `video` son vistas de conveniencia derivadas de esos mismos recursos, no fallbacks locales.

### Notas guardadas enriquecidas

`GET /auth/saved-notes` requiere sesión, pero no CSRF por ser lectura. Devuelve sólo notas publicadas, en orden descendente de guardado:

```json
{
  "items": [{
    "id": "freedom",
    "databaseId": "uuid",
    "slug": "freedom",
    "title": "La libertad no se pide",
    "thumbnailText": "Resumen editorial",
    "tone": "red",
    "editionSlug": "n-012-la-libertad",
    "image": { "url": "https://...", "alt": "..." },
    "savedAt": "2026-08-13T12:00:00.000Z"
  }],
  "pagination": { "page": 1, "pageSize": 12, "total": 1, "totalPages": 1 }
}
```

Comentario:

```json
{ "author": "Anónima", "body": "Texto del comentario" }
```

Se crea como `pending` y la respuesta `201` ya incluye `status`, `isAnonymous`, `authorType` y `moderationMessage`. `GET /notes/:noteId/comments` devuelve como máximo 200 comentarios totales: raíces con `parentId: null`, `votes`, `reactionsCount` y respuestas de primer nivel en `replies[]`. Expone `visible` y `pending`; nunca expone `hidden` ni `reported`. Un comentario anónimo `deleted` aparece como tombstone (`body: ""`, `isAnonymous: true`); uno de cuenta deja de aparecer.

Respuesta a un comentario principal (un solo nivel, también pendiente de moderación):

```json
{ "author": "Anónima", "body": "Texto de la respuesta" }
```

Reacción reversible por cuenta o cookie anónima:

```json
{ "reaction": "like" }
```

`POST .../reactions` agrega o retira el like y devuelve `reaction`, `reacted` y el conteo actualizado. El endpoint histórico `POST .../upvote` se conserva: agrega el like de manera idempotente, pero no lo retira.

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
DELETE /admin/editions/:id
POST  /admin/notes
PATCH /admin/notes/:id
DELETE /admin/notes/:id
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

`PATCH /admin/settings` acepta cualquier subconjunto de `brandName`, `publicationType`, `statement`, `headerLine`, `navigation`, `footerStatement`, `socialPrompt`, `socialLinks`, `contentByLocale` y `seoByLocale`. Cada navegación usa `{ "label", "to", "sortOrder" }`; cada vínculo social usa `{ "label", "url", "icon?" }`. Los mapas localizados se validan completos antes de persistirlos.

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
  "noteIds": [],
  "coverArt": {
    "preset": "riot",
    "elements": [{
      "id": "tape-top",
      "type": "tape",
      "tone": "red",
      "x": 40,
      "y": 30,
      "w": 260,
      "h": 70,
      "rotation": -8,
      "depth": 12
    }]
  }
}
```

`coverArt` persiste la dirección de arte de cada edición sin aceptar CSS, HTML ni URLs arbitrarias. `preset` admite `archive`, `riot`, `night`, `signal` o `ash`; cada elemento admite `type` `tape|staples|coffee|burn|stamp|brush` y `tone` `paper|red|yellow|cyan|lime|ink`. La maqueta nominal mide 1055 × 1492: todas las coordenadas son enteras, `x/y >= 0`, `w/h >= 1`, `x + w <= 1055`, `y + h <= 1492`, `rotation` va de -30 a 30 y `depth` de 0 a 100. Los ids deben ser únicos y se admiten como máximo 12 elementos.

En `POST`, omitir `coverArt` aplica `{ "preset": "archive", "elements": [] }`. En `PATCH`, `coverArt` es parcial: enviar sólo `preset` conserva los elementos; enviar `elements` reemplaza la colección completa. La respuesta lo incluye en la edición creada/actualizada, `GET /admin/dashboard?section=editions`, `GET /editions`, `GET /catalog`, `GET /editions/:slug/home` y `GET /editions/current/home` (en estos dos últimos bajo `edition.coverArt`). Un valor histórico inválido degrada de forma segura al preset `archive` sin romper la lectura pública.

El número siguiente se calcula dentro de una transacción. `admin` y `editor` pueden crear, editar, publicar y eliminar lógicamente; `moderator` recibe `403`. Publicar se realiza con:

```json
{ "status": "published" }
```

La respuesta es `200` con la edición actualizada; desde ese momento `GET /editions/current/home` la devuelve si es la revista publicada más reciente. Las fechas editoriales sólo cambian cuando hay una transición real de estado: reenviar `status: "published"` sobre una edición ya publicada no renueva `publishedAt` ni altera la portada vigente. `DELETE /admin/editions/:id` es explícitamente lógico: responde `200`, conserva la fila y sus relaciones, y establece `status: "deleted"` y `deletedAt`. `PATCH` con `status: "deleted"` conserva la misma semántica por compatibilidad.

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
  "readingMinutes": 3,
  "coverTypography": {
    "titleSize": "display",
    "titleAlign": "left",
    "titleTreatment": "brush",
    "excerptSize": "large"
  }
}
```

`body` admite hasta 500 KB. La API pública deriva `paragraphs[]` separando bloques Markdown por líneas vacías.

`coverTypography` controla únicamente estilos tipográficos editoriales predefinidos de la nota en portada. `titleSize` admite `compact|standard|display`; `titleAlign`, `left|center|right`; `titleTreatment`, `brush|block|torn`; y `excerptSize`, `compact|standard|large`. El objeto es estricto: CSS, HTML, medidas libres y propiedades desconocidas se rechazan con `400 VALIDATION_ERROR`.

En `POST /admin/notes`, omitirlo aplica `{ "titleSize":"standard", "titleAlign":"left", "titleTreatment":"brush", "excerptSize":"standard" }`. En `PATCH /admin/notes/:id` es parcial: las propiedades omitidas conservan su valor. Se devuelve en POST/PATCH, `GET /admin/dashboard?section=notes`, `GET /notes/:id`, `GET /editions/:slug/home` y `GET /editions/current/home` dentro de cada nota pública. Sólo `admin` y `editor` pueden modificarlo.

`DELETE /admin/notes/:id` aplica borrado lógico con respuesta `200`: establece `status: "deleted"` y `deletedAt`, preservando comentarios, métricas y relaciones para auditoría. Sólo `admin` y `editor` pueden usar las mutaciones editoriales.

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
{ "status": "deleted", "moderationReason": "Incumple las pautas comunitarias." }
```

Estados de comentario: `pending`, `visible`, `hidden`, `reported`, `deleted`. `moderationNote` sigue aceptado como alias legado, pero no puede enviarse junto con `moderationReason`. Si el motivo se omite al borrar, la API aplica una explicación comunitaria predeterminada.

`PATCH /admin/comments/:id` requiere sesión de `admin` o `moderator` y CSRF. El borrado es lógico: conserva texto, autor, motivo y fecha en el dashboard. Para comentarios asociados a una cuenta, envía un aviso automático con la imagen panorámica publicada en `GET /site/settings` bajo `assets.moderationEmail`; en desarrollo deja un JSON `comment_removal` en `.dev-mailbox/`. Un fallo de correo no revierte la moderación y se informa mediante `emailDelivery.status: "failed"`.

`GET /admin/dashboard?section=comments&status=deleted&page=1&pageSize=25` devuelve cuerpo original, `isAnonymous`, `authorType`, `moderationReason`, `moderatedAt`, `moderatedBy`, `deletedAt` y `emailDelivery`, sin incluir la dirección de correo. La auditoría correlacionable se consulta con `GET /admin/dashboard?section=logs`; cada registro incluye actor, entidad, requestId y metadata segura.

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
