import { readFile } from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { localizedString, resolveEditorialTranslation, type PublicLocale } from './localization.js';
import { paragraphsFromMarkdown } from './serializers.js';

type PdfEdition = Awaited<ReturnType<typeof loadPdfEdition>>;
type PdfNote = NonNullable<PdfEdition>['notes'][number];

const labels = {
  es: { contents: 'ÍNDICE', backToContents: 'VOLVER AL ÍNDICE', note: 'NOTA', by: 'Por', edition: 'Edición', generated: 'Edición digital exportada desde La Guillotina' },
  en: { contents: 'CONTENTS', backToContents: 'BACK TO CONTENTS', note: 'ARTICLE', by: 'By', edition: 'Issue', generated: 'Digital edition exported from La Guillotina' },
  ru: { contents: 'СОДЕРЖАНИЕ', backToContents: 'К СОДЕРЖАНИЮ', note: 'МАТЕРИАЛ', by: 'Автор', edition: 'Выпуск', generated: 'Цифровой выпуск La Guillotina' },
} satisfies Record<PublicLocale, Record<string, string>>;

const fontRegular = path.resolve('node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf');
const fontBold = path.resolve('node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf');

export async function buildEditionPdf(prisma: PrismaClient, config: AppConfig, slug: string, locale: PublicLocale) {
  const edition = await loadPdfEdition(prisma, slug);
  if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición publicada.');
  const localizedEdition = resolveEditorialTranslation(edition.localizedContent, locale).record;
  const title = localizedString(localizedEdition, 'title', edition.title)!;
  const subtitle = localizedString(localizedEdition, 'subtitle', edition.subtitle);
  const publication = localizedString(localizedEdition, 'publication', edition.publication)!;
  const headerLine = localizedString(localizedEdition, 'headerLine', edition.headerLine)!;
  const dateLabel = localizedString(localizedEdition, 'dateLabel', edition.dateLabel)!;
  const author = localizedString(localizedEdition, 'author', edition.author ?? publication)!;
  const summary = localizedString(localizedEdition, 'summary', edition.summary);
  const cover = edition.coverResource ? await loadImage(edition.coverResource, config) : null;
  const document = new PDFDocument({ size: 'A4', margins: { top: 54, right: 54, bottom: 54, left: 54 }, bufferPages: true, info: {
    Title: `${title} - ${publication}`, Author: author,
    Subject: subtitle ?? summary ?? labels[locale].generated, Keywords: edition.notes.flatMap(note => note.categories.map(item => item.category.name)).join(', '),
  } });
  document.registerFont('Body', fontRegular);
  document.registerFont('BodyBold', fontBold);
  const chunks: Buffer[] = [];
  document.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });

  drawCover(document, edition, { title, subtitle, headerLine, dateLabel }, cover, locale);
  drawContents(document, edition.notes, locale);
  for (const [index, note] of edition.notes.entries()) drawNote(document, note, index, locale);
  addPageNumbers(document, publication);
  document.end();
  return { buffer: await completed, fileName: `${safeFileName(edition.slug)}-${locale}.pdf`, editionId: edition.id, slug: edition.slug, noteCount: edition.notes.length };
}

async function loadPdfEdition(prisma: PrismaClient, slug: string) {
  return prisma.edition.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: {
      coverResource: true,
      notes: {
        where: { status: 'PUBLISHED' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { categories: { include: { category: true } } },
      },
    },
  });
}

async function loadImage(resource: NonNullable<PdfEdition>['coverResource'], config: AppConfig) {
  if (!resource || resource.status !== 'PUBLISHED' || resource.uploadStatus !== 'COMPLETE') return null;
  try {
    let bytes: Buffer;
    if (resource.storageDriver === 'LOCAL' && resource.objectKey) {
      bytes = await readFile(path.resolve(config.localStoragePath, resource.objectKey));
    } else {
      const response = await fetch(resource.url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    return await sharp(bytes).jpeg({ quality: 88 }).toBuffer();
  } catch {
    return null;
  }
}

function drawCover(document: PDFKit.PDFDocument, edition: NonNullable<PdfEdition>, content: { title: string; subtitle: string | null; headerLine: string; dateLabel: string }, image: Buffer | null, locale: PublicLocale) {
  const { title, subtitle, headerLine, dateLabel } = content;
  const width = document.page.width;
  const height = document.page.height;
  if (image) document.image(image, 0, 0, { cover: [width, height], align: 'center', valign: 'center' });
  else document.rect(0, 0, width, height).fill('#141312');
  document.save().rect(0, 0, width, height).fillColor('#000000').opacity(image ? 0.58 : 0.15).fill().restore();
  document.fillColor('#f3f0e8').font('BodyBold').fontSize(12).text(headerLine, 54, 54, { width: width - 108, characterSpacing: 1.2 });
  document.fontSize(46).text(title.toUpperCase(), 54, 250, { width: width - 108, lineGap: 2 });
  if (subtitle) document.font('Body').fontSize(17).text(subtitle, 56, document.y + 18, { width: width - 112, lineGap: 4 });
  const number = edition.number == null ? '' : `${labels[locale].edition} ${edition.number}`;
  document.font('BodyBold').fontSize(12).text([number, dateLabel].filter(Boolean).join(' · '), 56, height - 82, { width: width - 112 });
  document.outline.addItem(title, { pageNumber: 0, fit: true } as PDFOutlineOptions);
}

function drawContents(document: PDFKit.PDFDocument, notes: PdfNote[], locale: PublicLocale) {
  document.addPage();
  document.addNamedDestination('contents', 'Fit');
  document.outline.addItem(labels[locale].contents, { pageNumber: 1, fit: true } as PDFOutlineOptions);
  document.fillColor('#111111').font('BodyBold').fontSize(30).text(labels[locale].contents, 54, 62);
  document.moveTo(54, 108).lineTo(document.page.width - 54, 108).lineWidth(2).stroke('#d8202f');
  let y = 135;
  notes.forEach((note, index) => {
    const localized = resolveEditorialTranslation(note.localizedContent, locale).record;
    const title = localizedString(localized, 'title', note.title)!;
    const target = destinationFor(note.slug);
    if (y > document.page.height - 90) { document.addPage(); y = 62; }
    document.fillColor('#d8202f').font('BodyBold').fontSize(10).text(String(index + 1).padStart(2, '0'), 54, y, { width: 28, goTo: target });
    document.fillColor('#111111').fontSize(15).text(title, 92, y - 2, { width: document.page.width - 146, goTo: target, underline: true });
    y = Math.max(document.y, y + 25) + 12;
  });
}

function drawNote(document: PDFKit.PDFDocument, note: PdfNote, index: number, locale: PublicLocale) {
  const localized = resolveEditorialTranslation(note.localizedContent, locale).record;
  const title = localizedString(localized, 'title', note.title)!;
  const excerpt = localizedString(localized, 'excerpt', note.excerpt)!;
  const body = localizedString(localized, 'bodyMarkdown', note.bodyMarkdown)!;
  const author = localizedString(localized, 'authorName', note.authorName)!;
  document.addPage();
  const pageNumber = document.bufferedPageRange().count - 1;
  const target = destinationFor(note.slug);
  document.addNamedDestination(target, 'FitH', document.page.height - 54);
  document.outline.addItem(title, { pageNumber, fit: true } as PDFOutlineOptions);
  document.fillColor('#d8202f').font('BodyBold').fontSize(10).text(`${labels[locale].note} ${String(index + 1).padStart(2, '0')}`, 54, 55, { characterSpacing: 1.1 });
  document.fillColor('#111111').fontSize(29).text(title, 54, 78, { width: document.page.width - 108, lineGap: 2 });
  document.fillColor('#4a4743').font('Body').fontSize(15).text(excerpt, 54, document.y + 12, { width: document.page.width - 108, lineGap: 4 });
  document.fillColor('#77716b').fontSize(9).text(`${labels[locale].by} ${author} · ${note.readingMinutes} min`, 54, document.y + 13);
  document.moveTo(54, document.y + 16).lineTo(document.page.width - 54, document.y + 16).lineWidth(1).stroke('#b5afa7');
  document.y += 35;
  for (const paragraph of paragraphsFromMarkdown(body)) {
    document.fillColor('#1c1b19').font('Body').fontSize(11.5).text(cleanMarkdown(paragraph), { width: document.page.width - 108, align: 'justify', lineGap: 4 });
    document.moveDown(0.8);
  }
  document.fontSize(8).fillColor('#d8202f').text(labels[locale].backToContents, 54, footerY(document), { goTo: 'contents', underline: true, width: 150, lineBreak: false });
}

function addPageNumbers(document: PDFKit.PDFDocument, publication: string) {
  const range = document.bufferedPageRange();
  for (let index = 1; index < range.count; index += 1) {
    document.switchToPage(index);
    document.font('Body').fontSize(8).fillColor('#77716b').text(`${publication} · ${index}`, 54, footerY(document), { width: document.page.width - 108, align: 'right', lineBreak: false });
  }
}

function destinationFor(slug: string) { return `note-${slug.replace(/[^a-z0-9_-]/gi, '-')}`; }
function safeFileName(value: string) { return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'edicion'; }
function cleanMarkdown(value: string) { return value.replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1'); }
function footerY(document: PDFKit.PDFDocument) { return document.page.height - document.page.margins.bottom - 16; }

type PDFOutlineOptions = Parameters<PDFKit.PDFOutline['addItem']>[1] & { pageNumber: number; fit: boolean };
