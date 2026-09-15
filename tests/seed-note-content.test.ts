import { describe, expect, it } from 'vitest';
import {
  completeSeedBody,
  localizedSeedBody,
  minimumSeedParagraphs,
  seedBodyMarkdown,
} from '../prisma/seed-note-content.js';

const note = {
  title: 'Cocinas comunes',
  excerpt: 'Comer también es organizarnos',
  tags: ['apoyo mutuo', 'cuidados'],
  paragraphs: ['Párrafo original uno.', 'Párrafo original dos.'],
};

describe('contenido editorial del seed', () => {
  it('conserva el contenido original y completa al menos cinco párrafos contextuales en español', () => {
    const paragraphs = completeSeedBody(note);
    expect(paragraphs).toHaveLength(minimumSeedParagraphs);
    expect(paragraphs.slice(0, 2)).toEqual(note.paragraphs);
    expect(paragraphs.join(' ')).toContain(note.title.toLowerCase());
    expect(paragraphs.join(' ')).toContain(note.tags.join(', '));
  });

  it.each(['en', 'ru'] as const)('produce cinco párrafos editoriales deterministas para %s', locale => {
    const paragraphs = localizedSeedBody(locale, note.title, note.excerpt);
    expect(paragraphs).toHaveLength(minimumSeedParagraphs);
    expect(paragraphs.every(paragraph => paragraph.trim().length > 80)).toBe(true);
    expect(localizedSeedBody(locale, note.title, note.excerpt)).toEqual(paragraphs);
  });

  it('genera bodyMarkdown desde los mismos párrafos sin pérdida ni reordenamiento', () => {
    const paragraphs = completeSeedBody(note);
    const markdown = seedBodyMarkdown(paragraphs);
    expect(markdown.split(/\n\n/)).toEqual(paragraphs);
  });
});
