import { describe, expect, it } from 'vitest';
import { seedNoteTeasers } from '../prisma/seed-note-teasers.js';

const locales = ['es', 'en', 'ru'] as const;

describe('bajadas editoriales del seed', () => {
  it('cubre las dieciséis notas publicadas en los tres idiomas', () => {
    expect(Object.keys(seedNoteTeasers)).toHaveLength(16);
    for (const variants of Object.values(seedNoteTeasers)) {
      expect(Object.keys(variants).sort()).toEqual([...locales].sort());
    }
  });

  it.each(locales)('mantiene coverExcerpt entre 120 y 220 caracteres en %s', locale => {
    for (const variants of Object.values(seedNoteTeasers)) {
      expect(variants[locale].coverExcerpt.length).toBeGreaterThanOrEqual(120);
      expect(variants[locale].coverExcerpt.length).toBeLessThanOrEqual(220);
    }
  });

  it.each(locales)('usa una invitación breve y distinta de la bajada en %s', locale => {
    for (const variants of Object.values(seedNoteTeasers)) {
      const { coverExcerpt, readMoreSubtitle } = variants[locale];
      expect(readMoreSubtitle.length).toBeGreaterThanOrEqual(20);
      expect(readMoreSubtitle.length).toBeLessThanOrEqual(90);
      expect(readMoreSubtitle).not.toBe(coverExcerpt);
    }
  });

  it.each(locales)('enumera al menos seis temas naturales en contents (%s)', locale => {
    const topics = seedNoteTeasers.contents[locale].coverExcerpt.split(/[,;]/);
    expect(topics.length).toBeGreaterThanOrEqual(6);
  });
});
