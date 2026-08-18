import { Request, Response } from 'express';

const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    statusCode: 404,
    message: 'API endpoint not found',
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
};

export default notFound;
