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
app.use(
  cors({
    origin: config.cors_origin.split(',').map((item) => item.trim()) || [
      'http://localhost:3000',
      'https://game.maxlived.net',
    ],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-User-Id',
    ],
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(apiRateLimiter);

app.use('/api/v1', routes);
app.use(notFound);
app.use(globalErrorHandler);

export default app;
