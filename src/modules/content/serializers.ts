import type { Prisma } from '../../generated/prisma/client.js';
import { serializeCoverComposition } from './cover-composition.js';
import { asRecord, localizedRecord, localizedString, localizedStringArray, resolveEditorialTranslation, translationStatuses, type PublicLocale } from './localization.js';
import { serializeCoverTypography } from './note-cover-typography.js';

export function serializeSiteSettings(settings: {
  brandName: string;
  publicationType: string;
  statement: string;
  headerLine: string;
  navigation: unknown;
  footerStatement: string;
  socialPrompt: string;
  socialLinks: unknown;
  contentByLocale: unknown;
  seoByLocale: unknown;
  updatedAt: Date;
}, locale: PublicLocale = 'es', includeTranslations = false) {
  const storedContent = localizedRecord(settings.contentByLocale, locale);
  const storedBrand = asRecord(storedContent.brand);
  const storedFooter = asRecord(storedContent.footer);
  const primaryLocale = locale === 'es';
  const navigation = primaryLocale ? settings.navigation : storedContent.navigation ?? settings.navigation;
  const socialLinks = primaryLocale ? settings.socialLinks : storedFooter.socialLinks ?? settings.socialLinks;
  const brandName = primaryLocale ? settings.brandName : localizedString(storedBrand, 'name', settings.brandName)!;
  const publicationType = primaryLocale ? settings.publicationType : localizedString(storedBrand, 'publicationType', settings.publicationType)!;
  const statement = primaryLocale ? settings.statement : localizedString(storedBrand, 'statement', settings.statement)!;
  const headerLine = primaryLocale ? settings.headerLine : localizedString(storedBrand, 'headerLine', settings.headerLine)!;
  const footerStatement = primaryLocale ? settings.footerStatement : localizedString(storedFooter, 'statement', settings.footerStatement)!;
  const socialPrompt = primaryLocale ? settings.socialPrompt : localizedString(storedFooter, 'socialPrompt', settings.socialPrompt)!;
  const brand = { name: brandName, publicationType, statement, headerLine };
  const footer = { statement: footerStatement, socialPrompt, socialLinks };
  return {
    requestedLocale: locale,
    locale: Object.keys(storedContent).length ? locale : 'es',
    translationFallback: locale !== 'es' && !Object.prototype.hasOwnProperty.call(asRecord(settings.contentByLocale), locale),
    brandName, publicationType, statement, headerLine, navigation,
    footerStatement, socialPrompt, socialLinks,
    brand,
    footer,
    authentication: storedContent.authentication ?? null,
    archive: storedContent.archive ?? null,
    pages: storedContent.pages ?? {},
    assets: storedContent.assets ?? {},
    seo: localizedRecord(settings.seoByLocale, locale),
    ...(includeTranslations ? { contentByLocale: settings.contentByLocale, seoByLocale: settings.seoByLocale } : {}),
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
  durationSeconds?: number | null; checksum?: string | null;
  localizedContent?: unknown;
}, locale: PublicLocale = 'es', includeTranslations = false) {
  const resolved = resolveEditorialTranslation(resource.localizedContent, locale);
  const localized = resolved.record;
  const name = localizedString(localized, 'name', resource.name)!;
  const title = localizedString(localized, 'title', name)!;
  const alt = localizedString(localized, 'alt', resource.alt)!;
  const caption = localizedString(localized, 'caption', name)!;
  const credit = localizedString(localized, 'credit', resource.credit)!;
  const license = localizedString(localized, 'license', resource.license)!;
  return {
    id: resource.id,
    type: resource.type.toLowerCase(),
    name,
    title,
    caption,
    url: resource.url,
    alt,
    credit,
    license,
    status: resource.status.toLowerCase(),
    uploadStatus: resource.uploadStatus.toLowerCase(),
    fileName: resource.fileName ?? '',
    fileSize: resource.fileSize,
    mimeType: resource.mimeType,
    storageDriver: resource.storageDriver.toLowerCase(),
    width: resource.width ?? undefined,
    height: resource.height ?? undefined,
    durationSeconds: resource.durationSeconds ?? undefined,
    checksum: resource.checksum ?? undefined,
    date: resource.resourceDate.toISOString(),
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    requestedLocale: resolved.requestedLocale,
    locale: resolved.locale,
    translationFallback: resolved.translationFallback,
    ...(includeTranslations ? { translations: resource.localizedContent, translationStatus: translationStatuses(resource.localizedContent) } : {}),
  };
}

type NoteForPublic = Prisma.NoteGetPayload<{
  include: {
    categories: { include: { category: true } };
    resources: { include: { resource: true } };
    ratings: { select: { score: true } };
  };
}>;

type CoverNote = {
  coverTitleLines: string[];
  coverExcerpt: string | null;
  coverButtonPosition: Prisma.JsonValue | null;
  coverDepth: number | null;
};

function coverPosition(value: Prisma.JsonValue | null) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const position = value as Record<string, Prisma.JsonValue>;
  const read = (key: 'left' | 'right' | 'bottom') => typeof position[key] === 'string' ? position[key] : undefined;
  const normalized = { left: read('left'), right: read('right'), bottom: read('bottom') };
  return Object.values(normalized).some(value => value !== undefined) ? normalized : null;
}

export function serializeCoverMetadata(note: CoverNote) {
  const position = coverPosition(note.coverButtonPosition);
  return {
    coverTitleLines: note.coverTitleLines,
    coverExcerpt: note.coverExcerpt,
    coverButtonPosition: position,
    coverDepth: note.coverDepth,
    cover: {
      titleLines: note.coverTitleLines,
      excerpt: note.coverExcerpt,
      buttonLeft: position?.left,
      buttonRight: position?.right,
      buttonBottom: position?.bottom,
      depth: note.coverDepth,
    },
  };
}

export function serializePublicNote(note: NoteForPublic, locale: PublicLocale = 'es') {
  const resolved = resolveEditorialTranslation(note.localizedContent, locale);
  const localized = resolved.record;
  const ratings = note.ratings.map(item => item.score);
  const rating = ratings.length ? Number((ratings.reduce((total, score) => total + score, 0) / ratings.length).toFixed(1)) : 0;
  const linked = note.resources
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(item => serializeResource(item.resource, locale))
    .filter(resource => resource.status === 'published' && resource.uploadStatus === 'complete');
  const images = linked.filter(resource => resource.type === 'image');
  const video = linked.find(resource => resource.type === 'video');
  const thumbnailResource = linked.find(resource => resource.type === 'image');
  const resourcePoster = thumbnailResource ? { url: thumbnailResource.url, alt: thumbnailResource.alt } : null;
  const enrichedResources = linked.map(resource => resource.type === 'video' || resource.type === 'audio'
    ? { ...resource, poster: resourcePoster }
    : resource);
  const title = localizedString(localized, 'title', note.title)!;
  const excerpt = localizedString(localized, 'excerpt', note.excerpt)!;
  const subtitle = localizedString(localized, 'subtitle', excerpt)!;
  const summary = localizedString(localized, 'summary', excerpt)!;
  const thumbnailText = localizedString(localized, 'thumbnailText', excerpt)!;
  const bodyMarkdown = localizedString(localized, 'bodyMarkdown', note.bodyMarkdown)!;
  const author = localizedString(localized, 'authorName', note.authorName)!;
  const readMoreLabel = localizedString(localized, 'readMoreLabel', note.readMoreLabel)!;
  const readMoreSubtitle = localizedString(localized, 'readMoreSubtitle', note.readMoreSubtitle ?? excerpt)!;
  const localizedCoverLines = localizedStringArray(localized, 'coverTitleLines', note.coverTitleLines);
  return {
    id: note.slug,
    databaseId: note.id,
    slug: note.slug,
    ...serializeCoverComposition(note),
    title,
    subtitle,
    summary,
    excerpt,
    thumbnailText,
    readMoreLabel,
    readMoreSubtitle,
    ...serializeCoverMetadata({ ...note, coverTitleLines: localizedCoverLines, coverExcerpt: localizedString(localized, 'coverExcerpt', note.coverExcerpt) }),
    coverTypography: serializeCoverTypography(note.coverTypography),
    paragraphs: paragraphsFromMarkdown(bodyMarkdown),
    bodyMarkdown,
    author,
    readingMinutes: note.readingMinutes,
    tags: note.categories.map(item => localizedString(resolveEditorialTranslation(item.category.localizedContent, locale).record, 'name', item.category.name)!),
    categoryIds: note.categories.map(item => item.category.slug),
    resources: enrichedResources,
    thumbnail: thumbnailResource ? { url: thumbnailResource.url, alt: thumbnailResource.alt, caption: thumbnailResource.caption, credit: thumbnailResource.credit, license: thumbnailResource.license } : null,
    gallery: images.map(resource => ({ url: resource.url, alt: resource.alt, caption: resource.caption, credit: resource.credit, license: resource.license })),
    video: video ? { url: video.url, src: video.url, title: video.name, description: video.alt, credit: video.credit, poster: resourcePoster } : undefined,
    rating,
    ratingsCount: ratings.length,
    requestedLocale: resolved.requestedLocale,
    locale: resolved.locale,
    translationFallback: resolved.translationFallback,
  };
}

type CommentForPublic = {
  id: string;
  parentId?: string | null;
  userId?: string | null;
  authorName: string;
  body: string;
  status: string;
  createdAt: Date;
  _count?: { votes: number };
  replies?: CommentForPublic[];
};

export type SerializedComment = {
  id: string;
  author: string;
  isAnonymous: boolean;
  authorType: 'anonymous' | 'account';
  body: string;
  votes: number;
  reactionsCount: number;
  parentId: string | null;
  replies: SerializedComment[];
  status: string;
  createdAt: string;
};

export function serializeComment(comment: CommentForPublic): SerializedComment {
  const reactionsCount = comment._count?.votes ?? 0;
  const isAnonymous = !comment.userId;
  const isDeletedTombstone = isAnonymous && comment.status === 'DELETED';
  return {
    id: comment.id,
    author: isDeletedTombstone ? 'Anónima' : comment.authorName,
    isAnonymous,
    authorType: isAnonymous ? 'anonymous' : 'account',
    body: isDeletedTombstone ? '' : comment.body,
    votes: reactionsCount,
    reactionsCount,
    parentId: comment.parentId ?? null,
    replies: (comment.replies ?? []).map(serializeComment),
    status: comment.status.toLowerCase(),
    createdAt: comment.createdAt.toISOString(),
  };
}
