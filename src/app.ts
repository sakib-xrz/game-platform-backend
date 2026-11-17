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
app.use(
  helmet({
    frameguard: false, // Allow 3rd party host apps to embed games in WebView and iframes
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(compression());

// Permissive CORS for 3rd-party integration, iframe embedding, and mobile WebViews
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server) or any origin
      callback(null, true);
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-User-Id',
      'X-App-Name',
      'X-Package-Name',
      'X-Sha-Key',
      'X-App-Key',
      'X-Signature',
      'X-Timestamp',
      'X-Nonce',
      'X-Operator-Id',
      'X-Player-Token',
    ],
    exposedHeaders: ['Idempotency-Key', 'X-Request-Id'],
  }),
);
app.use(
  express.json({
    limit: '2mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(apiRateLimiter);

app.use('/api/v1', routes);
app.use(notFound);
app.use(globalErrorHandler);

export default app;
