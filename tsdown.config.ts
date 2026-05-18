import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['bin/dynamoip.ts'],
  format: 'cjs',
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
});
