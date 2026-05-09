// ============================================================================
// Frontmatter Storage
// ----------------------------------------------------------------------------
// Reads, writes, and removes WindowArrangement data stored in markdown
// frontmatter (the default storage mode). Companion to external-store.ts,
// which handles the external-storage mode.
//
// The arrangement is stored as a single base64 line:
//   perspecta-arrangement: "<base64-encoded-compact-json>"
// See src/storage/codec.ts for the wire format.
// ============================================================================

import { App, TFile } from 'obsidian';
import { FRONTMATTER_KEY, WindowArrangement, WindowArrangementV2 } from '../types';
import { decodeArrangement, encodeArrangement } from './codec';

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

/**
 * Read an arrangement from a note's frontmatter, or null if none.
 * Falls back to the legacy multi-line YAML representation for backward compatibility.
 */
export function getContextFromFrontmatter(app: App, file: TFile): WindowArrangement | null {
	const cache = app.metadataCache.getFileCache(file);
	const rawValue = cache?.frontmatter?.[FRONTMATTER_KEY];

	if (!rawValue) return null;

	// New compact format = base64 string. Old format = parsed YAML object.
	if (typeof rawValue === 'string') {
		return decodeArrangement(rawValue);
	}
	return rawValue as WindowArrangement;
}

/**
 * Save an arrangement into a note's frontmatter (replacing any existing one).
 */
export async function saveContextToFrontmatter(
	app: App,
	file: TFile,
	arrangement: WindowArrangementV2
): Promise<void> {
	// === DIAGNOSTIC (v0.1.37) ===
	// Always-on logging to verify the vault.read/modify race against the
	// editor buffer. Will be removed in the follow-up fix release.
	const tag = `[Perspecta-DIAG] saveContextToFrontmatter "${file.path}"`;

	const readStart = performance.now();
	const content = await app.vault.read(file);
	const readMs = (performance.now() - readStart).toFixed(1);
	const hasKeyBeforeWrite = content.includes('perspecta-arrangement:');
	console.warn(`${tag} step1 vault.read: ${readMs}ms, len=${content.length}, hasArrKeyOnDisk=${hasKeyBeforeWrite}`);

	const fmStart = performance.now();
	const newContent = updateFrontmatter(content, arrangement);
	const fmMs = (performance.now() - fmStart).toFixed(1);
	const hasKeyAfterEncode = newContent.includes('perspecta-arrangement:');
	console.warn(`${tag} step2 updateFrontmatter: ${fmMs}ms, newLen=${newContent.length}, hasArrKey=${hasKeyAfterEncode}`);

	const writeStart = performance.now();
	await app.vault.modify(file, newContent);
	const writeMs = (performance.now() - writeStart).toFixed(1);
	console.warn(`${tag} step3 vault.modify: ${writeMs}ms (returned)`);

	// Re-read at three points to see if anything overwrites our line.
	const verify = async (label: string, delayMs: number): Promise<void> => {
		await new Promise(r => setTimeout(r, delayMs));
		const after = await app.vault.read(file);
		const stillHas = after.includes('perspecta-arrangement:');
		const sameLen = after.length === newContent.length;
		console.warn(`${tag} step4 verify@${label}: hasArrKey=${stillHas}, sameLen=${sameLen}, len=${after.length}`);
	};
	void verify('100ms', 100);
	void verify('500ms', 500);
	void verify('2000ms', 2000);
}

/**
 * Cheap O(1) check (against the metadata cache) for whether a note has a
 * stored arrangement in its frontmatter. Used by the file-explorer indicator
 * scan, so it must be honest about *absence* — `undefined` (key missing)
 * and falsy values both count as "no arrangement".
 *
 * Critical: do NOT use `!== null` here. Obsidian's frontmatter cache
 * returns `undefined` for missing keys, never `null` — so `!== null` is
 * true for every file with any frontmatter at all, which produces a
 * false-positive indicator for every markdown file in the vault.
 */
export function hasContextInFrontmatter(app: App, file: TFile): boolean {
	const value = app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY];
	return Boolean(value);
}

/**
 * Remove the perspecta-arrangement line from a note's frontmatter, if present.
 * Returns true if the file was modified.
 */
export async function removeContextFromFrontmatter(app: App, file: TFile): Promise<boolean> {
	const content = await app.vault.read(file);
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) return false;

	const fm = match[1];
	if (!fm.includes(`${FRONTMATTER_KEY}:`)) return false;

	// Strip both old multi-line YAML and new single-line variants.
	const newFm = fm
		.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')
		.replace(/perspecta-arrangement: ".*"\n?/g, '')
		.trim();

	const newContent = content.replace(FRONTMATTER_REGEX, `---\n${newFm}\n---`);

	if (newContent !== content) {
		await app.vault.modify(file, newContent);
		return true;
	}
	return false;
}

/**
 * Splice an encoded arrangement into the file's frontmatter, replacing any
 * existing entry. Used by saveContextToFrontmatter.
 */
function updateFrontmatter(content: string, arrangement: WindowArrangementV2): string {
	const match = content.match(FRONTMATTER_REGEX);
	const encoded = encodeArrangement(arrangement);

	if (match) {
		// Strip any existing perspecta-arrangement entry, then append the new one.
		let fm = match[1]
			.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')
			.replace(/perspecta-arrangement: ".*"/g, '')
			.trim();
		fm = fm ? fm + '\n' + encoded : encoded;
		return content.replace(FRONTMATTER_REGEX, `---\n${fm}\n---`);
	}
	return `---\n${encoded}\n---\n${content}`;
}
