import { z } from 'zod';

export const publicLocaleSchema = z.enum(['es', 'en', 'ru']).default('es');
export type PublicLocale = z.infer<typeof publicLocaleSchema>;
export const editorialTranslationStatusSchema = z.enum(['draft', 'review', 'published']);
export type EditorialTranslationStatus = z.infer<typeof editorialTranslationStatusSchema>;

type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value !== null && !Array.isArray(value) && typeof value === 'object' ? value as JsonRecord : {};
}

export function localizedRecord(value: unknown, locale: PublicLocale): JsonRecord {
  const locales = asRecord(value);
  return asRecord(locales[locale] ?? locales.es);
}

export function resolveEditorialTranslation(value: unknown, requestedLocale: PublicLocale) {
  const locales = asRecord(value);
  const requested = asRecord(locales[requestedLocale]);
  const requestedStatus = requested.status;
  const canPublishRequested = Object.keys(requested).length > 0 && (requestedStatus === undefined || requestedStatus === 'published');
  if (canPublishRequested) {
    return { record: requested, locale: requestedLocale, requestedLocale, translationFallback: false } as const;
  }
  const spanish = asRecord(locales.es);
  const spanishStatus = spanish.status;
  const publishedSpanish = Object.keys(spanish).length > 0 && (spanishStatus === undefined || spanishStatus === 'published') ? spanish : {};
  return {
    record: requestedLocale === 'es' ? {} : publishedSpanish,
    locale: 'es' as const,
    requestedLocale,
    translationFallback: requestedLocale !== 'es',
  };
}

export function localizedString(record: JsonRecord, key: string, fallback: string | null): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

export function localizedStringArray(record: JsonRecord, key: string, fallback: string[]): string[] {
  const value = record[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : fallback;
}

const translationHttpUrl = z.string().url().max(2_000).refine(value => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'La URL debe usar HTTP o HTTPS.');
const optionalTranslationText = (max: number) => z.string().trim().max(max).optional();
const requirePublishedFields = (fields: string[]) => (value: Record<string, unknown>, context: z.RefinementCtx) => {
  if (value.status !== 'published') return;
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      context.addIssue({ code: 'custom', path: [field], message: `La traducción publicada requiere ${field}.` });
    }
  }
};

export const mastheadTranslationSchema = z.object({
  image: translationHttpUrl,
  referenceImage: translationHttpUrl.optional(),
  alt: z.string().trim().min(2).max(2_000),
}).strict();

export const editionTranslationSchema = z.object({
  status: editorialTranslationStatusSchema.default('draft'),
  title: optionalTranslationText(180), subtitle: optionalTranslationText(240), date: optionalTranslationText(80),
  theme: optionalTranslationText(240), summary: optionalTranslationText(2_000), author: optionalTranslationText(120),
  publication: optionalTranslationText(120), headerLine: optionalTranslationText(240),
  masthead: mastheadTranslationSchema.optional(),
}).strict().superRefine((value, context) => {
  requirePublishedFields(['title', 'date', 'publication', 'headerLine'])(value, context);
  if (value.status === 'published' && !value.masthead) context.addIssue({ code: 'custom', path: ['masthead'], message: 'La traducción publicada requiere su imagen y texto alternativo de masthead.' });
});

export const noteTranslationSchema = z.object({
  status: editorialTranslationStatusSchema.default('draft'),
  title: optionalTranslationText(240), subtitle: optionalTranslationText(1_000), summary: optionalTranslationText(2_000),
  excerpt: optionalTranslationText(1_000), body: optionalTranslationText(500_000), thumbnailText: optionalTranslationText(1_000),
  author: optionalTranslationText(120), readMoreLabel: optionalTranslationText(40), readMoreSubtitle: optionalTranslationText(240),
  coverTitleLines: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  coverExcerpt: z.string().trim().max(2_000).nullable().optional(),
}).strict().superRefine((value, context) => requirePublishedFields([
  'title', 'subtitle', 'summary', 'excerpt', 'body', 'thumbnailText', 'author', 'readMoreLabel',
])(value, context));

export const resourceTranslationSchema = z.object({
  status: editorialTranslationStatusSchema.default('draft'),
  name: optionalTranslationText(240), title: optionalTranslationText(240), alt: optionalTranslationText(2_000),
  caption: optionalTranslationText(2_000), credit: optionalTranslationText(500), license: optionalTranslationText(500),
}).strict().superRefine((value, context) => requirePublishedFields(['name', 'alt', 'caption', 'credit', 'license'])(value, context));

export const categoryTranslationSchema = z.object({
  status: editorialTranslationStatusSchema.default('draft'),
  name: optionalTranslationText(100), description: optionalTranslationText(2_000),
}).strict().superRefine((value, context) => requirePublishedFields(['name', 'description'])(value, context));

export function translationsSchema<T extends z.ZodType>(variant: T) {
  return z.object({ es: variant.optional(), en: variant.optional(), ru: variant.optional() }).strict();
}

export function mergeTranslationRecords(current: unknown, updates: unknown): JsonRecord {
  const merged = { ...asRecord(current) };
  for (const locale of ['es', 'en', 'ru'] as const) {
    const update = asRecord(asRecord(updates)[locale]);
    if (Object.keys(update).length) merged[locale] = { ...asRecord(merged[locale]), ...update };
  }
  return merged;
}

export function translationStatuses(value: unknown) {
  const translations = asRecord(value);
  return Object.fromEntries((['es', 'en', 'ru'] as const).map(locale => {
    const status = asRecord(translations[locale]).status;
    return [locale, typeof status === 'string' ? status : locale === 'es' ? 'published' : 'missing'];
  }));
}

const title = z.object({ main: z.string().trim().min(1).max(180), accent: z.string().trim().min(1).max(180) }).strict();
const navigationItem = z.object({ label: z.string().trim().min(1).max(80), to: z.string().trim().min(1).max(500), sortOrder: z.number().int().min(0).max(1_000) }).strict();
const socialLink = z.object({ label: z.string().trim().min(1).max(80), url: z.string().url().max(2_000), icon: z.string().trim().min(1).max(40).optional() }).strict();
const field = z.object({ label: z.string().trim().min(1).max(100), placeholder: z.string().trim().min(1).max(240) }).strict();

export const publicationContentSchema = z.object({
  brand: z.object({
    name: z.string().trim().min(2).max(120), publicationType: z.string().trim().min(2).max(160),
    statement: z.string().trim().min(2).max(240), headerLine: z.string().trim().min(2).max(240),
  }).strict(),
  navigation: z.array(navigationItem).max(30),
  footer: z.object({ statement: z.string().trim().min(2).max(500), socialPrompt: z.string().trim().min(2).max(160), socialLinks: z.array(socialLink).max(30) }).strict(),
  authentication: z.object({
    triggerLabel: z.string().trim().min(1).max(100), eyebrow: z.string().trim().min(1).max(120), kicker: z.string().trim().min(1).max(180),
    privacyNote: z.string().trim().min(1).max(1_000), localNote: z.string().trim().min(1).max(1_000),
    login: z.object({ title: z.string().trim().min(1).max(180), copy: z.string().trim().min(1).max(1_000), submitLabel: z.string().trim().min(1).max(100) }).strict(),
    register: z.object({ title: z.string().trim().min(1).max(180), copy: z.string().trim().min(1).max(1_000), submitLabel: z.string().trim().min(1).max(100) }).strict(),
  }).strict(),
  archive: z.object({
    eyebrow: z.string().trim().min(1).max(120), title, intro: z.string().trim().min(1).max(1_000),
    magazinesLabel: z.string().trim().min(1).max(80), booksLabel: z.string().trim().min(1).max(80),
    showcaseLabel: z.string().trim().min(1).max(80), multimediaLabel: z.string().trim().min(1).max(80), booksEmpty: z.string().trim().min(1).max(1_000),
  }).strict(),
  pages: z.object({
    about: z.object({ eyebrow: z.string(), title, lead: z.string(), paragraphs: z.array(z.string()).min(1).max(30) }).strict(),
    manifesto: z.object({
      eyebrow: z.string(), title, statements: z.array(z.string()).min(1).max(30),
      items: z.array(z.object({
        id: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
        title: z.string().trim().min(1).max(240),
        paragraphs: z.array(z.string().trim().min(1).max(5_000)).min(2).max(3),
      }).strict()).min(1).max(30).optional(),
    }).strict(),
    collaborate: z.object({
      eyebrow: z.string(), title, lead: z.string(), paragraph: z.string(), actionLabel: z.string(), actionHref: z.string().max(2_000),
      donation: z.object({ eyebrow: z.string().optional(), title: title.optional(), alias: z.string(), label: z.string(), url: z.string().url().max(2_000) }).strict().optional(),
    }).strict(),
    contact: z.object({ eyebrow: z.string(), title, lead: z.string(), form: z.object({ name: field, email: field, message: field, submitLabel: z.string() }).strict() }).strict(),
    help: z.object({ eyebrow: z.string(), title, lead: z.string(), shortcuts: z.array(z.object({ keys: z.string(), label: z.string() }).strict()).min(1).max(30) }).strict(),
    soon: z.object({ eyebrow: z.string(), title, paragraphs: z.array(z.string()).min(1).max(20), actionLabel: z.string(), actionHref: z.string().max(500) }).strict(),
    notFound: z.object({ eyebrow: z.string(), title, copy: z.string(), actionLabel: z.string(), actionHref: z.string().max(500) }).strict(),
  }).strict(),
  assets: z.record(z.string(), z.object({ url: z.string().url().max(2_000), alt: z.string().max(500) }).strict()).default({}),
}).strict();

const seoPage = z.object({ title: z.string().trim().min(1).max(180), description: z.string().trim().min(1).max(500), image: z.object({ url: z.string().url(), alt: z.string() }).strict().nullable().optional(), canonical: z.string().max(500).optional() }).strict();

export const publicationSeoSchema = z.object({
  siteName: z.string().trim().min(2).max(120), defaultTitle: z.string().trim().min(2).max(180), defaultDescription: z.string().trim().min(2).max(500),
  defaultImage: z.object({ url: z.string().url(), alt: z.string() }).strict().nullable(), locale: z.enum(['es', 'en', 'ru']),
  pages: z.record(z.string(), seoPage),
}).strict();

export const contentByLocaleSchema = z.object({
  es: publicationContentSchema,
  en: publicationContentSchema.optional(),
  ru: publicationContentSchema.optional(),
}).strict();

export const seoByLocaleSchema = z.object({
  es: publicationSeoSchema,
  en: publicationSeoSchema.optional(),
  ru: publicationSeoSchema.optional(),
}).strict();
