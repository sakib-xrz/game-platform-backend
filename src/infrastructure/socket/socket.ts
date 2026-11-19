import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import config from '@/config';
import { resolvePlayerIdentity } from '@/middlewares/player-context';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { logger } from '@/utils/logger';

let io: Server | null = null;

export const initializeSocket = (http_server: HttpServer): Server => {
  io = new Server(http_server, {
    cors: {
      origin: config.cors_origin.split(',').map((item) => item.trim()),
      credentials: true,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
  });

  io.adapter(createAdapter(redisClient));

  io.on('connection', (socket) => {
    socket.join('game:greedy');
    socket.join('game:teen-patti');
    socket.join('game:lucky-77');
    socket.join('game:greedy-classic');

    // Same identity rules as HTTP requests: host-signed token first (mapped
    // to the internal player id), legacy user_id only for non-host players.
    const auth = socket.handshake.auth ?? {};
    resolvePlayerIdentity({
      token: typeof auth.token === 'string' ? auth.token : undefined,
      appKey: typeof auth.app === 'string' ? auth.app : undefined,
      headerUserId: typeof auth.user_id === 'string' ? auth.user_id : undefined,
    })
      .then((user_id) => {
        if (user_id && socket.connected) socket.join(`user:${user_id}`);
      })
      .catch((err) => {
        logger.debug('socket_identity_rejected', {
          socket_id: socket.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      });

    socket.emit('platform.connected', {
      socket_id: socket.id,
      server_time: new Date().toISOString(),
    });

    socket.on('disconnect', (reason) => {
      logger.debug('socket_disconnected', { socket_id: socket.id, reason });
    });
  });

  return io;
};

export const getSocketServer = (): Server => {
  if (!io) throw new Error('Socket.IO has not been initialized');
  return io;
};
