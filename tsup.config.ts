import {defineConfig} from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    clean: true,
    format: ['cjs', 'esm'],
    target: 'esnext',
    bundle: true,
    dts: true,
});
