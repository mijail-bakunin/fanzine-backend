import type { Prisma } from '../../generated/prisma/client.js';

export function serializeSiteSettings(settings: {
  brandName: string;
  publicationType: string;
  statement: string;
  headerLine: string;
  navigation: unknown;
  footerStatement: string;
  socialPrompt: string;
  socialLinks: unknown;
  updatedAt: Date;
}) {
  return {
    brandName: settings.brandName,
    publicationType: settings.publicationType,
    statement: settings.statement,
    headerLine: settings.headerLine,
    navigation: settings.navigation,
    footerStatement: settings.footerStatement,
    socialPrompt: settings.socialPrompt,
    socialLinks: settings.socialLinks,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

export function paragraphsFromMarkdown(body: string) {
  return body.split(/\r?\n\s*\r?\n/).map(paragraph => paragraph.trim()).filter(Boolean);
}

export function serializeResource(resource: {
  id: string; type: string; name: string; url: string; alt: string; credit: string; license: string;
  status: string; uploadStatus: string; fileName: string | null; fileSize: number; mimeType: string | null; storageDriver: string;
  resourceDate: Date; createdAt: Date; updatedAt: Date; width?: number | null; height?: number | null;
}) {
  return {
    id: resource.id,
    type: resource.type.toLowerCase(),
    name: resource.name,
    title: resource.name,
    url: resource.url,
    alt: resource.alt,
    credit: resource.credit,
    license: resource.license,
    status: resource.status.toLowerCase(),
    uploadStatus: resource.uploadStatus.toLowerCase(),
    fileName: resource.fileName ?? '',
    fileSize: resource.fileSize,
    mimeType: resource.mimeType,
    storageDriver: resource.storageDriver.toLowerCase(),
    width: resource.width ?? undefined,
    height: resource.height ?? undefined,
    date: resource.resourceDate.toISOString(),
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
  };
}

type NoteForPublic = Prisma.NoteGetPayload<{
  include: {
    categories: { include: { category: true } };
    resources: { include: { resource: true } };
    ratings: { select: { score: true } };
  };
}>;

export function serializePublicNote(note: NoteForPublic) {
  const ratings = note.ratings.map(item => item.score);
  const rating = ratings.length ? Number((ratings.reduce((total, score) => total + score, 0) / ratings.length).toFixed(1)) : 0;
  const linked = note.resources.sort((a, b) => a.sortOrder - b.sortOrder).map(item => serializeResource(item.resource));
  const images = linked.filter(resource => resource.type === 'image' && resource.status === 'published');
  const video = linked.find(resource => resource.type === 'video' && resource.status === 'published');
  return {
    id: note.slug,
    databaseId: note.id,
    slug: note.slug,
    fragment: note.fragment ?? note.slug,
    x: note.x ?? 0,
    y: note.y ?? 440,
    w: note.width ?? 240,
    h: note.height ?? 320,
    tone: note.tone,
    title: note.title,
    subtitle: note.excerpt,
    thumbnailText: note.excerpt,
    readMoreLabel: note.readMoreLabel,
    readMoreSubtitle: note.readMoreSubtitle ?? note.excerpt,
    paragraphs: paragraphsFromMarkdown(note.bodyMarkdown),
    bodyMarkdown: note.bodyMarkdown,
    author: note.authorName,
    readingMinutes: note.readingMinutes,
    tags: note.categories.map(item => item.category.name),
    categoryIds: note.categories.map(item => item.category.slug),
    resources: linked,
    gallery: images.map(resource => ({ url: resource.url, alt: resource.alt, caption: resource.name, credit: resource.credit, license: resource.license })),
    video: video ? { url: video.url, title: video.name, description: video.alt, credit: video.credit } : undefined,
    editionLink: note.editionLink || undefined,
    rating,
    ratingsCount: ratings.length,
  };
}

export function serializeComment(comment: {
  id: string; authorName: string; body: string; status: string; createdAt: Date; _count?: { votes: number };
}) {
  return {
    id: comment.id,
    author: comment.authorName,
    body: comment.body,
    votes: comment._count?.votes ?? 0,
    status: comment.status.toLowerCase(),
    createdAt: comment.createdAt.toISOString(),
  };
}
