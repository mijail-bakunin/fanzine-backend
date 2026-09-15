import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDatabase, createTestContext, credentials, ids, prefix, prisma, type TestContext } from './helpers/test-context.js';

let context: TestContext;
let baseUrl = '';

beforeEach(async () => {
  context = await createTestContext();
  const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address;
});
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

async function request(pathname: string, init?: RequestInit) {
  return fetch(`${baseUrl}${pathname}`, init);
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get('set-cookie') ?? '';
  const match = cookie.match(/lg_session=[^;]+/);
  if (!match) throw new Error('La respuesta HTTP real no incluyó lg_session.');
  return match[0];
}

function responseCookie(response: Response, name: string) {
  const cookie = response.headers.get('set-cookie') ?? '';
  return cookie.match(new RegExp(`${name}=[^;]+`))?.[0] ?? '';
}

describe('end-to-end mediante socket HTTP real', () => {
  it('envía mensajes anónimos al asistente y continúa una conversación por HTTP real', async () => {
    const first = await request(`${prefix}/assistant/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hello, show me the archive', locale: 'en' }),
    });
    expect(first.status).toBe(200);
    const initial = await first.json() as { conversationId: string; reply: { role: string; text: string; createdAt: string }; requestId: string };
    expect(initial).toMatchObject({ reply: { role: 'assistant', text: expect.stringContaining('Hello.') }, requestId: expect.any(String) });

    const continued = await request(`${prefix}/assistant/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '¿Cómo colaborar?', locale: 'es', conversationId: initial.conversationId }),
    });
    expect(continued.status).toBe(200);
    expect(await continued.json()).toMatchObject({ conversationId: initial.conversationId, reply: { role: 'assistant', text: expect.stringContaining('Colaborar') } });
  });

  it('sirve la experiencia pública completa y guardadas sin reconstrucción local', async () => {
    const settings = await request(`${prefix}/site/settings?locale=en`);
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({
      locale: 'en', brand: { publicationType: 'Anarchist magazine' },
      authentication: { login: { submitLabel: 'SIGN IN' } },
      archive: { magazinesLabel: 'Magazines' }, pages: { about: { lead: 'Sentinel EN.' } },
      assets: {}, seo: { defaultTitle: 'Sentinel SEO EN' },
    });

    const home = await request(`${prefix}/editions/n-012-la-libertad/home?locale=en`);
    expect(home.status).toBe(200);
    const homeBody = await home.json() as { notes: Array<{ slug: string; title: string; summary: string; bodyMarkdown: string; resources: unknown[]; rating: number; ratingsCount: number }> };
    expect(homeBody.notes).toHaveLength(2);
    expect(homeBody.notes[0]).toMatchObject({
      slug: 'freedom', title: 'Freedom is not requested', summary: 'Direct action sentinel',
      bodyMarkdown: 'First paragraph.\n\nSecond paragraph.', resources: expect.any(Array), rating: 0, ratingsCount: 0,
    });

    const search = await request(`${prefix}/search?q=Freedom&locale=en&page=1&pageSize=8`);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ items: [expect.objectContaining({ type: 'note', slug: 'freedom', route: '/edicion/n-012-la-libertad/nota/freedom' })] });

    const login = await request(`${prefix}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials.reader),
    });
    const cookie = sessionCookie(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const saved = await request(`${prefix}/auth/saved-notes/freedom/toggle`, {
      method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(saved.status).toBe(200);
    const listing = await request(`${prefix}/auth/saved-notes?locale=en&page=1&pageSize=12`, { headers: { cookie } });
    expect(listing.status).toBe(200);
    const listingBody = await listing.json() as { items: Array<Record<string, unknown>>; pagination: Record<string, number> };
    expect(listingBody.items).toHaveLength(1);
    expect(listingBody.items[0]).toMatchObject({ id: 'freedom', title: 'Freedom is not requested', image: { url: 'https://example.org/image.webp' } });
    expect(listingBody.pagination).toMatchObject({ page: 1, pageSize: 12, total: 1, totalPages: 1 });

    const rating = await request(`${prefix}/notes/freedom/rating`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ score: 5 }),
    });
    expect(rating.status).toBe(200);
    expect(await rating.json()).toMatchObject({ rating: 5, ratingsCount: 1 });
  });

  it('recorre login, administración, publicación y lectura pública preservando cookies/CSRF', async () => {
    const health = await request(`${prefix}/health/ready`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ready', database: 'connected' });

    const login = await request(`${prefix}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials.editor),
    });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const { csrfToken } = await login.json() as { csrfToken: string };

    const typography = await request(`${prefix}/admin/notes/${ids.note}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ coverTypography: { titleSize: 'display', titleAlign: 'right', titleTreatment: 'torn', excerptSize: 'large' } }),
    });
    expect(typography.status).toBe(200);
    expect(await typography.json()).toMatchObject({ coverTypography: { titleSize: 'display', titleAlign: 'right', titleTreatment: 'torn', excerptSize: 'large' } });

    const created = await request(`${prefix}/admin/editions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        title: 'E2E publicada', date: 'Agosto 2026', status: 'published', noteIds: [ids.note],
        coverArt: { preset: 'signal', elements: [{ id: 'e2e-tape', type: 'tape', tone: 'yellow', x: 40, y: 30, w: 250, h: 60, rotation: -5, depth: 20 }] },
      }),
    });
    expect(created.status).toBe(201);
    const edition = await created.json() as { id: string; slug: string };
    expect(await prisma.edition.findUnique({ where: { id: edition.id } })).not.toBeNull();

    const publicEdition = await request(`${prefix}/editions/${edition.slug}/home`);
    expect(publicEdition.status).toBe(200);
    expect(await publicEdition.json()).toMatchObject({
      edition: { slug: edition.slug, coverArt: { preset: 'signal', elements: [{ id: 'e2e-tape', type: 'tape', tone: 'yellow', x: 40, y: 30, w: 250, h: 60, rotation: -5, depth: 20 }] } },
      notes: [expect.objectContaining({ slug: 'freedom', coverTypography: { titleSize: 'display', titleAlign: 'right', titleTreatment: 'torn', excerptSize: 'large' } })],
    });

    const preflight = await request(`${prefix}/admin/editions/${edition.id}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type,x-csrf-token' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });

  it('transfiere un multipart real y sirve exactamente los mismos bytes por HTTP', async () => {
    const login = await request(`${prefix}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials.editor) });
    const cookie = sessionCookie(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'e2e.png');
    form.append('type', 'image'); form.append('name', 'Imagen E2E'); form.append('alt', 'Contenido E2E');
    form.append('credit', 'Pruebas'); form.append('license', 'CC0'); form.append('status', 'published');
    const upload = await request(`${prefix}/admin/resources/upload`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken }, body: form });
    expect(upload.status).toBe(201);
    const resource = await upload.json() as { url: string };
    const downloaded = await fetch(resource.url.replace('http://localhost:3001', baseUrl));
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  it('recorre respuestas y reacciones anónimas por HTTP real', async () => {
    const reply = await request(`${prefix}/notes/freedom/comments/${ids.comment}/replies`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ author: 'E2E', body: 'Respuesta creada por HTTP real.' }),
    });
    expect(reply.status).toBe(201);
    const created = await reply.json() as { id: string; parentId: string; status: string };
    expect(created).toMatchObject({ parentId: ids.comment, status: 'pending' });
    await prisma.comment.update({ where: { id: created.id }, data: { status: 'VISIBLE' } });

    const thread = await request(`${prefix}/notes/freedom/comments`);
    expect(thread.status).toBe(200);
    expect(await thread.json()).toEqual([expect.objectContaining({ id: ids.comment, replies: [expect.objectContaining({ id: created.id, parentId: ids.comment })] })]);

    const liked = await request(`${prefix}/notes/freedom/comments/${created.id}/reactions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reaction: 'like' }),
    });
    expect(liked.status).toBe(200);
    expect(await liked.json()).toMatchObject({ reacted: true, reactionsCount: 1 });
    const voter = responseCookie(liked, 'lg_voter');
    expect(voter).not.toBe('');
    const unliked = await request(`${prefix}/notes/freedom/comments/${created.id}/reactions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: voter }, body: JSON.stringify({ reaction: 'like' }),
    });
    expect(await unliked.json()).toMatchObject({ reacted: false, reactionsCount: 0 });
  });
});
