import 'dotenv/config';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/lib/crypto.js';
import { slugify } from '../src/lib/slug.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const adminId = '00000000-0000-4000-8000-000000000001';
const readerId = '00000000-0000-4000-8000-000000000002';
const editorId = '00000000-0000-4000-8000-000000000003';
const moderatorId = '00000000-0000-4000-8000-000000000004';
const editionId = '00000000-0000-4000-8000-000000000012';
const coverId = '00000000-0000-4000-8000-000000000112';
const coverObjectKey = 'seed/guillotina-reference.webp';
const publicStorageBaseUrl = (process.env.PUBLIC_STORAGE_BASE_URL ?? 'http://localhost:3001/laguillotina/api/v1/media').replace(/\/$/, '');
const localStoragePath = path.resolve(process.env.LOCAL_STORAGE_PATH ?? './storage');
const coverSourcePath = fileURLToPath(new URL('./assets/guillotina-reference.webp', import.meta.url));
const coverDestinationPath = path.join(localStoragePath, ...coverObjectKey.split('/'));
const coverUrl = `${publicStorageBaseUrl}/${coverObjectKey}`;

const notes = [
  { slug: 'cat', fragment: 'cat', x: 28, y: 443, w: 243, h: 410, tone: 'yellow', title: 'Gato negro', excerpt: 'Símbolos que no piden permiso', tags: ['símbolos', 'cultura libre'], paragraphs: ['La imagen abre una nota sobre los emblemas que viajan de pared en pared: no como marca, sino como gesto de reconocimiento y memoria compartida.'] },
  { slug: 'freedom', fragment: 'freedom', x: 282, y: 456, w: 350, h: 542, tone: 'red', title: 'La libertad no se pide', excerpt: 'Acción directa y apoyo mutuo', tags: ['autogestión', 'apoyo mutuo'], paragraphs: ['La autonomía no llega desde una oficina. Esta nota recorre prácticas pequeñas, sostenidas y colectivas que nos permiten decidir sobre nuestras propias vidas.', 'Organizarse desde abajo significa construir poder sin reemplazar un mando por otro.'] },
  { slug: 'uprising', fragment: 'uprising', x: 520, y: 446, w: 227, h: 557, tone: 'cyan', title: 'Cuerpos en la calle', excerpt: 'La protesta como lenguaje', tags: ['protesta', 'memoria'], paragraphs: ['Una presencia que ocupa espacio también produce relato. El cuerpo, la mirada y el puño levantado son archivo de una lucha que sigue abierta.'] },
  { slug: 'wall', fragment: 'wall', x: 748, y: 451, w: 289, h: 555, tone: 'lime', title: 'Ni dios, ni patrón', excerpt: 'Una consigna para discutir', tags: ['anticapitalismo', 'autogestión'], paragraphs: ['La frase no promete una salida individual: propone discutir cómo desarmar las jerarquías que estructuran el trabajo, el hogar y el Estado.'] },
  { slug: 'why', fragment: 'why', x: 28, y: 867, w: 222, h: 484, tone: 'yellow', title: '¿Por qué anarquismo?', excerpt: 'Una introducción', tags: ['introducción', 'autonomía'], paragraphs: ['Porque pensar una vida sin dominación no es una fantasía abstracta: es mirar con atención lo que ya hacemos cuando cuidamos, compartimos y resistimos.'] },
  { slug: 'memory', fragment: 'memory', x: 262, y: 1005, w: 399, h: 490, tone: 'red', title: 'Memoria y rebeldía', excerpt: 'Las que estuvieron antes', tags: ['memoria', 'resistencia'], paragraphs: ['La memoria es una herramienta activa. Nombra a quienes faltan, conserva aprendizajes y evita que la historia oficial borre las experiencias de resistencia.'] },
  { slug: 'contents', fragment: 'contents', x: 693, y: 1007, w: 315, h: 338, tone: 'cyan', title: 'En este número', excerpt: 'Abrí cada tema desde la portada', tags: ['archivo'], paragraphs: ['Represión, ecología, autogestión, internacionalismo y poesía: temas para leer en relación, no como noticias aisladas.'], editionLink: true },
  { slug: 'quote', fragment: 'quote', x: 680, y: 1342, w: 349, h: 147, tone: 'lime', title: 'Construir desde las ruinas', excerpt: 'Una invitación final', tags: ['autonomía'], paragraphs: ['No alcanza con rechazar el mundo que hay. La tarea también es ensayar vínculos, redes y espacios que anticipen el mundo que queremos.'] },
  { slug: 'kitchens', tone: 'red', title: 'Cocinas comunes', excerpt: 'Comer también es organizarnos', tags: ['apoyo mutuo', 'cuidados'], paragraphs: ['Una cocina colectiva no resuelve todo, pero cambia la pregunta: de quién merece ayuda a cómo sostenemos la vida entre muchas personas.', 'Los fogones, las ollas y las mesas largas son herramientas políticas cuando nadie manda sobre el hambre de otras.'] },
  { slug: 'posters', tone: 'yellow', title: 'Carteles que viajan', excerpt: 'La gráfica como herramienta', tags: ['gráfica', 'cultura libre'], paragraphs: ['Un afiche pegado, copiado y modificado por otras manos deja de pertenecerle a quien lo hizo. Ahí empieza a funcionar.', 'La gráfica callejera no ilustra una lucha: aprende a hablar dentro de ella.'] },
  { slug: 'seeds', tone: 'lime', title: 'Semillas en la ciudad', excerpt: 'Ecología de todos los días', tags: ['ecología', 'territorio'], paragraphs: ['Huertas, compost y redes de intercambio no son una postal verde: son ensayos para depender menos de los mercados y más de nuestros vínculos.', 'Cuidar un terreno también es discutir quién decide sobre él.'] },
  { slug: 'street-choir', tone: 'cyan', title: 'Cajas de resonancia', excerpt: 'La calle como coro', tags: ['asamblea', 'protesta'], paragraphs: ['Un canto compartido ordena la respiración de una marcha. No es decoración: ayuda a reconocerse, medir el miedo y sostener la presencia.', 'Las voces no necesitan voceros para hacerse escuchar.'] },
  { slug: 'care', tone: 'yellow', title: 'Cuidados insurgentes', excerpt: 'El apoyo mutuo se practica', tags: ['cuidados', 'apoyo mutuo'], paragraphs: ['Cuidar no es una tarea menor ni privada. Es una red de decisiones materiales: tiempo, escucha, recursos y compañía.', 'Cuando el cuidado se vuelve colectivo, también desafía las jerarquías que nos aíslan.'] },
  { slug: 'press', tone: 'red', title: 'Crónicas del taller', excerpt: 'Imprenta, tinta y paciencia', tags: ['imprenta', 'cultura libre'], paragraphs: ['La reproducción casera deja errores, manchas y bordes torcidos. Esa materialidad no es un defecto: cuenta cómo fue hecho el texto.', 'Imprimir sigue siendo una forma de no depender de una sola pantalla.'] },
  { slug: 'living-archive', tone: 'lime', title: 'Archivo vivo', excerpt: 'Guardar para volver a usar', tags: ['memoria', 'archivo'], paragraphs: ['Archivar no es guardar cosas quietas. Es dejar pistas para que una idea pueda reaparecer en otro barrio, otra lengua o otra pelea.', 'La memoria se vuelve útil cuando circula.'] },
  { slug: 'affection-map', tone: 'cyan', title: 'Mapa de afectos', excerpt: 'Redes que no se ven desde arriba', tags: ['territorio', 'apoyo mutuo'], paragraphs: ['Los mapas oficiales nombran avenidas y límites. Los nuestros también deberían nombrar la olla, la biblioteca, el taller y la casa que abre la puerta.', 'Toda geografía cambia cuando se la recorre con otras.'] },
];

async function main() {
  await mkdir(path.dirname(coverDestinationPath), { recursive: true });
  await copyFile(coverSourcePath, coverDestinationPath);
  const coverFile = await stat(coverSourcePath);

  const [adminPassword, readerPassword, editorPassword, moderatorPassword] = await Promise.all([
    hashPassword('guillotina-admin'),
    hashPassword('guillotina'),
    hashPassword('guillotina-editor'),
    hashPassword('guillotina-moderator'),
  ]);
  await prisma.user.upsert({
    where: { email: 'admin@laguillotina.local' },
    update: { displayName: 'Administración de prueba', passwordHash: adminPassword, role: 'ADMIN', status: 'ACTIVE', deletedAt: null },
    create: { id: adminId, email: 'admin@laguillotina.local', displayName: 'Administración de prueba', passwordHash: adminPassword, role: 'ADMIN', profile: { create: { publicName: 'Administración de prueba' } }, preference: { create: {} } },
  });
  await prisma.user.upsert({
    where: { email: 'prueba@laguillotina.local' },
    update: { displayName: 'Tinta de Prueba', passwordHash: readerPassword, role: 'READER', status: 'ACTIVE', deletedAt: null },
    create: { id: readerId, email: 'prueba@laguillotina.local', displayName: 'Tinta de Prueba', passwordHash: readerPassword, role: 'READER', profile: { create: { publicName: 'Tinta de Prueba' } }, preference: { create: {} } },
  });
  await prisma.user.upsert({
    where: { email: 'editor@laguillotina.local' },
    update: { displayName: 'Edición de prueba', passwordHash: editorPassword, role: 'EDITOR', status: 'ACTIVE', deletedAt: null },
    create: { id: editorId, email: 'editor@laguillotina.local', displayName: 'Edición de prueba', passwordHash: editorPassword, role: 'EDITOR', profile: { create: { publicName: 'Edición de prueba' } }, preference: { create: {} } },
  });
  await prisma.user.upsert({
    where: { email: 'moderador@laguillotina.local' },
    update: { displayName: 'Moderación de prueba', passwordHash: moderatorPassword, role: 'MODERATOR', status: 'ACTIVE', deletedAt: null },
    create: { id: moderatorId, email: 'moderador@laguillotina.local', displayName: 'Moderación de prueba', passwordHash: moderatorPassword, role: 'MODERATOR', profile: { create: { publicName: 'Moderación de prueba' } }, preference: { create: {} } },
  });

  await prisma.siteSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default', brandName: 'La Guillotina', publicationType: 'Revista anarquista', statement: 'Contra toda autoridad',
      headerLine: 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD', footerStatement: 'HECHA SIN AMO · SIN COPYRIGHT · COPIÁ · DIFUNDÍ · ORGANIZATE',
      socialPrompt: 'SEGUÍ LA SEÑAL', navigation: [
        { label: 'Inicio', to: '/', sortOrder: 0 }, { label: 'Ediciones', to: '/archivo', sortOrder: 1 },
        { label: 'Quiénes somos', to: '/quienes-somos', sortOrder: 2 }, { label: 'Contacto', to: '/contacto', sortOrder: 3 },
      ], socialLinks: [],
    },
  });

  const categoryNames = [...new Set(notes.flatMap(note => note.tags))];
  const categories = new Map<string, string>();
  for (const [index, name] of categoryNames.entries()) {
    const slug = slugify(name);
    const category = await prisma.category.upsert({
      where: { slug },
      update: { name, status: 'PUBLISHED', deletedAt: null },
      create: { slug, name, description: `Notas y materiales sobre ${name}.`, color: ['red', 'yellow', 'cyan', 'lime'][index % 4]!, status: 'PUBLISHED', createdById: adminId },
    });
    categories.set(slug, category.id);
  }

  await prisma.resource.upsert({
    where: { id: coverId },
    update: {
      storageDriver: 'LOCAL', url: coverUrl, objectKey: coverObjectKey, fileName: 'guillotina-reference.webp',
      fileSize: coverFile.size, mimeType: 'image/webp', status: 'PUBLISHED', uploadStatus: 'COMPLETE', deletedAt: null,
    },
    create: {
      id: coverId, type: 'IMAGE', storageDriver: 'LOCAL', name: 'Portada de La Guillotina Nº 12',
      url: coverUrl, objectKey: coverObjectKey, fileName: 'guillotina-reference.webp', fileSize: coverFile.size, mimeType: 'image/webp',
      alt: 'Portada grabada de La Guillotina',
      credit: 'Archivo de La Guillotina', license: 'Material editorial propio', status: 'PUBLISHED', uploadStatus: 'COMPLETE', createdById: adminId,
    },
  });
  await prisma.edition.upsert({
    where: { slug: 'n-012-la-libertad' },
    update: { status: 'PUBLISHED', deletedAt: null, coverResourceId: coverId },
    create: {
      id: editionId, slug: 'n-012-la-libertad', number: 12, title: 'La libertad no se pide', subtitle: 'Acción directa y apoyo mutuo',
      dateLabel: 'Mayo 2024', theme: 'Acción directa y apoyo mutuo', summary: 'Una edición sobre autonomía, memoria y organización desde abajo.',
      status: 'PUBLISHED', publishedAt: new Date('2024-05-01T12:00:00.000Z'), coverResourceId: coverId, createdById: adminId, updatedById: adminId,
    },
  });

  const noteIds = new Map<string, string>();
  for (const [index, note] of notes.entries()) {
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const saved = await prisma.note.upsert({
      where: { slug: note.slug },
      update: {
        title: note.title, excerpt: note.excerpt, bodyMarkdown: note.paragraphs.join('\n\n'), status: 'PUBLISHED', editionId,
        fragment: note.fragment, x: note.x, y: note.y, width: note.w, height: note.h, tone: note.tone,
        sortOrder: index, editionLink: note.editionLink ?? false, deletedAt: null,
      },
      create: {
        id, slug: note.slug, title: note.title, excerpt: note.excerpt, bodyMarkdown: note.paragraphs.join('\n\n'), status: 'PUBLISHED',
        editionId, fragment: note.fragment, x: note.x, y: note.y, width: note.w, height: note.h, tone: note.tone,
        sortOrder: index, editionLink: note.editionLink ?? false, publishedAt: new Date('2024-05-01T12:00:00.000Z'), createdById: adminId, updatedById: adminId,
      },
    });
    noteIds.set(note.slug, saved.id);
    await prisma.noteCategory.deleteMany({ where: { noteId: saved.id } });
    await prisma.noteCategory.createMany({ data: note.tags.map(name => ({ noteId: saved.id, categoryId: categories.get(slugify(name))! })), skipDuplicates: true });
  }

  const videoId = '00000000-0000-4000-8000-000000000220';
  await prisma.resource.upsert({
    where: { id: videoId }, update: {}, create: {
      id: videoId, type: 'VIDEO', storageDriver: 'EXTERNAL', name: 'Registro de una asamblea',
      url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', alt: 'Registro audiovisual de muestra',
      credit: 'Archivo común', license: 'Muestra técnica', status: 'PUBLISHED', uploadStatus: 'COMPLETE', createdById: adminId,
    },
  });
  await prisma.noteResource.createMany({ data: ['street-choir', 'press'].map((slug, index) => ({ noteId: noteIds.get(slug)!, resourceId: videoId, role: 'video', sortOrder: index })), skipDuplicates: true });

  await prisma.comment.upsert({
    where: { id: '30000000-0000-4000-8000-000000000001' }, update: {},
    create: { id: '30000000-0000-4000-8000-000000000001', noteId: noteIds.get('cat')!, authorName: 'Tinta Negra', body: 'Una lectura necesaria. Gracias por dejar la puerta abierta.', status: 'VISIBLE' },
  });
  await prisma.comment.upsert({
    where: { id: '30000000-0000-4000-8000-000000000002' }, update: {},
    create: { id: '30000000-0000-4000-8000-000000000002', noteId: noteIds.get('freedom')!, authorName: 'Archivo Barrial', body: 'La memoria también se organiza.', status: 'VISIBLE' },
  });
  await prisma.comment.upsert({
    where: { id: '30000000-0000-4000-8000-000000000003' }, update: {},
    create: { id: '30000000-0000-4000-8000-000000000003', noteId: noteIds.get('posters')!, authorName: 'Anónima', body: '¿Hay versión imprimible del afiche?', status: 'PENDING' },
  });

  await prisma.noteRating.upsert({ where: { noteId_voterKey: { noteId: noteIds.get('freedom')!, voterKey: `user:${readerId}` } }, update: { score: 5 }, create: { noteId: noteIds.get('freedom')!, userId: readerId, voterKey: `user:${readerId}`, score: 5 } });
  await prisma.noteRating.upsert({ where: { noteId_voterKey: { noteId: noteIds.get('freedom')!, voterKey: `user:${adminId}` } }, update: { score: 4 }, create: { noteId: noteIds.get('freedom')!, userId: adminId, voterKey: `user:${adminId}`, score: 4 } });
  await prisma.savedNote.upsert({ where: { userId_noteId: { userId: readerId, noteId: noteIds.get('freedom')! } }, update: {}, create: { userId: readerId, noteId: noteIds.get('freedom')! } });

  await prisma.contactMessage.upsert({
    where: { id: '40000000-0000-4000-8000-000000000001' }, update: {},
    create: { id: '40000000-0000-4000-8000-000000000001', name: 'Colectivo La Trama', email: 'latrama@ejemplo.org', subject: 'Propuesta de muestra', body: 'Queremos compartir una serie de afiches del barrio para la próxima edición.', status: 'NEW' },
  });

  for (let index = 0; index < 84; index += 1) {
    const id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const noteId = [...noteIds.values()][index % noteIds.size]!;
    const occurredAt = new Date(Date.now() - (index % 14) * 24 * 60 * 60 * 1_000 - index * 60_000);
    await prisma.analyticsEvent.upsert({
      where: { id }, update: {}, create: {
        id, type: index % 7 === 0 ? 'READING_COMPLETED' : index % 5 === 0 ? 'READING_STARTED' : 'PAGE_VIEW',
        sessionHash: `seed-session-${index % 31}`, noteId, editionId, sourceCategory: ['direct', 'social', 'search', 'referral'][index % 4], occurredAt,
      },
    });
  }
  for (let index = 0; index < 16; index += 1) {
    const id = `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await prisma.analyticsEvent.upsert({ where: { id }, update: {}, create: {
      id, type: 'READING_TIME', sessionHash: `seed-session-${index}`, noteId: [...noteIds.values()][index % noteIds.size]!, editionId,
      durationSeconds: 120 + index * 17, occurredAt: new Date(Date.now() - (index % 7) * 24 * 60 * 60 * 1_000),
    } });
  }

  await prisma.adminLog.upsert({
    where: { id: '60000000-0000-4000-8000-000000000001' }, update: {},
    create: { id: '60000000-0000-4000-8000-000000000001', actorId: adminId, action: 'Preparó la edición de demostración.', entityType: 'edition', entityId: editionId },
  });
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async error => { console.error(error); await prisma.$disconnect(); process.exitCode = 1; });
