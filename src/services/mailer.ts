import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';

export async function sendPasswordReset(config: AppConfig, input: { to: string; displayName: string; resetUrl: string }) {
  const subject = 'Recuperar acceso a La Guillotina';
  const text = `Hola ${input.displayName}. Abrí este enlace para cambiar tu contraseña: ${input.resetUrl}`;
  if (config.mail.mode === 'development') {
    return writeDevelopmentMail(config, { kind: 'password_reset', to: input.to, subject, text });
  }

  const { transport, from } = smtpTransport(config);
  const result = await transport.sendMail({ from, to: input.to, subject, text });
  return { messageId: result.messageId, mode: 'smtp' as const };
}

export async function sendContactReply(config: AppConfig, input: {
  to: string;
  contactName: string;
  originalSubject: string;
  body: string;
}) {
  const subject = /^re:/i.test(input.originalSubject) ? input.originalSubject : `Re: ${input.originalSubject}`;
  const text = `Hola ${input.contactName},\n\n${input.body}\n\nLa Guillotina`;
  if (config.mail.mode === 'development') {
    return writeDevelopmentMail(config, { kind: 'contact_reply', to: input.to, subject, text });
  }
  const { transport, from } = smtpTransport(config);
  const result = await transport.sendMail({ from, to: input.to, subject, text });
  return { messageId: result.messageId, mode: 'smtp' as const };
}

export async function sendCommentRemoval(config: AppConfig, input: {
  to: string;
  displayName: string;
  reason: string;
  imageUrl?: string;
}) {
  const subject = 'Aviso de moderación de un comentario';
  const text = `Hola ${input.displayName},\n\nUn comentario asociado a tu cuenta fue eliminado.\n\nMotivo: ${input.reason}\n\nLa Guillotina`;
  const imageUrl = input.imageUrl ?? config.mail.moderationImageUrl;
  const html = `<div style="margin:0 auto;max-width:720px;background:#f3f0e8;color:#171513;font-family:Arial,sans-serif">`
    + `<img src="${escapeHtml(imageUrl)}" alt="Mesa de imprenta comunitaria" style="display:block;width:100%;height:auto">`
    + `<div style="padding:28px"><h1 style="font-size:24px;margin:0 0 18px">Aviso de moderación</h1>`
    + `<p>Hola ${escapeHtml(input.displayName)},</p><p>Un comentario asociado a tu cuenta fue eliminado.</p>`
    + `<p><strong>Motivo:</strong> ${escapeHtml(input.reason)}</p><p>La Guillotina</p></div></div>`;
  if (config.mail.mode === 'development') {
    return writeDevelopmentMail(config, { kind: 'comment_removal', to: input.to, subject, text, html, imageUrl });
  }
  const { transport, from } = smtpTransport(config);
  const result = await transport.sendMail({ from, to: input.to, subject, text, html });
  return { messageId: result.messageId, mode: 'smtp' as const };
}

function smtpTransport(config: AppConfig) {
  const { smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom } = config.mail;
  if (!smtpHost || !smtpUser || !smtpPassword || !smtpFrom) {
    throw new AppError(503, 'MAIL_NOT_CONFIGURED', 'El servicio de correo todavía no está configurado.');
  }
  return {
    from: smtpFrom,
    transport: nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPassword },
    }),
  };
}

async function writeDevelopmentMail(config: AppConfig, input: {
  kind: 'password_reset' | 'contact_reply' | 'comment_removal';
  to: string;
  subject: string;
  text: string;
  html?: string;
  imageUrl?: string;
}) {
  const directory = path.resolve(config.mail.developmentMailboxPath);
  await mkdir(directory, { recursive: true });
  const messageId = `${Date.now()}-${randomToken(6)}`;
  await writeFile(path.join(directory, `${messageId}.json`), JSON.stringify({
    messageId,
    ...input,
    createdAt: new Date().toISOString(),
  }, null, 2), { encoding: 'utf8', flag: 'wx' });
  return { messageId, mode: 'development' as const };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
