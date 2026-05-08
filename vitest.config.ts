import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		// The plugin's own source imports `obsidian`, which is a runtime-only
		// dependency. Tests target leaf modules that don't import obsidian
		// (codec, etc.). If a test ever needs an Obsidian-coupled module,
		// add a per-file alias here that maps `obsidian` to a stub.
	},
	resolve: {
		alias: {
			// Stub the `obsidian` module so tests for files that transitively
			// touch it can still load. Real test fixtures pass plain objects.
			obsidian: new URL('./tests/stubs/obsidian.ts', import.meta.url).pathname,
		},
	},
});
