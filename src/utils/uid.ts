// ============================================================================
// UID Utilities
// ============================================================================

import { App, TFile } from 'obsidian';
import { UID_FRONTMATTER_KEY } from '../types';

// Generate a UUID v4
export function generateUid(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

// Get UID from a file's frontmatter cache
export function getUidFromCache(app: App, file: TFile): string | undefined {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.[UID_FRONTMATTER_KEY] as string | undefined;
}

// Add UID to a markdown file's frontmatter (creates frontmatter if needed)
export async function addUidToFile(app: App, file: TFile, uid: string): Promise<void> {
	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	let newContent: string;
	if (match) {
		let fm = match[1];
		if (fm.includes(`${UID_FRONTMATTER_KEY}:`)) {
			// perspecta-uid already exists - just clean up old uid if present
			if (fm.match(/^uid:\s*["']?[^"'\n]+["']?\s*$/m)) {
				fm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
				newContent = content.replace(frontmatterRegex, `---\n${fm}\n---`);
				await app.vault.modify(file, newContent);
			}
			return;
		}
		// Remove old 'uid' property if present (migration from old format)
		fm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
		const newFm = `${UID_FRONTMATTER_KEY}: "${uid}"\n${fm}`;
		newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);
	} else {
		newContent = `---\n${UID_FRONTMATTER_KEY}: "${uid}"\n---\n${content}`;
	}

	await app.vault.modify(file, newContent);
}

// Remove old 'uid' property from a file if it has perspecta-uid
export async function cleanupOldUid(app: App, file: TFile): Promise<boolean> {
	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return false;

	const fm = match[1];
	if (!fm.includes(`${UID_FRONTMATTER_KEY}:`)) return false;
	if (!fm.match(/^uid:\s*["']?[^"'\n]+["']?\s*$/m)) return false;

	const newFm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
	const newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);

	if (newContent !== content) {
		await app.vault.modify(file, newContent);
		return true;
	}
	return false;
}
