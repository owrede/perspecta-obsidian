// ============================================================================
// Base File Storage
// Base files are YAML and store perspecta data as base64-encoded JSON
// ============================================================================

import { App, TFile, parseYaml, stringifyYaml } from 'obsidian';
import { WindowArrangement, BaseData } from '../types';
import { encodeBase64, decodeBase64 } from '../utils/base64';

// Get UID from a base file's YAML
export async function getUidFromBase(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension !== 'base') return undefined;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		return data?.perspecta?.uid;
	} catch {
		return undefined;
	}
}

// Get context from a base file's YAML (stored as base64-encoded JSON)
export async function getContextFromBase(app: App, file: TFile): Promise<WindowArrangement | null> {
	if (file.extension !== 'base') return null;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		const encoded = data?.perspecta?.context;
		if (!encoded) return null;

		// Decode from base64
		const json = decodeBase64(encoded);
		return JSON.parse(json) as WindowArrangement;
	} catch {
		return null;
	}
}

// Save UID to a base file's YAML
export async function addUidToBase(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension !== 'base') return;
	try {
		const content = await app.vault.read(file);
		const data = (content.trim() ? parseYaml(content) : {}) as BaseData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.uid = uid;

		await app.vault.modify(file, stringifyYaml(data));
	} catch (e) {
		console.error('[Perspecta] Failed to add UID to base file:', e);
	}
}

// Save context to a base file's YAML (stored as base64-encoded JSON)
export async function saveContextToBase(app: App, file: TFile, context: WindowArrangement): Promise<void> {
	if (file.extension !== 'base') return;
	try {
		const content = await app.vault.read(file);
		const data = (content.trim() ? parseYaml(content) : {}) as BaseData;

		if (!data.perspecta) {
			data.perspecta = {};
		}

		// Encode as base64 JSON blob (same format as markdown frontmatter)
		const json = JSON.stringify(context);
		const base64 = encodeBase64(json);
		data.perspecta.context = base64;

		await app.vault.modify(file, stringifyYaml(data));
	} catch (e) {
		console.error('[Perspecta] Failed to save context to base file:', e);
		throw e;
	}
}

// Check if a base file has a context stored
export async function baseHasContext(app: App, file: TFile): Promise<boolean> {
	if (file.extension !== 'base') return false;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		return !!data?.perspecta?.context;
	} catch {
		return false;
	}
}
