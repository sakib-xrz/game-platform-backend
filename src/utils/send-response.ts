import { Response } from 'express';
import { toJsonSafe } from './json-safe';

type ApiResponse<T> = {
  statusCode: number;
  success: boolean;
  message?: string | null;
  meta?: Record<string, unknown>;
  data?: T | null;
};

const sendResponse = <T>(res: Response, data: ApiResponse<T>): void => {
  res.status(data.statusCode).json(
    toJsonSafe({
      statusCode: data.statusCode,
      success: data.success,
      message: data.message ?? null,
      meta: data.meta,
      data: data.data ?? null,
      timestamp: new Date(),
    }),
  );
};

export default sendResponse;
