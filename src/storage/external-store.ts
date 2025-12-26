// ============================================================================
// External Context Storage Manager
// Stores context data as JSON files in the plugin folder
// Supports multiple timestamped arrangements per file
// ============================================================================

import { App, DataAdapter, PluginManifest } from 'obsidian';
import { WindowArrangementV2, ArrangementCollection, TimestampedArrangement } from '../types';
import { PerfTimer } from '../utils/perf-timer';

const CONTEXTS_FOLDER = 'contexts';

export interface ExternalStoreConfig {
	app: App;
	manifest: PluginManifest;
}

// Type guard to check if data is old format (single arrangement) or new format (collection)
function isArrangementCollection(data: unknown): data is ArrangementCollection {
	return typeof data === 'object' && data !== null && 'arrangements' in data && Array.isArray((data as ArrangementCollection).arrangements);
}

export class ExternalContextStore {
	private app: App;
	private manifest: PluginManifest;
	private cache: Map<string, ArrangementCollection> = new Map();
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
							// Handle migration from old format (single arrangement) to new format (collection)
							if (isArrangementCollection(data)) {
								this.cache.set(uid, data);
							} else {
								// Migrate old single arrangement to collection format
								const arrangement = data as WindowArrangementV2;
								const collection: ArrangementCollection = {
									arrangements: [{
										arrangement,
										savedAt: arrangement.ts || Date.now()
									}]
								};
								this.cache.set(uid, collection);
								this.dirty.add(uid); // Mark for re-save in new format
							}
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

	// Get the most recent arrangement (for backward compatibility)
	get(uid: string): WindowArrangementV2 | null {
		const collection = this.cache.get(uid);
		if (!collection || collection.arrangements.length === 0) return null;
		// Return the most recent arrangement
		return collection.arrangements[collection.arrangements.length - 1].arrangement;
	}

	// Get all arrangements for a UID
	getAll(uid: string): TimestampedArrangement[] {
		const collection = this.cache.get(uid);
		if (!collection) return [];
		// Return sorted by timestamp, newest first
		return [...collection.arrangements].sort((a, b) => b.savedAt - a.savedAt);
	}

	// Get arrangement count for a UID
	getCount(uid: string): number {
		const collection = this.cache.get(uid);
		return collection?.arrangements.length ?? 0;
	}

	has(uid: string): boolean {
		const collection = this.cache.get(uid);
		return collection !== undefined && collection.arrangements.length > 0;
	}

	// Add a new arrangement, respecting the max limit
	set(uid: string, context: WindowArrangementV2, maxArrangements = 1): void {
		let collection = this.cache.get(uid);

		if (!collection) {
			collection = { arrangements: [] };
		}

		// Add the new arrangement
		const timestamped: TimestampedArrangement = {
			arrangement: context,
			savedAt: Date.now()
		};
		collection.arrangements.push(timestamped);

		// Sort by timestamp (oldest first for easier pruning)
		collection.arrangements.sort((a, b) => a.savedAt - b.savedAt);

		// Prune oldest arrangements if over the limit
		while (collection.arrangements.length > maxArrangements) {
			collection.arrangements.shift();
		}

		this.cache.set(uid, collection);
		this.dirty.add(uid);
		this.scheduleSave();
	}

	// Delete a specific arrangement by timestamp
	deleteArrangement(uid: string, savedAt: number): void {
		const collection = this.cache.get(uid);
		if (!collection) return;

		collection.arrangements = collection.arrangements.filter(a => a.savedAt !== savedAt);

		if (collection.arrangements.length === 0) {
			this.cache.delete(uid);
		} else {
			this.cache.set(uid, collection);
		}

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
			const collection = this.cache.get(uid);
			const filePath = `${contextsPath}/${uid}.json`;

			if (collection && collection.arrangements.length > 0) {
				try {
					const json = JSON.stringify(collection);
					await this.adapter.write(filePath, json);
				} catch (e) {
					console.error(`[Perspecta] Failed to save context: ${uid}`, e);
					this.dirty.add(uid);
				}
			} else {
				// If collection is empty, delete the file
				try {
					if (await this.adapter.exists(filePath)) {
						await this.adapter.remove(filePath);
					}
				} catch (e) {
					console.warn(`[Perspecta] Failed to delete empty context file: ${filePath}`, e);
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

	/**
	 * Check if the store has been initialized.
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Ensure the store is initialized before use.
	 * Safe to call multiple times - will only initialize once.
	 */
	async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}
	}
}
