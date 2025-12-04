// ============================================================================
// Canvas File Storage
// Canvas files store perspecta data in a "perspecta" property within the JSON
// ============================================================================

import { App, TFile } from 'obsidian';
import { WindowArrangement, CanvasData } from '../types';

// Get UID from a canvas file's JSON
export async function getUidFromCanvas(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension !== 'canvas') return undefined;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return data.perspecta?.uid;
	} catch {
		return undefined;
	}
}

// Get context from a canvas file's JSON
export async function getContextFromCanvas(app: App, file: TFile): Promise<WindowArrangement | null> {
	if (file.extension !== 'canvas') return null;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return data.perspecta?.context ?? null;
	} catch {
		return null;
	}
}

// Save UID to a canvas file's JSON
export async function addUidToCanvas(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension !== 'canvas') return;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.uid = uid;

		await app.vault.modify(file, JSON.stringify(data, null, '\t'));
	} catch (e) {
		console.error('[Perspecta] Failed to add UID to canvas:', e);
	}
}

// Save context to a canvas file's JSON
export async function saveContextToCanvas(app: App, file: TFile, context: WindowArrangement): Promise<void> {
	if (file.extension !== 'canvas') return;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.context = context;

		await app.vault.modify(file, JSON.stringify(data, null, '\t'));
	} catch (e) {
		console.error('[Perspecta] Failed to save context to canvas:', e);
		throw e;
	}
}

// Check if a canvas file has a context stored
export async function canvasHasContext(app: App, file: TFile): Promise<boolean> {
	if (file.extension !== 'canvas') return false;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return !!data.perspecta?.context;
	} catch {
		return false;
	}
}
