import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation.js';
import { publicLocaleSchema } from '../content/localization.js';
import { simulateAssistantReply } from './assistant.service.js';

const assistantMessageSchema = z.object({
  message: z.string().trim().min(1).max(1_000),
  locale: publicLocaleSchema,
  conversationId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'conversationId sólo admite letras, números, guion y guion bajo.').nullable().optional(),
}).strict();

export const assistantRoutes: FastifyPluginAsync = async app => {
  app.post('/assistant/messages', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const input = parse(assistantMessageSchema, request.body);
    return {
      conversationId: input.conversationId ?? randomUUID(),
      reply: {
        id: randomUUID(),
        role: 'assistant' as const,
        text: simulateAssistantReply(input.message, input.locale),
        createdAt: new Date().toISOString(),
      },
      requestId: request.id,
    };
  });
};
