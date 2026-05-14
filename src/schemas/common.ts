import { z } from 'zod';

export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

export const paginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of results to return (1–200, default 50)'),
  page_cursor: z
    .string()
    .optional()
    .describe('Cursor for next page, from a previous response next_cursor field'),
};

export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

// Some MCP HTTP/SSE gateways serialize nested JSON args as strings before forwarding to
// the server. Accept either a native object/array or a JSON string and coerce to the
// expected shape so callers don't hit "Expected object, received string" errors.
export const jsonObjectArg = z
  .union([z.record(z.unknown()), z.string()])
  .transform((v, ctx) => {
    if (typeof v !== 'string') return v;
    try {
      const parsed = JSON.parse(v);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected JSON object' });
        return z.NEVER;
      }
      return parsed as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON string' });
      return z.NEVER;
    }
  });

export const jsonArrayArg = <T extends z.ZodTypeAny>(item: T) =>
  z.union([z.array(item), z.string()]).transform((v, ctx) => {
    if (typeof v !== 'string') return v as z.infer<T>[];
    try {
      const parsed = JSON.parse(v);
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected JSON array' });
        return z.NEVER;
      }
      const result = z.array(item).safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON string' });
      return z.NEVER;
    }
  });
