import { describe, expect, it } from 'vitest';
import { mediaImages, noteMedia, seedImageUrl } from '../prisma/seed-note-media.js';

const publishedNoteSlugs = [
  'cat', 'freedom', 'uprising', 'wall', 'why', 'memory', 'contents', 'quote',
  'kitchens', 'posters', 'seeds', 'street-choir', 'care', 'press', 'living-archive', 'affection-map',
];

describe('medios editoriales del seed', () => {
  it('asigna al menos una imagen a cada una de las dieciséis notas publicadas', () => {
    expect(Object.keys(noteMedia).sort()).toEqual([...publishedNoteSlugs].sort());
    for (const slug of publishedNoteSlugs) expect(noteMedia[slug as keyof typeof noteMedia].length).toBeGreaterThan(0);
  });

  it('mantiene todos los vínculos apuntando a fotografías declaradas', () => {
    for (const keys of Object.values(noteMedia)) {
      for (const key of keys) {
        expect(mediaImages[key]).toBeDefined();
        expect(seedImageUrl(key)).toMatch(/^https:\/\/images\.unsplash\.com\/photo-[\w-]+\?/);
      }
    }
  });

  it('usa una fotografía limpia y específica como hero del gato negro', () => {
    expect(noteMedia.cat[0]).toBe('blackCat');
    expect(mediaImages.blackCat[1]).toContain('Gato negro');
    expect(mediaImages.blackCat[1]).not.toMatch(/guillotina|revista|nota/i);
  });
});
