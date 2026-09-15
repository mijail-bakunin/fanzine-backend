import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { buildApp } from '../../src/build-app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { hashPassword } from '../../src/lib/crypto.js';

export const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://guillotina:guillotina_dev@127.0.0.1:5432/laguillotina_test?schema=public';
export const prefix = '/laguillotina/api/v1';
export const storagePath = './storage/test-comprehensive';
export const mailboxPath = `${storagePath}/mailbox`;

export const ids = {
  admin: '00000000-0000-4000-8000-000000000001',
  reader: '00000000-0000-4000-8000-000000000002',
  editor: '00000000-0000-4000-8000-000000000003',
  moderator: '00000000-0000-4000-8000-000000000004',
  suspended: '00000000-0000-4000-8000-000000000005',
  deleted: '00000000-0000-4000-8000-000000000006',
  edition: '10000000-0000-4000-8000-000000000012',
  book: '10000000-0000-4000-8000-000000000013',
  draftEdition: '10000000-0000-4000-8000-000000000014',
  note: '20000000-0000-4000-8000-000000000001',
  secondNote: '20000000-0000-4000-8000-000000000002',
  draftNote: '20000000-0000-4000-8000-000000000003',
  category: '30000000-0000-4000-8000-000000000001',
  secondCategory: '30000000-0000-4000-8000-000000000002',
  cover: '40000000-0000-4000-8000-000000000001',
  image: '40000000-0000-4000-8000-000000000002',
  video: '40000000-0000-4000-8000-000000000003',
  draftResource: '40000000-0000-4000-8000-000000000004',
  comment: '50000000-0000-4000-8000-000000000001',
  contact: '60000000-0000-4000-8000-000000000001',
} as const;

export const credentials = {
  admin: { email: 'admin@laguillotina.local', password: 'guillotina-admin' },
  reader: { email: 'prueba@laguillotina.local', password: 'guillotina' },
  editor: { email: 'editor@laguillotina.local', password: 'guillotina-editor' },
  moderator: { email: 'moderador@laguillotina.local', password: 'guillotina-moderator' },
  suspended: { email: 'suspendida@laguillotina.local', password: 'guillotina-suspended' },
  deleted: { email: 'eliminada@laguillotina.local', password: 'guillotina-deleted' },
} as const;

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

export const baseConfig = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  API_PREFIX: prefix,
  APP_PUBLIC_URL: 'http://localhost:5173',
  COOKIE_SECRET: 'test-cookie-secret-with-more-than-thirty-two-characters',
  ANONYMOUS_HMAC_SECRET: 'test-anonymous-secret-with-more-than-thirty-two-characters',
  ANALYTICS_HMAC_SECRET: 'test-analytics-secret-with-more-than-thirty-two-characters',
  CRON_SECRET: 'test-cron-secret-long-enough',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_PATH: storagePath,
  DEV_MAILBOX_PATH: mailboxPath,
  PUBLIC_STORAGE_BASE_URL: 'http://localhost:3001/laguillotina/api/v1/media',
  FRONTEND_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  LOG_LEVEL: 'silent',
});

export type ConfigOverrides = Partial<Omit<AppConfig, 's3' | 'mail' | 'oauth'>> & {
  s3?: Partial<AppConfig['s3']>;
  mail?: Partial<AppConfig['mail']>;
  oauth?: { google?: Partial<AppConfig['oauth']['google']>; x?: Partial<AppConfig['oauth']['x']> };
};

export type TestContext = {
  app: FastifyInstance;
  config: AppConfig;
};

let passwordHashes: Promise<Record<keyof typeof credentials, string>> | undefined;

export async function createTestContext(overrides: ConfigOverrides = {}): Promise<TestContext> {
  await resetDatabase();
  const config = {
    ...baseConfig,
    ...overrides,
    s3: { ...baseConfig.s3, ...overrides.s3 },
    mail: { ...baseConfig.mail, ...overrides.mail },
    oauth: {
      google: { ...baseConfig.oauth.google, ...overrides.oauth?.google },
      x: { ...baseConfig.oauth.x, ...overrides.oauth?.x },
    },
  } as AppConfig;
  const app = await buildApp({ config, prisma, logger: false });
  await app.ready();
  return { app, config };
}

export async function resetDatabase() {
  await rm(storagePath, { recursive: true, force: true });
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      analytics_daily, analytics_events, error_logs, admin_logs, contact_replies, contact_messages,
      saved_notes, note_ratings, comment_reports, comment_votes, comments, resource_uploads,
      edition_resources, note_resources, resources, note_categories, categories, notes, editions,
      password_reset_tokens, oauth_accounts, sessions, user_preferences, user_profiles, users, site_settings
    RESTART IDENTITY CASCADE
  `);
  await seedBaseline();
}

async function seedBaseline() {
  passwordHashes ??= (async () => {
    const entries = await Promise.all(Object.entries(credentials).map(async ([key, value]) => [key, await hashPassword(value.password)] as const));
    return Object.fromEntries(entries) as Record<keyof typeof credentials, string>;
  })();
  const hashes = await passwordHashes;
  await prisma.user.createMany({ data: [
    { id: ids.admin, email: credentials.admin.email, displayName: 'Administración', passwordHash: hashes.admin, role: 'ADMIN' },
    { id: ids.reader, email: credentials.reader.email, displayName: 'Lectora', passwordHash: hashes.reader, role: 'READER' },
    { id: ids.editor, email: credentials.editor.email, displayName: 'Edición', passwordHash: hashes.editor, role: 'EDITOR' },
    { id: ids.moderator, email: credentials.moderator.email, displayName: 'Moderación', passwordHash: hashes.moderator, role: 'MODERATOR' },
    { id: ids.suspended, email: credentials.suspended.email, displayName: 'Suspendida', passwordHash: hashes.suspended, role: 'READER', status: 'SUSPENDED' },
    { id: ids.deleted, email: credentials.deleted.email, displayName: 'Eliminada', passwordHash: hashes.deleted, role: 'READER', status: 'DELETED', deletedAt: new Date() },
  ] });
  await Promise.all([ids.admin, ids.reader, ids.editor, ids.moderator, ids.suspended].map(userId => prisma.userProfile.create({ data: { userId, publicName: `Perfil ${userId.slice(-1)}` } })));
  await Promise.all([ids.admin, ids.reader, ids.editor, ids.moderator, ids.suspended].map(userId => prisma.userPreference.create({ data: { userId } })));

  await prisma.siteSettings.create({ data: {
    id: 'default', brandName: 'La Guillotina', publicationType: 'Revista anarquista', statement: 'Contra toda autoridad',
    headerLine: 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD', footerStatement: 'COPIÁ · DIFUNDÍ · ORGANIZATE',
    socialPrompt: 'SEGUÍ LA SEÑAL', navigation: [{ label: 'Inicio', to: '/', sortOrder: 0 }], socialLinks: [],
    contentByLocale: {
      es: {
        brand: { name: 'La Guillotina', publicationType: 'Revista anarquista', statement: 'Contra toda autoridad', headerLine: 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD' },
        navigation: [{ label: 'Inicio', to: '/', sortOrder: 0 }], footer: { statement: 'COPIÁ · DIFUNDÍ · ORGANIZATE', socialPrompt: 'SEGUÍ LA SEÑAL', socialLinks: [] },
        authentication: { triggerLabel: 'INGRESAR', eyebrow: 'ACCESO', kicker: 'ARCHIVO', privacyNote: 'Privacidad por defecto.', localNote: 'Sesión segura.', login: { title: 'VOLVÉ', copy: 'Ingresá.', submitLabel: 'INGRESAR' }, register: { title: 'SUMATE', copy: 'Creá una cuenta.', submitLabel: 'CREAR' } },
        archive: { eyebrow: 'MEMORIA', title: { main: 'Archivo de', accent: 'ediciones' }, intro: 'Colección en prueba.', magazinesLabel: 'Revistas', booksLabel: 'Libros', showcaseLabel: 'Muestra', multimediaLabel: 'Multimedia', booksEmpty: 'Sin libros.' },
        pages: {
          about: { eyebrow: 'QUIÉNES', title: { main: 'Una red', accent: 'indócil' }, lead: 'Sentinela ES.', paragraphs: ['Texto ES.'] },
          manifesto: { eyebrow: 'MANIFIESTO', title: { main: 'Sin', accent: 'autoridad' }, statements: ['Declaración.'], items: [{ id: 'shared-principle', title: 'Principio compartido', paragraphs: ['Primer desarrollo editorial ES.', 'Segundo desarrollo editorial ES.'] }] },
          collaborate: { eyebrow: 'COLABORAR', title: { main: 'Mandá', accent: 'una chispa' }, lead: 'Materiales.', paragraph: 'Experiencias.', actionLabel: 'Escribir', actionHref: 'mailto:test@example.org' },
          contact: { eyebrow: 'CONTACTO', title: { main: 'Dejá', accent: 'una nota' }, lead: 'Mensajes.', form: { name: { label: 'Nombre', placeholder: 'Alias' }, email: { label: 'Correo', placeholder: 'a@b.c' }, message: { label: 'Mensaje', placeholder: 'Texto' }, submitLabel: 'Enviar' } },
          help: { eyebrow: 'AYUDA', title: { main: 'Cómo', accent: 'leer' }, lead: 'Atajos.', shortcuts: [{ keys: 'Esc', label: 'Cerrar.' }] },
          soon: { eyebrow: 'PRONTO', title: { main: 'Lo que', accent: 'viene' }, paragraphs: ['Próximamente.'], actionLabel: 'Archivo', actionHref: '/archivo' },
          notFound: { eyebrow: '404', title: { main: 'No', accent: 'está' }, copy: 'Ausente.', actionLabel: 'Inicio', actionHref: '/' },
        }, assets: {},
      },
      en: {
        brand: { name: 'The Guillotine', publicationType: 'Anarchist magazine', statement: 'Against all authority', headerLine: 'ANARCHIST MAGAZINE' },
        navigation: [{ label: 'Home', to: '/', sortOrder: 0 }], footer: { statement: 'COPY · SHARE', socialPrompt: 'FOLLOW', socialLinks: [] },
        authentication: { triggerLabel: 'SIGN IN', eyebrow: 'ACCESS', kicker: 'ARCHIVE', privacyNote: 'Private by default.', localNote: 'Secure session.', login: { title: 'RETURN', copy: 'Sign in.', submitLabel: 'SIGN IN' }, register: { title: 'JOIN', copy: 'Create account.', submitLabel: 'CREATE' } },
        archive: { eyebrow: 'MEMORY', title: { main: 'Issue', accent: 'archive' }, intro: 'Test collection.', magazinesLabel: 'Magazines', booksLabel: 'Books', showcaseLabel: 'Showcase', multimediaLabel: 'Multimedia', booksEmpty: 'No books.' },
        pages: {
          about: { eyebrow: 'ABOUT', title: { main: 'A', accent: 'network' }, lead: 'Sentinel EN.', paragraphs: ['Text EN.'] },
          manifesto: { eyebrow: 'MANIFESTO', title: { main: 'No', accent: 'authority' }, statements: ['Statement.'], items: [{ id: 'shared-principle', title: 'Shared principle', paragraphs: ['First editorial paragraph EN.', 'Second editorial paragraph EN.'] }] },
          collaborate: { eyebrow: 'CONTRIBUTE', title: { main: 'Send', accent: 'a spark' }, lead: 'Materials.', paragraph: 'Experiences.', actionLabel: 'Write', actionHref: 'mailto:test@example.org' },
          contact: { eyebrow: 'CONTACT', title: { main: 'Leave', accent: 'a note' }, lead: 'Messages.', form: { name: { label: 'Name', placeholder: 'Alias' }, email: { label: 'Email', placeholder: 'a@b.c' }, message: { label: 'Message', placeholder: 'Text' }, submitLabel: 'Send' } },
          help: { eyebrow: 'HELP', title: { main: 'How', accent: 'to read' }, lead: 'Shortcuts.', shortcuts: [{ keys: 'Esc', label: 'Close.' }] },
          soon: { eyebrow: 'SOON', title: { main: 'What', accent: 'is next' }, paragraphs: ['Coming soon.'], actionLabel: 'Archive', actionHref: '/archivo' },
          notFound: { eyebrow: '404', title: { main: 'Not', accent: 'found' }, copy: 'Missing.', actionLabel: 'Home', actionHref: '/' },
        }, assets: {},
      },
      ru: {
        brand: { name: 'Гильотина', publicationType: 'Анархистский журнал', statement: 'Против всякой власти', headerLine: 'АНАРХИСТСКИЙ ЖУРНАЛ' },
        navigation: [{ label: 'Главная', to: '/', sortOrder: 0 }], footer: { statement: 'КОПИРУЙ · ДЕЛИСЬ', socialPrompt: 'СЛЕДУЙ', socialLinks: [] },
        authentication: { triggerLabel: 'ВОЙТИ', eyebrow: 'ДОСТУП', kicker: 'АРХИВ', privacyNote: 'Конфиденциальность.', localNote: 'Безопасная сессия.', login: { title: 'ВЕРНУТЬСЯ', copy: 'Войдите.', submitLabel: 'ВОЙТИ' }, register: { title: 'ПРИСОЕДИНИТЬСЯ', copy: 'Создайте аккаунт.', submitLabel: 'СОЗДАТЬ' } },
        archive: { eyebrow: 'ПАМЯТЬ', title: { main: 'Архив', accent: 'изданий' }, intro: 'Тестовая коллекция.', magazinesLabel: 'Журналы', booksLabel: 'Книги', showcaseLabel: 'Выставка', multimediaLabel: 'Мультимедиа', booksEmpty: 'Нет книг.' },
        pages: {
          about: { eyebrow: 'О НАС', title: { main: 'Наша', accent: 'сеть' }, lead: 'Sentinel RU.', paragraphs: ['Текст RU.'] },
          manifesto: { eyebrow: 'МАНИФЕСТ', title: { main: 'Без', accent: 'власти' }, statements: ['Заявление.'], items: [{ id: 'shared-principle', title: 'Общий принцип', paragraphs: ['Первый редакционный абзац RU.', 'Второй редакционный абзац RU.'] }] },
          collaborate: { eyebrow: 'УЧАСТВОВАТЬ', title: { main: 'Отправьте', accent: 'искру' }, lead: 'Материалы.', paragraph: 'Опыт.', actionLabel: 'Написать', actionHref: 'mailto:test@example.org' },
          contact: { eyebrow: 'КОНТАКТ', title: { main: 'Оставьте', accent: 'записку' }, lead: 'Сообщения.', form: { name: { label: 'Имя', placeholder: 'Псевдоним' }, email: { label: 'Почта', placeholder: 'a@b.c' }, message: { label: 'Сообщение', placeholder: 'Текст' }, submitLabel: 'Отправить' } },
          help: { eyebrow: 'ПОМОЩЬ', title: { main: 'Как', accent: 'читать' }, lead: 'Команды.', shortcuts: [{ keys: 'Esc', label: 'Закрыть.' }] },
          soon: { eyebrow: 'СКОРО', title: { main: 'Что', accent: 'дальше' }, paragraphs: ['Скоро.'], actionLabel: 'Архив', actionHref: '/archivo' },
          notFound: { eyebrow: '404', title: { main: 'Не', accent: 'найдено' }, copy: 'Нет.', actionLabel: 'Главная', actionHref: '/' },
        }, assets: {},
      },
    },
    seoByLocale: { es: { siteName: 'La Guillotina', defaultTitle: 'Sentinela SEO ES', defaultDescription: 'Descripción ES.', defaultImage: null, locale: 'es', pages: {} }, en: { siteName: 'The Guillotine', defaultTitle: 'Sentinel SEO EN', defaultDescription: 'EN description.', defaultImage: null, locale: 'en', pages: {} }, ru: { siteName: 'Гильотина', defaultTitle: 'Sentinel SEO RU', defaultDescription: 'RU description.', defaultImage: null, locale: 'ru', pages: {} } },
  } });
  await prisma.category.createMany({ data: [
    { id: ids.category, slug: 'autogestion', name: 'Autogestión', description: 'Prácticas autónomas.', color: 'red', status: 'PUBLISHED', createdById: ids.admin },
    { id: ids.secondCategory, slug: 'memoria', name: 'Memoria', description: 'Archivo y memoria.', color: 'cyan', status: 'PUBLISHED', createdById: ids.admin },
  ] });
  await prisma.resource.createMany({ data: [
    { id: ids.cover, type: 'IMAGE', storageDriver: 'EXTERNAL', name: 'Portada principal', url: 'https://example.org/cover.webp', alt: 'Portada principal', credit: 'Archivo', license: 'CC BY', status: 'PUBLISHED', uploadStatus: 'COMPLETE', mimeType: 'image/webp' },
    { id: ids.image, type: 'IMAGE', storageDriver: 'EXTERNAL', name: 'Imagen pública', url: 'https://example.org/image.webp', alt: 'Imagen de la nota', credit: 'Archivo', license: 'CC BY', status: 'PUBLISHED', uploadStatus: 'COMPLETE', mimeType: 'image/webp' },
    { id: ids.video, type: 'VIDEO', storageDriver: 'EXTERNAL', name: 'Video público', url: 'https://example.org/video.mp4', alt: 'Video de prueba', credit: 'Archivo', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'COMPLETE', mimeType: 'video/mp4' },
    { id: ids.draftResource, type: 'PDF', storageDriver: 'EXTERNAL', name: 'Recurso borrador', url: 'https://example.org/draft.pdf', alt: 'PDF borrador', credit: 'Archivo', license: 'CC0', status: 'DRAFT', uploadStatus: 'COMPLETE', mimeType: 'application/pdf' },
  ] });
  await prisma.edition.createMany({ data: [
    { id: ids.edition, slug: 'n-012-la-libertad', kind: 'MAGAZINE', number: 12, title: 'La libertad no se pide', subtitle: 'Acción directa', dateLabel: 'Mayo 2024', status: 'PUBLISHED', publishedAt: new Date('2024-05-01T12:00:00Z'), coverResourceId: ids.cover, createdById: ids.admin, updatedById: ids.admin },
    { id: ids.book, slug: 'libro-de-prueba', kind: 'BOOK', number: 1, title: 'Libro de prueba', author: 'La Guillotina', summary: 'Libro publicado.', dateLabel: '2026', status: 'PUBLISHED', publishedAt: new Date('2026-01-01T12:00:00Z'), createdById: ids.admin, updatedById: ids.admin },
    { id: ids.draftEdition, slug: 'edicion-borrador', kind: 'MAGAZINE', number: 13, title: 'Edición secreta', dateLabel: 'Agosto 2026', status: 'DRAFT', createdById: ids.admin, updatedById: ids.admin },
  ] });
  await prisma.note.createMany({ data: [
    { id: ids.note, slug: 'freedom', title: 'La libertad no se pide', excerpt: 'Acción directa', bodyMarkdown: 'Primer párrafo.\n\nSegundo párrafo.', localizedContent: { en: { title: 'Freedom is not requested', excerpt: 'Direct action sentinel', bodyMarkdown: 'First paragraph.\n\nSecond paragraph.' } }, status: 'PUBLISHED', publishedAt: new Date(), editionId: ids.edition, authorName: 'Redacción', fragment: 'freedom', x: 100, y: 500, width: 300, height: 400, sortOrder: 0, createdById: ids.admin, updatedById: ids.admin },
    { id: ids.secondNote, slug: 'memory', title: 'Memoria viva', excerpt: 'Archivos compartidos', bodyMarkdown: 'La memoria circula.', status: 'PUBLISHED', publishedAt: new Date(), editionId: ids.edition, authorName: 'Archivo', sortOrder: 1, createdById: ids.admin, updatedById: ids.admin },
    { id: ids.draftNote, slug: 'draft-note', title: 'Nota secreta', excerpt: 'No publicada', bodyMarkdown: 'Borrador.', status: 'DRAFT', editionId: ids.draftEdition, createdById: ids.admin, updatedById: ids.admin },
  ] });
  await prisma.noteCategory.createMany({ data: [
    { noteId: ids.note, categoryId: ids.category }, { noteId: ids.secondNote, categoryId: ids.secondCategory },
  ] });
  await prisma.noteResource.createMany({ data: [
    { noteId: ids.note, resourceId: ids.image, sortOrder: 0 }, { noteId: ids.note, resourceId: ids.video, sortOrder: 1 },
  ] });
  await prisma.comment.create({ data: { id: ids.comment, noteId: ids.note, authorName: 'Visible', body: 'Comentario visible.', status: 'VISIBLE' } });
  await prisma.contactMessage.create({ data: { id: ids.contact, name: 'Colectivo', email: 'colectivo@example.org', subject: 'Consulta editorial', body: 'Consulta suficientemente extensa para el equipo.', status: 'NEW' } });
}

export async function login(app: FastifyInstance, account: keyof typeof credentials) {
  const response = await app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials[account] });
  if (response.statusCode !== 200) throw new Error(`Login ${account} falló: ${response.statusCode} ${response.body}`);
  return { response, cookie: namedCookie(response, 'lg_session'), csrfToken: response.json().csrfToken as string };
}

export function authHeaders(auth: { cookie: string; csrfToken: string }) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken };
}

export function namedCookie(response: { headers: Record<string, unknown> }, name: string) {
  const values = response.headers['set-cookie'];
  const all = Array.isArray(values) ? values : [String(values ?? '')];
  const match = all.find(value => value.startsWith(`${name}=`));
  if (!match) throw new Error(`No se recibió la cookie ${name}.`);
  return match.split(';')[0]!;
}

export function cookieValue(cookie: string) {
  return cookie.slice(cookie.indexOf('=') + 1);
}

export function multipartBody(boundary: string, fields: Record<string, string>, fileField: string, fileName: string, mimeType: string, file: Buffer) {
  const chunks: Buffer[] = [];
  const line = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  line(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  chunks.push(file); line('\r\n');
  for (const [name, value] of Object.entries(fields)) line(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  line(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

export type DevelopmentMail = {
  messageId: string;
  kind: 'password_reset' | 'contact_reply' | 'comment_removal';
  to: string;
  subject: string;
  text: string;
  html?: string;
  imageUrl?: string;
  createdAt: string;
};

export async function mailboxMessages(): Promise<DevelopmentMail[]> {
  try {
    const files = (await readdir(mailboxPath)).filter(file => file.endsWith('.json'));
    return Promise.all(files.map(async file => JSON.parse(await readFile(path.join(mailboxPath, file), 'utf8')) as DevelopmentMail));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function storedFiles() {
  const root = path.resolve(storagePath);
  const found: Array<{ path: string; size: number }> = [];
  async function visit(directory: string) {
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else found.push({ path: fullPath, size: (await stat(fullPath)).size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await visit(root);
  return found;
}

export async function closeTestDatabase() {
  await prisma.$disconnect();
  await rm(storagePath, { recursive: true, force: true });
}
