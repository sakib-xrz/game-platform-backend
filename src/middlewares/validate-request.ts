import { NextFunction, Request, Response } from 'express';
import { ZodType } from 'zod';

const validateRequest =
  (schema: ZodType<any>) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed.body !== undefined) req.body = parsed.body;
      if (parsed.query !== undefined) {
        // Force-replace query so coerced numbers/dates always reach controllers.
        Object.defineProperty(req, 'query', {
          value: parsed.query,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (parsed.params !== undefined) Object.assign(req.params, parsed.params);
      next();
    } catch (error) {
      next(error);
    }
  };

export default validateRequest;
