import { generateKeyPairSync } from 'crypto';
import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import { materializeGcsKeyFromEnv } from '../bootstrap/gcs-key-from-env';
import { runsRoutes } from './routes/runs';
import { authRoutes } from './routes/auth';
import { usersRoutes } from './routes/users';
import { tenantsRoutes } from './routes/tenants';
import { membersRoutes } from './routes/members';
import { platformRoutes } from './routes/platform';
import { testCasesRoutes } from './routes/test-cases';
import { closePool } from '../db/pool';

dotenv.config();
materializeGcsKeyFromEnv();

/**
 * JWT key configuration.
 * Production: set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY as PEM strings in env
 *             (newlines encoded as \n, decoded here).
 * Development: ephemeral RSA keypair generated at startup — tokens are
 *              invalidated on restart. Never use this in production.
 *
 * Spec ref: docs/spec-identity.md §11 — JWT Contract (RS256)
 */
function loadJwtKeys(): { privateKey: string; publicKey: string } {
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    return {
      privateKey: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      publicKey: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set in production.');
  }

  console.warn(
    '[auth] JWT_PRIVATE_KEY/JWT_PUBLIC_KEY not set — generating ephemeral keypair for development. ' +
    'All tokens will be invalidated on server restart.',
  );

  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',   format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8',  format: 'pem' },
  });
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty' },
    }),
  },
});

const jwtKeys = loadJwtKeys();

void app.register(fjwt, {
  secret: {
    private: jwtKeys.privateKey,
    public:  jwtKeys.publicKey,
  },
  sign: { algorithm: 'RS256' },
});

void app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
});

// Health check
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Routes
void app.register(authRoutes);
void app.register(usersRoutes);
void app.register(tenantsRoutes);
void app.register(membersRoutes);
void app.register(platformRoutes);
void app.register(runsRoutes);
void app.register(testCasesRoutes);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ event: 'shutdown', signal });
  await app.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

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
