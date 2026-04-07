import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { runsRoutes } from './routes/runs';
import { authRoutes } from './routes/auth';
import { closePool } from '../db/pool';

dotenv.config();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty' },
    }),
  },
});

// JWT plugin — used by POST /auth/token to issue short-lived session tokens
void app.register(fjwt, {
  secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
});

// Configure CORS for the frontend dashboard
void app.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
});

// Health check — used by load balancers and docker healthcheck
app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

void app.register(runsRoutes);
void app.register(authRoutes);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ event: 'shutdown', signal });
  await app.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

const start = async (): Promise<void> => {
  try {
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
