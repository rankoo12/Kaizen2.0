import { CachedElementResolver } from '../cached.element-resolver';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import { PinoObservability } from '../../observability/pino.observability';
import { getPool, closePool } from '../../../db/pool';
import pino from 'pino';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

/**
 * Spec ref: Phase 4 — Global Brain Seeding
 * Integration test verifying L4 shared pool lookups.
 */

describe('Shared Pool Integration', () => {
  let resolver: CachedElementResolver;
  let mockRedis: any;
  let mockLLM: jest.Mocked<ILLMGateway>;
  let obs: PinoObservability;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const domain = 'integration-test.com';

  beforeAll(async () => {
    // Ensure DB is clean
    await getPool().query('DELETE FROM selector_cache_aliases WHERE tenant_id = $1', [tenantId]);
    await getPool().query('DELETE FROM selector_cache WHERE domain = $1', [domain]);
    
    // Create test tenant if it doesn't exist
    await getPool().query(
      `INSERT INTO tenants (id, name, slug, plan_tier, global_brain_opt_in)
       VALUES ($1, 'Integration Test Tenant', 'integration-tenant', 'starter', true)
       ON CONFLICT (id) DO NOTHING`,
      [tenantId]
    );

    // Insert a seeded shared entry
    // Embedding is a synthetic 1536D vector near [0.5, 0.5, ...]
    const seededEmbedding = Array(1536).fill(0.5);
    const toSQL = (v: number[]) => '[' + v.join(',') + ']';

    await getPool().query(
      `INSERT INTO selector_cache
         (tenant_id, content_hash, domain, selectors, step_embedding, confidence_score, is_shared, attribution)
       VALUES
         (NULL, 'seeded-hash', $1, '[{"selector": "#seeded-btn", "strategy": "css", "confidence": 1.0}]', $2::vector, 1.0, true, '{"source": "seed", "contributors": []}')`,
      [domain, toSQL(seededEmbedding)]
    );
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM selector_cache_aliases WHERE tenant_id = $1', [tenantId]);
    await getPool().query('DELETE FROM selector_cache WHERE domain = $1', [domain]);
    await closePool();
  });

  beforeEach(() => {
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };

    mockLLM = {
      compileStep: jest.fn(),
      resolveElement: jest.fn(),
      // Return an embedding that is extremely close (cosine > 0.95) to the seeded one
      generateEmbedding: jest.fn().mockResolvedValue(Array(1536).fill(0.51)),
    };

    obs = new PinoObservability(pino({ level: 'silent' }));
    resolver = new CachedElementResolver(mockRedis, mockLLM, obs);
  });

  it('resolves using L4 shared pool when no tenant entry exists, and writes alias', async () => {
    const step = {
      action: 'click' as const,
      targetDescription: 'click seeded button',
      value: null,
      url: null,
      rawText: 'click seeded button',
      contentHash: 'new-hash-123',
    };

    const context = {
      tenantId,
      domain,
      page: {} as any,
    };

    const result = await resolver.resolve(step, context);

    // 1. Assert result comes from shared pool
    expect(result.fromCache).toBe(true);
    expect(result.cacheSource).toBe('shared');
    expect(result.selectors[0].selector).toBe('#seeded-btn');

    // 2. Assert alias was written
    const { rows } = await getPool().query(
      'SELECT canonical_hash FROM selector_cache_aliases WHERE tenant_id = $1 AND new_hash = $2',
      [tenantId, 'new-hash-123']
    );
    expect(rows.length).toBe(1);
    expect(rows[0].canonical_hash).toBe('seeded-hash');
  });
});
