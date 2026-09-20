import type { RequestHandler } from 'express';
import type { z } from 'zod';
export function validateQuery(schema: z.ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(
        Object.assign(new Error('Invalid query parameters.'), {
          status: 400,
          code: 'INVALID_QUERY',
        }),
      );
      return;
    }
    res.locals['query'] = result.data;
    next();
  };
}
