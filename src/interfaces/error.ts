export type ApiErrorResponse = {
  success: false;
  statusCode: number;
  message: string;
  errors?: string[];
  path?: string;
  stack?: string;
  timestamp: string;
};
