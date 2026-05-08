import { describe, expect, it, vi } from 'vitest';
import {
	getContextFromFrontmatter,
	saveContextToFrontmatter,
	removeContextFromFrontmatter,
} from '../src/storage/frontmatter-store';
import { encodeArrangement } from '../src/storage/codec';
import { WindowArrangementV2 } from '../src/types';

// Build a minimal mock App that the frontmatter-store talks to. Only the
// surfaces it actually uses are stubbed: vault.read/modify and metadataCache.
function makeMockApp(content: string, parsedFrontmatter: Record<string, unknown> = {}) {
	let current = content;
	return {
		vault: {
			read: vi.fn(async () => current),
			modify: vi.fn(async (_file: unknown, newContent: string) => {
				current = newContent;
			}),
		},
		metadataCache: {
			getFileCache: vi.fn(() => ({ frontmatter: parsedFrontmatter })),
		},
		_currentContent: () => current,
	};
}

function makeArrangement(): WindowArrangementV2 {
	return {
		v: 2,
		ts: 1700000000000,
		focusedWindow: 0,
		main: {
			root: { type: 'tabs', tabs: [{ path: 'note.md', active: true, name: 'note' }] },
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
		},
		popouts: [],
	};
}

describe('frontmatter-store', () => {
	describe('saveContextToFrontmatter', () => {
		it('inserts frontmatter when none exists', async () => {
			const arr = makeArrangement();
			const app = makeMockApp('# Hello\n\nbody text');
			const file = { path: 'a.md' } as never;

			await saveContextToFrontmatter(app as never, file, arr);

			const saved = app._currentContent();
			expect(saved).toMatch(/^---\nperspecta-arrangement: ".+"\n---\n# Hello/);
		});

		it('replaces an existing perspecta-arrangement line', async () => {
			const arr = makeArrangement();
			const app = makeMockApp(
				'---\nperspecta-arrangement: "OLDBLOB"\nother: keep me\n---\n# Body'
			);
			const file = { path: 'a.md' } as never;

			await saveContextToFrontmatter(app as never, file, arr);

			const saved = app._currentContent();
			expect(saved).not.toContain('OLDBLOB');
			expect(saved).toContain('other: keep me');
			// The new arrangement is present
			expect(saved).toMatch(/perspecta-arrangement: ".+"/);
			// Body untouched
			expect(saved).toContain('# Body');
		});
	});

	describe('removeContextFromFrontmatter', () => {
		it('returns false when the file has no frontmatter', async () => {
			const app = makeMockApp('plain body, no frontmatter');
			const file = { path: 'a.md' } as never;

			const result = await removeContextFromFrontmatter(app as never, file);

			expect(result).toBe(false);
			expect(app.vault.modify).not.toHaveBeenCalled();
		});

		it('returns false when frontmatter exists but has no perspecta-arrangement', async () => {
			const app = makeMockApp('---\ntitle: Foo\n---\nbody');
			const file = { path: 'a.md' } as never;

			const result = await removeContextFromFrontmatter(app as never, file);

			expect(result).toBe(false);
			expect(app.vault.modify).not.toHaveBeenCalled();
		});

		it('strips the perspecta-arrangement line and preserves siblings', async () => {
			const app = makeMockApp(
				'---\ntitle: Foo\nperspecta-arrangement: "BLOB"\ntags: [a]\n---\nbody'
			);
			const file = { path: 'a.md' } as never;

			const result = await removeContextFromFrontmatter(app as never, file);

			expect(result).toBe(true);
			const saved = app._currentContent();
			expect(saved).not.toContain('BLOB');
			expect(saved).not.toContain('perspecta-arrangement');
			expect(saved).toContain('title: Foo');
			expect(saved).toContain('tags: [a]');
			expect(saved).toContain('body');
		});
	});

	describe('getContextFromFrontmatter', () => {
		it('returns null when frontmatter has no arrangement', () => {
			const app = makeMockApp('', { title: 'Foo' });
			const file = { path: 'a.md' } as never;

			const result = getContextFromFrontmatter(app as never, file);

			expect(result).toBeNull();
		});

		it('decodes a base64-encoded compact arrangement', () => {
			const arr = makeArrangement();
			const line = encodeArrangement(arr);
			// encodeArrangement returns `perspecta-arrangement: "<base64>"` —
			// the metadataCache delivers the inner string, sans key/quotes.
			const blob = line.match(/^perspecta-arrangement: "(.+)"$/)?.[1];
			expect(blob).toBeTruthy();

			const app = makeMockApp('', { 'perspecta-arrangement': blob });
			const file = { path: 'a.md' } as never;

			const result = getContextFromFrontmatter(app as never, file);

			expect(result).not.toBeNull();
			expect(result?.v).toBe(2);
			expect(result?.ts).toBe(arr.ts);
		});

		it('returns the raw value when frontmatter holds the legacy YAML object form', () => {
			// Old format (pre-base64) stored the whole arrangement as a YAML object.
			// Code reads `metadataCache.frontmatter[key]`, which Obsidian parses to
			// an object. We pass it through unchanged for backward compatibility.
			const legacy = { v: 1, ts: 0, focusedWindow: 0 };
			const app = makeMockApp('', { 'perspecta-arrangement': legacy });
			const file = { path: 'a.md' } as never;

			const result = getContextFromFrontmatter(app as never, file);

			expect(result).toEqual(legacy);
		});
	});
});
