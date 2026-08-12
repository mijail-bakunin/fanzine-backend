import type { PrismaClient } from '../../generated/prisma/client.js';

export async function serializeUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { preference: true, savedNotes: { select: { note: { select: { slug: true } } } } },
  });
  return {
    id: user.id,
    name: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl ?? '',
    role: user.role.toLowerCase(),
    status: user.status.toLowerCase(),
    savedNoteIds: user.savedNotes.map(item => item.note.slug),
    preferences: user.preference ? {
      theme: user.preference.theme,
      locale: user.preference.locale,
      readingSize: user.preference.readingSize,
      readingFont: user.preference.readingFont,
      contrast: user.preference.contrast,
      analyticsOptOut: user.preference.analyticsOptOut,
      expiresAt: user.preference.expiresAt?.getTime(),
      ...(user.preference.extra && typeof user.preference.extra === 'object' ? user.preference.extra : {}),
    } : null,
  };
}
