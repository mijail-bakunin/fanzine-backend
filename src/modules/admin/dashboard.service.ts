import type { PrismaClient, UserRole } from '../../generated/prisma/client.js';
import { paginationMeta, pageWindow } from '../../lib/pagination.js';
import { serializeCoverMetadata, serializeResource } from '../content/serializers.js';
import { buildDashboardAnalytics } from '../analytics/dashboard-analytics.js';
import { translationStatuses } from '../content/localization.js';
import { serializeCoverComposition } from '../content/cover-composition.js';
import { serializeCoverArt } from '../content/edition-cover-art.js';
import { serializeCoverTypography } from '../content/note-cover-typography.js';
import { serializeCommentEmailDelivery } from './comment-moderation.js';

export type DashboardSection = 'all' | 'editions' | 'notes' | 'resources' | 'categories' | 'contacts' | 'comments' | 'users' | 'logs' | 'analytics';

export async function getDashboard(prisma: PrismaClient, input: {
  page: number;
  pageSize: number;
  section: DashboardSection;
  role: UserRole;
  status?: string;
  search?: string;
  from: Date;
}) {
  const window = pageWindow(input.page, input.pageSize);
  const normalizedStatus = input.status?.toUpperCase();
  const editorialStatuses = new Set(['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED', 'DELETED']);
  const commentStatuses = new Set(['PENDING', 'VISIBLE', 'HIDDEN', 'REPORTED', 'DELETED']);
  const editorialStatus = normalizedStatus && editorialStatuses.has(normalizedStatus) ? normalizedStatus as never : undefined;
  const commentStatus = normalizedStatus && commentStatuses.has(normalizedStatus) ? normalizedStatus as never : undefined;
  const contains = input.search ? { contains: input.search, mode: 'insensitive' as const } : undefined;
  const editionWhere = { ...(editorialStatus ? { status: editorialStatus } : {}), ...(contains ? { OR: [{ title: contains }, { subtitle: contains }, { summary: contains }] } : {}) };
  const noteWhere = { ...(editorialStatus ? { status: editorialStatus } : {}), ...(contains ? { OR: [{ title: contains }, { excerpt: contains }, { authorName: contains }] } : {}) };
  const resourceWhere = { ...(editorialStatus ? { status: editorialStatus } : {}), ...(contains ? { OR: [{ name: contains }, { alt: contains }, { credit: contains }] } : {}) };
  const categoryWhere = contains ? { OR: [{ name: contains }, { description: contains }] } : {};
  const contactWhere = contains ? { OR: [{ name: contains }, { email: contains }, { subject: contains }, { body: contains }] } : {};
  const commentWhere = { ...(commentStatus ? { status: commentStatus } : {}), ...(contains ? { OR: [{ authorName: contains }, { body: contains }, { moderationNote: contains }] } : {}) };
  const userWhere = contains ? { OR: [{ displayName: contains }, { email: contains }] } : {};
  const logWhere = contains ? { action: contains } : {};
  const load = (section: Exclude<DashboardSection, 'all'>) => isAllowed(input.role, section) && (input.section === 'all' || input.section === section);

  const [
    editions, editionTotal, notes, noteTotal, resources, resourceTotal, categories, categoryTotal,
    contacts, contactTotal, comments, commentTotal, users, userTotal, logs, logTotal, analytics,
  ] = await Promise.all([
    load('editions') ? prisma.edition.findMany({ where: editionWhere, ...window, orderBy: { updatedAt: 'desc' }, include: { coverResource: true, notes: { select: { id: true } } } }) : [],
    load('editions') ? prisma.edition.count({ where: editionWhere }) : 0,
    load('notes') ? prisma.note.findMany({ where: noteWhere, ...window, orderBy: { updatedAt: 'desc' }, include: {
      categories: { include: { category: true } }, resources: { select: { resourceId: true } }, ratings: { select: { score: true } },
      _count: { select: { analyticsEvents: { where: { type: 'PAGE_VIEW' } } } },
    } }) : [],
    load('notes') ? prisma.note.count({ where: noteWhere }) : 0,
    load('resources') ? prisma.resource.findMany({ where: resourceWhere, ...window, orderBy: { createdAt: 'desc' } }) : [],
    load('resources') ? prisma.resource.count({ where: resourceWhere }) : 0,
    load('categories') ? prisma.category.findMany({ where: categoryWhere, ...window, orderBy: { name: 'asc' }, include: { _count: { select: { notes: true } } } }) : [],
    load('categories') ? prisma.category.count({ where: categoryWhere }) : 0,
    load('contacts') ? prisma.contactMessage.findMany({ where: contactWhere, ...window, orderBy: { receivedAt: 'desc' }, include: { replies: { orderBy: { updatedAt: 'desc' }, take: 1 } } }) : [],
    load('contacts') ? prisma.contactMessage.count({ where: contactWhere }) : 0,
    load('comments') ? prisma.comment.findMany({ where: commentWhere, ...window, orderBy: { createdAt: 'desc' }, include: { note: { select: { slug: true, title: true } }, moderatedBy: { select: { displayName: true } }, _count: { select: { reports: true, votes: true } } } }) : [],
    load('comments') ? prisma.comment.count({ where: commentWhere }) : 0,
    load('users') ? prisma.user.findMany({ where: userWhere, ...window, orderBy: { createdAt: 'desc' }, include: { _count: { select: { comments: true, savedNotes: true } } } }) : [],
    load('users') ? prisma.user.count({ where: userWhere }) : 0,
    load('logs') ? prisma.adminLog.findMany({ where: logWhere, ...window, orderBy: { createdAt: 'desc' }, include: { actor: { select: { displayName: true } } } }) : [],
    load('logs') ? prisma.adminLog.count({ where: logWhere }) : 0,
    load('analytics') ? buildDashboardAnalytics(prisma, input.from) : emptyAnalytics(),
  ]);

  const meta = (total: number) => paginationMeta(input.page, input.pageSize, total);
  return {
    editions: editions.map(edition => ({
      id: edition.id,
      number: edition.number == null ? '' : String(edition.number).padStart(2, '0'),
      slug: edition.slug,
      title: edition.title,
      subtitle: edition.subtitle ?? '',
      date: edition.dateLabel,
      status: edition.status.toLowerCase(),
      cover: edition.coverResource?.url ?? '',
      coverArt: serializeCoverArt(edition.coverArt),
      noteIds: edition.notes.map(note => note.id),
      translations: edition.localizedContent,
      translationStatus: translationStatuses(edition.localizedContent),
      createdAt: edition.createdAt.toISOString(),
      updatedAt: edition.updatedAt.toISOString(),
    })),
    notes: notes.map(note => {
      const scores = note.ratings.map(item => item.score);
      return {
        id: note.id,
        slug: note.slug,
        title: note.title,
        excerpt: note.excerpt,
        body: note.bodyMarkdown,
        status: note.status.toLowerCase(),
        editionId: note.editionId,
        categoryIds: note.categories.map(item => item.category.slug),
        resourceIds: note.resources.map(item => item.resourceId),
        author: note.authorName,
        rating: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : 0,
        ratingsCount: scores.length,
        views: note._count.analyticsEvents,
        readingMinutes: note.readingMinutes,
        ...serializeCoverComposition(note),
        ...serializeCoverMetadata(note),
        coverTypography: serializeCoverTypography(note.coverTypography),
        translations: note.localizedContent,
        translationStatus: translationStatuses(note.localizedContent),
        updatedAt: note.updatedAt.toISOString(),
      };
    }),
    resources: resources.map(resource => serializeResource(resource, 'es', true)),
    categories: categories.map(category => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      color: category.color,
      description: category.description,
      status: category.status.toLowerCase(),
      notesCount: category._count.notes,
      translations: category.localizedContent,
      translationStatus: translationStatuses(category.localizedContent),
    })),
    contacts: contacts.map(contact => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      subject: contact.subject,
      body: contact.body,
      status: contact.status.toLowerCase(),
      receivedAt: contact.receivedAt.toISOString(),
      reply: contact.replies[0]?.body ?? '',
      replyStatus: contact.replies[0]?.status.toLowerCase() ?? null,
      sentAt: contact.replies[0]?.sentAt?.toISOString() ?? null,
    })),
    comments: comments.map(comment => ({
      id: comment.id,
      parentId: comment.parentId,
      noteId: comment.note.slug,
      noteTitle: comment.note.title,
      author: comment.authorName,
      isAnonymous: comment.userId === null,
      authorType: comment.userId === null ? 'anonymous' : 'account',
      body: comment.body,
      status: comment.status.toLowerCase(),
      moderationReason: comment.moderationNote,
      moderatedAt: comment.moderatedAt?.toISOString() ?? null,
      moderatedBy: comment.moderatedBy?.displayName ?? null,
      deletedAt: comment.deletedAt?.toISOString() ?? null,
      emailDelivery: serializeCommentEmailDelivery(comment),
      createdAt: comment.createdAt.toISOString(),
      reports: comment._count.reports,
      votes: comment._count.votes,
    })),
    users: users.map(user => ({
      id: user.id,
      name: user.displayName,
      email: user.email,
      role: user.role.toLowerCase(),
      status: user.status.toLowerCase(),
      joinedAt: user.createdAt.toISOString(),
      comments: user._count.comments,
      saved: user._count.savedNotes,
    })),
    analytics,
    logs: logs.map(log => ({
      id: log.id,
      at: log.createdAt.toISOString(),
      level: log.level.toLowerCase(),
      actor: log.actor?.displayName ?? 'Sistema',
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      requestId: log.requestId,
      metadata: log.metadata,
    })),
    pagination: {
      editions: meta(editionTotal),
      notes: meta(noteTotal),
      resources: meta(resourceTotal),
      categories: meta(categoryTotal),
      contacts: meta(contactTotal),
      comments: meta(commentTotal),
      users: meta(userTotal),
      logs: meta(logTotal),
    },
    filters: {
      section: input.section,
      status: input.status ?? null,
      search: input.search ?? null,
      from: input.from.toISOString(),
    },
  };
}

export function isAllowed(role: UserRole, section: Exclude<DashboardSection, 'all'>) {
  if (role === 'ADMIN') return true;
  if (role === 'EDITOR') return ['editions', 'notes', 'resources', 'categories', 'analytics'].includes(section);
  if (role === 'MODERATOR') return ['contacts', 'comments'].includes(section);
  return false;
}

function emptyAnalytics() {
  return {
    summary: { visits: 0, uniqueReaders: 0, completedReads: 0, avgReadingSeconds: 0, downloads: 0, comments: 0, ratings: 0, avgRating: 0 },
    timeline: [],
    topNotes: [],
    attention: [
      { label: 'Inicio', value: 0 },
      { label: 'Primer tercio', value: 0 },
      { label: 'Segundo tercio', value: 0 },
      { label: 'Final', value: 0 },
    ],
    sources: [],
  };
}
