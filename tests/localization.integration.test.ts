import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, closeTestDatabase, createTestContext, ids, login, prefix, type TestContext,
} from './helpers/test-context.js';
import { localizedRecord, resolveEditorialTranslation } from '../src/modules/content/localization.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

const englishEdition = {
  status: 'published', title: 'Freedom is never requested', subtitle: 'Direct action translated', date: 'May 2024',
  theme: 'Mutual aid', summary: 'English issue summary.', author: 'The Guillotine', publication: 'The Guillotine',
  headerLine: 'ANARCHIST MAGAZINE / AGAINST ALL AUTHORITY',
  masthead: { image: 'https://cdn.example.org/the-guillotine.png', referenceImage: 'https://cdn.example.org/the-guillotine-sheet.png', alt: 'The Guillotine English cover' },
} as const;

const russianEdition = {
  status: 'published', title: 'Свободу не просят', subtitle: 'Прямое действие', date: 'Май 2024',
  theme: 'Взаимопомощь', summary: 'Описание выпуска на русском языке.', author: 'Гильотина', publication: 'Гильотина',
  headerLine: 'АНАРХИСТСКИЙ ЖУРНАЛ / ПРОТИВ ВСЯКОЙ ВЛАСТИ',
  masthead: { image: 'https://cdn.example.org/guillotine-ru.png', alt: 'Русская обложка журнала Гильотина' },
} as const;

const englishNote = {
  status: 'published', title: 'Freedom is never requested', subtitle: 'English subtitle', summary: 'English summary',
  excerpt: 'English excerpt', body: 'First translated paragraph.\n\nSecond translated paragraph.', thumbnailText: 'English card',
  author: 'Editorial collective', readMoreLabel: 'READ +', readMoreSubtitle: 'Open the English article',
  coverTitleLines: ['FREEDOM', 'IS NOT REQUESTED'], coverExcerpt: 'English cover copy',
} as const;

const russianNote = {
  status: 'published', title: 'Свободу не просят', subtitle: 'Русский подзаголовок', summary: 'Краткое описание',
  excerpt: 'Русский фрагмент', body: 'Первый переведённый абзац.\n\nВторой переведённый абзац.', thumbnailText: 'Карточка на русском',
  author: 'Редакция', readMoreLabel: 'ЧИТАТЬ +', readMoreSubtitle: 'Открыть материал',
  coverTitleLines: ['СВОБОДУ', 'НЕ ПРОСЯТ'], coverExcerpt: 'Текст для обложки',
} as const;

describe('traducciones editoriales ES/EN/RU', () => {
  it('admin/editor publica edición, nota, categoría y medios; las rutas públicas resuelven cada idioma', async () => {
    const editor = await login(context.app, 'editor');
    const edition = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor),
      payload: { translations: { en: englishEdition, ru: russianEdition } },
    });
    expect(edition.statusCode).toBe(200);
    expect(edition.json()).toMatchObject({ translationStatus: { es: 'published', en: 'published', ru: 'published' }, translations: { en: { title: englishEdition.title }, ru: { title: russianEdition.title } } });

    const note = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor),
      payload: { translations: { en: englishNote, ru: russianNote } },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ translationStatus: { es: 'published', en: 'published', ru: 'published' } });

    const category = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/categories/${ids.category}`, headers: authHeaders(editor), payload: { translations: {
        en: { status: 'published', name: 'self-management', description: 'Autonomous practices.' },
        ru: { status: 'published', name: 'самоуправление', description: 'Автономные практики.' },
      } },
    });
    expect(category.statusCode).toBe(200);
    expect(category.json().translationStatus).toMatchObject({ en: 'published', ru: 'published' });

    const resource = await context.app.inject({
      method: 'PATCH', url: `${prefix}/admin/resources/${ids.image}`, headers: authHeaders(editor), payload: { translations: {
        en: { status: 'published', name: 'Public image', title: 'Public image', alt: 'English image alt', caption: 'English caption', credit: 'Archive', license: 'CC BY' },
        ru: { status: 'published', name: 'Публичное изображение', title: 'Публичное изображение', alt: 'Описание изображения', caption: 'Подпись изображения', credit: 'Архив', license: 'CC BY' },
      } },
    });
    expect(resource.statusCode).toBe(200);
    expect(resource.json().translationStatus).toMatchObject({ en: 'published', ru: 'published' });

    const homeEn = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home?locale=en` });
    expect(homeEn.statusCode).toBe(200);
    expect(homeEn.json()).toMatchObject({
      requestedLocale: 'en', locale: 'en', translationFallback: false,
      edition: { title: englishEdition.title, publication: 'The Guillotine' },
      masthead: {
        image: englishEdition.masthead.image, referenceImage: englishEdition.masthead.referenceImage, alt: englishEdition.masthead.alt,
        canvas: { width: 1055, height: 1492, mastheadHeight: 440 }, locale: 'en', translationFallback: false,
      },
    });
    const publicNoteEn = homeEn.json().notes.find((item: { databaseId: string }) => item.databaseId === ids.note);
    expect(publicNoteEn).toMatchObject({ title: englishNote.title, bodyMarkdown: englishNote.body, readMoreLabel: 'READ +', tags: ['self-management'], locale: 'en', translationFallback: false });
    expect(publicNoteEn.resources[0]).toMatchObject({ alt: 'English image alt', caption: 'English caption', locale: 'en', translationFallback: false });

    const noteRu = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=ru` });
    expect(noteRu.statusCode).toBe(200);
    expect(noteRu.json()).toMatchObject({ title: russianNote.title, paragraphs: ['Первый переведённый абзац.', 'Второй переведённый абзац.'], tags: ['самоуправление'], requestedLocale: 'ru', locale: 'ru', translationFallback: false });
    const homeRu = await context.app.inject({ method: 'GET', url: `${prefix}/editions/current/home?locale=ru` });
    expect(homeRu.json().masthead).toMatchObject({ image: russianEdition.masthead.image, referenceImage: russianEdition.masthead.image, canvas: { width: 1055, height: 1492, mastheadHeight: 440 } });
  });

  it('no expone ni indexa traducciones draft/review y conserva la raíz canónica ES', async () => {
    const editor = await login(context.app, 'editor');
    const sentinel = 'PRIVATE_TRANSLATION_SENTINEL';
    const changed = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: {
      translations: { en: { status: 'review', title: sentinel }, es: { status: 'draft', title: 'BORRADOR ESPAÑOL PRIVADO' } },
    } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().translationStatus).toMatchObject({ es: 'draft', en: 'review' });
    expect(changed.json().title).toBe('La libertad no se pide');

    const english = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=en` });
    expect(english.statusCode).toBe(200);
    expect(english.json()).toMatchObject({ title: 'La libertad no se pide', requestedLocale: 'en', locale: 'es', translationFallback: true });
    expect(english.body).not.toContain(sentinel);
    const spanish = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=es` });
    expect(spanish.json()).toMatchObject({ title: 'La libertad no se pide', locale: 'es', translationFallback: false });

    const search = await context.app.inject({ method: 'GET', url: `${prefix}/search?q=${sentinel}&locale=en` });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual([]);
    expect(search.json().pagination.total).toBe(0);

    expect(resolveEditorialTranslation({ es: { status: 'published', title: 'Español publicado' } }, 'ru')).toMatchObject({
      record: { title: 'Español publicado' }, locale: 'es', requestedLocale: 'ru', translationFallback: true,
    });
    expect(localizedRecord({ es: { title: 'Fallback histórico' } }, 'ru')).toEqual({ title: 'Fallback histórico' });
  });

  it('valida publicaciones completas, URLs HTTP(S), locales y permisos', async () => {
    const editor = await login(context.app, 'editor');
    const moderator = await login(context.app, 'moderator');
    const incomplete = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { translations: { ru: { status: 'published', title: 'Только заголовок' } } } });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error.code).toBe('VALIDATION_ERROR');
    const unsafeImage = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { translations: { en: { ...englishEdition, masthead: { image: 'file:///secret.png', alt: 'Invalid image' } } } } });
    expect(unsafeImage.statusCode).toBe(400);
    const unsafeReference = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { translations: { en: { ...englishEdition, masthead: { ...englishEdition.masthead, referenceImage: 'file:///secret.png' } } } } });
    expect(unsafeReference.statusCode).toBe(400);
    const missingMasthead = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { translations: { en: { status: 'published', title: 'Complete text but no image', date: 'May 2024', publication: 'The Guillotine', headerLine: 'ANARCHIST MAGAZINE' } } } });
    expect(missingMasthead.statusCode).toBe(400);
    const draftWithoutDate = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { translations: { en: { status: 'draft', title: 'Unfinished translation' } } } });
    expect(draftWithoutDate.statusCode).toBe(200);
    expect(draftWithoutDate.json().translationStatus.en).toBe('draft');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(moderator), payload: { translations: { en: englishNote } } })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom?locale=fr` })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/resources/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor), payload: { name: 'Missing resource' } })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/categories/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor), payload: { name: 'Missing category' } })).statusCode).toBe(404);
  });

  it('sincroniza una variante española publicada con los campos canónicos de creación y edición', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: {
      title: 'Raíz original', date: '2027', translations: { es: {
        status: 'published', title: 'Título español publicado', subtitle: 'Subtítulo español', date: 'Junio 2027',
        publication: 'La Guillotina', headerLine: 'REVISTA ANARQUISTA', masthead: { image: 'https://cdn.example.org/es.png', alt: 'Portada española' },
      } },
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: 'Título español publicado', subtitle: 'Subtítulo español', date: 'Junio 2027' });

    const edition = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: { translations: { es: {
      status: 'published', title: 'Edición canónica', subtitle: 'Nueva bajada', date: 'Julio 2027', theme: 'Tema', summary: 'Nuevo resumen', author: 'Colectivo',
      publication: 'La Guillotina', headerLine: 'REVISTA ANARQUISTA', masthead: { image: 'https://cdn.example.org/es-2.png', alt: 'Nueva portada española' },
    } } } });
    expect(edition.statusCode).toBe(200);
    expect(edition.json()).toMatchObject({ title: 'Edición canónica', subtitle: 'Nueva bajada', date: 'Julio 2027' });

    const note = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(editor), payload: { translations: { es: {
      status: 'published', title: 'Nota canónica', subtitle: 'Subtítulo', summary: 'Resumen', excerpt: 'Extracto español', body: 'Cuerpo uno.\n\nCuerpo dos.',
      thumbnailText: 'Tarjeta española', author: 'Redacción ES', readMoreLabel: 'LEER AHORA', readMoreSubtitle: 'Abrir nota', coverTitleLines: ['NOTA', 'CANÓNICA'], coverExcerpt: 'Copia de portada',
    } } } });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ title: 'Nota canónica', excerpt: 'Extracto español', body: 'Cuerpo uno.\n\nCuerpo dos.', author: 'Redacción ES', coverTitleLines: ['NOTA', 'CANÓNICA'], coverExcerpt: 'Copia de portada' });
  });

  it('dashboard entrega todas las variantes/estados y admin settings conserva el mapa completo', async () => {
    const admin = await login(context.app, 'admin');
    await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(admin), payload: { translations: { en: englishEdition } } });
    await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${ids.note}`, headers: authHeaders(admin), payload: { translations: { en: englishNote } } });
    const dashboard = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=all&page=1&pageSize=20`, headers: { cookie: admin.cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().editions.find((item: { id: string }) => item.id === ids.edition)).toMatchObject({ translations: { en: { title: englishEdition.title } }, translationStatus: { en: 'published', ru: 'missing' } });
    expect(dashboard.json().notes.find((item: { id: string }) => item.id === ids.note)).toMatchObject({ translations: { en: { title: englishNote.title } }, translationStatus: { en: 'published', ru: 'missing' } });
    expect(dashboard.json().resources[0]).toHaveProperty('translationStatus');
    expect(dashboard.json().categories[0]).toHaveProperty('translationStatus');
    const settings = await context.app.inject({ method: 'GET', url: `${prefix}/admin/settings`, headers: { cookie: admin.cookie } });
    expect(settings.statusCode).toBe(200);
    expect(Object.keys(settings.json().contentByLocale).sort()).toEqual(['en', 'es', 'ru']);
    expect(Object.keys(settings.json().seoByLocale).sort()).toEqual(['en', 'es', 'ru']);
  });
});
