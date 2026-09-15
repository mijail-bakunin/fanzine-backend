import { z } from 'zod';

export const COVER_ART_CANVAS = Object.freeze({ width: 1_055, height: 1_492 });
export const COVER_ART_PRESETS = ['archive', 'riot', 'night', 'signal', 'ash'] as const;
export const COVER_ART_ELEMENT_TYPES = ['tape', 'staples', 'coffee', 'burn', 'stamp', 'brush'] as const;
export const COVER_ART_TONES = ['paper', 'red', 'yellow', 'cyan', 'lime', 'ink'] as const;

const coverArtElementSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'El id sólo admite letras, números, guion y guion bajo.'),
  type: z.enum(COVER_ART_ELEMENT_TYPES),
  tone: z.enum(COVER_ART_TONES),
  x: z.number().int().min(0).max(COVER_ART_CANVAS.width - 1),
  y: z.number().int().min(0).max(COVER_ART_CANVAS.height - 1),
  w: z.number().int().min(1).max(COVER_ART_CANVAS.width),
  h: z.number().int().min(1).max(COVER_ART_CANVAS.height),
  rotation: z.number().int().min(-30).max(30),
  depth: z.number().int().min(0).max(100),
}).strict().superRefine((element, context) => {
  if (element.x + element.w > COVER_ART_CANVAS.width) {
    context.addIssue({ code: 'custom', path: ['w'], message: `x + w no puede superar ${COVER_ART_CANVAS.width}.` });
  }
  if (element.y + element.h > COVER_ART_CANVAS.height) {
    context.addIssue({ code: 'custom', path: ['h'], message: `y + h no puede superar ${COVER_ART_CANVAS.height}.` });
  }
});

const coverArtShape = {
  preset: z.enum(COVER_ART_PRESETS),
  elements: z.array(coverArtElementSchema).max(12),
};

function assertUniqueElementIds(elements: Array<{ id: string }>, context: z.RefinementCtx) {
  const seen = new Set<string>();
  elements.forEach((element, index) => {
    if (seen.has(element.id)) {
      context.addIssue({ code: 'custom', path: ['elements', index, 'id'], message: 'Los ids de los elementos deben ser únicos dentro de la edición.' });
    }
    seen.add(element.id);
  });
}

export const coverArtSchema = z.object(coverArtShape).strict().superRefine((coverArt, context) => {
  assertUniqueElementIds(coverArt.elements, context);
});

export const coverArtPatchSchema = z.object({
  preset: coverArtShape.preset.optional(),
  elements: coverArtShape.elements.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'coverArt no puede estar vacío.').superRefine((coverArt, context) => {
  if (coverArt.elements) assertUniqueElementIds(coverArt.elements, context);
});

export type CoverArt = z.infer<typeof coverArtSchema>;
export type CoverArtPatch = z.infer<typeof coverArtPatchSchema>;

export const DEFAULT_COVER_ART: CoverArt = Object.freeze({ preset: 'archive', elements: [] });

export function serializeCoverArt(value: unknown): CoverArt {
  const result = coverArtSchema.safeParse(value);
  return result.success ? result.data : { preset: DEFAULT_COVER_ART.preset, elements: [] };
}

export function mergeCoverArt(current: unknown, patch: CoverArtPatch): CoverArt {
  return coverArtSchema.parse({ ...serializeCoverArt(current), ...patch });
}
