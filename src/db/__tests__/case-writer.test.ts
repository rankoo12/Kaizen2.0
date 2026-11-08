import { createCase } from '../case-writer';

jest.mock('../transaction', () => ({ withTenantTransaction: jest.fn() }));
jest.mock('../../modules/test-compiler/learned.compiler', () => ({
  stepContentHash: (raw: string) => `hash:${raw}`,
}));

/**
 * Finding #14 — the behindAuth protection is a property of the CASE. The insert
 * derives `authenticated` from the generation job's scope itself, so no caller
 * (draft writer, validation runner, a future importer) can forget to pass it.
 * Spec: docs/specs/bench/spec-changing-sites.md §12 #14
 */
describe('createCase — authenticated scope derived from the generation job', () => {
  const makeClient = () => {
    const query = jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM test_suites')) return { rows: [{ id: 'suite-1' }] };
      if (s.includes('INSERT INTO test_cases')) {
        return { rows: [{ id: 'case-1', name: 'n', base_url: 'http://t', created_at: new Date(), updated_at: new Date() }] };
      }
      if (s.includes('INSERT INTO test_steps')) return { rows: [{ id: 'step-1' }] };
      return { rows: [] };
    });
    return { query } as any;
  };

  const caseInsert = (client: { query: jest.Mock }) =>
    client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO test_cases'))!;

  it('derives authenticated from generation_jobs.scope inside the insert', async () => {
    const client = makeClient();
    await createCase('tenant-1', {
      suiteId: 'suite-1', name: 'Admin settings', baseUrl: 'http://t',
      steps: [{ rawText: 'click "Save"' }],
      status: 'draft', origin: 'generated', generationJobId: 'job-9',
    }, client);

    const [sql, params] = caseInsert(client);
    expect(String(sql)).toContain('authenticated');
    expect(String(sql)).toMatch(/SELECT gj\.scope = 'authenticated' FROM generation_jobs gj WHERE gj\.id = \$8/);
    // The job id is the lookup key — the scope is read from the database, never
    // trusted from a caller-supplied flag.
    expect((params as unknown[])[7]).toBe('job-9');
  });

  it('a user-authored case (no job) falls through to public — the subselect finds nothing', async () => {
    const client = makeClient();
    await createCase('tenant-1', {
      suiteId: 'suite-1', name: 'Hand-written', baseUrl: 'http://t', steps: [{ rawText: 'click "Go"' }],
    }, client);

    const [sql, params] = caseInsert(client);
    // COALESCE(subselect, false): a NULL job id yields no row, so false.
    expect(String(sql)).toMatch(/COALESCE\(\(SELECT gj\.scope = 'authenticated'[^)]*\), false\)/);
    expect((params as unknown[])[7]).toBeNull();
  });
});
