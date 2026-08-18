class AppError extends Error {
  statusCode: number;
  errors?: string[] | Record<string, string[]>;

  constructor(
    statusCode: number,
    message: string,
    errors?: string[] | Record<string, string[]>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
