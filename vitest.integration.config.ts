import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/security*.ts','tests/api*.ts'], environment: 'node', testTimeout: 30000, fileParallelism: false } });
