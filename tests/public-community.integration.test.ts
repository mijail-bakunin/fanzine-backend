import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hmacSha256 } from '../src/lib/crypto.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  closeTestDatabase, createTestContext, ids, login, namedCookie, prefix, prisma, storagePath, type TestContext,
} from './helpers/test-context.js';
import { createPublicContent } from '../prisma/public-content.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('configuración y archivo público', () => {
  it('publica configuración institucional y responde 503 cuando no fue inicializada', async () => {
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brandName: 'La Guillotina', statement: 'Contra toda autoridad',
      navigation: [{ label: 'Inicio', to: '/', sortOrder: 0 }], socialLinks: [], updatedAt: expect.any(String),
      locale: 'es', pages: { about: { lead: 'Sentinela ES.' } }, seo: { defaultTitle: 'Sentinela SEO ES' },
    });
    await prisma.siteSettings.delete({ where: { id: 'default' } });
    const missing = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings` });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.code).toBe('SITE_SETTINGS_NOT_CONFIGURED');
  });

  it('localiza en backend contenido editorial y rechaza locales inventados', async () => {
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings?locale=en` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      locale: 'en', publicationType: 'Anarchist magazine', navigation: [{ label: 'Home' }],
      pages: { about: { lead: 'Sentinel EN.' }, manifesto: { statements: ['Statement.'], items: [{ id: 'shared-principle', title: 'Shared principle', paragraphs: ['First editorial paragraph EN.', 'Second editorial paragraph EN.'] }] } }, seo: { locale: 'en', defaultTitle: 'Sentinel SEO EN' },
    });
    expect(response.json()).not.toHaveProperty('contentByLocale');
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/site/settings?locale=fr` })).statusCode).toBe(400);
  });

  it('construye el seed del Manifiesto con IDs estables, traducciones y contrato OpenAPI', async () => {
    const content = createPublicContent('https://example.org/cover.webp', 'https://example.org/state.png', 'https://example.org/moderation.png');
    const spanish = content.es.pages.manifesto;
    const english = content.en.pages.manifesto;
    const russian = content.ru.pages.manifesto;
    expect(spanish.statements).toHaveLength(5);
    expect(spanish.items).toHaveLength(5);
    expect(spanish.items.every(item => item.paragraphs.length >= 2 && item.paragraphs.length <= 3)).toBe(true);
    expect(english.items.map(item => item.id)).toEqual(spanish.items.map(item => item.id));
    expect(russian.items.map(item => item.id)).toEqual(spanish.items.map(item => item.id));
    expect(english.items[0]).toMatchObject({ title: 'Freedom is a practice', paragraphs: [expect.stringContaining('authorization'), expect.stringContaining('Disobedience')] });
    expect(russian.items[0]).toMatchObject({ title: 'Свобода — это практика', paragraphs: [expect.stringContaining('разрешения'), expect.stringContaining('Неповиновение')] });
    expect(english.items[0]!.title).not.toBe(spanish.items[0]!.title);
    expect(russian.items[0]!.title).not.toBe(spanish.items[0]!.title);
    expect(content.es.assets.moderationEmail).toMatchObject({ url: 'https://example.org/moderation.png', alt: expect.any(String) });
    const document = (await context.app.inject({ method: 'GET', url: '/documentation/json' })).json();
    expect(document.components.schemas.ManifestoItem).toMatchObject({
      required: ['title', 'paragraphs'],
      properties: { paragraphs: { minItems: 2, maxItems: 3 } },
    });
    expect(document.components.schemas.PublicationContent.properties.pages.properties.manifesto.properties).toHaveProperty('items');
  });

  it('usa navegación y redes planas si una traducción histórica no las contiene', async () => {
    await prisma.siteSettings.update({ where: { id: 'default' }, data: {
      navigation: [{ label: 'Fallback nav', to: '/fallback', sortOrder: 7 }],
      socialLinks: [{ label: 'Fallback social', url: 'https://example.org/social' }],
      contentByLocale: {
        es: {},
        en: {
          brand: { name: 'Localized name' },
          footer: { statement: 'Localized footer', socialPrompt: 'Localized prompt' },
        },
      },
    } });
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/site/settings?locale=en` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brandName: 'Localized name', navigation: [{ label: 'Fallback nav' }], socialLinks: [{ label: 'Fallback social' }],
      footer: { statement: 'Localized footer', socialPrompt: 'Localized prompt', socialLinks: [{ label: 'Fallback social' }] },
    });
  });

  it('pagina revistas y libros por separado sin exponer borradores', async () => {
    const magazines = await context.app.inject({ method: 'GET', url: `${prefix}/editions?kind=magazine&page=1&pageSize=1` });
    expect(magazines.statusCode).toBe(200);
    expect(magazines.json()).toMatchObject({ items: [{ slug: 'n-012-la-libertad', kind: 'magazine' }], pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 } });
    expect(magazines.json().items.some((edition: { slug: string }) => edition.slug === 'edicion-borrador')).toBe(false);
    const books = await context.app.inject({ method: 'GET', url: `${prefix}/editions?kind=book` });
    expect(books.json().items).toEqual([expect.objectContaining({ slug: 'libro-de-prueba', kind: 'book', author: 'La Guillotina' })]);
    const invalid = await context.app.inject({ method: 'GET', url: `${prefix}/editions?kind=periodico&page=0&pageSize=1000` });
    expect(invalid.statusCode).toBe(400);
  });

  it('filtra el catálogo por sección, búsqueda, categoría y tipo con paginación independiente', async () => {
    const complete = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?page=1&pageSize=1` });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().magazines).toHaveLength(1);
    expect(complete.json().books).toHaveLength(1);
    expect(complete.json().showcase).toHaveLength(1);
    expect(complete.json().multimedia).toHaveLength(1);
    expect(complete.json().pagination.magazines).toMatchObject({ pageSize: 1, total: 1 });

    const byTag = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?section=magazines&tag=autogestion` });
    expect(byTag.json().magazines).toEqual([expect.objectContaining({ slug: 'n-012-la-libertad', tags: ['Autogestión', 'Memoria'] })]);
    expect(byTag.json().books).toEqual([]);
    const search = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?section=multimedia&type=video&search=VIDEO` });
    expect(search.json().multimedia).toEqual([expect.objectContaining({ id: ids.video, type: 'video', name: 'Video público' })]);
    const incompatible = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?section=showcase&type=video` });
    expect(incompatible.json().showcase).toEqual([]);
  });

  it('busca sólo contenido publicado, pagina y agrupa rutas listas para frontend', async () => {
    const note = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Freedom&locale=en&page=1&pageSize=1` });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({
      items: [{ id: ids.note, slug: 'freedom', type: 'note', title: 'Freedom is not requested', description: 'Direct action sentinel', route: '/edicion/n-012-la-libertad/nota/freedom', editionSlug: 'n-012-la-libertad', image: { url: 'https://example.org/image.webp' } }],
      groups: { notes: [expect.objectContaining({ type: 'note' })], editions: [], resources: [] },
      pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 }, filters: { q: 'Freedom', locale: 'en' },
    });
    const resource = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Video&locale=es&pageSize=8` });
    expect(resource.json().groups.resources).toEqual([expect.objectContaining({ id: ids.video, type: 'video', route: '/archivo' })]);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/search?q=x` })).statusCode).toBe(400);
    const hidden = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=secreta` });
    expect(hidden.json().items).toEqual([]);
  });

  it('busca empíricamente cada clase, relación y fallback publicable', async () => {
    await prisma.note.update({ where: { id: ids.secondNote }, data: { title: 'Coverage orphan note', editionId: null, publishedAt: null } });
    const orphanNote = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Coverage+orphan+note` });
    expect(orphanNote.json().items).toEqual([expect.objectContaining({
      type: 'note', slug: 'memory', route: '/nota/memory', editionSlug: null, image: null,
    })]);

    const pendingCover = await prisma.resource.create({ data: {
      type: 'IMAGE', storageDriver: 'S3', name: 'Coverage pending cover', url: '', alt: 'Pending', credit: 'Tests', license: 'CC0',
      status: 'PUBLISHED', uploadStatus: 'UPLOADING',
    } });
    await prisma.edition.createMany({ data: [
      { slug: 'coverage-theme-edition', number: 20, title: 'Coverage edition theme', dateLabel: '2026', theme: 'Theme fallback', status: 'PUBLISHED', publishedAt: null },
      { slug: 'coverage-empty-edition', number: 21, title: 'Coverage edition empty', dateLabel: '2026', status: 'PUBLISHED', publishedAt: null, coverResourceId: pendingCover.id },
    ] });
    const editions = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Coverage+edition&pageSize=8` });
    expect(editions.statusCode).toBe(200);
    expect(editions.json().groups.editions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'edition', slug: 'coverage-theme-edition', description: 'Theme fallback', image: null }),
      expect.objectContaining({ type: 'edition', slug: 'coverage-empty-edition', description: '', image: null }),
    ]));
    const book = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Libro+de+prueba` });
    expect(book.json().groups.editions).toEqual([expect.objectContaining({ type: 'book', slug: 'libro-de-prueba', description: 'Libro publicado.', image: null })]);
    const magazine = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=La+libertad` });
    expect(magazine.json().groups.editions).toEqual([expect.objectContaining({ type: 'edition', slug: 'n-012-la-libertad', description: 'Acción directa', image: expect.objectContaining({ url: 'https://example.org/cover.webp' }) })]);

    const editionResource = await prisma.resource.create({ data: {
      type: 'LINK', storageDriver: 'EXTERNAL', name: 'Coverage resource edition', url: 'https://example.org/edition-resource', alt: 'Linked only to edition', credit: 'Tests', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'COMPLETE',
    } });
    const orphanResource = await prisma.resource.create({ data: {
      type: 'AUDIO', storageDriver: 'EXTERNAL', name: 'Coverage resource orphan', url: 'https://example.org/orphan.mp3', alt: 'Without relations', credit: 'Tests', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'COMPLETE',
    } });
    await prisma.editionResource.create({ data: { editionId: ids.book, resourceId: editionResource.id } });
    const resources = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Coverage+resource&pageSize=8` });
    expect(resources.json().groups.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: editionResource.id, type: 'link', editionSlug: 'libro-de-prueba', image: null }),
      expect.objectContaining({ id: orphanResource.id, type: 'audio', editionSlug: null, tags: [], image: null }),
    ]));
    const linkedImage = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=Imagen+pública` });
    expect(linkedImage.json().groups.resources).toEqual([expect.objectContaining({ id: ids.image, type: 'image', editionSlug: 'n-012-la-libertad', image: expect.objectContaining({ url: 'https://example.org/image.webp' }) })]);
  });

  it('lista sólo recursos publicados y completos, validando tipos y páginas', async () => {
    await prisma.resource.create({ data: { type: 'AUDIO', storageDriver: 'S3', name: 'Audio incompleto', url: '', alt: 'Audio pendiente', credit: 'Archivo', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'UPLOADING' } });
    const images = await context.app.inject({ method: 'GET', url: `${prefix}/resources?types=image&page=1&pageSize=1` });
    expect(images.statusCode).toBe(200);
    expect(images.json().items).toHaveLength(1);
    expect(images.json().items[0]).toMatchObject({ type: 'image', uploadStatus: 'complete' });
    expect(images.json().pagination.total).toBe(2);
    const invalid = await context.app.inject({ method: 'GET', url: `${prefix}/resources?types=ejecutable` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_RESOURCE_TYPE');
  });
});

describe('portada y notas públicas', () => {
  it('descarga un PDF real con portada, índice, notas, marcadores y enlaces internos', async () => {
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf?locale=en` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain('n-012-la-libertad-en.pdf');
    expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    expect(response.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const pdf = await getDocument({ data: new Uint8Array(response.rawPayload) }).promise;
    expect(pdf.numPages).toBe(4);
    const textByPage: string[] = [];
    let internalLinks = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      textByPage.push(text.items.map(item => 'str' in item ? item.str : '').join(' '));
      internalLinks += (await page.getAnnotations()).filter(annotation => annotation.subtype === 'Link' && annotation.dest).length;
    }
    expect(textByPage.join('\n')).toContain('CONTENTS');
    expect(textByPage.join('\n')).toContain('Freedom is not requested');
    expect(textByPage.join('\n')).toContain('First paragraph.');
    expect(internalLinks).toBeGreaterThanOrEqual(3);
    const outline = await pdf.getOutline();
    expect(outline?.map(item => item.title)).toEqual(expect.arrayContaining(['La libertad no se pide', 'CONTENTS', 'Freedom is not requested']));
    await pdf.cleanup();
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/editions/edicion-borrador/pdf` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/editions/no-existe/pdf` })).statusCode).toBe(404);
  });

  it('tolera y representa portadas locales, remotas, incompletas y ausentes sin falsear el PDF', async () => {
    const png = await readFile(path.resolve('prisma/assets/archive-cat-not-found.png'));
    await mkdir(storagePath, { recursive: true });
    await writeFile(path.join(storagePath, 'pdf-cover.png'), png);

    await prisma.resource.update({ where: { id: ids.cover }, data: { storageDriver: 'LOCAL', objectKey: 'pdf-cover.png', url: `${prefix}/media/pdf-cover.png` } });
    const local = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(local.statusCode).toBe(200);
    expect(local.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    await prisma.resource.update({ where: { id: ids.cover }, data: { objectKey: null, url: `data:image/png;base64,${png.toString('base64')}` } });
    const fetched = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(fetched.statusCode).toBe(200);

    await prisma.resource.update({ where: { id: ids.cover }, data: { objectKey: null, url: 'https://storage.invalid/cover.png' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));
    const unavailableRemote = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(unavailableRemote.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();

    await prisma.resource.update({ where: { id: ids.cover }, data: { objectKey: 'archivo-inexistente.png', url: '' } });
    const missingFile = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(missingFile.statusCode).toBe(200);

    await prisma.resource.update({ where: { id: ids.cover }, data: { status: 'PUBLISHED', uploadStatus: 'UPLOADING' } });
    const incomplete = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(incomplete.statusCode).toBe(200);

    await prisma.resource.update({ where: { id: ids.cover }, data: { status: 'DRAFT', uploadStatus: 'COMPLETE' } });
    const draftCover = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(draftCover.statusCode).toBe(200);

    const book = await context.app.inject({ method: 'GET', url: `${prefix}/editions/libro-de-prueba/pdf?locale=ru` });
    expect(book.statusCode).toBe(200);
    const bookPdf = await getDocument({ data: new Uint8Array(book.rawPayload) }).promise;
    expect((await (await bookPdf.getPage(2)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ')).toContain('СОДЕРЖАНИЕ');
    await bookPdf.cleanup();

    await prisma.edition.update({ where: { id: ids.book }, data: { slug: '---', number: null, summary: null, author: null } });
    const minimal = await context.app.inject({ method: 'GET', url: `${prefix}/editions/---/pdf?locale=ru` });
    expect(minimal.statusCode).toBe(200);
    expect(minimal.headers['content-disposition']).toContain('edicion-ru.pdf');
  });

  it('pagina un índice extenso y mantiene todos sus destinos internos', async () => {
    await prisma.resource.update({ where: { id: ids.cover }, data: { status: 'DRAFT' } });
    await prisma.note.createMany({ data: Array.from({ length: 18 }, (_, index) => ({
      slug: `nota-indice-${index + 3}`, title: `Nota de índice ${index + 3}`, excerpt: 'Resumen verificable',
      bodyMarkdown: '# Encabezado\n\nTexto con **negrita**, *énfasis* y `código`.', status: 'PUBLISHED',
      publishedAt: new Date(), editionId: ids.edition, sortOrder: index + 2,
    })) });
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/pdf` });
    expect(response.statusCode).toBe(200);
    const pdf = await getDocument({ data: new Uint8Array(response.rawPayload) }).promise;
    expect(pdf.numPages).toBe(23);
    const outline = await pdf.getOutline();
    expect(outline).toHaveLength(22);
    expect(outline?.map(item => item.title)).toContain('Nota de índice 20');
    await pdf.cleanup();
  });

  it('selecciona la vigente por fecha de publicación y no por número o slug', async () => {
    await prisma.edition.create({ data: { slug: 'edicion-vigente-test', number: 1, title: 'Vigente por fecha', dateLabel: '2026', status: 'PUBLISHED', publishedAt: new Date('2030-01-01T00:00:00Z') } });
    const current = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(current.statusCode).toBe(200);
    expect(current.json().edition.slug).toBe('edicion-vigente-test');
    await prisma.edition.updateMany({ data: { status: 'ARCHIVED', archivedAt: new Date() } });
    const missing = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('CURRENT_EDITION_NOT_FOUND');
  });

  it('devuelve portada portable, sólo notas publicadas y relaciones multimedia', async () => {
    await prisma.note.update({ where: { id: ids.draftNote }, data: { editionId: ids.edition } });
    await prisma.note.update({ where: { id: ids.note }, data: {
      coverTitleLines: ['LA LIBERTAD', 'NO SE PIDE'], coverExcerpt: 'Copia editorial de portada.',
      coverButtonPosition: { right: '9%', bottom: '12px' }, coverDepth: 4,
    } });
    const incomplete = await prisma.resource.create({ data: {
      type: 'AUDIO', storageDriver: 'S3', name: 'Audio pendiente', url: '', alt: 'Todavía no disponible',
      credit: 'Archivo', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'UPLOADING',
    } });
    await prisma.noteResource.createMany({ data: [
      { noteId: ids.note, resourceId: ids.draftResource, role: 'attachment', sortOrder: 20 },
      { noteId: ids.note, resourceId: incomplete.id, role: 'audio', sortOrder: 21 },
    ] });
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/home` });
    expect(response.statusCode).toBe(200);
    expect(response.json().edition).toMatchObject({ id: ids.edition, slug: 'n-012-la-libertad', number: 12 });
    expect(response.json().masthead).toMatchObject({ image: 'https://example.org/cover.webp', alt: 'Portada principal' });
    expect(response.json().notes.map((note: { slug: string }) => note.slug)).toEqual(['freedom', 'memory']);
    const note = response.json().notes[0];
    expect(note.paragraphs).toEqual(['Primer párrafo.', 'Segundo párrafo.']);
    expect(note).toMatchObject({
      fragment: 'freedom', x: 100, y: 500, w: 300, h: 400, tone: 'red', sortOrder: 0, editionLink: false,
      coverTitleLines: ['LA LIBERTAD', 'NO SE PIDE'], coverExcerpt: 'Copia editorial de portada.',
      coverButtonPosition: { right: '9%', bottom: '12px' }, coverDepth: 4,
      cover: { titleLines: ['LA LIBERTAD', 'NO SE PIDE'], excerpt: 'Copia editorial de portada.', buttonRight: '9%', buttonBottom: '12px', depth: 4 },
    });
    expect(note.resources.every((resource: { status: string; uploadStatus: string }) => resource.status === 'published' && resource.uploadStatus === 'complete')).toBe(true);
    expect(note.resources.map((resource: { id: string }) => resource.id)).not.toContain(ids.draftResource);
    expect(note.resources.map((resource: { id: string }) => resource.id)).not.toContain(incomplete.id);
    expect(note.gallery).toEqual([expect.objectContaining({ url: 'https://example.org/image.webp' })]);
    expect(note.video).toMatchObject({ url: 'https://example.org/video.mp4' });
  });

  it('localiza título, resumen y cuerpo de una nota desde la API', async () => {
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=en` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      title: 'Freedom is not requested', subtitle: 'Direct action sentinel', summary: 'Direct action sentinel', excerpt: 'Direct action sentinel',
      paragraphs: ['First paragraph.', 'Second paragraph.'], bodyMarkdown: 'First paragraph.\n\nSecond paragraph.',
    });
  });

  it('acepta cortes de portada localizados y descarta arrays editoriales inválidos', async () => {
    await prisma.note.update({ where: { id: ids.note }, data: { coverTitleLines: ['BASE'], localizedContent: {
      en: { title: 'Freedom', excerpt: 'Excerpt', bodyMarkdown: 'Body', coverTitleLines: ['API', 'TITLE'] },
    } } });
    let response = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=en` });
    expect(response.json().coverTitleLines).toEqual(['API', 'TITLE']);
    await prisma.note.update({ where: { id: ids.note }, data: { localizedContent: {
      en: { title: 'Freedom', excerpt: 'Excerpt', bodyMarkdown: 'Body', coverTitleLines: ['API', 42] },
    } } });
    response = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=en` });
    expect(response.json().coverTitleLines).toEqual(['BASE']);
  });

  it('obtiene notas por slug o UUID y oculta borradores, eliminadas e inexistentes', async () => {
    const bySlug = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom` });
    const byId = await context.app.inject({ method: 'GET', url: `${prefix}/notes/${ids.note}` });
    expect(bySlug.statusCode).toBe(200);
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toEqual(bySlug.json());
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/draft-note` })).statusCode).toBe(404);
    await prisma.note.update({ where: { id: ids.note }, data: { status: 'DELETED', deletedAt: new Date() } });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/editions/no-existe/home` })).statusCode).toBe(404);
  });
});

describe('comentarios, votos y reportes', () => {
  it('crea comentarios anónimos y autenticados como pendientes y los publica con identidad estructurada', async () => {
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments`, payload: { author: 'Visitante', body: 'Comentario anónimo válido.' } });
    expect(anonymous.statusCode).toBe(201);
    expect(anonymous.json()).toMatchObject({ author: 'Visitante', isAnonymous: true, authorType: 'anonymous', status: 'pending', votes: 0, moderationMessage: expect.any(String) });
    const reader = await login(context.app, 'reader');
    const authenticated = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments`, headers: { cookie: reader.cookie }, payload: { author: 'Alias ignorado', body: 'Comentario de una cuenta.' } });
    expect(authenticated.statusCode).toBe(201);
    expect(authenticated.json()).toMatchObject({ author: 'Lectora', isAnonymous: false, authorType: 'account', status: 'pending' });
    await prisma.comment.createMany({ data: [
      { id: '40000000-0000-4000-8000-000000000001', noteId: ids.note, parentId: ids.comment, authorName: 'Respuesta visible', body: 'Respuesta publicada.', status: 'VISIBLE' },
      { id: '40000000-0000-4000-8000-000000000002', noteId: ids.note, parentId: ids.comment, authorName: 'Respuesta oculta', body: 'Respuesta moderada.', status: 'HIDDEN' },
    ] });
    const visible = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom/comments` });
    expect(visible.json()).toHaveLength(3);
    expect(visible.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      id: ids.comment, parentId: null, status: 'visible', votes: 0, reactionsCount: 0,
      replies: [expect.objectContaining({ id: '40000000-0000-4000-8000-000000000001', parentId: ids.comment, replies: [], status: 'visible' })],
    }), expect.objectContaining({ id: anonymous.json().id, status: 'pending', isAnonymous: true }), expect.objectContaining({ id: authenticated.json().id, status: 'pending', isAnonymous: false })]));
    expect(visible.body).not.toContain('Respuesta oculta');
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: authenticated.json().id } });
    expect(stored.userId).toBe(ids.reader);
  });

  it('expone pending en replies, omite estados privados y conserva sólo tombstones anónimos deleted', async () => {
    await prisma.comment.createMany({ data: [
      { id: '41000000-0000-4000-8000-000000000001', noteId: ids.note, parentId: ids.comment, authorName: 'Pendiente', body: 'Respuesta pendiente.', status: 'PENDING' },
      { id: '41000000-0000-4000-8000-000000000002', noteId: ids.note, authorName: 'Anónima borrada', body: 'Texto privado preservado.', status: 'DELETED', deletedAt: new Date() },
      { id: '41000000-0000-4000-8000-000000000003', noteId: ids.note, userId: ids.reader, authorName: 'Lectora', body: 'Cuenta borrada.', status: 'DELETED', deletedAt: new Date() },
      { id: '41000000-0000-4000-8000-000000000004', noteId: ids.note, authorName: 'Oculto', body: 'No público.', status: 'HIDDEN' },
      { id: '41000000-0000-4000-8000-000000000005', noteId: ids.note, authorName: 'Reportado', body: 'Tampoco público.', status: 'REPORTED' },
    ] });
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom/comments` });
    expect(response.statusCode).toBe(200);
    const comments = response.json();
    expect(comments.find((comment: { id: string }) => comment.id === ids.comment).replies).toEqual([
      expect.objectContaining({ id: '41000000-0000-4000-8000-000000000001', status: 'pending', isAnonymous: true, authorType: 'anonymous' }),
    ]);
    expect(comments).toContainEqual(expect.objectContaining({
      id: '41000000-0000-4000-8000-000000000002', status: 'deleted', body: '', author: 'Anónima', isAnonymous: true, authorType: 'anonymous',
    }));
    expect(response.body).not.toMatch(/Cuenta borrada|No público|Tampoco público|Texto privado preservado/);
  });

  it('valida cuerpo y nota antes de persistir comentarios', async () => {
    const short = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments`, payload: { body: 'x' } });
    expect(short.statusCode).toBe(400);
    const missing = await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/comments`, payload: { body: 'Comentario suficientemente largo.' } });
    expect(missing.statusCode).toBe(404);
    expect(await prisma.comment.count()).toBe(1);
  });

  it('crea respuestas anónimas/autenticadas pendientes y limita el hilo a un nivel', async () => {
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/replies`, payload: { author: 'Visitante', body: 'Respuesta anónima válida.' } });
    expect(anonymous.statusCode).toBe(201);
    expect(anonymous.json()).toMatchObject({ author: 'Visitante', parentId: ids.comment, status: 'pending', replies: [], reactionsCount: 0, moderationMessage: expect.any(String) });
    const reader = await login(context.app, 'reader');
    const authenticated = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/replies`, headers: { cookie: reader.cookie }, payload: { author: 'Alias ignorado', body: 'Respuesta de una cuenta.' } });
    expect(authenticated.statusCode).toBe(201);
    expect(authenticated.json()).toMatchObject({ author: 'Lectora', parentId: ids.comment, status: 'pending' });
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: authenticated.json().id } });
    expect(stored).toMatchObject({ parentId: ids.comment, userId: ids.reader });

    await prisma.comment.update({ where: { id: anonymous.json().id }, data: { status: 'VISIBLE' } });
    const nested = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${anonymous.json().id}/replies`, payload: { body: 'No se admite un tercer nivel.' } });
    expect(nested.statusCode).toBe(409);
    expect(nested.json().error.code).toBe('COMMENT_REPLY_DEPTH_EXCEEDED');
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/99999999-9999-4999-8999-999999999999/replies`, payload: { body: 'Comentario inexistente.' } })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/replies`, payload: { body: 'x' } })).statusCode).toBe(400);
  });

  it('aplica autor anónimo por defecto y rechaza respuestas en notas ausentes o no publicadas', async () => {
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/replies`, payload: { body: 'Respuesta sin alias explícito.' } });
    expect(anonymous.statusCode).toBe(201);
    expect(anonymous.json().author).toBe('Anónima');
    const missing = await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/comments/${ids.comment}/replies`, payload: { body: 'Nota inexistente.' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOTE_NOT_FOUND');
    const draft = await context.app.inject({ method: 'POST', url: `${prefix}/notes/draft-note/comments/${ids.comment}/replies`, payload: { body: 'Nota todavía en borrador.' } });
    expect(draft.statusCode).toBe(404);
    expect(draft.json().error.code).toBe('NOTE_NOT_FOUND');
  });

  it('alterna la reacción like por identidad y devuelve el estado/conteo resultante', async () => {
    const first = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/reactions`, payload: { reaction: 'like' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ reaction: 'like', reacted: true, votes: 1, reactionsCount: 1, parentId: null, replies: [] });
    const cookie = namedCookie(first, 'lg_voter');
    const removed = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/reactions`, headers: { cookie }, payload: { reaction: 'like' } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ reaction: null, reacted: false, votes: 0, reactionsCount: 0 });
    expect(await prisma.commentVote.count({ where: { commentId: ids.comment } })).toBe(0);

    const reader = await login(context.app, 'reader');
    const account = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/reactions`, headers: { cookie: reader.cookie }, payload: { reaction: 'like' } });
    expect(account.json()).toMatchObject({ reacted: true, reactionsCount: 1 });
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/reactions`, payload: { reaction: 'love' } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/memory/comments/${ids.comment}/reactions`, payload: { reaction: 'like' } })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/comments/${ids.comment}/reactions`, payload: { reaction: 'like' } })).statusCode).toBe(404);
  });

  it('hace el voto idempotente por cookie y suma identidades anónimas distintas', async () => {
    const first = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/upvote` });
    expect(first.statusCode).toBe(200);
    expect(first.json().votes).toBe(1);
    const firstCookie = namedCookie(first, 'lg_voter');
    const repeated = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/upvote`, headers: { cookie: firstCookie } });
    expect(repeated.json().votes).toBe(1);
    const second = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/upvote` });
    expect(second.json().votes).toBe(2);
    expect(namedCookie(second, 'lg_voter')).not.toBe(firstCookie);
    expect(await prisma.commentVote.count({ where: { commentId: ids.comment } })).toBe(2);
  });

  it('rechaza votar comentarios ocultos, ajenos a la nota o inexistentes', async () => {
    await prisma.comment.update({ where: { id: ids.comment }, data: { status: 'HIDDEN' } });
    const hidden = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/upvote` });
    expect(hidden.statusCode).toBe(404);
    const wrongNote = await context.app.inject({ method: 'POST', url: `${prefix}/notes/memory/comments/${ids.comment}/upvote` });
    expect(wrongNote.statusCode).toBe(404);
  });

  it('registra una denuncia por identidad y deriva el comentario visible a moderación', async () => {
    const first = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/report`, payload: { reason: 'privacy', detail: 'Expone información personal.' } });
    expect(first.statusCode).toBe(202);
    const cookie = namedCookie(first, 'lg_voter');
    const repeated = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/report`, headers: { cookie }, payload: { reason: 'privacy', detail: 'Repetido.' } });
    expect(repeated.statusCode).toBe(202);
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: ids.comment }, include: { _count: { select: { reports: true } } } });
    expect(stored).toMatchObject({ status: 'REPORTED', reportCount: 1, _count: { reports: 1 } });
    const invalid = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${ids.comment}/report`, payload: { reason: 'disagree' } });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('valoraciones, contacto y analítica pública', () => {
  it('mantiene una valoración por identidad y recalcula el promedio observado', async () => {
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, payload: { score: 2 } });
    const cookie = namedCookie(anonymous, 'lg_voter');
    expect(anonymous.json()).toEqual({ rating: 2, ratingsCount: 1 });
    const corrected = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, headers: { cookie }, payload: { score: 4 } });
    expect(corrected.json()).toEqual({ rating: 4, ratingsCount: 1 });
    const reader = await login(context.app, 'reader');
    const account = await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, headers: { cookie: reader.cookie }, payload: { score: 2 } });
    expect(account.json()).toEqual({ rating: 3, ratingsCount: 2 });
    expect(await prisma.noteRating.count({ where: { noteId: ids.note } })).toBe(2);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, payload: { score: 6 } })).statusCode).toBe(400);
  });

  it('guarda contactos con asunto por defecto y valida datos obligatorios', async () => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/contacts`, payload: { name: 'Nueva persona', email: 'PERSONA@Example.org', body: 'Este es un mensaje de contacto suficientemente largo.' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'new', message: expect.any(String) });
    const stored = await prisma.contactMessage.findUniqueOrThrow({ where: { id: response.json().id } });
    expect(stored).toMatchObject({ email: 'persona@example.org', subject: 'Mensaje desde el sitio' });
    const invalid = await context.app.inject({ method: 'POST', url: `${prefix}/contacts`, payload: { name: 'X', email: 'mal', body: 'corto' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('limita empíricamente el abuso del formulario de contacto', async () => {
    const responses = [];
    for (let index = 0; index < 4; index++) responses.push(await context.app.inject({ method: 'POST', url: `${prefix}/contacts`, payload: { name: `Persona ${index}`, email: `persona-${index}@example.org`, body: 'Mensaje de contacto suficientemente largo para validar.' } }));
    expect(responses.slice(0, 3).map(response => response.statusCode)).toEqual([201, 201, 201]);
    expect(responses[3]!.statusCode).toBe(429);
    expect(await prisma.contactMessage.count()).toBe(4); // uno de fixture + tres aceptados
  });

  it('anonimiza eventos, resuelve relaciones y respeta DNT/GPC sin persistir', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const sessionId = 'session-publica-empirica-00000001';
    const accepted = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, payload: { sessionId, events: [
      { type: 'page_view', noteId: 'freedom', editionSlug: 'n-012-la-libertad', source: 'https://google.com/search', occurredAt: yesterday },
      { type: 'reading_time', noteId: ids.note, durationSeconds: 90, progressPercent: 50, occurredAt: yesterday },
    ] } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: 2 });
    const rows = await prisma.analyticsEvent.findMany({ orderBy: { type: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.sessionHash !== sessionId && row.sessionHash?.length === 64)).toBe(true);
    expect(rows[0]!.sessionHash).toBe(hmacSha256(context.config.analyticsHmacSecret, `${new Date().toISOString().slice(0, 10)}:${sessionId}`));
    expect(rows.find(row => row.type === 'PAGE_VIEW')).toMatchObject({ noteId: ids.note, editionId: ids.edition, sourceCategory: 'search' });

    const gpc = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, headers: { 'sec-gpc': '1' }, payload: { sessionId: 'session-gpc-000000000001', events: [{ type: 'page_view' }] } });
    const dnt = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, headers: { dnt: '1' }, payload: { sessionId: 'session-dnt-000000000001', events: [{ type: 'page_view' }] } });
    expect(gpc.json()).toEqual({ accepted: 0, privacySignalRespected: true });
    expect(dnt.json()).toEqual({ accepted: 0, privacySignalRespected: true });
    expect(await prisma.analyticsEvent.count()).toBe(2);
  });

  it('rechaza lotes analíticos inválidos sin persistencia parcial', async () => {
    const invalid = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, payload: { sessionId: 'corta', events: [{ type: 'evento_inventado' }] } });
    expect(invalid.statusCode).toBe(400);
    const tooMany = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, payload: { sessionId: 'session-demasiados-eventos-0001', events: Array.from({ length: 21 }, () => ({ type: 'page_view' })) } });
    expect(tooMany.statusCode).toBe(400);
    expect(await prisma.analyticsEvent.count()).toBe(0);
  });
});
