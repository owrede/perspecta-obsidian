import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, copyFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyWallpaperToLocal } from '../src/utils/wallpaper';

let tmp: string;
let srcDir: string;
let dstDir: string;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'perspecta-wallpaper-test-'));
	srcDir = join(tmp, 'src');
	dstDir = join(tmp, 'dst');
	await writeFile(join(tmp, '.tmpdir'), '');
	// Create source dir
	await import('fs/promises').then(fs => fs.mkdir(srcDir, { recursive: true }));
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

async function makeWallpaper(name: string, content: string): Promise<string> {
	const path = join(srcDir, name);
	await writeFile(path, content);
	return path;
}

describe('copyWallpaperToLocal', () => {
	// The v0.1.39 regression test. Through v0.1.38 the destination filename
	// included a hash of the *source path*. After Restore, the system wallpaper
	// became the previously-saved local copy — so the next save read THAT path,
	// hashed it, and produced a NEW longer name, accumulating one suffix per
	// save: name_a.jpg → name_a_b.jpg → name_a_b_c.jpg → ...
	// Fix: content-addressed naming. Same content always produces the same name.
	describe('v0.1.39 duplicate-accumulation regression', () => {
		it('produces the SAME destination path for the same content, regardless of source path', async () => {
			const a = await makeWallpaper('original.jpeg', 'wallpaper-bytes-XYZ');
			const b = await makeWallpaper('moved-elsewhere.jpeg', 'wallpaper-bytes-XYZ');

			const result1 = await copyWallpaperToLocal(a, dstDir);
			const result2 = await copyWallpaperToLocal(b, dstDir);

			expect(result1.success).toBe(true);
			expect(result2.success).toBe(true);
			expect(result1.path).toBe(result2.path);

			// Only ONE file in the destination, not two.
			const files = await readdir(dstDir);
			expect(files).toHaveLength(1);
		});

		it('does not accumulate suffixes when called repeatedly on the same source', async () => {
			const src = await makeWallpaper('w.jpeg', 'identical-bytes');

			await copyWallpaperToLocal(src, dstDir);
			await copyWallpaperToLocal(src, dstDir);
			await copyWallpaperToLocal(src, dstDir);
			await copyWallpaperToLocal(src, dstDir);

			const files = await readdir(dstDir);
			expect(files).toHaveLength(1);
			// Filename must NOT contain underscore-separated chains of suffixes.
			// Pre-fix output looked like: w_<hash1>_<hash2>_<hash3>_<hash4>.jpeg
			expect(files[0]).not.toMatch(/_.*_/);
		});

		it('survives the full save→restore→save loop without duplicating', async () => {
			// Simulate the user's scenario: save copies system wallpaper to vault,
			// restore sets system wallpaper to that local copy, next save reads
			// the local copy as "current wallpaper" and copies it again.
			const systemWallpaper = await makeWallpaper('SystemWallpaper.jpeg', 'WALLPAPER_BYTES');

			// Save 1
			const save1 = await copyWallpaperToLocal(systemWallpaper, dstDir);
			expect(save1.success).toBe(true);
			const localCopyPath = save1.path!;

			// Save 2: simulating that after restore, the system points at the local copy
			const save2 = await copyWallpaperToLocal(localCopyPath, dstDir);
			expect(save2.success).toBe(true);

			// Save 3: same again
			const save3 = await copyWallpaperToLocal(localCopyPath, dstDir);
			expect(save3.success).toBe(true);

			// All three saves produce the SAME destination — content is identical.
			expect(save1.path).toBe(save2.path);
			expect(save2.path).toBe(save3.path);

			// Only one file in dest after three saves.
			const files = await readdir(dstDir);
			expect(files).toHaveLength(1);
		});
	});

	describe('different content → different files', () => {
		it('different image content produces different destination filenames', async () => {
			const a = await makeWallpaper('a.jpeg', 'content-A');
			const b = await makeWallpaper('b.jpeg', 'content-B');

			const ra = await copyWallpaperToLocal(a, dstDir);
			const rb = await copyWallpaperToLocal(b, dstDir);

			expect(ra.path).not.toBe(rb.path);

			const files = await readdir(dstDir);
			expect(files).toHaveLength(2);
		});

		it('preserves the file extension', async () => {
			const a = await makeWallpaper('w.jpeg', 'bytes');
			const b = await makeWallpaper('w.png', 'other-bytes');

			const ra = await copyWallpaperToLocal(a, dstDir);
			const rb = await copyWallpaperToLocal(b, dstDir);

			expect(ra.path!.endsWith('.jpeg')).toBe(true);
			expect(rb.path!.endsWith('.png')).toBe(true);
		});

		it('normalises extension to lowercase', async () => {
			// macOS sometimes hands us paths with uppercase extensions
			// (e.g. screenshots). Normalising prevents two copies of the same
			// content sharing a hash but differing in case.
			const upper = await makeWallpaper('w.JPEG', 'same-bytes');
			const lower = await makeWallpaper('x.jpeg', 'same-bytes');

			const r1 = await copyWallpaperToLocal(upper, dstDir);
			const r2 = await copyWallpaperToLocal(lower, dstDir);

			expect(r1.path).toBe(r2.path);
			expect(r1.path!.endsWith('.jpeg')).toBe(true);

			const files = await readdir(dstDir);
			expect(files).toHaveLength(1);
		});
	});

	describe('error paths', () => {
		it('returns success=false when source is not a file', async () => {
			const r = await copyWallpaperToLocal(join(tmp, 'does-not-exist.jpeg'), dstDir);
			expect(r.success).toBe(false);
		});

		it('rejects unsupported extensions', async () => {
			const bad = await makeWallpaper('not-an-image.txt', 'plain text');
			const r = await copyWallpaperToLocal(bad, dstDir);
			expect(r.success).toBe(false);
		});

		it('creates the destination directory when missing', async () => {
			const src = await makeWallpaper('w.jpeg', 'bytes');
			const deepDst = join(dstDir, 'nested', 'further');

			const r = await copyWallpaperToLocal(src, deepDst);

			expect(r.success).toBe(true);
			const files = await readdir(deepDst);
			expect(files).toHaveLength(1);
		});
	});

	describe('content addressing properties', () => {
		it('does not include any segment of the source filename in the destination', async () => {
			const src = await makeWallpaper('SuperLongFileNameWithRandomGarbage_xyz123.jpeg', 'bytes');

			const r = await copyWallpaperToLocal(src, dstDir);
			expect(r.success).toBe(true);

			const filename = r.path!.split('/').pop()!;
			expect(filename).not.toContain('SuperLong');
			expect(filename).not.toContain('Random');
			expect(filename).not.toContain('xyz123');
		});

		it('idempotent under copy: copying the dest file back to itself produces the same dest', async () => {
			const src = await makeWallpaper('w.jpeg', 'bytes-AAA');

			const r1 = await copyWallpaperToLocal(src, dstDir);
			expect(r1.success).toBe(true);

			// Now treat the dest as a new source.
			const r2 = await copyWallpaperToLocal(r1.path!, dstDir);
			expect(r2.success).toBe(true);
			expect(r2.path).toBe(r1.path);
		});
	});
});
