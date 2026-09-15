import type { OpenAPIV3 } from 'openapi-types';
import { openApiOperations } from './operations.js';
import { openApiSchemas } from './schemas.js';

const methodNames = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

export function enrichOpenApi(document: Partial<OpenAPIV3.Document>): Partial<OpenAPIV3.Document> {
  document.info = {
    title: 'La Guillotina API',
    version: '1.0.0',
    description: [
      'API externa de la revista/fanzine digital **La Guillotina**.',
      '',
      '## Autenticación',
      'La sesión usa una cookie opaca `lg_session` HttpOnly. Swagger UI conserva la cookie después de ejecutar login, pero JavaScript no puede leerla.',
      'Toda mutación autenticada también exige `x-csrf-token`, obtenido en registro, login o `GET /auth/me`.',
      '',
      '## Formato y errores',
      'Los cuerpos JSON usan UTF-8. Fechas y horas están en ISO 8601 UTC. Los errores siempre tienen `{ error: { code, message, details?, requestId } }`.',
      '',
      '## Paginación y privacidad',
      'Los listados devuelven metadatos de paginación y nunca cargan tablas completas. La analítica no almacena el identificador de sesión recibido: lo convierte mediante HMAC diario.',
    ].join('\n'),
  };
  document.tags = [
    { name: 'system', description: 'Estado del proceso y PostgreSQL.' },
    { name: 'auth', description: 'Registro, sesión HttpOnly, perfil, preferencias y recuperación.' },
    { name: 'public', description: 'Configuración institucional, archivo, ediciones, notas y comunidad.' },
    { name: 'assistant', description: 'Asistente público simulado, localizado y sin proveedor de IA externo.' },
    { name: 'admin', description: 'Dashboard y operaciones protegidas por rol más CSRF.' },
    { name: 'resources', description: 'Carga local o directa S3/R2 con URLs firmadas y multipart.' },
    { name: 'analytics', description: 'Recepción anónima y respetuosa de señales de privacidad.' },
    { name: 'internal', description: 'Operaciones de infraestructura protegidas por secreto Bearer.' },
  ];

  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...openApiSchemas },
    securitySchemes: {
      ...document.components?.securitySchemes,
      cookieAuth: {
        type: 'apiKey', in: 'cookie', name: 'lg_session',
        description: 'Cookie opaca HttpOnly emitida por registro/login. El nombre real puede configurarse con SESSION_COOKIE_NAME.',
      },
      cronBearer: {
        type: 'http', scheme: 'bearer', bearerFormat: 'CRON_SECRET',
        description: 'Secreto exclusivo para tareas internas; nunca debe enviarse desde el frontend.',
      },
    },
    parameters: {
      ...document.components?.parameters,
      CsrfToken: {
        name: 'x-csrf-token', in: 'header', required: true,
        description: 'Token opaco devuelto por registro, login o GET /auth/me. Se rota al consultar la sesión.',
        schema: { type: 'string', minLength: 20 }, example: 'token-csrf-opaco',
      },
      Dnt: {
        name: 'DNT', in: 'header', required: false,
        description: 'Si vale 1, no se persiste ningún evento y accepted es 0.', schema: { type: 'string', enum: ['1'] },
      },
      SecGpc: {
        name: 'Sec-GPC', in: 'header', required: false,
        description: 'Si vale 1, se respeta Global Privacy Control y no se persiste ningún evento.', schema: { type: 'string', enum: ['1'] },
      },
    },
    headers: {
      ...document.components?.headers,
      SetCookie: {
        description: 'Cookie de sesión HttpOnly o cookie anónima firmada. Los atributos Secure, SameSite y Domain dependen del entorno.',
        schema: { type: 'string', example: 'lg_session=token-opaco; Path=/; HttpOnly; SameSite=Lax' },
      },
    },
    responses: {
      ...document.components?.responses,
      ...errorResponses(),
    },
  };

  const undocumented: string[] = [];
  for (const [url, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;
    for (const [method, generatedOperation] of Object.entries(pathItem)) {
      if (!methodNames.has(method) || !generatedOperation || typeof generatedOperation !== 'object') continue;
      const key = `${method.toUpperCase()} ${url}`;
      const documentation = openApiOperations[key];
      if (!documentation) {
        undocumented.push(key);
        continue;
      }
      Object.assign(generatedOperation, documentation);
    }
  }

  Object.assign(document, {
    'x-documentation': {
      contract: 'centralized',
      documentedOperations: Object.keys(openApiOperations).length,
      undocumentedOperations: undocumented,
      authentication: 'opaque-cookie-session-plus-csrf',
    },
  });
  return document;
}

function errorResponses(): Record<string, OpenAPIV3.ResponseObject> {
  const descriptions: Record<number, string> = {
    400: 'Payload, parámetros o formato inválidos.', 401: 'Falta sesión/credencial o no es válida.', 403: 'Sesión válida sin permiso, cuenta suspendida o CSRF inválido.',
    404: 'Recurso inexistente o no publicado.', 409: 'Conflicto de unicidad, relación, estado o almacenamiento.', 410: 'La sesión de carga venció.',
    413: 'Archivo o cuerpo demasiado grande.', 415: 'Tipo multimedia no admitido o inconsistente.', 429: 'Límite de solicitudes excedido.',
    500: 'Error interno inesperado.', 501: 'Integración reservada pero todavía no implementada.', 502: 'El proveedor externo no pudo completar la operación.',
    503: 'Servicio o configuración requerida no disponible.',
  };
  const examples: Record<number, { code: string; message: string }> = {
    400: { code: 'VALIDATION_ERROR', message: 'El pedido contiene datos inválidos.' }, 401: { code: 'AUTH_REQUIRED', message: 'Necesitás iniciar sesión.' },
    403: { code: 'FORBIDDEN', message: 'No tenés permisos para realizar esta acción.' }, 404: { code: 'NOT_FOUND', message: 'No encontramos el recurso solicitado.' },
    409: { code: 'CONFLICT', message: 'La operación entra en conflicto con el estado actual.' }, 410: { code: 'UPLOAD_EXPIRED', message: 'La sesión de carga venció.' },
    413: { code: 'FILE_TOO_LARGE', message: 'El archivo supera el límite permitido.' }, 415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'El tipo declarado no coincide con el archivo.' },
    429: { code: 'RATE_LIMIT_EXCEEDED', message: 'Superaste temporalmente el límite de solicitudes.' }, 500: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno inesperado.' },
    501: { code: 'OAUTH_PENDING', message: 'La integración todavía no fue activada.' }, 502: { code: 'MAIL_DELIVERY_FAILED', message: 'No pudimos completar la operación con el proveedor externo.' },
    503: { code: 'SITE_SETTINGS_NOT_CONFIGURED', message: 'La configuración requerida todavía no está disponible.' },
  };
  return Object.fromEntries(Object.entries(descriptions).map(([statusText, description]) => {
    const status = Number(statusText);
    const example = examples[status]!;
    return [
      `Error${status}`,
      {
        description,
        ...(status === 429 ? { headers: {
          'Retry-After': { description: 'Segundos aproximados antes de reintentar.', schema: { type: 'integer', minimum: 1 } },
          'X-RateLimit-Limit': { description: 'Cupo total de la ventana.', schema: { type: 'integer', minimum: 1 } },
          'X-RateLimit-Remaining': { description: 'Solicitudes restantes en la ventana.', schema: { type: 'integer', minimum: 0 } },
          'X-RateLimit-Reset': { description: 'Segundos aproximados hasta reiniciar la ventana.', schema: { type: 'integer', minimum: 0 } },
        } } : {}),
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' }, example: { error: { ...example, requestId: 'req-1' } } } },
      },
    ];
  }));
}

export const documentedOperationKeys = Object.keys(openApiOperations).sort();
