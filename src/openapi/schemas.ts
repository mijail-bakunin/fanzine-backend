import type { OpenAPIV3 } from 'openapi-types';

type Schema = OpenAPIV3.SchemaObject;

const uuid = (description?: string): Schema => ({ type: 'string', format: 'uuid', ...(description ? { description } : {}) });
const dateTime = (description?: string): Schema => ({ type: 'string', format: 'date-time', ...(description ? { description } : {}) });
const nullableString = (description?: string): Schema => ({ type: 'string', nullable: true, ...(description ? { description } : {}) });
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });

export const openApiSchemas: Record<string, Schema | OpenAPIV3.ReferenceObject> = {
  ErrorDetail: {
    type: 'object',
    required: ['code', 'message', 'requestId'],
    properties: {
      code: { type: 'string', example: 'VALIDATION_ERROR', description: 'Código estable para tratamiento programático.' },
      message: { type: 'string', example: 'El pedido contiene datos inválidos.' },
      details: { nullable: true, description: 'Detalle estructurado opcional; en validaciones contiene los campos rechazados.' },
      requestId: { type: 'string', example: 'req-1', description: 'Identificador correlacionable con los logs del servidor.' },
    },
  },
  ErrorEnvelope: {
    type: 'object', required: ['error'], properties: { error: ref('ErrorDetail') },
    example: { error: { code: 'VALIDATION_ERROR', message: 'El pedido contiene datos inválidos.', details: {}, requestId: 'req-1' } },
  },
  Message: {
    type: 'object', required: ['message'], properties: { message: { type: 'string' } },
    example: { message: 'Operación completada.' },
  },
  AssistantMessageResponse: {
    type: 'object', required: ['conversationId', 'reply', 'requestId'], additionalProperties: false,
    properties: {
      conversationId: { type: 'string', minLength: 1, maxLength: 100, description: 'Identificador opaco recibido o generado por el backend.' },
      reply: {
        type: 'object', required: ['id', 'role', 'text', 'createdAt'], additionalProperties: false,
        properties: {
          id: uuid('Identificador único de la respuesta simulada.'), role: { type: 'string', enum: ['assistant'] },
          text: { type: 'string', minLength: 1, description: 'Respuesta determinista localizada según mensaje e idioma.' }, createdAt: dateTime(),
        },
      },
      requestId: { type: 'string', description: 'Identificador correlacionable con los logs HTTP.' },
    },
  },
  Pagination: {
    type: 'object', required: ['page', 'pageSize', 'total', 'totalPages'],
    properties: {
      page: { type: 'integer', minimum: 1, example: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, example: 25 },
      total: { type: 'integer', minimum: 0, example: 42 }, totalPages: { type: 'integer', minimum: 1, example: 2 },
    },
  },
  UserPreferences: {
    type: 'object', nullable: true,
    description: 'Preferencias conocidas más claves adicionales conservadas por compatibilidad futura.',
    properties: {
      theme: { type: 'string', enum: ['dark', 'light'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] },
      readingSize: { type: 'string', maxLength: 30 }, readingFont: { type: 'string', maxLength: 30 },
      contrast: { type: 'string', maxLength: 30 }, analyticsOptOut: { type: 'boolean' },
      expiresAt: { type: 'integer', format: 'int64', description: 'Marca temporal Unix en milisegundos enviada por el frontend.' },
    },
    additionalProperties: true,
  },
  User: {
    type: 'object', required: ['id', 'name', 'email', 'avatarUrl', 'role', 'status', 'savedNoteIds', 'preferences'],
    properties: {
      id: uuid('Identificador interno de la cuenta.'), name: { type: 'string', example: 'Tinta de Prueba' }, email: { type: 'string', format: 'email' },
      avatarUrl: { type: 'string', example: '', description: 'URL HTTP(S), data URL de imagen o cadena vacía.' },
      role: { type: 'string', enum: ['reader', 'admin', 'editor', 'moderator'] }, status: { type: 'string', enum: ['active', 'suspended', 'deleted'] },
      savedNoteIds: { type: 'array', items: { type: 'string' }, description: 'Slugs públicos de notas guardadas.' },
      preferences: ref('UserPreferences'),
    },
  },
  AuthResponse: {
    type: 'object', required: ['user', 'csrfToken'],
    properties: {
      user: ref('User'), csrfToken: { type: 'string', minLength: 20, description: 'Token opaco para el header x-csrf-token en mutaciones autenticadas.' },
    },
  },
  NavigationItem: {
    type: 'object', required: ['label', 'to', 'sortOrder'], additionalProperties: false,
    properties: { label: { type: 'string', maxLength: 80 }, to: { type: 'string', maxLength: 500 }, sortOrder: { type: 'integer', minimum: 0, maximum: 1000 } },
  },
  SocialLink: {
    type: 'object', required: ['label', 'url'], additionalProperties: false,
    properties: { label: { type: 'string', maxLength: 80 }, url: { type: 'string', format: 'uri', maxLength: 2000 }, icon: { type: 'string', maxLength: 40 } },
  },
  TitleParts: {
    type: 'object', required: ['main', 'accent'], additionalProperties: false,
    properties: { main: { type: 'string' }, accent: { type: 'string' } },
  },
  MediaReference: {
    type: 'object', required: ['url', 'alt'], additionalProperties: false,
    properties: { url: { type: 'string', format: 'uri' }, alt: { type: 'string' } },
  },
  ManifestoItem: {
    type: 'object', required: ['title', 'paragraphs'], additionalProperties: false,
    description: 'Bloque editorial desplegable del Manifiesto. El id, cuando existe, es estable entre idiomas.',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$', example: 'mutual-aid-organizes' },
      title: { type: 'string', minLength: 1, maxLength: 240 },
      paragraphs: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 5000 } },
    },
  },
  TranslationResolution: {
    type: 'object', required: ['requestedLocale', 'locale', 'translationFallback'],
    properties: {
      requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] },
      translationFallback: { type: 'boolean', description: 'True cuando la variante solicitada no está publicada y se entrega el español canónico.' },
    },
  },
  TranslationStatusMap: {
    type: 'object', required: ['es', 'en', 'ru'], additionalProperties: false,
    properties: { es: { type: 'string', enum: ['missing', 'draft', 'review', 'published'] }, en: { type: 'string', enum: ['missing', 'draft', 'review', 'published'] }, ru: { type: 'string', enum: ['missing', 'draft', 'review', 'published'] } },
  },
  MastheadTranslation: {
    type: 'object', required: ['image', 'alt'], additionalProperties: false,
    properties: {
      image: { type: 'string', format: 'uri', description: 'Variante gráfica que debe contener el logotipo en el idioma correspondiente.' },
      referenceImage: { type: 'string', format: 'uri', description: 'Lámina completa usada como fuente de recortes geométricos. Si se omite, se utiliza image.' },
      alt: { type: 'string', minLength: 2, maxLength: 2000 },
    },
  },
  EditionTranslation: {
    type: 'object', required: ['status'], additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['draft', 'review', 'published'], default: 'draft' }, title: { type: 'string', maxLength: 180 }, subtitle: { type: 'string', maxLength: 240 },
      date: { type: 'string', maxLength: 80 }, theme: { type: 'string', maxLength: 240 }, summary: { type: 'string', maxLength: 2000 }, author: { type: 'string', maxLength: 120 },
      publication: { type: 'string', maxLength: 120 }, headerLine: { type: 'string', maxLength: 240 }, masthead: ref('MastheadTranslation'),
    },
    description: 'Al publicar exige title, date, publication, headerLine y masthead completo.'
  },
  NoteTranslation: {
    type: 'object', required: ['status'], additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['draft', 'review', 'published'], default: 'draft' }, title: { type: 'string', maxLength: 240 }, subtitle: { type: 'string', maxLength: 1000 },
      summary: { type: 'string', maxLength: 2000 }, excerpt: { type: 'string', maxLength: 1000 }, body: { type: 'string', maxLength: 500000 }, thumbnailText: { type: 'string', maxLength: 1000 },
      author: { type: 'string', maxLength: 120 }, readMoreLabel: { type: 'string', maxLength: 40 }, readMoreSubtitle: { type: 'string', maxLength: 240 },
      coverTitleLines: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 120 } }, coverExcerpt: nullableString(),
    },
    description: 'Al publicar exige title, subtitle, summary, excerpt, body, thumbnailText, author y readMoreLabel.'
  },
  ResourceTranslation: {
    type: 'object', required: ['status'], additionalProperties: false,
    properties: { status: { type: 'string', enum: ['draft', 'review', 'published'] }, name: { type: 'string', maxLength: 240 }, title: { type: 'string', maxLength: 240 }, alt: { type: 'string', maxLength: 2000 }, caption: { type: 'string', maxLength: 2000 }, credit: { type: 'string', maxLength: 500 }, license: { type: 'string', maxLength: 500 } },
    description: 'Al publicar exige name, alt, caption, credit y license.'
  },
  CategoryTranslation: {
    type: 'object', required: ['status'], additionalProperties: false,
    properties: { status: { type: 'string', enum: ['draft', 'review', 'published'] }, name: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 2000 } },
    description: 'Al publicar exige name y description.'
  },
  EditionTranslations: { type: 'object', additionalProperties: false, properties: { es: ref('EditionTranslation'), en: ref('EditionTranslation'), ru: ref('EditionTranslation') } },
  NoteTranslations: { type: 'object', additionalProperties: false, properties: { es: ref('NoteTranslation'), en: ref('NoteTranslation'), ru: ref('NoteTranslation') } },
  ResourceTranslations: { type: 'object', additionalProperties: false, properties: { es: ref('ResourceTranslation'), en: ref('ResourceTranslation'), ru: ref('ResourceTranslation') } },
  CategoryTranslations: { type: 'object', additionalProperties: false, properties: { es: ref('CategoryTranslation'), en: ref('CategoryTranslation'), ru: ref('CategoryTranslation') } },
  PublicationContent: {
    type: 'object', required: ['brand', 'navigation', 'footer', 'authentication', 'archive', 'pages', 'assets'],
    description: 'Contenido editorial localizado para marca, cabecera, pie, acceso, archivo y páginas institucionales.',
    properties: {
      brand: { type: 'object', required: ['name', 'publicationType', 'statement', 'headerLine'], properties: { name: { type: 'string' }, publicationType: { type: 'string' }, statement: { type: 'string' }, headerLine: { type: 'string' } } },
      navigation: { type: 'array', items: ref('NavigationItem') },
      footer: { type: 'object', required: ['statement', 'socialPrompt', 'socialLinks'], properties: { statement: { type: 'string' }, socialPrompt: { type: 'string' }, socialLinks: { type: 'array', items: ref('SocialLink') } } },
      authentication: { type: 'object', additionalProperties: true, description: 'Copias de acceso, privacidad, login y registro.' },
      archive: { type: 'object', additionalProperties: true, description: 'Título, introducción, rótulos y estados vacíos del archivo.' },
      pages: {
        type: 'object', required: ['about', 'manifesto', 'collaborate', 'contact', 'help', 'soon', 'notFound'], additionalProperties: true,
        properties: {
          manifesto: {
            type: 'object', required: ['eyebrow', 'title', 'statements'], additionalProperties: false,
            description: 'Mantiene statements por compatibilidad y agrega items para desplegables editoriales.',
            properties: {
              eyebrow: { type: 'string' }, title: ref('TitleParts'), statements: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string' } },
              items: { type: 'array', minItems: 1, maxItems: 30, items: ref('ManifestoItem') },
            },
          },
        },
      },
      assets: { type: 'object', additionalProperties: ref('MediaReference'), description: 'Assets editoriales y de estados publicados por la API.' },
    },
  },
  SeoSettings: {
    type: 'object', required: ['siteName', 'defaultTitle', 'defaultDescription', 'defaultImage', 'locale', 'pages'],
    properties: {
      siteName: { type: 'string' }, defaultTitle: { type: 'string' }, defaultDescription: { type: 'string' },
      defaultImage: { allOf: [ref('MediaReference')], nullable: true }, locale: { type: 'string', enum: ['es', 'en', 'ru'] },
      pages: { type: 'object', additionalProperties: { type: 'object', required: ['title', 'description'], properties: { title: { type: 'string' }, description: { type: 'string' }, image: { allOf: [ref('MediaReference')], nullable: true }, canonical: { type: 'string' } } } },
    },
  },
  SiteSettings: {
    type: 'object', required: ['requestedLocale', 'locale', 'translationFallback', 'brandName', 'publicationType', 'statement', 'headerLine', 'navigation', 'footerStatement', 'socialPrompt', 'socialLinks', 'brand', 'footer', 'authentication', 'archive', 'pages', 'assets', 'seo', 'updatedAt'],
    properties: {
      requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] }, translationFallback: { type: 'boolean' }, brandName: { type: 'string', minLength: 2, maxLength: 120 }, publicationType: { type: 'string', minLength: 2, maxLength: 160 },
      statement: { type: 'string', minLength: 2, maxLength: 240 }, headerLine: { type: 'string', minLength: 2, maxLength: 240 },
      navigation: { type: 'array', maxItems: 30, items: ref('NavigationItem') }, footerStatement: { type: 'string', minLength: 2, maxLength: 500 },
      socialPrompt: { type: 'string', minLength: 2, maxLength: 160 }, socialLinks: { type: 'array', maxItems: 30, items: ref('SocialLink') },
      brand: { type: 'object', additionalProperties: true }, footer: { type: 'object', additionalProperties: true }, authentication: { type: 'object', nullable: true, additionalProperties: true },
      archive: { type: 'object', nullable: true, additionalProperties: true }, pages: { type: 'object', additionalProperties: true }, assets: { type: 'object', additionalProperties: ref('MediaReference') }, seo: ref('SeoSettings'),
      contentByLocale: { type: 'object', additionalProperties: ref('PublicationContent'), description: 'Sólo en GET/PATCH administrativos.' },
      seoByLocale: { type: 'object', additionalProperties: ref('SeoSettings'), description: 'Sólo en GET/PATCH administrativos.' },
      updatedAt: dateTime('Última modificación de la configuración.'),
    },
  },
  Resource: {
    type: 'object', required: ['id', 'type', 'name', 'title', 'url', 'alt', 'caption', 'credit', 'license', 'status', 'uploadStatus', 'fileName', 'fileSize', 'storageDriver', 'date', 'createdAt', 'updatedAt', 'requestedLocale', 'locale', 'translationFallback'],
    properties: {
      id: uuid(), type: { type: 'string', enum: ['image', 'video', 'audio', 'pdf', 'link'] }, name: { type: 'string' }, title: { type: 'string' },
      url: { type: 'string', description: 'URL pública o externa. Puede estar vacía mientras una carga S3 está incompleta.' }, alt: { type: 'string' }, caption: { type: 'string' }, credit: { type: 'string' }, license: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted'] },
      uploadStatus: { type: 'string', enum: ['pending', 'uploading', 'complete', 'failed', 'aborted'] }, fileName: { type: 'string' },
      fileSize: { type: 'integer', format: 'int64', minimum: 0 }, mimeType: nullableString('MIME detectado; puede ser nulo para enlaces externos.'), storageDriver: { type: 'string', enum: ['local', 's3', 'external'] },
      width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, durationSeconds: { type: 'integer', minimum: 0 }, checksum: { type: 'string' },
      poster: { allOf: [ref('MediaReference')], nullable: true }, date: dateTime(), createdAt: dateTime(), updatedAt: dateTime(),
      requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] }, translationFallback: { type: 'boolean' },
      translations: ref('ResourceTranslations'), translationStatus: ref('TranslationStatusMap'),
    },
  },
  GalleryItem: {
    type: 'object', required: ['url', 'alt', 'caption', 'credit', 'license'],
    properties: { url: { type: 'string' }, alt: { type: 'string' }, caption: { type: 'string' }, credit: { type: 'string' }, license: { type: 'string' } },
  },
  CoverButtonPosition: {
    type: 'object', additionalProperties: false,
    description: 'Posición editorial opcional del botón de lectura. Las longitudes admiten px, %, rem, em, vw, vh, cqw, cqh o auto.',
    properties: {
      left: { type: 'string', example: '7px' },
      right: { type: 'string', example: '7px' },
      bottom: { type: 'string', example: '7px' },
    },
  },
  CoverPresentation: {
    type: 'object', required: ['titleLines', 'excerpt', 'depth'],
    description: 'Vista normalizada para consumo directo del frontend. Los campos de posición se omiten cuando no fueron configurados.',
    properties: {
      titleLines: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
      excerpt: nullableString(),
      buttonLeft: { type: 'string' }, buttonRight: { type: 'string' }, buttonBottom: { type: 'string' },
      depth: { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
    },
  },
  CoverTypography: {
    type: 'object', required: ['titleSize', 'titleAlign', 'titleTreatment', 'excerptSize'], additionalProperties: false,
    description: 'Tratamiento tipográfico editorial seguro de una nota en portada. No acepta CSS ni valores libres.',
    properties: {
      titleSize: { type: 'string', enum: ['compact', 'standard', 'display'], default: 'standard' },
      titleAlign: { type: 'string', enum: ['left', 'center', 'right'], default: 'left' },
      titleTreatment: { type: 'string', enum: ['brush', 'block', 'torn'], default: 'brush' },
      excerptSize: { type: 'string', enum: ['compact', 'standard', 'large'], default: 'standard' },
    },
  },
  CoverTypographyPatch: {
    type: 'object', minProperties: 1, additionalProperties: false,
    description: 'PATCH parcial: los campos omitidos conservan su valor persistido.',
    properties: {
      titleSize: { type: 'string', enum: ['compact', 'standard', 'display'] },
      titleAlign: { type: 'string', enum: ['left', 'center', 'right'] },
      titleTreatment: { type: 'string', enum: ['brush', 'block', 'torn'] },
      excerptSize: { type: 'string', enum: ['compact', 'standard', 'large'] },
    },
  },
  PublicNote: {
    type: 'object', required: ['id', 'databaseId', 'slug', 'fragment', 'x', 'y', 'w', 'h', 'tone', 'sortOrder', 'editionLink', 'title', 'subtitle', 'thumbnailText', 'readMoreLabel', 'readMoreSubtitle', 'coverTitleLines', 'coverExcerpt', 'coverButtonPosition', 'coverDepth', 'cover', 'coverTypography', 'paragraphs', 'bodyMarkdown', 'author', 'readingMinutes', 'tags', 'categoryIds', 'resources', 'gallery', 'rating', 'ratingsCount'],
    properties: {
      id: { type: 'string', description: 'Identificador público; coincide con slug.' }, databaseId: uuid(), slug: { type: 'string' }, fragment: { type: 'string' },
      x: { type: 'integer', minimum: 0, maximum: 1054 }, y: { type: 'integer', minimum: 440, maximum: 1491 }, w: { type: 'integer', minimum: 1, maximum: 1055 }, h: { type: 'integer', minimum: 1, maximum: 1052 }, tone: { type: 'string', enum: ['red', 'yellow', 'cyan', 'lime'] }, sortOrder: { type: 'integer', minimum: 0 },
      title: { type: 'string' }, subtitle: { type: 'string' }, summary: { type: 'string' }, excerpt: { type: 'string' }, thumbnailText: { type: 'string' }, readMoreLabel: { type: 'string' }, readMoreSubtitle: { type: 'string' },
      coverTitleLines: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } }, coverExcerpt: nullableString(),
      coverButtonPosition: { allOf: [ref('CoverButtonPosition')], nullable: true }, coverDepth: { type: 'integer', nullable: true, minimum: 0, maximum: 100 }, cover: ref('CoverPresentation'),
      coverTypography: ref('CoverTypography'),
      paragraphs: { type: 'array', items: { type: 'string' } }, bodyMarkdown: { type: 'string' }, author: { type: 'string' }, readingMinutes: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { type: 'string' } }, categoryIds: { type: 'array', items: { type: 'string' } }, resources: { type: 'array', items: ref('Resource') },
      gallery: { type: 'array', items: ref('GalleryItem') },
      thumbnail: { allOf: [ref('GalleryItem')], nullable: true },
      video: { type: 'object', properties: { url: { type: 'string' }, src: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, credit: { type: 'string' }, poster: { allOf: [ref('MediaReference')], nullable: true } } },
      editionLink: { type: 'boolean' }, rating: { type: 'number', format: 'float', minimum: 0, maximum: 5 }, ratingsCount: { type: 'integer', minimum: 0 },
      requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] }, translationFallback: { type: 'boolean' },
    },
  },
  SearchResult: {
    type: 'object', required: ['id', 'slug', 'type', 'title', 'description', 'tags', 'route', 'editionSlug', 'image'],
    properties: {
      id: uuid(), slug: { type: 'string', nullable: true }, type: { type: 'string', enum: ['note', 'edition', 'book', 'image', 'video', 'audio', 'pdf', 'link'] },
      title: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, route: { type: 'string' }, editionSlug: nullableString(), image: { allOf: [ref('MediaReference')], nullable: true },
    },
  },
  SavedNote: {
    type: 'object', required: ['id', 'databaseId', 'slug', 'title', 'thumbnailText', 'tone', 'editionSlug', 'image', 'savedAt'],
    properties: { id: { type: 'string' }, databaseId: uuid(), slug: { type: 'string' }, title: { type: 'string' }, thumbnailText: { type: 'string' }, tone: { type: 'string' }, editionSlug: nullableString(), image: { allOf: [ref('MediaReference')], nullable: true }, savedAt: dateTime() },
  },
  CatalogResource: {
    allOf: [
      ref('Resource'),
      {
        type: 'object', required: ['tags', 'notes', 'editions'],
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'object', required: ['slug', 'title', 'role'], properties: { slug: { type: 'string' }, title: { type: 'string' }, role: { type: 'string' } } } },
          editions: { type: 'array', items: { type: 'object', required: ['slug', 'title', 'kind', 'role'], properties: { slug: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: ['magazine', 'book'] }, role: { type: 'string' } } } },
        },
      },
    ],
  },
  CoverArtElement: {
    type: 'object', required: ['id', 'type', 'tone', 'x', 'y', 'w', 'h', 'rotation', 'depth'], additionalProperties: false,
    description: 'Elemento visual seguro sobre el lienzo nominal de 1055 × 1492. No acepta CSS, HTML ni URLs.',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$', example: 'tape-top-left' },
      type: { type: 'string', enum: ['tape', 'staples', 'coffee', 'burn', 'stamp', 'brush'] },
      tone: { type: 'string', enum: ['paper', 'red', 'yellow', 'cyan', 'lime', 'ink'] },
      x: { type: 'integer', minimum: 0, maximum: 1054 }, y: { type: 'integer', minimum: 0, maximum: 1491 },
      w: { type: 'integer', minimum: 1, maximum: 1055, description: 'Debe cumplir x + w <= 1055.' },
      h: { type: 'integer', minimum: 1, maximum: 1492, description: 'Debe cumplir y + h <= 1492.' },
      rotation: { type: 'integer', minimum: -30, maximum: 30 }, depth: { type: 'integer', minimum: 0, maximum: 100 },
    },
  },
  CoverArt: {
    type: 'object', required: ['preset', 'elements'], additionalProperties: false,
    description: 'Dirección de arte persistente de la portada. El preset define el lenguaje visual y elements agrega hasta 12 marcas posicionables sin CSS arbitrario.',
    properties: {
      preset: { type: 'string', enum: ['archive', 'riot', 'night', 'signal', 'ash'], default: 'archive' },
      elements: { type: 'array', minItems: 0, maxItems: 12, uniqueItems: false, items: ref('CoverArtElement'), description: 'Los id deben ser únicos dentro de la edición.' },
    },
  },
  CoverArtPatch: {
    type: 'object', minProperties: 1, additionalProperties: false,
    description: 'Actualización parcial de dirección de arte. Omitir un campo lo conserva; enviar elements reemplaza la colección completa.',
    properties: {
      preset: { type: 'string', enum: ['archive', 'riot', 'night', 'signal', 'ash'] },
      elements: { type: 'array', minItems: 0, maxItems: 12, items: ref('CoverArtElement'), description: 'Los id deben ser únicos dentro de la edición.' },
    },
  },
  EditionSummary: {
    type: 'object', required: ['id', 'slug', 'kind', 'number', 'title', 'date', 'coverArt'],
    properties: {
      id: uuid(), slug: { type: 'string' }, kind: { type: 'string', enum: ['magazine', 'book'] }, number: { type: 'integer', nullable: true }, title: { type: 'string' },
      subtitle: nullableString(), author: nullableString(), date: { type: 'string' }, theme: nullableString(), summary: nullableString(),
      coverArt: ref('CoverArt'), cover: { type: 'object', nullable: true, properties: { url: { type: 'string' }, alt: { type: 'string' } } }, tags: { type: 'array', items: { type: 'string' } },
    },
  },
  EditionHome: {
    type: 'object', required: ['requestedLocale', 'locale', 'translationFallback', 'edition', 'masthead', 'notes'],
    properties: {
      edition: {
        type: 'object', required: ['id', 'slug', 'number', 'title', 'date', 'coverArt'],
        properties: { id: uuid(), slug: { type: 'string' }, number: { type: 'integer', nullable: true, example: 12 }, title: { type: 'string' }, subtitle: nullableString(), theme: nullableString(), summary: nullableString(), date: { type: 'string' }, publication: nullableString(), headerLine: nullableString(), coverArt: ref('CoverArt') },
      },
      requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] }, translationFallback: { type: 'boolean' },
      masthead: {
        type: 'object', required: ['image', 'referenceImage', 'alt', 'canvas', 'requestedLocale', 'locale', 'translationFallback'],
        properties: {
          image: { type: 'string', description: 'Imagen principal del masthead localizado.' },
          referenceImage: { type: 'string', description: 'Lámina completa localizada que debe escalarse al canvas nominal antes de aplicar x/y/w/h.' },
          alt: { type: 'string' },
          canvas: { type: 'object', required: ['width', 'height', 'mastheadHeight'], additionalProperties: false, properties: {
            width: { type: 'integer', enum: [1055] }, height: { type: 'integer', enum: [1492] }, mastheadHeight: { type: 'integer', enum: [440] },
          } },
          requestedLocale: { type: 'string', enum: ['es', 'en', 'ru'] }, locale: { type: 'string', enum: ['es', 'en', 'ru'] }, translationFallback: { type: 'boolean' },
        },
      },
      notes: { type: 'array', items: ref('PublicNote') },
    },
  },
  Comment: {
    type: 'object', required: ['id', 'author', 'isAnonymous', 'authorType', 'body', 'votes', 'reactionsCount', 'parentId', 'replies', 'status', 'createdAt'],
    properties: {
      id: uuid(), author: { type: 'string' }, isAnonymous: { type: 'boolean' }, authorType: { type: 'string', enum: ['anonymous', 'account'] },
      body: { type: 'string', description: 'Vacío en el tombstone público de un comentario anónimo eliminado.' },
      votes: { type: 'integer', minimum: 0, description: 'Alias compatible de reactionsCount.' },
      reactionsCount: { type: 'integer', minimum: 0, description: 'Cantidad de reacciones like.' },
      parentId: { type: 'string', format: 'uuid', nullable: true, description: 'Null para comentarios principales; UUID raíz para respuestas.' },
      replies: { type: 'array', maxItems: 200, items: ref('Comment'), description: 'Respuestas públicas de primer nivel; vacío en una respuesta.' },
      status: { type: 'string', enum: ['pending', 'visible', 'deleted'], description: 'hidden/reported nunca se publican; deleted sólo se publica como tombstone anónimo.' }, createdAt: dateTime(),
      reaction: { type: 'string', enum: ['like'], nullable: true, description: 'Sólo se devuelve al alternar una reacción.' },
      reacted: { type: 'boolean', description: 'Estado resultante del toggle; sólo se devuelve al reaccionar.' },
      moderationMessage: { type: 'string' },
    },
  },
  CommentEmailDelivery: {
    type: 'object', required: ['status', 'messageId', 'error'], additionalProperties: false, nullable: true,
    properties: {
      status: { type: 'string', enum: ['pending', 'development', 'sent', 'failed', 'not_applicable'] },
      messageId: nullableString('Identificador técnico del envío; no contiene el correo de destino.'),
      error: nullableString('Código seguro de error; nunca incluye credenciales ni datos del proveedor.'),
    },
  },
  AdminComment: {
    type: 'object', required: ['id', 'parentId', 'noteId', 'noteTitle', 'author', 'isAnonymous', 'authorType', 'body', 'status', 'moderationReason', 'moderatedAt', 'moderatedBy', 'deletedAt', 'emailDelivery', 'createdAt', 'reports', 'votes'],
    properties: {
      id: uuid(), parentId: { type: 'string', format: 'uuid', nullable: true }, noteId: { type: 'string' }, noteTitle: { type: 'string' },
      author: { type: 'string' }, isAnonymous: { type: 'boolean' }, authorType: { type: 'string', enum: ['anonymous', 'account'] },
      body: { type: 'string', description: 'El dashboard conserva el texto original también después del borrado lógico.' },
      status: { type: 'string', enum: ['pending', 'visible', 'hidden', 'reported', 'deleted'] },
      moderationReason: nullableString(), moderatedAt: { type: 'string', format: 'date-time', nullable: true }, moderatedBy: nullableString(),
      deletedAt: { type: 'string', format: 'date-time', nullable: true }, emailDelivery: ref('CommentEmailDelivery'),
      createdAt: dateTime(), reports: { type: 'integer', minimum: 0 }, votes: { type: 'integer', minimum: 0 },
    },
  },
  CommentModerationResult: {
    type: 'object', required: ['id', 'status', 'isAnonymous', 'authorType', 'moderationReason', 'moderatedAt', 'deletedAt', 'emailDelivery'],
    properties: {
      id: uuid(), status: { type: 'string', enum: ['pending', 'visible', 'hidden', 'reported', 'deleted'] }, isAnonymous: { type: 'boolean' },
      authorType: { type: 'string', enum: ['anonymous', 'account'] }, moderationReason: nullableString(),
      moderatedAt: { type: 'string', format: 'date-time', nullable: true }, deletedAt: { type: 'string', format: 'date-time', nullable: true },
      emailDelivery: ref('CommentEmailDelivery'),
    },
  },
  RatingAggregate: {
    type: 'object', required: ['rating', 'ratingsCount'], properties: { rating: { type: 'number', minimum: 0, maximum: 5, example: 4.6 }, ratingsCount: { type: 'integer', minimum: 0, example: 18 } },
  },
  AdminEdition: {
    type: 'object', required: ['id', 'slug', 'number', 'title', 'subtitle', 'date', 'status', 'coverArt', 'createdAt', 'updatedAt'],
    properties: { id: uuid(), slug: { type: 'string' }, number: { type: 'string', example: '12' }, title: { type: 'string' }, subtitle: { type: 'string' }, date: { type: 'string' }, status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted'] }, coverArt: ref('CoverArt'), translations: ref('EditionTranslations'), translationStatus: ref('TranslationStatusMap'), createdAt: dateTime(), updatedAt: dateTime() },
  },
  AdminNote: {
    type: 'object', required: ['id', 'slug', 'title', 'excerpt', 'body', 'status', 'author', 'readingMinutes', 'fragment', 'x', 'y', 'w', 'h', 'tone', 'sortOrder', 'editionLink', 'coverTitleLines', 'coverExcerpt', 'coverButtonPosition', 'coverDepth', 'cover', 'coverTypography', 'updatedAt'],
    properties: { id: uuid(), slug: { type: 'string' }, title: { type: 'string' }, excerpt: { type: 'string' }, body: { type: 'string' }, status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted'] }, editionId: { type: 'string', format: 'uuid', nullable: true }, author: { type: 'string' }, readingMinutes: { type: 'integer' }, fragment: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 1054 }, y: { type: 'integer', minimum: 440, maximum: 1491 }, w: { type: 'integer', minimum: 1, maximum: 1055 }, h: { type: 'integer', minimum: 1, maximum: 1052 }, tone: { type: 'string', enum: ['red', 'yellow', 'cyan', 'lime'] }, sortOrder: { type: 'integer', minimum: 0 }, editionLink: { type: 'boolean' }, coverTitleLines: { type: 'array', items: { type: 'string' } }, coverExcerpt: nullableString(), coverButtonPosition: { allOf: [ref('CoverButtonPosition')], nullable: true }, coverDepth: { type: 'integer', nullable: true, minimum: 0, maximum: 100 }, cover: ref('CoverPresentation'), coverTypography: ref('CoverTypography'), translations: ref('NoteTranslations'), translationStatus: ref('TranslationStatusMap'), updatedAt: dateTime() },
  },
  Category: {
    type: 'object', required: ['id', 'slug', 'name', 'color', 'description', 'status'],
    properties: { id: uuid(), slug: { type: 'string' }, name: { type: 'string' }, color: { type: 'string', enum: ['red', 'yellow', 'cyan', 'lime'] }, description: { type: 'string' }, status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'archived', 'deleted'] }, translations: ref('CategoryTranslations'), translationStatus: ref('TranslationStatusMap'), notesCount: { type: 'integer', minimum: 0 } },
  },
  ContactResult: {
    type: 'object', required: ['id', 'status', 'reply', 'replyStatus', 'sentAt'],
    properties: { id: uuid(), status: { type: 'string', enum: ['new', 'in_progress', 'answered', 'archived'] }, reply: { type: 'string' }, replyStatus: { type: 'string', enum: ['draft', 'queued', 'sent', 'failed'], nullable: true }, sentAt: { type: 'string', format: 'date-time', nullable: true } },
  },
  AdminUser: {
    type: 'object', required: ['id', 'name', 'email', 'role', 'status'],
    properties: { id: uuid(), name: { type: 'string' }, email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['reader', 'admin', 'editor', 'moderator'] }, status: { type: 'string', enum: ['active', 'suspended'] } },
  },
  AnalyticsDashboard: {
    type: 'object',
    required: ['summary', 'timeline', 'topNotes', 'attention', 'sources'],
    properties: {
      summary: { type: 'object', required: ['visits', 'uniqueReaders', 'completedReads', 'avgReadingSeconds', 'downloads', 'comments', 'ratings', 'avgRating'], properties: { visits: { type: 'integer' }, uniqueReaders: { type: 'integer' }, completedReads: { type: 'integer' }, avgReadingSeconds: { type: 'integer' }, downloads: { type: 'integer' }, comments: { type: 'integer' }, ratings: { type: 'integer' }, avgRating: { type: 'number' } } },
      timeline: { type: 'array', items: { type: 'object', required: ['label', 'date', 'visits', 'reads'], properties: { label: { type: 'string' }, date: { type: 'string', format: 'date' }, visits: { type: 'integer' }, reads: { type: 'integer' } } } },
      topNotes: { type: 'array', items: { type: 'object', required: ['noteId', 'title', 'visits', 'completion', 'rating'], properties: { noteId: uuid(), title: { type: 'string' }, visits: { type: 'integer' }, completion: { type: 'integer', minimum: 0 }, rating: { type: 'number', minimum: 0, maximum: 5 } } } },
      attention: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'number' } } } },
      sources: { type: 'array', items: { type: 'object', required: ['label', 'value', 'count'], properties: { label: { type: 'string' }, value: { type: 'integer', minimum: 0, maximum: 100, description: 'Porcentaje redondeado.' }, count: { type: 'integer', minimum: 0 } } } },
    },
  },
  Dashboard: {
    type: 'object', required: ['editions', 'notes', 'resources', 'categories', 'contacts', 'comments', 'users', 'analytics', 'logs', 'pagination', 'filters'],
    properties: {
      editions: { type: 'array', items: { allOf: [ref('AdminEdition'), { type: 'object', properties: { cover: { type: 'string' }, noteIds: { type: 'array', items: uuid() } } }] } },
      notes: { type: 'array', items: { allOf: [ref('AdminNote'), { type: 'object', properties: { categoryIds: { type: 'array', items: { type: 'string' } }, resourceIds: { type: 'array', items: uuid() }, rating: { type: 'number' }, ratingsCount: { type: 'integer' }, views: { type: 'integer' } } }] } },
      resources: { type: 'array', items: ref('Resource') }, categories: { type: 'array', items: ref('Category') },
      contacts: { type: 'array', items: { type: 'object', additionalProperties: true } }, comments: { type: 'array', items: ref('AdminComment') }, users: { type: 'array', items: { type: 'object', additionalProperties: true } },
      analytics: ref('AnalyticsDashboard'), logs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      pagination: { type: 'object', additionalProperties: ref('Pagination') }, filters: { type: 'object', additionalProperties: true },
    },
  },
  UploadStart: {
    type: 'object', required: ['mode', 'uploadId', 'resourceId', 'expiresAt'],
    properties: {
      mode: { type: 'string', enum: ['single', 'multipart'] }, uploadId: uuid(), resourceId: uuid(), expiresAt: dateTime(),
      uploadUrl: { type: 'string', format: 'uri' }, method: { type: 'string', enum: ['PUT'] }, headers: { type: 'object', additionalProperties: { type: 'string' } }, partSize: { type: 'integer', minimum: 5242880 },
    },
  },
  SignedPart: {
    type: 'object', required: ['partNumber', 'uploadUrl', 'method', 'expiresAt'],
    properties: { partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, uploadUrl: { type: 'string', format: 'uri' }, method: { type: 'string', enum: ['PUT'] }, expiresAt: dateTime() },
  },
  AnalyticsAccepted: {
    type: 'object', required: ['accepted'], properties: { accepted: { type: 'integer', minimum: 0, maximum: 20 }, privacySignalRespected: { type: 'boolean' } },
  },
};

export const schemaRef = ref;
