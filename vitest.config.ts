import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['tests/security*.ts','tests/api*.ts','tests/e2e/**'], environment: 'node' } });
