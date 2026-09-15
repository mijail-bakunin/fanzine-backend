export const COVER_CANVAS = Object.freeze({
  width: 1_055,
  height: 1_492,
  mastheadHeight: 440,
});

export const DEFAULT_COVER_COMPOSITION = Object.freeze({
  x: 0,
  y: COVER_CANVAS.mastheadHeight,
  w: 240,
  h: 320,
});

export type CoverCompositionSource = {
  slug: string;
  fragment: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  tone: string;
  sortOrder: number;
  editionLink: boolean;
};

export type CoverCompositionPatch = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export function serializeCoverComposition(note: CoverCompositionSource) {
  return {
    fragment: note.fragment ?? note.slug,
    x: note.x ?? DEFAULT_COVER_COMPOSITION.x,
    y: note.y ?? DEFAULT_COVER_COMPOSITION.y,
    w: note.width ?? DEFAULT_COVER_COMPOSITION.w,
    h: note.height ?? DEFAULT_COVER_COMPOSITION.h,
    tone: note.tone,
    sortOrder: note.sortOrder,
    editionLink: note.editionLink,
  };
}

export function resolveCoverRectangle(input: CoverCompositionPatch, current?: Partial<CoverCompositionSource>) {
  return {
    x: input.x ?? current?.x ?? DEFAULT_COVER_COMPOSITION.x,
    y: input.y ?? current?.y ?? DEFAULT_COVER_COMPOSITION.y,
    w: input.w ?? current?.width ?? DEFAULT_COVER_COMPOSITION.w,
    h: input.h ?? current?.height ?? DEFAULT_COVER_COMPOSITION.h,
  };
}

export function coverRectangleErrors(rectangle: ReturnType<typeof resolveCoverRectangle>) {
  const errors: Record<string, string[]> = {};
  if (rectangle.x + rectangle.w > COVER_CANVAS.width) {
    errors.w = [`El rectángulo supera el ancho del lienzo (${COVER_CANVAS.width}).`];
  }
  if (rectangle.y + rectangle.h > COVER_CANVAS.height) {
    errors.h = [`El rectángulo supera el alto del lienzo (${COVER_CANVAS.height}).`];
  }
  return errors;
}
