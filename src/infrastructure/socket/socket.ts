import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import config from '@/config';
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

    const dev_user_id = config.allow_dev_identity_header
      ? String(socket.handshake.auth?.user_id || '').trim()
      : '';

    if (dev_user_id) socket.join(`user:${dev_user_id}`);

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
