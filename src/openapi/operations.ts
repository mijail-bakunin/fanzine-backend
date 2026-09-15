import type { OpenAPIV3 } from 'openapi-types';
import { schemaRef } from './schemas.js';

type Operation = OpenAPIV3.OperationObject;
type Schema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;

const csrf: OpenAPIV3.ReferenceObject = { $ref: '#/components/parameters/CsrfToken' };
const sessionSecurity: OpenAPIV3.SecurityRequirementObject[] = [{ cookieAuth: [] }];
const optionalSessionSecurity: OpenAPIV3.SecurityRequirementObject[] = [{}, { cookieAuth: [] }];
const cronSecurity: OpenAPIV3.SecurityRequirementObject[] = [{ cronBearer: [] }];
const status: OpenAPIV3.SchemaObject = { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted'] };
const dashboardStatus: OpenAPIV3.SchemaObject = { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted', 'pending', 'visible', 'hidden', 'reported'] };
const resourceType: OpenAPIV3.SchemaObject = { type: 'string', enum: ['image', 'video', 'audio', 'pdf', 'link'] };
const tone: OpenAPIV3.SchemaObject = { type: 'string', enum: ['red', 'yellow', 'cyan', 'lime'] };
const uuid: OpenAPIV3.SchemaObject = { type: 'string', format: 'uuid' };
const translations = (schema: 'EditionTranslations' | 'NoteTranslations' | 'ResourceTranslations' | 'CategoryTranslations'): Schema => ({ allOf: [schemaRef(schema)], description: 'Variantes editoriales ES/EN/RU. La raíz existente continúa siendo el español canónico. Sólo las variantes published se exponen públicamente.' });

function path(name: string, description: string, schema: Schema = { type: 'string' }): OpenAPIV3.ParameterObject {
  return { name, in: 'path', required: true, description, schema };
}

function query(name: string, description: string, schema: Schema, example?: unknown): OpenAPIV3.ParameterObject {
  return { name, in: 'query', required: false, description, schema, ...(example !== undefined ? { example } : {}) };
}

function jsonBody(schema: Schema, example?: unknown, description?: string): OpenAPIV3.RequestBodyObject {
  return { required: true, ...(description ? { description } : {}), content: { 'application/json': { schema, ...(example !== undefined ? { example } : {}) } } };
}

function jsonResponse(description: string, schema: Schema, example?: unknown, setCookie = false): OpenAPIV3.ResponseObject {
  return {
    description,
    ...(setCookie ? { headers: { 'Set-Cookie': { $ref: '#/components/headers/SetCookie' } } } : {}),
    content: { 'application/json': { schema, ...(example !== undefined ? { example } : {}) } },
  };
}

function pdfResponse(description: string): OpenAPIV3.ResponseObject {
  return {
    description,
    headers: {
      'Content-Disposition': { description: 'Nombre de archivo de descarga.', schema: { type: 'string', example: 'attachment; filename="n-012-la-libertad-es.pdf"' } },
      'Content-Length': { description: 'Tamaño del PDF en bytes.', schema: { type: 'integer', minimum: 1 } },
    },
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
  };
}

const noContent = (description: string): OpenAPIV3.ResponseObject => ({ description });
const error = (code: number): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/responses/Error${code}` });
const withErrors = (responses: OpenAPIV3.ResponsesObject, codes: number[]): OpenAPIV3.ResponsesObject => {
  for (const code of codes) responses[String(code)] = error(code);
  return responses;
};

function operation(input: Operation): Operation {
  return input;
}

const paginationParams = (max = 50, defaultSize = 12): OpenAPIV3.ParameterObject[] => [
  query('page', 'Página solicitada, comenzando en 1.', { type: 'integer', minimum: 1, default: 1 }, 1),
  query('pageSize', `Elementos por página; máximo ${max}.`, { type: 'integer', minimum: 1, maximum: max, default: defaultSize }, defaultSize),
];

const settingsPatchSchema: OpenAPIV3.SchemaObject = {
  type: 'object', minProperties: 1, additionalProperties: false,
  properties: {
    brandName: { type: 'string', minLength: 2, maxLength: 120 }, publicationType: { type: 'string', minLength: 2, maxLength: 160 },
    statement: { type: 'string', minLength: 2, maxLength: 240 }, headerLine: { type: 'string', minLength: 2, maxLength: 240 },
    navigation: { type: 'array', maxItems: 30, items: schemaRef('NavigationItem') }, footerStatement: { type: 'string', minLength: 2, maxLength: 500 },
    socialPrompt: { type: 'string', minLength: 2, maxLength: 160 }, socialLinks: { type: 'array', maxItems: 30, items: schemaRef('SocialLink') },
    contentByLocale: { type: 'object', required: ['es'], additionalProperties: schemaRef('PublicationContent'), description: 'Contenido editorial completo por idioma.' },
    seoByLocale: { type: 'object', required: ['es'], additionalProperties: schemaRef('SeoSettings'), description: 'Metadatos SEO completos por idioma.' },
  },
};

const editionCreateSchema: OpenAPIV3.SchemaObject = {
  type: 'object', required: ['title', 'date'], additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 2, maxLength: 180 }, slug: { type: 'string', maxLength: 180, description: 'Opcional; si se omite, se genera.' },
    subtitle: { type: 'string', maxLength: 240, default: '' }, date: { type: 'string', minLength: 2, maxLength: 80, example: 'Agosto 2026' }, status,
    cover: { type: 'string', format: 'uri', description: 'URL de portada externa; vacío significa sin portada.' },
    noteIds: { type: 'array', maxItems: 500, items: { type: 'string', description: 'UUID o slug público.' }, default: [] },
    kind: { type: 'string', enum: ['magazine', 'book'], default: 'magazine' }, author: { type: 'string', maxLength: 120 }, summary: { type: 'string', maxLength: 2000 },
    translations: translations('EditionTranslations'),
    coverArt: schemaRef('CoverArt'),
  },
};

const editionUpdateSchema: OpenAPIV3.SchemaObject = {
  ...editionCreateSchema, required: [], minProperties: 1,
  properties: {
    title: editionCreateSchema.properties!.title!, slug: editionCreateSchema.properties!.slug!, subtitle: editionCreateSchema.properties!.subtitle!,
    date: editionCreateSchema.properties!.date!, status, cover: { oneOf: [{ type: 'string', format: 'uri' }, { type: 'string', enum: [''] }], description: 'Una URL crea una nueva portada. Actualmente cadena vacía no elimina la portada existente.' },
    noteIds: editionCreateSchema.properties!.noteIds!, author: editionCreateSchema.properties!.author!, summary: editionCreateSchema.properties!.summary!, translations: translations('EditionTranslations'),
    coverArt: schemaRef('CoverArtPatch'),
  },
};

const noteProperties: Record<string, Schema> = {
  title: { type: 'string', minLength: 2, maxLength: 240 }, slug: { type: 'string', maxLength: 180 }, excerpt: { type: 'string', minLength: 3, maxLength: 1000 },
  body: { type: 'string', minLength: 3, maxLength: 500000, description: 'Contenido Markdown. La API pública deriva paragraphs separando bloques por líneas vacías.' },
  status, editionId: { oneOf: [uuid, { type: 'string', enum: [''] }], description: 'UUID de edición o cadena vacía para desvincular.' },
  categoryIds: { type: 'array', maxItems: 500, items: { type: 'string', description: 'UUID o slug.' } }, resourceIds: { type: 'array', maxItems: 500, items: uuid },
  author: { type: 'string', maxLength: 120, default: 'Redacción' }, readingMinutes: { type: 'integer', minimum: 1, maximum: 240, default: 3 },
  fragment: { type: 'string', maxLength: 80, description: 'Nombre de la plantilla visual del fragmento.' },
  x: { type: 'integer', minimum: 0, maximum: 1054, description: 'Coordenada horizontal absoluta sobre la maqueta nominal de 1055 × 1492.' },
  y: { type: 'integer', minimum: 440, maximum: 1491, description: 'Coordenada vertical absoluta desde el borde superior. La zona editorial comienza debajo del masthead de 440 unidades.' },
  w: { type: 'integer', minimum: 1, maximum: 1055, description: 'Ancho. Se valida además que x + w no supere 1055.' },
  h: { type: 'integer', minimum: 1, maximum: 1052, description: 'Alto. Se valida además que y + h no supere 1492.' },
  tone, readMoreLabel: { type: 'string', maxLength: 40, default: 'LEER +' }, readMoreSubtitle: { type: 'string', maxLength: 240 }, sortOrder: { type: 'integer', minimum: 0, default: 0 }, editionLink: { type: 'boolean', default: false },
  coverTitleLines: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Cortes editoriales opcionales del título en portada. Un array vacío activa el corte automático del frontend.' },
  coverExcerpt: { type: 'string', nullable: true, maxLength: 2000, description: 'Copia específica de portada; null activa la derivación desde el contenido.' },
  coverButtonPosition: { allOf: [schemaRef('CoverButtonPosition')], nullable: true, description: 'Posición fina del botón; null restaura la posición de la plantilla.' },
  coverDepth: { type: 'integer', nullable: true, minimum: 0, maximum: 100, description: 'Profundidad visual opcional dentro del collage.' },
  coverTypography: schemaRef('CoverTypography'),
  translations: translations('NoteTranslations'),
};
const noteCreateSchema: OpenAPIV3.SchemaObject = { type: 'object', required: ['title', 'excerpt', 'body'], additionalProperties: false, properties: noteProperties };
const noteUpdateSchema: OpenAPIV3.SchemaObject = { type: 'object', minProperties: 1, additionalProperties: false, properties: { ...noteProperties, coverTypography: schemaRef('CoverTypographyPatch') } };

const resourceMetadataProperties: Record<string, Schema> = {
  type: resourceType, name: { type: 'string', minLength: 2, maxLength: 240 }, alt: { type: 'string', minLength: 2, maxLength: 2000 },
  credit: { type: 'string', minLength: 2, maxLength: 500 }, license: { type: 'string', minLength: 2, maxLength: 500 }, status,
  fileName: { type: 'string', maxLength: 255 }, fileSize: { type: 'integer', minimum: 0 }, mimeType: { type: 'string', maxLength: 160 }, date: { type: 'string', format: 'date-time' },
  translations: translations('ResourceTranslations'),
};
const resourceExternalSchema: OpenAPIV3.SchemaObject = { type: 'object', required: ['type', 'name', 'url', 'alt', 'credit', 'license'], additionalProperties: false, properties: { ...resourceMetadataProperties, url: { type: 'string', format: 'uri' } } };
const resourceUpdateSchema: OpenAPIV3.SchemaObject = { type: 'object', minProperties: 1, additionalProperties: false, properties: { type: resourceType, name: resourceMetadataProperties.name!, url: { type: 'string', format: 'uri' }, alt: resourceMetadataProperties.alt!, credit: resourceMetadataProperties.credit!, license: resourceMetadataProperties.license!, status, date: resourceMetadataProperties.date!, translations: translations('ResourceTranslations') } };
const categoryProperties: Record<string, Schema> = { name: { type: 'string', minLength: 2, maxLength: 100 }, slug: { type: 'string', maxLength: 120 }, description: { type: 'string', minLength: 3, maxLength: 2000 }, color: tone, translations: translations('CategoryTranslations') };

export const openApiOperations: Record<string, Operation> = {
  'GET /health': operation({
    tags: ['system'], operationId: 'getHealth', summary: 'Comprobar que el proceso responde', description: 'Liveness probe. No consulta PostgreSQL.',
    responses: { '200': jsonResponse('Servicio activo.', { type: 'object', required: ['status', 'service', 'timestamp'], properties: { status: { type: 'string', enum: ['ok'] }, service: { type: 'string', enum: ['backend-guillotina'] }, timestamp: { type: 'string', format: 'date-time' } } }, { status: 'ok', service: 'backend-guillotina', timestamp: '2026-08-12T12:00:00.000Z' }) },
  }),
  'GET /health/ready': operation({
    tags: ['system'], operationId: 'getReadiness', summary: 'Comprobar disponibilidad de PostgreSQL', description: 'Readiness probe; ejecuta una consulta mínima contra la base.',
    responses: withErrors({ '200': jsonResponse('API y base listas.', { type: 'object', required: ['status', 'database'], properties: { status: { type: 'string', enum: ['ready'] }, database: { type: 'string', enum: ['connected'] } } }) }, [500]),
  }),

  'POST /auth/register': operation({
    tags: ['auth'], operationId: 'register', summary: 'Registrar una cuenta lectora', description: 'Crea siempre rol reader, inicia sesión y devuelve CSRF. Límite: 5 solicitudes/minuto.',
    requestBody: jsonBody({ type: 'object', required: ['name', 'email', 'password'], additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, email: { type: 'string', format: 'email', maxLength: 254 }, password: { type: 'string', format: 'password', minLength: 8, maxLength: 128 } } }, { name: 'Alias', email: 'alias@example.org', password: 'clave-segura' }),
    responses: withErrors({ '201': jsonResponse('Cuenta y sesión creadas.', schemaRef('AuthResponse'), undefined, true) }, [400, 409, 429, 500]),
  }),
  'POST /auth/login': operation({
    tags: ['auth'], operationId: 'login', summary: 'Iniciar una sesión', description: 'Valida Argon2id, registra el último acceso y emite cookie HttpOnly más CSRF. Límite: 8 solicitudes/minuto.',
    requestBody: jsonBody({ type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', format: 'email', maxLength: 254 }, password: { type: 'string', format: 'password', minLength: 1, maxLength: 128 } } }, { email: 'prueba@laguillotina.local', password: 'guillotina' }),
    responses: withErrors({ '200': jsonResponse('Sesión iniciada.', schemaRef('AuthResponse'), undefined, true) }, [400, 401, 403, 429, 500]),
  }),
  'POST /auth/logout': operation({
    tags: ['auth'], operationId: 'logout', summary: 'Cerrar la sesión actual', description: 'Revoca la sesión en PostgreSQL y elimina la cookie.', security: sessionSecurity, parameters: [csrf],
    responses: withErrors({ '204': noContent('Sesión revocada; sin cuerpo de respuesta.') }, [401, 403, 500]),
  }),
  'GET /auth/me': operation({
    tags: ['auth'], operationId: 'getCurrentSession', summary: 'Obtener la sesión actual', description: 'Devuelve el perfil actual y rota el token CSRF.', security: sessionSecurity,
    responses: withErrors({ '200': jsonResponse('Sesión vigente.', schemaRef('AuthResponse')) }, [401, 500]),
  }),
  'PATCH /auth/profile': operation({
    tags: ['auth'], operationId: 'updateProfile', summary: 'Actualizar perfil o contraseña', description: 'Para cambiar contraseña exige currentPassword. Al cambiarla revoca las demás sesiones.', security: sessionSecurity, parameters: [csrf],
    requestBody: jsonBody({ type: 'object', minProperties: 1, additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, avatarUrl: { type: 'string', maxLength: 2100000, description: 'URL HTTP(S), data:image o cadena vacía.' }, currentPassword: { type: 'string', format: 'password', maxLength: 128 }, newPassword: { type: 'string', format: 'password', minLength: 8, maxLength: 128 } } }),
    responses: withErrors({ '200': jsonResponse('Perfil actualizado.', schemaRef('User')) }, [400, 401, 403, 500]),
  }),
  'PATCH /auth/preferences': operation({
    tags: ['auth'], operationId: 'updatePreferences', summary: 'Guardar o eliminar preferencias', description: 'Un cuerpo null elimina las preferencias; un objeto actualiza claves conocidas y conserva extras.', security: sessionSecurity, parameters: [csrf],
    requestBody: jsonBody(schemaRef('UserPreferences'), { theme: 'dark', locale: 'es', analyticsOptOut: false }, 'También acepta JSON null para eliminar todas las preferencias.'),
    responses: withErrors({ '200': jsonResponse('Preferencias actualizadas.', schemaRef('User')) }, [400, 401, 403, 500]),
  }),
  'POST /auth/saved-notes/{noteId}/toggle': operation({
    tags: ['auth'], operationId: 'toggleSavedNote', summary: 'Alternar una nota guardada', description: 'Acepta UUID o slug público. Si ya estaba guardada, la elimina.', security: sessionSecurity, parameters: [path('noteId', 'UUID o slug público de la nota.'), csrf],
    responses: withErrors({ '200': jsonResponse('Estado de guardadas actualizado.', schemaRef('User')) }, [400, 401, 403, 404, 500]),
  }),
  'GET /auth/saved-notes': operation({
    tags: ['auth'], operationId: 'listSavedNotes', summary: 'Listar notas guardadas completas', description: 'Devuelve sólo guardadas que continúan publicadas, con contenido de tarjeta, edición e imagen; no reconstruye datos desde la portada.', security: sessionSecurity,
    parameters: [query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }), ...paginationParams(50, 12)],
    responses: withErrors({ '200': jsonResponse('Página de notas guardadas.', { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: schemaRef('SavedNote') }, pagination: schemaRef('Pagination') } }) }, [400, 401, 403, 500]),
  }),
  'DELETE /auth/saved-notes': operation({
    tags: ['auth'], operationId: 'clearSavedNotes', summary: 'Vaciar las notas guardadas', description: 'Elimina todas las relaciones de notas guardadas de la cuenta.', security: sessionSecurity, parameters: [csrf],
    responses: withErrors({ '200': jsonResponse('Listado vaciado.', schemaRef('User')) }, [401, 403, 500]),
  }),
  'POST /auth/password/forgot': operation({
    tags: ['auth'], operationId: 'forgotPassword', summary: 'Solicitar recuperación de contraseña', description: 'Siempre devuelve el mismo mensaje para evitar enumeración. El token vence según PASSWORD_RESET_TTL_MINUTES. Límite: 3/15 min.',
    requestBody: jsonBody({ type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', format: 'email', maxLength: 254 } } }, { email: 'alias@example.org' }),
    responses: withErrors({ '200': jsonResponse('Solicitud procesada sin revelar si la cuenta existe.', schemaRef('Message'), { message: 'Si existe una cuenta activa, preparamos las instrucciones de recuperación.' }) }, [400, 429, 500]),
  }),
  'POST /auth/password/reset': operation({
    tags: ['auth'], operationId: 'resetPassword', summary: 'Restablecer contraseña', description: 'Consume un token opaco, de un solo uso y con vencimiento; revoca todas las sesiones.',
    requestBody: jsonBody({ type: 'object', required: ['token', 'password'], additionalProperties: false, properties: { token: { type: 'string', minLength: 20, maxLength: 200 }, password: { type: 'string', format: 'password', minLength: 8, maxLength: 128 } } }),
    responses: withErrors({ '200': jsonResponse('Contraseña actualizada.', schemaRef('Message')) }, [400, 429, 500]),
  }),
  'DELETE /auth/account': operation({
    tags: ['auth'], operationId: 'deleteAccount', summary: 'Solicitar baja de la cuenta', description: 'Anonimiza datos personales, elimina preferencias/guardadas y revoca sesiones; conserva comentarios sin identidad.', security: sessionSecurity, parameters: [csrf],
    responses: withErrors({ '204': noContent('Cuenta anonimizada; sin cuerpo de respuesta.') }, [401, 403, 500]),
  }),
  'GET /auth/oauth/{provider}': operation({
    tags: ['auth'], operationId: 'startOAuth', summary: 'Reservar inicio OAuth', description: 'Integración futura. Devuelve 501 hasta activar el proveedor y sus credenciales.', parameters: [path('provider', 'Proveedor futuro.', { type: 'string', enum: ['google', 'x'] })],
    responses: withErrors({}, [400, 501]),
  }),
  'GET /auth/oauth/{provider}/callback': operation({
    tags: ['auth'], operationId: 'oauthCallback', summary: 'Reservar callback OAuth', description: 'Callback reservado; todavía no intercambia códigos.', parameters: [path('provider', 'Proveedor futuro.', { type: 'string', enum: ['google', 'x'] }), query('code', 'Código de autorización futuro.', { type: 'string' }), query('state', 'Estado antifalsificación futuro.', { type: 'string' })],
    responses: withErrors({}, [400, 501]),
  }),

  'GET /site/settings': operation({
    tags: ['public'], operationId: 'getSiteSettings', summary: 'Obtener publicación y páginas localizadas', description: 'Fuente pública de marca, navegación, pie, acceso, archivo, páginas institucionales, assets editoriales y SEO. Conserva los campos planos históricos por compatibilidad.',
    parameters: [query('locale', 'Idioma editorial. Si falta una traducción se usa español.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }, 'es')],
    responses: withErrors({ '200': jsonResponse('Configuración vigente.', schemaRef('SiteSettings')) }, [503, 500]),
  }),
  'GET /editions': operation({
    tags: ['public'], operationId: 'listEditions', summary: 'Listar ediciones publicadas', description: 'Listado paginado de revistas o libros; nunca devuelve borradores.',
    parameters: [query('kind', 'Tipo editorial.', { type: 'string', enum: ['magazine', 'book'], default: 'magazine' }, 'magazine'), query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }), ...paginationParams(50, 12)],
    responses: withErrors({ '200': jsonResponse('Página de ediciones.', { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: schemaRef('EditionSummary') }, pagination: schemaRef('Pagination') } }) }, [400, 500]),
  }),
  'GET /catalog': operation({
    tags: ['public'], operationId: 'getCatalog', summary: 'Consultar el catálogo editorial', description: 'Devuelve revistas, libros, muestra visual y multimedia con paginación independiente. Las secciones no solicitadas son arrays vacíos.',
    parameters: [
      query('section', 'Colección a cargar; all carga las cuatro.', { type: 'string', enum: ['all', 'magazines', 'books', 'showcase', 'multimedia'], default: 'all' }, 'all'), ...paginationParams(50, 12),
      query('search', 'Búsqueda textual, sin distinguir mayúsculas.', { type: 'string', maxLength: 120 }), query('tag', 'Slug de categoría.', { type: 'string', maxLength: 120 }),
      query('type', 'Filtro de tipo para multimedia/muestra.', resourceType),
      query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }),
    ],
    responses: withErrors({ '200': jsonResponse('Catálogo filtrado.', { type: 'object', required: ['magazines', 'books', 'showcase', 'multimedia', 'pagination', 'filters'], properties: {
      magazines: { type: 'array', items: schemaRef('EditionSummary') }, books: { type: 'array', items: schemaRef('EditionSummary') }, showcase: { type: 'array', items: schemaRef('CatalogResource') }, multimedia: { type: 'array', items: schemaRef('CatalogResource') },
      pagination: { type: 'object', additionalProperties: schemaRef('Pagination') }, filters: { type: 'object', properties: { section: { type: 'string' }, search: { type: 'string', nullable: true }, tag: { type: 'string', nullable: true }, type: { type: 'string', nullable: true } } },
    } }) }, [400, 500]),
  }),
  'GET /search': operation({
    tags: ['public'], operationId: 'searchPublication', summary: 'Buscar contenido publicado', description: 'Busca empíricamente notas, ediciones, libros y recursos publicados/completos. Devuelve una página unificada y los mismos elementos agrupados por familia.',
    parameters: [
      query('q', 'Texto requerido; mínimo 2 caracteres.', { type: 'string', minLength: 2, maxLength: 120 }),
      query('locale', 'Idioma editorial y campos localizados que deben participar.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }),
      ...paginationParams(50, 12),
    ],
    responses: withErrors({ '200': jsonResponse('Resultados publicados.', { type: 'object', required: ['items', 'groups', 'pagination', 'filters'], properties: {
      items: { type: 'array', items: schemaRef('SearchResult') },
      groups: { type: 'object', required: ['notes', 'editions', 'resources'], properties: { notes: { type: 'array', items: schemaRef('SearchResult') }, editions: { type: 'array', items: schemaRef('SearchResult') }, resources: { type: 'array', items: schemaRef('SearchResult') } } },
      pagination: schemaRef('Pagination'), filters: { type: 'object', required: ['q', 'locale'], properties: { q: { type: 'string' }, locale: { type: 'string', enum: ['es', 'en', 'ru'] } } },
    } }) }, [400, 500]),
  }),
  'GET /resources': operation({
    tags: ['public'], operationId: 'listResources', summary: 'Listar recursos publicados', description: 'Sólo devuelve recursos publicados con carga completa.',
    parameters: [query('types', 'Lista separada por comas: image,video,audio,pdf,link.', { type: 'string', maxLength: 120 }, 'image,video'), query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' }), ...paginationParams(50, 12)],
    responses: withErrors({ '200': jsonResponse('Página de recursos.', { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: schemaRef('Resource') }, pagination: schemaRef('Pagination') } }) }, [400, 500]),
  }),
  'GET /editions/{slug}/home': operation({
    tags: ['public'], operationId: 'getEditionHome', summary: 'Obtener portada y notas de una edición', description: 'Contrato de portada consumido por el frontend. Sólo ediciones/notas publicadas.', parameters: [path('slug', 'Slug público de la edición.'), query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' })],
    responses: withErrors({ '200': jsonResponse('Portada editorial.', schemaRef('EditionHome')) }, [400, 404, 500]),
  }),
  'GET /editions/current/home': operation({
    tags: ['public'], operationId: 'getCurrentEditionHome', summary: 'Obtener la edición vigente', description: 'Devuelve la revista publicada más reciente según publishedAt. Publicar una nueva edición mediante PATCH /admin/editions/{id} cambia este resultado sin modificar el frontend.',
    parameters: [query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' })],
    responses: withErrors({ '200': jsonResponse('Portada editorial vigente.', schemaRef('EditionHome')) }, [400, 404, 500]),
  }),
  'GET /editions/{slug}/pdf': operation({
    tags: ['public'], operationId: 'downloadEditionPdf', summary: 'Descargar una edición como PDF', description: 'Genera la edición publicada con portada, índice clickeable, destinos internos, marcadores y una sección por nota publicada. No expone borradores.',
    parameters: [path('slug', 'Slug público de la edición.'), query('locale', 'Idioma editorial del PDF.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' })],
    responses: withErrors({ '200': pdfResponse('PDF navegable de la edición.') }, [400, 404, 500]),
  }),
  'GET /notes/{noteId}': operation({
    tags: ['public'], operationId: 'getPublicNote', summary: 'Obtener una nota publicada', description: 'Acepta UUID o slug y devuelve contenido, resumen, cuerpo, imagen, galería, video, audio/PDF/link en resources y rating.', parameters: [path('noteId', 'UUID o slug público.'), query('locale', 'Idioma editorial.', { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' })],
    responses: withErrors({ '200': jsonResponse('Nota publicada.', schemaRef('PublicNote')) }, [400, 404, 500]),
  }),
  'GET /notes/{noteId}/comments': operation({
    tags: ['public'], operationId: 'listComments', summary: 'Listar conversaciones públicas', description: 'Máximo 200 comentarios totales, ordenados del más antiguo al más nuevo. Incluye visible y pending en raíces/replies. hidden/reported no se exponen. Un comentario anónimo deleted se conserva como tombstone sin cuerpo; uno de cuenta desaparece por completo.', parameters: [path('noteId', 'UUID o slug de la nota.')],
    responses: withErrors({ '200': jsonResponse('Comentarios públicos y tombstones anónimos.', { type: 'array', maxItems: 200, items: schemaRef('Comment') }) }, [400, 404, 500]),
  }),
  'POST /notes/{noteId}/comments': operation({
    tags: ['public'], operationId: 'createComment', summary: 'Enviar un comentario', description: 'Puede ser anónimo o autenticado. Siempre queda pendiente de moderación. Límite: 5/5 min.', security: optionalSessionSecurity, parameters: [path('noteId', 'UUID o slug de la nota.')],
    requestBody: jsonBody({ type: 'object', required: ['body'], additionalProperties: false, properties: { author: { type: 'string', minLength: 1, maxLength: 80, description: 'Ignorado si hay sesión.' }, body: { type: 'string', minLength: 3, maxLength: 2000 } } }, { author: 'Anónima', body: 'Texto del comentario.' }),
    responses: withErrors({ '201': jsonResponse('Comentario pendiente.', schemaRef('Comment')) }, [400, 404, 429, 500]),
  }),
  'POST /notes/{noteId}/comments/{commentId}/replies': operation({
    tags: ['public'], operationId: 'replyToComment', summary: 'Responder un comentario', description: 'Crea una respuesta anónima o autenticada, siempre pendiente de moderación. Sólo admite un nivel de respuestas. Límite: 5/5 min.', security: optionalSessionSecurity,
    parameters: [path('noteId', 'UUID o slug de la nota.'), path('commentId', 'UUID de un comentario principal visible.', uuid)],
    requestBody: jsonBody({ type: 'object', required: ['body'], additionalProperties: false, properties: { author: { type: 'string', minLength: 1, maxLength: 80, description: 'Ignorado si hay sesión.' }, body: { type: 'string', minLength: 3, maxLength: 2000 } } }, { author: 'Anónima', body: 'Una respuesta para la conversación.' }),
    responses: withErrors({ '201': jsonResponse('Respuesta pendiente de moderación.', schemaRef('Comment')) }, [400, 404, 409, 429, 500]),
  }),
  'POST /notes/{noteId}/comments/{commentId}/reactions': operation({
    tags: ['public'], operationId: 'toggleCommentReaction', summary: 'Alternar reacción like', description: 'Agrega o retira el like de la cuenta/cookie anónima y devuelve el comentario actualizado. Límite: 30/min.', security: optionalSessionSecurity,
    parameters: [path('noteId', 'UUID o slug de la nota.'), path('commentId', 'UUID del comentario visible.', uuid)],
    requestBody: jsonBody({ type: 'object', required: ['reaction'], additionalProperties: false, properties: { reaction: { type: 'string', enum: ['like'] } } }, { reaction: 'like' }),
    responses: withErrors({ '200': jsonResponse('Reacción alternada.', schemaRef('Comment'), undefined, true) }, [400, 404, 429, 500]),
  }),
  'POST /notes/{noteId}/comments/{commentId}/upvote': operation({
    tags: ['public'], operationId: 'upvoteComment', summary: 'Marcar comentario como útil', description: 'Endpoint compatible: agrega like de forma idempotente, pero no lo retira. Para UI nueva usar /reactions. Límite: 30/min.', security: optionalSessionSecurity,
    parameters: [path('noteId', 'UUID o slug de la nota.'), path('commentId', 'UUID del comentario.', uuid)],
    responses: withErrors({ '200': jsonResponse('Comentario con conteo actualizado.', schemaRef('Comment'), undefined, true) }, [400, 404, 429, 500]),
  }),
  'POST /notes/{noteId}/comments/{commentId}/report': operation({
    tags: ['public'], operationId: 'reportComment', summary: 'Reportar un comentario', description: 'Una denuncia por cuenta/cookie. Deriva comentarios visibles a moderación. Límite: 5/10 min.', security: optionalSessionSecurity,
    parameters: [path('noteId', 'UUID o slug de la nota.'), path('commentId', 'UUID del comentario.', uuid)],
    requestBody: jsonBody({ type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', enum: ['spam', 'abuse', 'privacy', 'other'] }, detail: { type: 'string', maxLength: 500 } } }, { reason: 'abuse', detail: 'Contenido hostil.' }),
    responses: withErrors({ '202': jsonResponse('Reporte recibido.', schemaRef('Message'), { message: 'Recibimos el reporte para moderación.' }, true) }, [400, 404, 429, 500]),
  }),
  'POST /notes/{noteId}/rating': operation({
    tags: ['public'], operationId: 'rateNote', summary: 'Puntuar una nota', description: 'Una puntuación por cuenta o cookie; una nueva solicitud actualiza la anterior. Límite: 20/min.', security: optionalSessionSecurity, parameters: [path('noteId', 'UUID o slug de la nota.')],
    requestBody: jsonBody({ type: 'object', required: ['score'], additionalProperties: false, properties: { score: { type: 'integer', minimum: 1, maximum: 5 } } }, { score: 5 }),
    responses: withErrors({ '200': jsonResponse('Promedio actualizado.', schemaRef('RatingAggregate'), undefined, true) }, [400, 404, 429, 500]),
  }),
  'POST /contacts': operation({
    tags: ['public'], operationId: 'createContact', summary: 'Enviar un mensaje de contacto', description: 'Guarda el mensaje en la bandeja editorial. Límite: 3/15 min.',
    requestBody: jsonBody({ type: 'object', required: ['name', 'email', 'body'], additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 100 }, email: { type: 'string', format: 'email', maxLength: 254 }, subject: { type: 'string', minLength: 3, maxLength: 160, default: 'Mensaje desde el sitio' }, body: { type: 'string', minLength: 10, maxLength: 10000 } } }),
    responses: withErrors({ '201': jsonResponse('Mensaje recibido.', { type: 'object', required: ['id', 'status', 'message'], properties: { id: uuid, status: { type: 'string', enum: ['new'] }, message: { type: 'string' } } }) }, [400, 429, 500]),
  }),
  'POST /assistant/messages': operation({
    tags: ['assistant'], operationId: 'sendAssistantMessage', summary: 'Enviar un mensaje al asistente simulado',
    description: 'Endpoint público y anónimo. No requiere cookie, CSRF ni API key; no persiste conversaciones y no llama a OpenAI. Devuelve una respuesta determinista localizada. Límite: 10 solicitudes/minuto por cliente.',
    security: [],
    requestBody: jsonBody({
      type: 'object', required: ['message'], additionalProperties: false,
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 1000, description: 'Se recortan espacios iniciales y finales antes de validar.' },
        locale: { type: 'string', enum: ['es', 'en', 'ru'], default: 'es' },
        conversationId: { type: 'string', nullable: true, minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$', description: 'Identificador opaco opcional. Null u omisión generan uno nuevo.' },
      },
    }, { message: '¿Cómo encuentro las ediciones anteriores?', locale: 'es', conversationId: 'web_01HXYZ' }),
    responses: withErrors({ '200': jsonResponse('Respuesta simulada generada.', schemaRef('AssistantMessageResponse'), {
      conversationId: 'web_01HXYZ', reply: { id: '4bb678b6-24fe-46a8-a83f-1fd027a7362d', role: 'assistant', text: 'Podés recorrer las ediciones desde el Archivo y abrir cada nota desde su portada. La edición publicada más reciente aparece primero.', createdAt: '2026-08-13T20:30:00.000Z' }, requestId: 'req-1',
    }) }, [400, 429, 500]),
  }),
  'POST /analytics/events': operation({
    tags: ['analytics'], operationId: 'recordAnalytics', summary: 'Registrar eventos anónimos', description: 'Anonimiza sessionId diariamente con HMAC. Respeta DNT: 1 y Sec-GPC: 1. Máximo 20 eventos; límite 120/min.',
    parameters: [{ $ref: '#/components/parameters/Dnt' }, { $ref: '#/components/parameters/SecGpc' }],
    requestBody: jsonBody({
      type: 'object', required: ['sessionId', 'events'], additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 16, maxLength: 100 },
        events: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', required: ['type'], additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['page_view', 'reading_started', 'reading_completed', 'reading_time', 'attention', 'download', 'referral'] },
              noteId: { type: 'string', maxLength: 100 }, editionSlug: { type: 'string', maxLength: 160 }, resourceId: uuid,
              segment: { type: 'string', maxLength: 60 }, source: { type: 'string', maxLength: 500 },
              durationSeconds: { type: 'integer', minimum: 0, maximum: 86400 }, progressPercent: { type: 'integer', minimum: 0, maximum: 100 },
              occurredAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }),
    responses: withErrors({ '202': jsonResponse('Eventos aceptados o señal de privacidad respetada.', schemaRef('AnalyticsAccepted')) }, [400, 429, 500]),
  }),

  'GET /admin/dashboard': operation({
    tags: ['admin'], operationId: 'getAdminDashboard', summary: 'Consultar el dashboard paginado', description: 'Cada colección se pagina de forma independiente. section=all devuelve sólo las colecciones permitidas para el rol. section=comments permite filtrar pending/visible/hidden/reported/deleted y conserva cuerpo/razón privados.', security: sessionSecurity,
    parameters: [...paginationParams(100, 25), query('section', 'Colección solicitada.', { type: 'string', enum: ['all', 'editions', 'notes', 'resources', 'categories', 'contacts', 'comments', 'users', 'logs', 'analytics'], default: 'all' }), query('status', 'Estado editorial o de comentario según la sección.', dashboardStatus), query('search', 'Filtro textual.', { type: 'string', maxLength: 120 }), query('from', 'Inicio ISO para analítica; por defecto 30 días.', { type: 'string', format: 'date-time' })],
    responses: withErrors({ '200': jsonResponse('Dashboard permitido para el rol.', schemaRef('Dashboard')) }, [400, 401, 403, 500]),
  }),
  'GET /admin/settings': operation({
    tags: ['admin'], operationId: 'getAdminSettings', summary: 'Obtener configuración editable', description: 'Roles: admin o editor.', security: sessionSecurity,
    responses: withErrors({ '200': jsonResponse('Configuración editorial.', schemaRef('SiteSettings')) }, [401, 403, 503, 500]),
  }),
  'PATCH /admin/settings': operation({
    tags: ['admin'], operationId: 'updateAdminSettings', summary: 'Actualizar configuración institucional', description: 'Acepta cualquier subconjunto no vacío. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf], requestBody: jsonBody(settingsPatchSchema),
    responses: withErrors({ '200': jsonResponse('Configuración actualizada.', schemaRef('SiteSettings')) }, [400, 401, 403, 503, 500]),
  }),
  'POST /admin/editions': operation({
    tags: ['admin'], operationId: 'createEdition', summary: 'Crear una edición', description: 'Numera transaccionalmente por kind y vincula las notas indicadas. coverArt usa un lienzo de 1055 × 1492, presets/tokens enumerados y nunca CSS libre. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf], requestBody: jsonBody(editionCreateSchema, { title: 'Título', subtitle: 'Consigna', date: 'Agosto 2026', status: 'draft', cover: 'https://example.org/portada.webp', noteIds: [], coverArt: { preset: 'riot', elements: [{ id: 'tape-top', type: 'tape', tone: 'red', x: 40, y: 30, w: 260, h: 70, rotation: -8, depth: 12 }] } }),
    responses: withErrors({ '201': jsonResponse('Edición creada.', schemaRef('AdminEdition')) }, [400, 401, 403, 409, 500]),
  }),
  'PATCH /admin/editions/{id}': operation({
    tags: ['admin'], operationId: 'updateEdition', summary: 'Actualizar una edición', description: 'Actualiza datos y relaciones. coverArt es parcial a nivel objeto; elements, cuando se envía, reemplaza la lista completa. Las fechas publishedAt/archivedAt/deletedAt sólo cambian ante una transición real de status; reenviar el mismo status es idempotente. status=deleted aplica borrado lógico. Roles: admin o editor.', security: sessionSecurity, parameters: [path('id', 'UUID de la edición.', uuid), csrf], requestBody: jsonBody(editionUpdateSchema),
    responses: withErrors({ '200': jsonResponse('Edición actualizada.', schemaRef('AdminEdition')) }, [400, 401, 403, 404, 409, 500]),
  }),
  'DELETE /admin/editions/{id}': operation({
    tags: ['admin'], operationId: 'softDeleteEdition', summary: 'Eliminar lógicamente una edición', description: 'Marca status=deleted y deletedAt sin eliminar la fila. Roles: admin o editor.', security: sessionSecurity, parameters: [path('id', 'UUID de la edición.', uuid), csrf],
    responses: withErrors({ '200': jsonResponse('Edición eliminada lógicamente.', schemaRef('AdminEdition')) }, [400, 401, 403, 404, 500]),
  }),
  'POST /admin/notes': operation({
    tags: ['admin'], operationId: 'createNote', summary: 'Crear una nota', description: 'Crea contenido Markdown y sus vínculos editoriales. La composición usa una maqueta nominal de 1055 × 1492, con masthead de 440 unidades; el rectángulo debe quedar íntegramente dentro del área inferior. coverTypography admite únicamente presets tipográficos seguros. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf], requestBody: jsonBody(noteCreateSchema, { title: 'Título', excerpt: 'Bajada', body: 'Contenido en Markdown.', status: 'draft', editionId: '', categoryIds: [], resourceIds: [], author: 'Redacción', readingMinutes: 3, fragment: 'freedom', x: 282, y: 456, w: 350, h: 542, tone: 'red', sortOrder: 0, coverTypography: { titleSize: 'display', titleAlign: 'left', titleTreatment: 'brush', excerptSize: 'large' } }),
    responses: withErrors({ '201': jsonResponse('Nota creada.', schemaRef('AdminNote')) }, [400, 401, 403, 409, 500]),
  }),
  'PATCH /admin/notes/{id}': operation({
    tags: ['admin'], operationId: 'updateNote', summary: 'Actualizar una nota', description: 'Patch parcial. Las coordenadas omitidas conservan su valor y se valida el rectángulo final contra la maqueta 1055 × 1492 (masthead: 440). No se corrigen valores silenciosamente. Roles: admin o editor.', security: sessionSecurity, parameters: [path('id', 'UUID de la nota.', uuid), csrf], requestBody: jsonBody(noteUpdateSchema),
    responses: withErrors({ '200': jsonResponse('Nota actualizada.', schemaRef('AdminNote')) }, [400, 401, 403, 404, 409, 500]),
  }),
  'DELETE /admin/notes/{id}': operation({
    tags: ['admin'], operationId: 'softDeleteNote', summary: 'Eliminar lógicamente una nota', description: 'Marca status=deleted y deletedAt; conserva comentarios, métricas y relaciones. Roles: admin o editor.', security: sessionSecurity, parameters: [path('id', 'UUID de la nota.', uuid), csrf],
    responses: withErrors({ '200': jsonResponse('Nota eliminada lógicamente.', schemaRef('AdminNote')) }, [400, 401, 403, 404, 500]),
  }),
  'POST /admin/resources': operation({
    tags: ['admin'], operationId: 'createExternalResource', summary: 'Registrar un recurso externo', description: 'Registra una URL y metadatos obligatorios. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf], requestBody: jsonBody(resourceExternalSchema),
    responses: withErrors({ '201': jsonResponse('Recurso registrado.', schemaRef('Resource')) }, [400, 401, 403, 409, 500]),
  }),
  'PATCH /admin/resources/{id}': operation({
    tags: ['admin'], operationId: 'updateResource', summary: 'Actualizar un recurso', description: 'Los metadatos de archivo son de sólo lectura. status=deleted aplica borrado lógico.', security: sessionSecurity, parameters: [path('id', 'UUID del recurso.', uuid), csrf], requestBody: jsonBody(resourceUpdateSchema),
    responses: withErrors({ '200': jsonResponse('Recurso actualizado.', schemaRef('Resource')) }, [400, 401, 403, 404, 409, 500]),
  }),
  'POST /admin/categories': operation({
    tags: ['admin'], operationId: 'createCategory', summary: 'Crear una categoría', description: 'El slug es opcional y se genera desde name. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf], requestBody: jsonBody({ type: 'object', required: ['name', 'description', 'color'], additionalProperties: false, properties: categoryProperties }),
    responses: withErrors({ '201': jsonResponse('Categoría creada.', schemaRef('Category')) }, [400, 401, 403, 409, 500]),
  }),
  'PATCH /admin/categories/{id}': operation({
    tags: ['admin'], operationId: 'updateCategory', summary: 'Actualizar una categoría', description: 'status=deleted aplica borrado lógico. Roles: admin o editor.', security: sessionSecurity, parameters: [path('id', 'UUID de la categoría.', uuid), csrf], requestBody: jsonBody({ type: 'object', minProperties: 1, additionalProperties: false, properties: { ...categoryProperties, status } }),
    responses: withErrors({ '200': jsonResponse('Categoría actualizada.', schemaRef('Category')) }, [400, 401, 403, 404, 409, 500]),
  }),
  'PATCH /admin/contacts/{id}': operation({
    tags: ['admin'], operationId: 'updateContact', summary: 'Gestionar contacto y respuesta', description: 'Guarda borrador o envía por el proveedor configurado. Roles: admin o moderator.', security: sessionSecurity, parameters: [path('id', 'UUID del mensaje.', uuid), csrf],
    requestBody: jsonBody({ type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['new', 'in_progress', 'answered', 'archived'] }, reply: { type: 'string', minLength: 1, maxLength: 20000 }, send: { type: 'boolean', description: 'Si es true exige reply. status=answered también dispara envío.' } } }, { status: 'answered', reply: 'Texto de la respuesta.', send: true }),
    responses: withErrors({ '200': jsonResponse('Contacto actualizado.', schemaRef('ContactResult')) }, [400, 401, 403, 404, 502, 500]),
  }),
  'PATCH /admin/comments/{id}': operation({
    tags: ['admin'], operationId: 'moderateComment', summary: 'Moderar o borrar lógicamente un comentario', description: 'Registra actor, motivo y fecha en el log administrativo. deleted conserva el cuerpo en privado. Si el comentario pertenece a una cuenta, desaparece del endpoint público y se envía un aviso automático; si es anónimo, se publica un tombstone gris sin cuerpo. Roles: admin o moderator. moderationNote es un alias legado de moderationReason y no se pueden enviar ambos.', security: sessionSecurity, parameters: [path('id', 'UUID del comentario.', uuid), csrf], requestBody: jsonBody({ type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'visible', 'hidden', 'reported', 'deleted'] }, moderationReason: { type: 'string', maxLength: 1000, description: 'Si se omite al borrar se aplica el motivo comunitario predeterminado.' }, moderationNote: { type: 'string', maxLength: 1000, deprecated: true } } }, { status: 'deleted', moderationReason: 'Incumple las pautas comunitarias de participación.' }),
    responses: withErrors({ '200': jsonResponse('Comentario moderado; el fallo de correo se informa en emailDelivery sin revertir el borrado.', schemaRef('CommentModerationResult')) }, [400, 401, 403, 404, 500]),
  }),
  'PATCH /admin/users/{id}': operation({
    tags: ['admin'], operationId: 'updateUserAccess', summary: 'Cambiar rol o estado de una cuenta', description: 'Sólo admin. No permite autobloqueo ni dejar el sistema sin una administradora activa.', security: sessionSecurity, parameters: [path('id', 'UUID de la cuenta.', uuid), csrf], requestBody: jsonBody({ type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['active', 'suspended'] }, role: { type: 'string', enum: ['reader', 'admin', 'editor', 'moderator'] } } }),
    responses: withErrors({ '200': jsonResponse('Acceso actualizado.', schemaRef('AdminUser')) }, [400, 401, 403, 404, 409, 500]),
  }),

  'POST /admin/resources/upload': operation({
    tags: ['resources'], operationId: 'uploadLocalResource', summary: 'Cargar un archivo en desarrollo local', description: 'Sólo STORAGE_DRIVER=local. Un archivo por pedido; 500 MB para video y 100 MB para otros tipos. Roles: admin o editor.', security: sessionSecurity, parameters: [csrf],
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'type', 'name', 'alt', 'credit', 'license'], properties: { file: { type: 'string', format: 'binary' }, type: { type: 'string', enum: ['image', 'video', 'pdf', 'audio'] }, name: resourceMetadataProperties.name!, alt: resourceMetadataProperties.alt!, credit: resourceMetadataProperties.credit!, license: resourceMetadataProperties.license!, status, date: resourceMetadataProperties.date! } }, encoding: { file: { contentType: 'image/*, video/*, audio/*, application/pdf' } } } } },
    responses: withErrors({ '201': jsonResponse('Archivo almacenado y recurso creado.', schemaRef('Resource')) }, [400, 401, 403, 409, 413, 415, 500]),
  }),
  'POST /admin/resources/uploads': operation({
    tags: ['resources'], operationId: 'startSignedUpload', summary: 'Iniciar una carga S3/R2', description: 'Sólo STORAGE_DRIVER=s3. Decide single o multipart y devuelve URLs de corta duración.', security: sessionSecurity, parameters: [csrf],
    requestBody: jsonBody({ type: 'object', required: ['type', 'name', 'alt', 'credit', 'license', 'fileName', 'fileSize', 'mimeType'], additionalProperties: false, properties: { ...resourceMetadataProperties, type: { type: 'string', enum: ['image', 'video', 'pdf', 'audio'] }, fileName: { type: 'string', minLength: 1, maxLength: 255 }, fileSize: { type: 'integer', minimum: 1 }, mimeType: { type: 'string', minLength: 3, maxLength: 160 } } }),
    responses: withErrors({ '201': jsonResponse('Sesión de carga iniciada.', schemaRef('UploadStart')) }, [400, 401, 403, 409, 413, 415, 500]),
  }),
  'POST /admin/resources/uploads/{id}/part': operation({
    tags: ['resources'], operationId: 'signUploadPart', summary: 'Firmar una parte multipart', description: 'Devuelve una URL PUT para una parte concreta. La carga debe estar activa y no vencida.', security: sessionSecurity, parameters: [path('id', 'UUID interno de la carga.', uuid), csrf], requestBody: jsonBody({ type: 'object', required: ['partNumber'], additionalProperties: false, properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 } } }, { partNumber: 1 }),
    responses: withErrors({ '200': jsonResponse('Parte firmada.', schemaRef('SignedPart')) }, [400, 401, 403, 404, 409, 410, 500]),
  }),
  'POST /admin/resources/uploads/{id}/complete': operation({
    tags: ['resources'], operationId: 'completeSignedUpload', summary: 'Completar una carga S3/R2', description: 'Completa multipart si corresponde, verifica el tamaño real y publica la URL en el recurso.', security: sessionSecurity, parameters: [path('id', 'UUID interno de la carga.', uuid), csrf], requestBody: jsonBody({ type: 'object', additionalProperties: false, properties: { parts: { type: 'array', maxItems: 10000, default: [], items: { type: 'object', required: ['partNumber', 'etag'], additionalProperties: false, properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, etag: { type: 'string', minLength: 1, maxLength: 200 } } } } } }, { parts: [{ partNumber: 1, etag: 'etag-parte-1' }] }),
    responses: withErrors({ '200': jsonResponse('Carga verificada y recurso completado.', schemaRef('Resource')) }, [400, 401, 403, 404, 409, 410, 500]),
  }),
  'DELETE /admin/resources/uploads/{id}': operation({
    tags: ['resources'], operationId: 'abortSignedUpload', summary: 'Cancelar una carga S3/R2', description: 'Aborta multipart, marca la carga aborted y aplica borrado lógico al recurso.', security: sessionSecurity, parameters: [path('id', 'UUID interno de la carga.', uuid), csrf],
    responses: withErrors({ '204': noContent('Carga cancelada; sin cuerpo de respuesta.') }, [401, 403, 404, 410, 500]),
  }),

  'POST /internal/analytics/aggregate': operation({
    tags: ['internal'], operationId: 'aggregateAnalytics', summary: 'Agregar y depurar analítica', description: 'Ruta exclusiva del cron. Agrega días cerrados y elimina eventos crudos anteriores a la retención.', security: cronSecurity,
    responses: withErrors({ '200': jsonResponse('Agregación completada.', { type: 'object', required: ['aggregatedGroups', 'removedRawEvents', 'cutoff'], properties: { aggregatedGroups: { type: 'integer', minimum: 0 }, removedRawEvents: { type: 'integer', minimum: 0 }, cutoff: { type: 'string', format: 'date-time' } } }) }, [401, 500]),
  }),
};
