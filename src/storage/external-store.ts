// ============================================================================
// External Context Storage Manager
// Stores context data as JSON files in the plugin folder
// ============================================================================

import { App, DataAdapter, PluginManifest } from 'obsidian';
import { WindowArrangementV2 } from '../types';
import { PerfTimer } from '../utils/perf-timer';

const CONTEXTS_FOLDER = 'contexts';

export interface ExternalStoreConfig {
	app: App;
	manifest: PluginManifest;
}

export class ExternalContextStore {
	private app: App;
	private manifest: PluginManifest;
	private cache: Map<string, WindowArrangementV2> = new Map();
	private dirty: Set<string> = new Set();
	private saveTimeout: ReturnType<typeof setTimeout> | null = null;
	private initialized = false;

	constructor(config: ExternalStoreConfig) {
		this.app = config.app;
		this.manifest = config.manifest;
	}

	private get adapter(): DataAdapter {
		return this.app.vault.adapter;
	}

	private getContextsPath(): string {
		return `${this.manifest.dir}/${CONTEXTS_FOLDER}`;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		const contextsPath = this.getContextsPath();

		try {
			if (!await this.adapter.exists(contextsPath)) {
				await this.adapter.mkdir(contextsPath);
			}

			const files = await this.adapter.list(contextsPath);
			for (const file of files.files) {
				if (file.endsWith('.json')) {
					try {
						const content = await this.adapter.read(file);
						const data = JSON.parse(content);
						const uid = file.split('/').pop()?.replace('.json', '');
						if (uid && data) {
							this.cache.set(uid, data as WindowArrangementV2);
						}
					} catch (e) {
						console.warn(`[Perspecta] Failed to load context file: ${file}`, e);
					}
				}
			}

			this.initialized = true;
			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta] External store initialized with ${this.cache.size} contexts`);
			}
		} catch (e) {
			console.error('[Perspecta] Failed to initialize external store:', e);
		}
	}

	get(uid: string): WindowArrangementV2 | null {
		return this.cache.get(uid) || null;
	}

	has(uid: string): boolean {
		return this.cache.has(uid);
	}

	set(uid: string, context: WindowArrangementV2): void {
		this.cache.set(uid, context);
		this.dirty.add(uid);
		this.scheduleSave();
	}

	async delete(uid: string): Promise<void> {
		this.cache.delete(uid);
		this.dirty.delete(uid);

		const filePath = `${this.getContextsPath()}/${uid}.json`;
		try {
			if (await this.adapter.exists(filePath)) {
				await this.adapter.remove(filePath);
			}
		} catch (e) {
			console.warn(`[Perspecta] Failed to delete context file: ${filePath}`, e);
		}
	}

	getAllUids(): string[] {
		return Array.from(this.cache.keys());
	}

	private scheduleSave(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = setTimeout(() => this.flushDirty(), 2000);
	}

	async flushDirty(): Promise<void> {
		if (this.dirty.size === 0) return;

		const contextsPath = this.getContextsPath();

		if (!await this.adapter.exists(contextsPath)) {
			await this.adapter.mkdir(contextsPath);
		}

		const toSave = Array.from(this.dirty);
		this.dirty.clear();

		for (const uid of toSave) {
			const context = this.cache.get(uid);
			if (context) {
				const filePath = `${contextsPath}/${uid}.json`;
				try {
					const json = JSON.stringify(context);
					await this.adapter.write(filePath, json);
				} catch (e) {
					console.error(`[Perspecta] Failed to save context: ${uid}`, e);
					this.dirty.add(uid);
				}
			}
		}

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Saved ${toSave.length} context(s) to disk`);
		}
	}

	async cleanup(): Promise<void> {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		await this.flushDirty();
	}
}
