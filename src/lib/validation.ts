import type { ZodType } from 'zod';

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
