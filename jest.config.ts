import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },
  // Fastify 5's inject() depends on light-my-request → cookie@2, which is
  // ESM-ONLY ("type": "module", a bare `exports` to an ESM file). Jest runs
  // CJS, so that one package must be transpiled: whitelist it out of
  // transformIgnorePatterns and let ts-jest compile its .js (S1 sprint,
  // spec-research-adoption-2026-11 — the Fastify-5 upgrade's only breakage).
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: 'tsconfig.test.json', allowJs: true }],
  },
  transformIgnorePatterns: ['node_modules/(?!cookie/)'],
  // benchmarks/changing-sites ships a judge whose honesty guarantees are unit
  // tested like product code — the bench is only trustworthy if the judge is.
  roots: ['<rootDir>/src', '<rootDir>/benchmarks/changing-sites'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};

export default config;
