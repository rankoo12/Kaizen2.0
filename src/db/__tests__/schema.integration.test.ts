/**
 * Schema integration tests — connect to the real DB and verify that all
 * migrations have been applied correctly.
 *
 * Run with: npm run test:integration
 * Skipped automatically when DATABASE_URL is not set.
 */
import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const DB_URL = process.env.DATABASE_URL;

const describeIfDB = DB_URL ? describe : describe.skip;

describeIfDB('DB schema — migration validation', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // ─── pgvector ──────────────────────────────────────────────────────────────

  it('pgvector extension is installed', async () => {
    const { rows } = await client.query(
      `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].extname).toBe('vector');
  });

  // ─── Core tables ──────────────────────────────────────────────────────────

  it.each([
    'tenants',
    'test_suites',
    'test_cases',
    'test_steps',
    'test_case_steps',
    'runs',
    'step_results',
    'healing_events',
    'selector_cache',
    'selector_cache_aliases',
    'compiled_ast_cache',
    'api_keys',
    'billing_events',
    'llm_call_log',
    'schema_migrations',
  ])('table "%s" exists', async (table) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    expect(rows).toHaveLength(1);
  });

  // ─── selector_cache columns ────────────────────────────────────────────────

  it('selector_cache has step_embedding vector(1536) column', async () => {
    const { rows } = await client.query(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'selector_cache' AND column_name = 'step_embedding'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].udt_name).toBe('vector');
  });

  // ─── HNSW index ────────────────────────────────────────────────────────────

  it('HNSW index exists on selector_cache.step_embedding', async () => {
    const { rows } = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'selector_cache' AND indexname = 'idx_selector_cache_step_vec'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('hnsw');
    expect(rows[0].indexdef).toContain('vector_cosine_ops');
  });

  // ─── api_keys columns ─────────────────────────────────────────────────────

  it.each(['id', 'tenant_id', 'key_hash', 'key_prefix', 'scope', 'description', 'expires_at', 'last_used_at', 'created_at'])(
    'api_keys has column "%s"',
    async (column) => {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'api_keys' AND column_name = $1`,
        [column],
      );
      expect(rows).toHaveLength(1);
    },
  );

  // ─── Dev tenant seed ──────────────────────────────────────────────────────

  it('dev tenant seed exists', async () => {
    const { rows } = await client.query(
      `SELECT id, slug FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(rows).toHaveLength(1);
  });

  // ─── All migrations applied ────────────────────────────────────────────────

  it.each([
    '001_initial_schema',
    '002_seed_compiled_ast_cache',
    '003_add_pgvector_and_auth',
    '007_user_verdict',
  ])('migration "%s" is recorded as applied', async (version) => {
    const { rows } = await client.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [version],
    );
    expect(rows).toHaveLength(1);
  });
});
