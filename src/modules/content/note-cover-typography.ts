import { z } from 'zod';

export const COVER_TITLE_SIZES = ['compact', 'standard', 'display'] as const;
export const COVER_TITLE_ALIGNS = ['left', 'center', 'right'] as const;
export const COVER_TITLE_TREATMENTS = ['brush', 'block', 'torn'] as const;
export const COVER_EXCERPT_SIZES = ['compact', 'standard', 'large'] as const;

const coverTypographyShape = {
  titleSize: z.enum(COVER_TITLE_SIZES),
  titleAlign: z.enum(COVER_TITLE_ALIGNS),
  titleTreatment: z.enum(COVER_TITLE_TREATMENTS),
  excerptSize: z.enum(COVER_EXCERPT_SIZES),
};

export const coverTypographySchema = z.object(coverTypographyShape).strict();

export const coverTypographyPatchSchema = z.object({
  titleSize: coverTypographyShape.titleSize.optional(),
  titleAlign: coverTypographyShape.titleAlign.optional(),
  titleTreatment: coverTypographyShape.titleTreatment.optional(),
  excerptSize: coverTypographyShape.excerptSize.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'coverTypography no puede estar vacío.');

export type CoverTypography = z.infer<typeof coverTypographySchema>;
export type CoverTypographyPatch = z.infer<typeof coverTypographyPatchSchema>;

export const DEFAULT_COVER_TYPOGRAPHY: CoverTypography = Object.freeze({
  titleSize: 'standard',
  titleAlign: 'left',
  titleTreatment: 'brush',
  excerptSize: 'standard',
});

export function serializeCoverTypography(value: unknown): CoverTypography {
  const result = coverTypographySchema.safeParse(value);
  return result.success ? result.data : { ...DEFAULT_COVER_TYPOGRAPHY };
}

export function mergeCoverTypography(current: unknown, patch: CoverTypographyPatch): CoverTypography {
  return coverTypographySchema.parse({ ...serializeCoverTypography(current), ...patch });
}
