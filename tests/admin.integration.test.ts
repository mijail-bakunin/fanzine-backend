import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, closeTestDatabase, createTestContext, ids, login, mailboxMessages, prefix, prisma, type TestContext,
} from './helpers/test-context.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('dashboard, permisos y auditoría', () => {
  it('rechaza anónimos/readers y limita cada rol a sus secciones', async () => {
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard` })).statusCode).toBe(401);
    const reader = await login(context.app, 'reader');
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard`, headers: { cookie: reader.cookie } })).statusCode).toBe(403);

    const editor = await login(context.app, 'editor');
    const editorAll = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=all`, headers: { cookie: editor.cookie } });
    expect(editorAll.statusCode).toBe(200);
    expect(editorAll.json().editions.length).toBeGreaterThan(0);
    expect(editorAll.json().contacts).toEqual([]);
    expect(editorAll.json().users).toEqual([]);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=users`, headers: { cookie: editor.cookie } })).statusCode).toBe(403);

    const moderator = await login(context.app, 'moderator');
    const moderation = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=all`, headers: { cookie: moderator.cookie } });
    expect(moderation.statusCode).toBe(200);
    expect(moderation.json().contacts).toHaveLength(1);
    expect(moderation.json().comments).toHaveLength(1);
    expect(moderation.json().notes).toEqual([]);
  });

  it('pagina, filtra por sección/estado/texto y devuelve metadatos independientes', async () => {
    await prisma.note.createMany({ data: Array.from({ length: 5 }, (_, index) => ({
      title: `Nota filtrable ${index}`, slug: `filtrable-${index}`, excerpt: 'Bajada', bodyMarkdown: 'Cuerpo', status: index % 2 ? 'DRAFT' : 'PUBLISHED', createdById: ids.admin, updatedById: ids.admin,
    })) });
    await prisma.note.update({ where: { slug: 'filtrable-4' }, data: { coverTitleLines: ['NOTA', 'FILTRABLE'], coverButtonPosition: { left: '4px' }, coverDepth: 3 } });
    const admin = await login(context.app, 'admin');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=notes&status=published&search=filtrable&page=1&pageSize=2`, headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toHaveLength(2);
    expect(response.json().notes.every((note: { status: string; title: string }) => note.status === 'published' && note.title.includes('filtrable'))).toBe(true);
    expect(response.json().notes[0]).toMatchObject({ coverTitleLines: ['NOTA', 'FILTRABLE'], coverButtonPosition: { left: '4px' }, coverDepth: 3, cover: { buttonLeft: '4px', depth: 3 } });
    expect(response.json().pagination.notes).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(response.json().editions).toEqual([]);
    expect(response.json().filters).toMatchObject({ section: 'notes', status: 'published', search: 'filtrable' });
  });

  it('registra acciones administrativas sin secretos en el log', async () => {
    const editor = await login(context.app, 'editor');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: { socialPrompt: 'SEGUÍ LA TINTA' } });
    expect(response.statusCode).toBe(200);
    const log = await prisma.adminLog.findFirstOrThrow({ where: { actorId: ids.editor, entityType: 'site_settings' } });
    expect(log.action).toContain('Actualizó');
    expect(JSON.stringify(log.metadata ?? {})).not.toMatch(/guillotina-editor|csrf|cookie/i);
    const admin = await login(context.app, 'admin');
    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=logs`, headers: { cookie: admin.cookie } });
    expect(dashboard.json().logs).toEqual([expect.objectContaining({ actor: 'Edición', action: log.action })]);
  });
});

describe('configuración editorial', () => {
  it('permite actualizar subconjuntos a admin/editor y publica el resultado', async () => {
    const editor = await login(context.app, 'editor');
    const update = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: {
      brandName: 'La Guillotina Federal',
      navigation: [{ label: 'Archivo', to: '/archivo', sortOrder: 1 }],
      socialLinks: [{ label: 'Mastodon', url: 'https://mastodon.social/@guillotina' }],
    } });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ brandName: 'La Guillotina Federal', navigation: [{ label: 'Archivo' }], socialLinks: [{ label: 'Mastodon' }] });
    const publicSettings = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings` });
    expect(publicSettings.json().brandName).toBe('La Guillotina Federal');
    expect((await prisma.siteSettings.findUniqueOrThrow({ where: { id: 'default' } })).brandName).toBe('La Guillotina Federal');
  });

  it('rechaza moderator, cuerpos vacíos y URLs sociales inválidas', async () => {
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(moderator), payload: { brandName: 'No permitido' } })).statusCode).toBe(403);
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: {} })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: { socialLinks: [{ label: 'Mala', url: 'javascript:alert(1)' }] } })).statusCode).toBe(400);
  });

  it('edita contenido localizado y SEO sin perder traducciones ni campos históricos', async () => {
    const admin = await login(context.app, 'admin');
    const current = await context.app.inject({ method: 'GET', url: `${prefix}/admin/settings`, headers: { cookie: admin.cookie } });
    expect(current.statusCode).toBe(200);
    const currentBody = current.json() as {
      contentByLocale: Record<string, Record<string, unknown>>;
      seoByLocale: Record<string, Record<string, unknown>>;
    };
    const english = structuredClone(currentBody.contentByLocale.en) as {
      pages: { about: { lead: string } };
    };
    const englishSeo = structuredClone(currentBody.seoByLocale.en) as {
      defaultDescription: string;
    };
    english.pages.about.lead = 'Updated entirely through the editorial API.';
    englishSeo.defaultDescription = 'Updated API-first SEO description.';

    const update = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(admin),
      payload: {
        contentByLocale: { ...currentBody.contentByLocale, en: english },
        seoByLocale: { ...currentBody.seoByLocale, en: englishSeo },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().brandName).toBe('La Guillotina');

    const published = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings?locale=en` });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      locale: 'en',
      pages: { about: { lead: english.pages.about.lead } },
      seo: { defaultDescription: englishSeo.defaultDescription },
    });
    expect(published.json().pages.manifesto.statements).toHaveLength(1);
  });

  it('rechaza configuraciones localizadas incompletas antes de persistirlas', async () => {
    const editor = await login(context.app, 'editor');
    const invalid = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor),
      payload: { contentByLocale: { es: { brand: { name: 'Incompleto' } } } },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await prisma.siteSettings.findUniqueOrThrow({ where: { id: 'default' } })).contentByLocale).not.toEqual({ es: { brand: { name: 'Incompleto' } } });

    const current = await context.app.inject({ method: 'GET', url: `${prefix}/admin/settings`, headers: { cookie: editor.cookie } });
    const localized = structuredClone(current.json().contentByLocale) as {
      es: { pages: { manifesto: { items: Array<{ id?: string; title: string; paragraphs: string[] }> } } };
    };
    localized.es.pages.manifesto.items[0]!.paragraphs = ['Un solo párrafo no alcanza.'];
    const shortItem = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: { contentByLocale: localized } });
    expect(shortItem.statusCode).toBe(400);
    expect(shortItem.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', requestId: expect.any(String) } });
    localized.es.pages.manifesto.items[0]!.paragraphs = ['Uno.', 'Dos.', 'Tres.', 'Cuatro.'];
    const longItem = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: { contentByLocale: localized } });
    expect(longItem.statusCode).toBe(400);
  });
});

describe('ediciones y relaciones', () => {
  it('crea revista/libro con slug, número, portada y notas vinculadas', async () => {
    const editor = await login(context.app, 'editor');
    const magazine = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: {
      title: 'Nueva autonomía', subtitle: 'Número especial', date: 'Agosto 2026', status: 'review',
      cover: 'https://example.org/nueva-portada.webp', noteIds: ['freedom', ids.secondNote],
    } });
    expect(magazine.statusCode).toBe(201);
    expect(magazine.json()).toMatchObject({ slug: 'n-014-nueva-autonomia', number: '14', status: 'review' });
    const stored = await prisma.edition.findUniqueOrThrow({ where: { id: magazine.json().id }, include: { coverResource: true, notes: true } });
    expect(stored.coverResource).toMatchObject({ url: 'https://example.org/nueva-portada.webp', type: 'IMAGE', storageDriver: 'EXTERNAL' });
    expect(stored.notes.map(note => note.id).sort()).toEqual([ids.note, ids.secondNote].sort());
    expect(stored.kind).toBe('MAGAZINE');

    const book = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: { title: 'Manual común', date: '2026', kind: 'book', author: 'Colectivo', summary: 'Descripción del libro.' } });
    expect(book.statusCode).toBe(201);
    expect(book.json()).toMatchObject({ number: '02', slug: 'n-002-manual-comun' });
    expect((await prisma.edition.findUniqueOrThrow({ where: { id: book.json().id } })).kind).toBe('BOOK');
  });

  it('persiste coverArt, permite PATCH parcial y lo publica en dashboard, listados y portada vigente', async () => {
    const editor = await login(context.app, 'editor');
    const coverArt = {
      preset: 'riot',
      elements: [
        { id: 'tape-top', type: 'tape', tone: 'red', x: 30, y: 22, w: 260, h: 72, rotation: -8, depth: 15 },
        { id: 'coffee-bottom', type: 'coffee', tone: 'paper', x: 850, y: 1_270, w: 160, h: 160, rotation: 12, depth: 4 },
      ],
    };
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: {
      title: 'Dirección de arte', date: 'Octubre 2026', status: 'published', noteIds: ['memory'], coverArt,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'published', coverArt });
    expect((await prisma.edition.findUniqueOrThrow({ where: { id: created.json().id } })).coverArt).toEqual(coverArt);

    const presetOnly = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${created.json().id}`, headers: authHeaders(editor), payload: {
      coverArt: { preset: 'night' },
    } });
    expect(presetOnly.statusCode).toBe(200);
    expect(presetOnly.json().coverArt).toEqual({ ...coverArt, preset: 'night' });

    const replacement = [{ id: 'stamp-center', type: 'stamp', tone: 'cyan', x: 430, y: 600, w: 190, h: 120, rotation: 3, depth: 80 }];
    const elementsOnly = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${created.json().id}`, headers: authHeaders(editor), payload: {
      coverArt: { elements: replacement },
    } });
    expect(elementsOnly.statusCode).toBe(200);
    expect(elementsOnly.json().coverArt).toEqual({ preset: 'night', elements: replacement });

    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=editions&search=Dirección`, headers: { cookie: editor.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().editions).toEqual([expect.objectContaining({ id: created.json().id, coverArt: { preset: 'night', elements: replacement } })]);

    const current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ edition: { id: created.json().id, coverArt: { preset: 'night', elements: replacement } } });
    const editions = await context.app.inject({ method: 'GET', url: `${prefix}/editions?page=1&pageSize=20` });
    expect(editions.json().items).toContainEqual(expect.objectContaining({ id: created.json().id, coverArt: { preset: 'night', elements: replacement } }));
    const catalog = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?section=magazines&page=1&pageSize=20` });
    expect(catalog.json().magazines).toContainEqual(expect.objectContaining({ id: created.json().id, coverArt: { preset: 'night', elements: replacement } }));
  });

  it('rechaza coverArt inseguro o fuera del lienzo con 400 sin alterar la edición', async () => {
    const editor = await login(context.app, 'editor');
    const valid = { id: 'safe', type: 'brush', tone: 'ink', x: 0, y: 0, w: 100, h: 100, rotation: 0, depth: 0 };
    const invalidCoverArt = [
      {},
      { preset: 'unknown' },
      { preset: 'archive', elements: [{ ...valid, x: 1_000, w: 56 }] },
      { preset: 'archive', elements: [{ ...valid, y: 1_450, h: 43 }] },
      { preset: 'archive', elements: [{ ...valid, rotation: 31 }] },
      { preset: 'archive', elements: [{ ...valid, depth: 101 }] },
      { preset: 'archive', elements: [{ ...valid, x: 1.5 }] },
      { preset: 'archive', elements: [valid, { ...valid }] },
      { preset: 'archive', elements: Array.from({ length: 13 }, (_, index) => ({ ...valid, id: `item-${index}` })) },
      { preset: 'archive', elements: [{ ...valid, style: 'background:url(javascript:alert(1))' }] },
      { preset: 'archive', elements: [], css: 'position:fixed' },
    ];
    const before = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition } });
    for (const coverArt of invalidCoverArt) {
      const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { coverArt } });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', requestId: expect.any(String) } });
    }
    const after = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition } });
    expect(after.coverArt).toEqual(before.coverArt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('degrada un coverArt histórico corrupto al preset seguro sin romper la API pública', async () => {
    await prisma.edition.update({ where: { id: ids.edition }, data: { coverArt: { legacyCss: 'position:fixed' } } });
    const publicEdition = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/home` });
    expect(publicEdition.statusCode).toBe(200);
    expect(publicEdition.json().edition.coverArt).toEqual({ preset: 'archive', elements: [] });
    const editor = await login(context.app, 'editor');
    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=editions`, headers: { cookie: editor.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().editions).toContainEqual(expect.objectContaining({ id: ids.edition, coverArt: { preset: 'archive', elements: [] } }));
  });

  it('numera creaciones concurrentes sin colisiones reales en PostgreSQL', async () => {
    const admin = await login(context.app, 'admin');
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(admin), payload: { title: `Concurrente ${index}`, date: '2027', noteIds: [] } })));
    expect(responses.every(response => response.statusCode === 201), responses.map(response => response.body).join('\n')).toBe(true);
    const numbers = responses.map(response => response.json().number);
    expect(new Set(numbers).size).toBe(8);
    const stored = await prisma.edition.findMany({ where: { title: { startsWith: 'Concurrente' } } });
    expect(new Set(stored.map(edition => edition.number)).size).toBe(8);
  });

  it('actualiza campos, reemplaza relaciones y aplica fechas de publicación/borrado lógico', async () => {
    const editor = await login(context.app, 'editor');
    const publishedAt = (await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition } })).publishedAt;
    const update = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { title: 'Título actualizado', status: 'published', noteIds: ['memory'] } });
    expect(update.statusCode).toBe(200);
    let stored = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition }, include: { notes: true } });
    expect(stored.title).toBe('Título actualizado');
    expect(stored.publishedAt).toEqual(publishedAt);
    expect(stored.notes.map(note => note.id)).toEqual([ids.secondNote]);
    expect((await prisma.note.findUniqueOrThrow({ where: { id: ids.note } })).editionId).toBeNull();
    const deleted = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { status: 'deleted' } });
    expect(deleted.statusCode).toBe(200);
    stored = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition }, include: { notes: true } });
    expect(stored.status).toBe('DELETED');
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(await prisma.edition.findUnique({ where: { id: ids.edition } })).not.toBeNull();
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/home` })).statusCode).toBe(404);
  });

  it('publica una nueva edición como vigente y permite borrado lógico explícito por editor', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: {
      title: 'Portada vigente', date: 'Septiembre 2026', status: 'draft', noteIds: ['memory'],
    } });
    expect(created.statusCode).toBe(201);
    let current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.json().edition.slug).toBe('n-012-la-libertad');
    const published = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${created.json().id}`, headers: authHeaders(editor), payload: { status: 'published' } });
    expect(published.statusCode).toBe(200);
    current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.json()).toMatchObject({ edition: { slug: created.json().slug, title: 'Portada vigente' }, notes: [{ slug: 'memory' }] });

    const removedEdition = await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/editions/${created.json().id}`, headers: authHeaders(editor) });
    expect(removedEdition.statusCode).toBe(200);
    expect(removedEdition.json().status).toBe('deleted');
    expect(await prisma.edition.findUnique({ where: { id: created.json().id } })).toMatchObject({ status: 'DELETED', deletedAt: expect.any(Date) });
    current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.json().edition.slug).toBe('n-012-la-libertad');

    const removedNote = await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor) });
    expect(removedNote.statusCode).toBe(200);
    expect(removedNote.json().status).toBe('deleted');
    expect(await prisma.note.findUnique({ where: { id: ids.note } })).toMatchObject({ status: 'DELETED', deletedAt: expect.any(Date) });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom` })).statusCode).toBe(404);
  });

  it('limita publicación y borrado editorial a admin/editor y responde 404 estable', async () => {
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(moderator), payload: { status: 'published' } })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(moderator), payload: { coverArt: { preset: 'ash' } } })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(moderator) })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(moderator) })).statusCode).toBe(403);
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/editions/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor) })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/notes/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor) })).statusCode).toBe(404);
  });

  it('rechaza IDs, URLs y payloads inválidos sin mutar la edición', async () => {
    const editor = await login(context.app, 'editor');
    const before = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition } });
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/no-uuid`, headers: authHeaders(editor), payload: { title: 'Cambio' } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { cover: 'no-es-url' } })).statusCode).toBe(400);
    const emptyLocalizedUrl = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: {
      translations: { en: { status: 'draft', masthead: { image: '', alt: 'Empty URL must be rejected' } } },
    } });
    expect(emptyLocalizedUrl.statusCode).toBe(400);
    expect(emptyLocalizedUrl.json().error.code).toBe('VALIDATION_ERROR');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: {} })).statusCode).toBe(400);
    const after = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('notas editoriales', () => {
  it('crea una nota con categorías/recursos y expone el contenido al publicarla', async () => {
    const editor = await login(context.app, 'editor');
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(editor), payload: {
      title: 'Redes barriales', excerpt: 'Una bajada editorial', body: 'Primer bloque.\n\nSegundo bloque.', status: 'published', editionId: ids.edition,
      categoryIds: ['autogestion', ids.secondCategory], resourceIds: [ids.image, ids.video], author: 'Colectivo', readingMinutes: 7,
      fragment: 'redes', x: 10, y: 460, w: 300, h: 400, tone: 'lime', sortOrder: 5,
      coverTitleLines: ['REDES', 'BARRIALES'], coverExcerpt: 'Una copia exclusiva para la portada.',
      coverButtonPosition: { left: '8%', bottom: '1.5rem' }, coverDepth: 7,
      coverTypography: { titleSize: 'display', titleAlign: 'center', titleTreatment: 'block', excerptSize: 'large' },
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      slug: 'redes-barriales', status: 'published', author: 'Colectivo', readingMinutes: 7,
      fragment: 'redes', x: 10, y: 460, w: 300, h: 400, tone: 'lime', sortOrder: 5, editionLink: false,
      coverTitleLines: ['REDES', 'BARRIALES'], coverExcerpt: 'Una copia exclusiva para la portada.',
      coverButtonPosition: { left: '8%', bottom: '1.5rem' }, coverDepth: 7,
      cover: { buttonLeft: '8%', buttonBottom: '1.5rem', depth: 7 },
      coverTypography: { titleSize: 'display', titleAlign: 'center', titleTreatment: 'block', excerptSize: 'large' },
    });
    const stored = await prisma.note.findUniqueOrThrow({ where: { id: response.json().id }, include: { categories: true, resources: true } });
    expect(stored.publishedAt).toBeInstanceOf(Date);
    expect(stored.categories).toHaveLength(2);
    expect(stored.resources).toHaveLength(2);
    expect(stored).toMatchObject({ coverTitleLines: ['REDES', 'BARRIALES'], coverExcerpt: 'Una copia exclusiva para la portada.', coverButtonPosition: { left: '8%', bottom: '1.5rem' }, coverDepth: 7, coverTypography: { titleSize: 'display', titleAlign: 'center', titleTreatment: 'block', excerptSize: 'large' } });
    const publicNote = await context.app.inject({ method: 'GET', url: `${prefix}/notes/redes-barriales` });
    expect(publicNote.statusCode).toBe(200);
    expect(publicNote.json()).toMatchObject({ paragraphs: ['Primer bloque.', 'Segundo bloque.'], tags: expect.arrayContaining(['Autogestión', 'Memoria']), coverTypography: { titleSize: 'display', titleAlign: 'center', titleTreatment: 'block', excerptSize: 'large' } });
    const defaults = await context.app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(editor), payload: {
      title: 'Portada automática', excerpt: 'Usa las reglas de la plantilla', body: 'Contenido suficiente.', coverButtonPosition: null,
    } });
    expect(defaults.statusCode).toBe(201);
    expect(defaults.json()).toMatchObject({ coverTitleLines: [], coverExcerpt: null, coverButtonPosition: null, coverDepth: null, coverTypography: { titleSize: 'standard', titleAlign: 'left', titleTreatment: 'brush', excerptSize: 'standard' } });
  });

  it('aplica PATCH tipográfico parcial y lo refleja en dashboard y ambas portadas públicas', async () => {
    const editor = await login(context.app, 'editor');
    const updated = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor),
      payload: { coverTypography: { titleSize: 'compact', titleTreatment: 'torn' } },
    });
    expect(updated.statusCode).toBe(200);
    const expected = { titleSize: 'compact', titleAlign: 'left', titleTreatment: 'torn', excerptSize: 'standard' };
    expect(updated.json().coverTypography).toEqual(expected);
    expect((await prisma.note.findUniqueOrThrow({ where: { id: ids.note } })).coverTypography).toEqual(expected);

    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=notes&pageSize=20`, headers: { cookie: editor.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().notes.find((note: { id: string }) => note.id === ids.note).coverTypography).toEqual(expected);

    for (const url of [`${prefix}/editions/n-012-la-libertad/home`, `${prefix}/editions/current/home`]) {
      const response = await context.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json().notes.find((note: { slug: string }) => note.slug === 'freedom').coverTypography).toEqual(expected);
    }
  });

  it('rechaza presets tipográficos libres, objetos vacíos y CSS sin alterar la nota', async () => {
    const editor = await login(context.app, 'editor');
    const invalid = [
      {},
      { titleSize: 'gigantic' },
      { titleAlign: 'justify' },
      { titleTreatment: 'url(javascript:alert(1))' },
      { excerptSize: '12px' },
      { titleSize: 'display', css: 'position:fixed' },
      { titleSize: null },
    ];
    const before = await prisma.note.findUniqueOrThrow({ where: { id: ids.note } });
    for (const coverTypography of invalid) {
      const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { coverTypography } });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', requestId: expect.any(String) } });
    }
    const after = await prisma.note.findUniqueOrThrow({ where: { id: ids.note } });
    expect(after.coverTypography).toEqual(before.coverTypography);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('degrada tipografía histórica corrupta al preset seguro sin romper lecturas', async () => {
    await prisma.note.update({ where: { id: ids.note }, data: { coverTypography: { css: 'font-size:999px' } } });
    const expected = { titleSize: 'standard', titleAlign: 'left', titleTreatment: 'brush', excerptSize: 'standard' };
    const publicNote = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom` });
    expect(publicNote.statusCode).toBe(200);
    expect(publicNote.json().coverTypography).toEqual(expected);
    const editor = await login(context.app, 'editor');
    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=notes`, headers: { cookie: editor.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().notes.find((note: { id: string }) => note.id === ids.note).coverTypography).toEqual(expected);
  });

  it('persiste la composición parcial, la devuelve en dashboard y ordena la portada por sortOrder', async () => {
    const editor = await login(context.app, 'editor');
    const updated = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor),
      payload: {
        fragment: 'freedom-wide', x: 120, y: 520, w: 360, h: 480, tone: 'cyan', sortOrder: 9,
        coverDepth: 42, coverButtonPosition: { right: '6%', bottom: '18px' },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      fragment: 'freedom-wide', x: 120, y: 520, w: 360, h: 480, tone: 'cyan', sortOrder: 9, editionLink: false,
      coverDepth: 42, coverButtonPosition: { right: '6%', bottom: '18px' },
    });

    const stored = await prisma.note.findUniqueOrThrow({ where: { id: ids.note } });
    expect(stored).toMatchObject({ fragment: 'freedom-wide', x: 120, y: 520, width: 360, height: 480, tone: 'cyan', sortOrder: 9, coverDepth: 42 });

    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=notes&pageSize=20`, headers: { cookie: editor.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().notes.find((note: { id: string }) => note.id === ids.note)).toMatchObject({
      fragment: 'freedom-wide', x: 120, y: 520, w: 360, h: 480, tone: 'cyan', sortOrder: 9, editionLink: false,
    });

    const home = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/home` });
    expect(home.statusCode).toBe(200);
    expect(home.json().notes.map((note: { slug: string }) => note.slug)).toEqual(['memory', 'freedom']);
    expect(home.json().notes[1]).toMatchObject({ fragment: 'freedom-wide', x: 120, y: 520, w: 360, h: 480, tone: 'cyan', sortOrder: 9 });

    const current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.statusCode).toBe(200);
    expect(current.json().notes.map((note: { slug: string }) => note.slug)).toEqual(['memory', 'freedom']);
  });

  it('rechaza campos y rectángulos fuera de la maqueta sin modificar la nota', async () => {
    const editor = await login(context.app, 'editor');
    const invalidPayloads = [
      { x: 1055 }, { y: 439 }, { y: 1492 }, { w: 0 }, { h: 0 },
      { x: 1000, w: 100 }, { y: 1450, h: 100 }, { x: 800 },
      { x: null }, { x: '' }, { x: true }, { w: '300' },
      { tone: 'violet' }, { coverDepth: -1 }, { coverDepth: true }, { sortOrder: -1 }, { sortOrder: null }, { sortOrder: 1.5 },
    ];
    for (const payload of invalidPayloads) {
      const response = await context.app.inject({
        method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code, JSON.stringify(payload)).toBe('VALIDATION_ERROR');
    }
    const stored = await prisma.note.findUniqueOrThrow({ where: { id: ids.note } });
    expect(stored).toMatchObject({ x: 100, y: 500, width: 300, height: 400, tone: 'red', sortOrder: 0 });
  });

  it('permite componer a admin/editor y rechaza moderator', async () => {
    const moderator = await login(context.app, 'moderator');
    const response = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(moderator), payload: { x: 120 },
    });
    expect(response.statusCode).toBe(403);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(moderator), payload: { coverTypography: { titleAlign: 'right' } } })).statusCode).toBe(403);
    expect((await prisma.note.findUniqueOrThrow({ where: { id: ids.note } })).x).toBe(100);
  });

  it('actualiza sólo campos enviados y reemplaza relaciones cuando se solicitan', async () => {
    const editor = await login(context.app, 'editor');
    const titleOnly = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { title: 'Libertad actualizada' } });
    expect(titleOnly.statusCode).toBe(200);
    expect(titleOnly.json()).toMatchObject({ title: 'Libertad actualizada', author: 'Redacción', readingMinutes: 3, status: 'published' });
    const relations = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { categoryIds: ['memoria'], resourceIds: [], editionId: '' } });
    expect(relations.statusCode).toBe(200);
    const stored = await prisma.note.findUniqueOrThrow({ where: { id: ids.note }, include: { categories: true, resources: true } });
    expect(stored.editionId).toBeNull();
    expect(stored.categories.map(item => item.categoryId)).toEqual([ids.secondCategory]);
    expect(stored.resources).toEqual([]);
    const emptyPosition = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { coverButtonPosition: {} } });
    expect(emptyPosition.statusCode).toBe(200);
    expect(emptyPosition.json().coverButtonPosition).toBeNull();
    const clearedCover = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { coverTitleLines: [], coverExcerpt: null, coverButtonPosition: null, coverDepth: null } });
    expect(clearedCover.statusCode).toBe(200);
    expect(clearedCover.json()).toMatchObject({ coverTitleLines: [], coverExcerpt: null, coverButtonPosition: null, coverDepth: null });
  });

  it('rechaza cuerpos vacíos, propiedades desconocidas y relaciones eliminadas', async () => {
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: {} })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { campoInventado: true } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { coverButtonPosition: { left: 'url(javascript:alert(1))' } } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { coverDepth: 101 } })).statusCode).toBe(400);
    const invalid = await context.app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(editor), payload: { title: 'X', excerpt: 'x', body: 'x', categoryIds: ['no-existe'] } });
    expect(invalid.statusCode).toBe(400);
    expect(await prisma.note.count()).toBe(3);
  });
});

describe('recursos y categorías', () => {
  it('registra, actualiza y elimina lógicamente un recurso externo', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources`, headers: authHeaders(editor), payload: {
      type: 'pdf', name: 'Documento común', url: 'https://example.org/documento.pdf', alt: 'Documento completo', credit: 'Archivo común', license: 'CC BY-SA', status: 'published', mimeType: 'application/pdf', fileSize: 1234,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ type: 'pdf', storageDriver: 'external', uploadStatus: 'complete', fileSize: 1234 });
    const updated = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/resources/${created.json().id}`, headers: authHeaders(editor), payload: { name: 'Documento corregido', license: 'CC0' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Documento corregido', license: 'CC0' });
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/resources/${created.json().id}`, headers: authHeaders(editor), payload: { fileSize: 999 } })).statusCode).toBe(400);
    const deleted = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/resources/${created.json().id}`, headers: authHeaders(editor), payload: { status: 'deleted' } });
    expect(deleted.statusCode).toBe(200);
    const stored = await prisma.resource.findUniqueOrThrow({ where: { id: created.json().id } });
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(await prisma.resource.count({ where: { id: created.json().id } })).toBe(1);
  });

  it('exige metadatos completos y URL externa válida', async () => {
    const editor = await login(context.app, 'editor');
    const missing = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources`, headers: authHeaders(editor), payload: { type: 'image', name: 'Sin metadatos', url: 'https://example.org/a.webp' } });
    expect(missing.statusCode).toBe(400);
    const badUrl = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources`, headers: authHeaders(editor), payload: { type: 'image', name: 'URL mala', url: 'file:///etc/passwd', alt: 'Alt válido', credit: 'Crédito', license: 'Licencia' } });
    expect(badUrl.statusCode).toBe(400);
  });

  it('crea y modifica categorías, controla unicidad y borrado lógico', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(editor), payload: { name: 'Apoyo mutuo', description: 'Redes solidarias.', color: 'yellow' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: 'apoyo-mutuo', status: 'published' });
    const duplicate = await context.app.inject({ method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(editor), payload: { name: 'Otra', slug: 'apoyo-mutuo', description: 'Duplicada.', color: 'red' } });
    expect(duplicate.statusCode).toBe(409);
    const update = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/categories/${created.json().id}`, headers: authHeaders(editor), payload: { description: 'Descripción ampliada.', color: 'lime' } });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ description: 'Descripción ampliada.', color: 'lime' });
    await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/categories/${created.json().id}`, headers: authHeaders(editor), payload: { status: 'deleted' } });
    expect((await prisma.category.findUniqueOrThrow({ where: { id: created.json().id } })).deletedAt).toBeInstanceOf(Date);
  });
});

describe('moderación, contactos y cuentas', () => {
  it('guarda borradores y envía respuestas reales al buzón de desarrollo', async () => {
    const moderator = await login(context.app, 'moderator');
    const draft = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'in_progress', reply: 'Borrador todavía no enviado.', send: false } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ status: 'in_progress', replyStatus: 'draft' });
    expect(await mailboxMessages()).toEqual([]);
    const sent = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'answered', reply: 'Respuesta editorial definitiva.' } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'answered', replyStatus: 'sent', sentAt: expect.any(String) });
    const messages = await mailboxMessages();
    expect(messages).toEqual([expect.objectContaining({ kind: 'contact_reply', to: 'colectivo@example.org', subject: 'Re: Consulta editorial' })]);
    const stored = await prisma.contactMessage.findUniqueOrThrow({ where: { id: ids.contact }, include: { replies: true } });
    expect(stored.status).toBe('ANSWERED');
    expect(stored.replies.map(reply => reply.status).sort()).toEqual(['DRAFT', 'SENT']);
  });

  it('valida combinaciones de respuesta y restringe contactos a moderación', async () => {
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(editor), payload: { status: 'archived' } })).statusCode).toBe(403);
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { send: true } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'answered', reply: 'No enviar', send: false } })).statusCode).toBe(400);
  });

  it('modera comentarios y registra responsable/fecha', async () => {
    const moderator = await login(context.app, 'moderator');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/${ids.comment}`, headers: authHeaders(moderator), payload: { status: 'hidden', moderationNote: 'Incumple pautas.' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: ids.comment, status: 'hidden', isAnonymous: true, authorType: 'anonymous', moderationReason: 'Incumple pautas.', deletedAt: null, emailDelivery: null });
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: ids.comment } });
    expect(stored).toMatchObject({ status: 'HIDDEN', moderationNote: 'Incumple pautas.', moderatedById: ids.moderator });
    expect(stored.moderatedAt).toBeInstanceOf(Date);
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/${ids.comment}`, headers: authHeaders(editor), payload: { status: 'visible' } })).statusCode).toBe(403);
  });

  it('borra comentarios según identidad, conserva auditoría y avisa a cuentas', async () => {
    const accountId = '51000000-0000-4000-8000-000000000001';
    const anonymousId = '51000000-0000-4000-8000-000000000002';
    await prisma.comment.createMany({ data: [
      { id: accountId, noteId: ids.note, userId: ids.reader, authorName: 'Lectora', body: 'Texto original de cuenta.', status: 'VISIBLE' },
      { id: anonymousId, noteId: ids.note, authorName: 'Visitante', body: 'Texto original anónimo.', status: 'VISIBLE' },
    ] });
    const moderator = await login(context.app, 'moderator');
    const account = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/comments/${accountId}`, headers: authHeaders(moderator),
      payload: { status: 'deleted', moderationReason: 'Incumple las pautas de cuidado mutuo.' },
    });
    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({
      id: accountId, status: 'deleted', isAnonymous: false, authorType: 'account', moderationReason: 'Incumple las pautas de cuidado mutuo.',
      moderatedAt: expect.any(String), deletedAt: expect.any(String), emailDelivery: { status: 'development', messageId: expect.any(String), error: null },
    });
    const anonymous = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/${anonymousId}`, headers: authHeaders(moderator), payload: { status: 'deleted' } });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toMatchObject({ status: 'deleted', isAnonymous: true, moderationReason: expect.stringContaining('pautas comunitarias'), emailDelivery: { status: 'not_applicable' } });

    const publicResponse = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom/comments` });
    expect(publicResponse.body).not.toContain('Texto original de cuenta.');
    expect(publicResponse.json()).toContainEqual(expect.objectContaining({ id: anonymousId, status: 'deleted', body: '', isAnonymous: true }));

    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=comments&status=deleted`, headers: { cookie: moderator.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: accountId, body: 'Texto original de cuenta.', moderationReason: 'Incumple las pautas de cuidado mutuo.', moderatedBy: 'Moderación', emailDelivery: expect.objectContaining({ status: 'development' }) }),
      expect.objectContaining({ id: anonymousId, body: 'Texto original anónimo.', isAnonymous: true, emailDelivery: expect.objectContaining({ status: 'not_applicable' }) }),
    ]));
    expect(dashboard.json().pagination.comments.total).toBe(2);

    const messages = await mailboxMessages();
    expect(messages).toEqual([expect.objectContaining({
      kind: 'comment_removal', to: 'prueba@laguillotina.local', imageUrl: expect.stringContaining('comment-moderation-panorama.png'), html: expect.stringContaining('<img'),
    })]);
    const admin = await login(context.app, 'admin');
    const logs = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=logs&search=moderación`, headers: { cookie: admin.cookie } });
    expect(logs.json().logs).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'comment', entityId: accountId, requestId: expect.any(String), metadata: expect.any(Object) })]));
  });

  it('valida el contrato de motivo y no revierte el borrado si el correo falla', async () => {
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/comments/${ids.comment}`, headers: authHeaders(moderator),
      payload: { status: 'deleted', moderationReason: 'Nuevo', moderationNote: 'Legado' },
    })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/99999999-9999-4999-8999-999999999999`, headers: authHeaders(moderator), payload: { status: 'deleted' } })).statusCode).toBe(404);

    await context.app.close();
    context = await createTestContext({ mail: { mode: 'smtp', smtpHost: undefined, smtpUser: undefined, smtpPassword: undefined, smtpFrom: undefined } });
    await prisma.comment.update({ where: { id: ids.comment }, data: { userId: ids.reader } });
    const smtpModerator = await login(context.app, 'moderator');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/${ids.comment}`, headers: authHeaders(smtpModerator), payload: { status: 'deleted' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'deleted', emailDelivery: { status: 'failed', messageId: null, error: 'MAIL_NOT_CONFIGURED' } });
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: ids.comment } })).status).toBe('DELETED');
  });

  it('cambia roles, suspende cuentas y revoca sus sesiones', async () => {
    const readerSession = await login(context.app, 'reader');
    const admin = await login(context.app, 'admin');
    const role = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.reader}`, headers: authHeaders(admin), payload: { role: 'moderator' } });
    expect(role.statusCode).toBe(200);
    expect(role.json().role).toBe('moderator');
    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=comments`, headers: { cookie: readerSession.cookie } });
    expect(dashboard.statusCode).toBe(200);
    const suspended = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.reader}`, headers: authHeaders(admin), payload: { status: 'suspended' } });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe('suspended');
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: readerSession.cookie } })).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { userId: ids.reader, revokedAt: null } })).toBe(0);
  });

  it('impide autobloqueo/autodemoción y reserva cuentas a admin', async () => {
    const admin = await login(context.app, 'admin');
    const selfSuspend = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.admin}`, headers: authHeaders(admin), payload: { status: 'suspended' } });
    expect(selfSuspend.statusCode).toBe(409);
    expect(selfSuspend.json().error.code).toBe('CANNOT_LOCK_SELF');
    const selfDemote = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.admin}`, headers: authHeaders(admin), payload: { role: 'reader' } });
    expect(selfDemote.statusCode).toBe(409);
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.reader}`, headers: authHeaders(moderator), payload: { status: 'suspended' } })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/99999999-9999-4999-8999-999999999999`, headers: authHeaders(admin), payload: { status: 'suspended' } })).statusCode).toBe(404);
  });
});
