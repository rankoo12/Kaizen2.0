import Fastify from 'fastify';
import dotenv from 'dotenv';

dotenv.config();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty' },
    }),
  },
});

// Health check — used by load balancers and docker healthcheck
app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

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
