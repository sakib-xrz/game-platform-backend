import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import config from '@/config';
import routes from '@/routes';
import { apiRateLimiter } from '@/middlewares/rate-limiter';
import requestContext from '@/middlewares/request-context';
import globalErrorHandler from '@/middlewares/global-error-handler';
import notFound from '@/middlewares/not-found';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requestContext);
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: config.cors_origin.split(',').map((item) => item.trim()),
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'X-Request-Id',
    'X-User-Id',
    'X-App-Package',
    'X-Package-Name',
    'X-Timestamp',
    'X-Signature',
  ],
}));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    const request = req as express.Request;
    if (request.originalUrl.startsWith('/api/v1/integrations')) {
      request.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(apiRateLimiter);

app.use('/api/v1', routes);
app.use(notFound);
app.use(globalErrorHandler);

export default app;
