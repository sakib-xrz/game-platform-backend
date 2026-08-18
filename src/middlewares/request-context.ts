import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.header('x-request-id')?.trim();
  const request_id = incoming && incoming.length <= 128 ? incoming : randomUUID();
  req.request_id = request_id;
  res.setHeader('X-Request-Id', request_id);
  next();
};

export default requestContext;
