// ============================================================================
// Markdown File Storage
// Stores context as base64-encoded JSON in frontmatter
// ============================================================================

import { App, TFile } from 'obsidian';
import { WindowArrangement, FRONTMATTER_KEY } from '../types';
import { encodeBase64, decodeBase64 } from '../utils/base64';

// Get context from markdown frontmatter
export function getContextFromFrontmatter(app: App, file: TFile): WindowArrangement | null {
	if (file.extension !== 'md') return null;

	const cache = app.metadataCache.getFileCache(file);
	const rawValue = cache?.frontmatter?.[FRONTMATTER_KEY];

	if (!rawValue) return null;

	try {
		// Decode from base64
		const json = decodeBase64(rawValue);
		return JSON.parse(json) as WindowArrangement;
	} catch {
		return null;
	}
}

// Check if markdown file has context in frontmatter
export function markdownHasContext(app: App, file: TFile): boolean {
	if (file.extension !== 'md') return false;
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.[FRONTMATTER_KEY] !== null;
}

// Encode arrangement as base64 frontmatter value
export function encodeArrangement(arrangement: WindowArrangement): string {
	const json = JSON.stringify(arrangement);
	const base64 = encodeBase64(json);
	return `${FRONTMATTER_KEY}: "${base64}"`;
}

// Save context to markdown frontmatter
export async function saveContextToMarkdown(app: App, file: TFile, context: WindowArrangement): Promise<void> {
	if (file.extension !== 'md') return;

	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	// Encode context as base64
	const json = JSON.stringify(context);
	const base64 = encodeBase64(json);
	const contextLine = `${FRONTMATTER_KEY}: "${base64}"`;

	let newContent: string;
	if (match) {
		let fm = match[1];
		// Remove existing context line if present
		fm = fm.replace(new RegExp(`^${FRONTMATTER_KEY}:.*$`, 'm'), '').trim();
		// Add new context line at the end
		const newFm = fm ? `${fm}\n${contextLine}` : contextLine;
		newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);
	} else {
		// No frontmatter - create it
		newContent = `---\n${contextLine}\n---\n${content}`;
	}

	await app.vault.modify(file, newContent);
}

// Remove context from markdown frontmatter
export async function removeContextFromMarkdown(app: App, file: TFile): Promise<boolean> {
	if (file.extension !== 'md') return false;

	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return false;

	const fm = match[1];
	if (!fm.includes(`${FRONTMATTER_KEY}:`)) return false;

	const newFm = fm.replace(new RegExp(`^${FRONTMATTER_KEY}:.*\n?`, 'm'), '').trim();

	let newContent: string;
	if (newFm) {
		newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);
	} else {
		// If frontmatter is now empty, remove it entirely
		newContent = content.replace(/^---\n\s*\n---\n?/, '');
	}

	if (newContent !== content) {
		await app.vault.modify(file, newContent);
		return true;
	}
	return false;
}
