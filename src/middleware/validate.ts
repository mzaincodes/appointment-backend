import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ValidationError } from '../utils/errors';

/**
 * Request validation.
 *
 * Each schema validates one part of the request and — importantly — *replaces*
 * that part with the parsed result. Downstream handlers therefore receive
 * coerced, trimmed, fully typed values, and there is no way to accidentally
 * read an unvalidated field: `req.body` simply is the validated object.
 *
 * Unknown keys are stripped by Zod's default object behaviour, so a client
 * cannot smuggle extra fields (`role`, `status`, …) into a create/update path.
 */

interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: { field: string; message: string }[] = [];

    for (const key of ['params', 'query', 'body'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (result.success) {
        // `req.query` and `req.params` are getter-only in Express 5 and
        // getter-backed in some Express 4 setups, so assign defensively.
        Object.defineProperty(req, key, {
          value: result.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            field: [key === 'body' ? '' : key, ...issue.path].filter(Boolean).join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (issues.length > 0) {
      // Report the first problem as the headline message — it is what a toast
      // will show — and return the full list for inline field errors.
      next(new ValidationError(issues[0]!.message, { issues }));
      return;
    }

    next();
  };
}

/** Helper for typing a handler's `req.body` after validation. */
export type Infer<T extends ZodTypeAny> = z.infer<T>;
