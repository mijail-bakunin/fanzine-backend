import type { CommentEmailStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';

export const DEFAULT_COMMENT_REMOVAL_REASON = 'El comentario fue eliminado porque incumple las pautas comunitarias de participación.';

export function serializeCommentEmailDelivery(comment: {
  moderationEmailStatus: CommentEmailStatus | null;
  moderationEmailMessageId: string | null;
  moderationEmailError: string | null;
}) {
  if (!comment.moderationEmailStatus) return null;
  return {
    status: comment.moderationEmailStatus.toLowerCase(),
    messageId: comment.moderationEmailMessageId,
    error: comment.moderationEmailError,
  };
}

export function safeModerationMailError(error: unknown) {
  if (error instanceof AppError) return error.code;
  return 'MAIL_DELIVERY_FAILED';
}
