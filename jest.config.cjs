module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  moduleNameMapper: {
    '^@viralforge/domain$': '<rootDir>/packages/domain/index.ts',
    '^@viralforge/supabase$': '<rootDir>/packages/supabase/index.ts',
  },
  collectCoverageFrom: ['packages/domain/src/schemas/pipeline.ts'],
};
