// ============================================================================
// External Context Storage Manager
// ----------------------------------------------------------------------------
// Stores context data as JSON files. Per-UID arrangement collections live
// under a workspace-scoped folder:
//
//   <plugin-dir>/contexts/_workspaces.json     (manifest)
//   <plugin-dir>/contexts/<workspace-id>/<uid>.json
//   <vault>/perspecta/workspaces/<workspace-id>/<uid>.json   (shared buckets)
//
// The `default` bucket is always present, never shareable, and used when no
// Obsidian workspace is active.
// ============================================================================

import { App, DataAdapter, PluginManifest } from 'obsidian';
import {
	WindowArrangementV2,
	ArrangementCollection,
	TimestampedArrangement,
	WorkspaceId,
	WorkspaceInfo,
	WorkspaceManifest,
	DEFAULT_WORKSPACE_ID,
	DEFAULT_WORKSPACE_DISPLAY_NAME,
} from '../types';
import { PerfTimer } from '../utils/perf-timer';
import { TIMING } from '../utils/constants';
import { debounceAsync } from '../utils/async-utils';
import { Logger } from '../utils/logger';

const CONTEXTS_FOLDER = 'contexts';
const MANIFEST_FILENAME = '_workspaces.json';

export interface ExternalStoreConfig {
	app: App;
	manifest: PluginManifest;
	/** Vault-relative folder for shared workspace buckets (no trailing slash). */
	sharedLocation?: string;
}

export type ConflictPolicy = 'merge' | 'overwrite' | 'skip';

export interface CopyResult {
	copied: number;
	skipped: number;
	overwritten: number;
}

function isArrangementCollection(data: unknown): data is ArrangementCollection {
	return typeof data === 'object' && data !== null && 'arrangements' in data && Array.isArray((data as ArrangementCollection).arrangements);
}

function isWorkspaceManifest(data: unknown): data is WorkspaceManifest {
	return typeof data === 'object' && data !== null && (data as WorkspaceManifest).v === 1 && typeof (data as WorkspaceManifest).workspaces === 'object';
}

/**
 * Slugify a workspace display name to a folder-safe id.
 */
export function slugifyWorkspaceName(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return slug || 'workspace';
}

export class ExternalContextStore {
	private app: App;
	private manifest: PluginManifest;
	private sharedLocation: string;

	// Workspace-keyed cache: workspaceId → uid → collection.
	private cache: Map<WorkspaceId, Map<string, ArrangementCollection>> = new Map();
	// Workspace-keyed dirty set: workspaceId → set of uids needing flush.
	private dirty: Map<WorkspaceId, Set<string>> = new Map();
	// Workspace manifest.
	private workspaceManifest: WorkspaceManifest = { v: 1, workspaces: {} };
	private manifestDirty = false;
	// Active workspace id (defaults to 'default').
	private activeWorkspaceId: WorkspaceId = DEFAULT_WORKSPACE_ID;

	private saveTimeoutCleanup: (() => void) | null = null;
	private initialized = false;
	private debouncedFlush: () => Promise<void>;

	constructor(config: ExternalStoreConfig) {
		this.app = config.app;
		this.manifest = config.manifest;
		this.sharedLocation = (config.sharedLocation ?? 'perspecta/workspaces').replace(/\/+$/, '');

		this.debouncedFlush = debounceAsync(async () => {
			await this.flushDirty();
		}, TIMING.EXTERNAL_STORE_DEBOUNCE);
	}

	private get adapter(): DataAdapter {
		return this.app.vault.adapter;
	}

	/** Plugin-dir base contexts folder (where the manifest lives). */
	private getContextsBasePath(): string {
		return `${this.manifest.dir}/${CONTEXTS_FOLDER}`;
	}

	private getManifestPath(): string {
		return `${this.getContextsBasePath()}/${MANIFEST_FILENAME}`;
	}

	/** Folder for a specific workspace bucket — plugin-dir or shared. */
	private getWorkspaceFolder(workspaceId: WorkspaceId): string {
		const info = this.workspaceManifest.workspaces[workspaceId];
		if (info?.shared && workspaceId !== DEFAULT_WORKSPACE_ID) {
			return `${this.sharedLocation}/${workspaceId}`;
		}
		return `${this.getContextsBasePath()}/${workspaceId}`;
	}

	/** Update the shared location at runtime (e.g. when settings change). */
	updateSharedLocation(sharedLocation: string): void {
		this.sharedLocation = sharedLocation.replace(/\/+$/, '');
	}

	// =========================================================================
	// Initialization
	// =========================================================================

	async initialize(): Promise<void> {
		if (this.initialized) return;

		const contextsPath = this.getContextsBasePath();

		try {
			if (!await this.adapter.exists(contextsPath)) {
				await this.adapter.mkdir(contextsPath);
			}

			// Step 1: Load or create the manifest.
			await this.loadManifest();

			// Step 2: Migrate flat layout if needed (any *.json at root → default/).
			await this.migrateFlatLayoutIfNeeded();

			// Step 3: Ensure `default` exists in manifest.
			if (!this.workspaceManifest.workspaces[DEFAULT_WORKSPACE_ID]) {
				this.workspaceManifest.workspaces[DEFAULT_WORKSPACE_ID] = {
					displayName: DEFAULT_WORKSPACE_DISPLAY_NAME,
					shared: false,
				};
				this.manifestDirty = true;
			}

			// Step 4: Load all workspace buckets.
			for (const wsId of Object.keys(this.workspaceManifest.workspaces)) {
				await this.loadWorkspaceBucket(wsId);
			}

			// Step 5: Flush manifest if it changed during init.
			if (this.manifestDirty) {
				await this.writeManifest();
				this.manifestDirty = false;
			}

			this.initialized = true;
			if (PerfTimer.isEnabled()) {
				const totalUids = Array.from(this.cache.values()).reduce((sum, m) => sum + m.size, 0);
				Logger.info(`External store initialized: ${this.cache.size} workspace(s), ${totalUids} context(s)`);
			}
		} catch (e) {
			Logger.error('Failed to initialize external store:', e);
		}
	}

	private async loadManifest(): Promise<void> {
		const manifestPath = this.getManifestPath();
		try {
			if (await this.adapter.exists(manifestPath)) {
				const content = await this.adapter.read(manifestPath);
				const parsed = JSON.parse(content);
				if (isWorkspaceManifest(parsed)) {
					this.workspaceManifest = parsed;
				} else {
					Logger.warn('Invalid workspace manifest, recreating');
					this.workspaceManifest = { v: 1, workspaces: {} };
					this.manifestDirty = true;
				}
			} else {
				this.workspaceManifest = { v: 1, workspaces: {} };
				this.manifestDirty = true;
			}
		} catch (e) {
			Logger.warn('Failed to load workspace manifest:', e);
			this.workspaceManifest = { v: 1, workspaces: {} };
			this.manifestDirty = true;
		}
	}

	private async writeManifest(): Promise<void> {
		const manifestPath = this.getManifestPath();
		const contextsPath = this.getContextsBasePath();
		if (!await this.adapter.exists(contextsPath)) {
			await this.adapter.mkdir(contextsPath);
		}
		await this.adapter.write(manifestPath, JSON.stringify(this.workspaceManifest, null, 2));
	}

	/**
	 * If there are *.json files at <plugin-dir>/contexts/ root (legacy flat
	 * layout), move them into contexts/default/. Idempotent.
	 */
	private async migrateFlatLayoutIfNeeded(): Promise<void> {
		const contextsPath = this.getContextsBasePath();

		try {
			const listing = await this.adapter.list(contextsPath);
			const rootJsonFiles = listing.files.filter(f =>
				f.endsWith('.json') && !f.endsWith(`/${MANIFEST_FILENAME}`)
			);

			if (rootJsonFiles.length === 0) return;

			const defaultFolder = `${contextsPath}/${DEFAULT_WORKSPACE_ID}`;
			if (!await this.adapter.exists(defaultFolder)) {
				await this.adapter.mkdir(defaultFolder);
			}

			for (const filePath of rootJsonFiles) {
				const filename = filePath.split('/').pop();
				if (!filename) continue;
				const target = `${defaultFolder}/${filename}`;
				try {
					if (await this.adapter.exists(target)) {
						Logger.warn(`Migration: ${target} already exists, leaving ${filePath} in place`);
						continue;
					}
					const content = await this.adapter.read(filePath);
					await this.adapter.write(target, content);
					await this.adapter.remove(filePath);
				} catch (e) {
					Logger.warn(`Failed to migrate ${filePath}:`, e);
				}
			}

			// Ensure default workspace is registered post-migration.
			if (!this.workspaceManifest.workspaces[DEFAULT_WORKSPACE_ID]) {
				this.workspaceManifest.workspaces[DEFAULT_WORKSPACE_ID] = {
					displayName: DEFAULT_WORKSPACE_DISPLAY_NAME,
					shared: false,
				};
			}
			this.manifestDirty = true;
			Logger.info(`Migrated ${rootJsonFiles.length} flat context file(s) into default/`);
		} catch (e) {
			Logger.warn('Flat-layout migration check failed:', e);
		}
	}

	private async loadWorkspaceBucket(workspaceId: WorkspaceId): Promise<void> {
		const folder = this.getWorkspaceFolder(workspaceId);
		const bucket = new Map<string, ArrangementCollection>();
		this.cache.set(workspaceId, bucket);

		try {
			if (!await this.adapter.exists(folder)) {
				return; // Empty bucket, nothing to load.
			}

			const listing = await this.adapter.list(folder);
			for (const file of listing.files) {
				if (!file.endsWith('.json')) continue;
				try {
					const content = await this.adapter.read(file);
					const data = JSON.parse(content);
					const uid = file.split('/').pop()?.replace('.json', '');
					if (!uid || !data) continue;

					if (isArrangementCollection(data)) {
						bucket.set(uid, data);
					} else {
						// Migrate legacy single-arrangement format.
						const arrangement = data as WindowArrangementV2;
						const collection: ArrangementCollection = {
							arrangements: [{
								arrangement,
								savedAt: arrangement.ts || Date.now()
							}]
						};
						bucket.set(uid, collection);
						this.markDirty(workspaceId, uid);
					}
				} catch (e) {
					Logger.warn(`Failed to load context file: ${file}`, e);
				}
			}
		} catch (e) {
			Logger.warn(`Failed to list workspace bucket ${workspaceId}:`, e);
		}
	}

	// =========================================================================
	// Workspace lifecycle
	// =========================================================================

	listWorkspaces(): WorkspaceInfo[] {
		return Object.entries(this.workspaceManifest.workspaces).map(([id, info]) => ({
			id,
			displayName: info.displayName,
			shared: info.shared,
		}));
	}

	getActiveWorkspace(): WorkspaceId {
		return this.activeWorkspaceId;
	}

	setActiveWorkspace(workspaceId: WorkspaceId): void {
		this.activeWorkspaceId = workspaceId || DEFAULT_WORKSPACE_ID;
	}

	hasWorkspace(workspaceId: WorkspaceId): boolean {
		return workspaceId in this.workspaceManifest.workspaces;
	}

	/**
	 * Create a new workspace bucket (in the manifest + on disk).
	 * Returns the (possibly suffixed) id actually used.
	 */
	async createWorkspaceBucket(displayName: string, requestedId?: WorkspaceId): Promise<WorkspaceId> {
		let baseId = requestedId ?? slugifyWorkspaceName(displayName);
		let id = baseId;
		let suffix = 2;
		while (this.workspaceManifest.workspaces[id]) {
			id = `${baseId}-${suffix}`;
			suffix++;
		}

		this.workspaceManifest.workspaces[id] = { displayName, shared: false };
		this.manifestDirty = true;
		this.cache.set(id, new Map());

		const folder = this.getWorkspaceFolder(id);
		if (!await this.adapter.exists(folder)) {
			await this.adapter.mkdir(folder);
		}
		await this.writeManifest();
		this.manifestDirty = false;

		return id;
	}

	/**
	 * Rename a workspace bucket's display name. Folder id (slug) is immutable
	 * to avoid path churn — only the manifest's displayName changes.
	 */
	async renameWorkspaceBucket(workspaceId: WorkspaceId, newDisplayName: string): Promise<void> {
		const info = this.workspaceManifest.workspaces[workspaceId];
		if (!info) return;
		info.displayName = newDisplayName;
		await this.writeManifest();
	}

	/**
	 * Delete a workspace bucket and all its arrangements. Refuses for `default`.
	 */
	async deleteWorkspaceBucket(workspaceId: WorkspaceId): Promise<void> {
		if (workspaceId === DEFAULT_WORKSPACE_ID) {
			throw new Error('Cannot delete the default workspace bucket');
		}
		const folder = this.getWorkspaceFolder(workspaceId);
		try {
			if (await this.adapter.exists(folder)) {
				const listing = await this.adapter.list(folder);
				for (const file of listing.files) {
					try {
						await this.adapter.remove(file);
					} catch (e) {
						Logger.warn(`Failed to remove ${file}:`, e);
					}
				}
				try {
					await this.adapter.rmdir(folder, false);
				} catch (e) {
					Logger.warn(`Failed to remove folder ${folder}:`, e);
				}
			}
		} catch (e) {
			Logger.warn(`Failed to delete workspace folder ${folder}:`, e);
		}

		delete this.workspaceManifest.workspaces[workspaceId];
		this.cache.delete(workspaceId);
		this.dirty.delete(workspaceId);
		await this.writeManifest();
	}

	/**
	 * Toggle a workspace bucket between unshared (plugin-dir) and shared
	 * (vault). Physically moves the folder. Refuses for `default`.
	 */
	async setWorkspaceShared(workspaceId: WorkspaceId, shared: boolean): Promise<void> {
		if (workspaceId === DEFAULT_WORKSPACE_ID) {
			throw new Error('Cannot share the default workspace bucket');
		}
		const info = this.workspaceManifest.workspaces[workspaceId];
		if (!info) return;
		if (info.shared === shared) return;

		const oldFolder = this.getWorkspaceFolder(workspaceId);
		info.shared = shared;
		const newFolder = this.getWorkspaceFolder(workspaceId);

		try {
			if (await this.adapter.exists(oldFolder)) {
				if (!await this.adapter.exists(newFolder)) {
					// Create parent path if needed.
					const newParent = newFolder.substring(0, newFolder.lastIndexOf('/'));
					if (newParent && !await this.adapter.exists(newParent)) {
						await this.adapter.mkdir(newParent);
					}
					await this.adapter.mkdir(newFolder);
				}
				const listing = await this.adapter.list(oldFolder);
				for (const file of listing.files) {
					const name = file.split('/').pop();
					if (!name) continue;
					const target = `${newFolder}/${name}`;
					const content = await this.adapter.read(file);
					await this.adapter.write(target, content);
					await this.adapter.remove(file);
				}
				try { await this.adapter.rmdir(oldFolder, false); } catch { /* non-fatal */ }
			}
		} catch (e) {
			// Roll back on failure.
			Logger.error(`Failed to ${shared ? 'share' : 'unshare'} workspace ${workspaceId}:`, e);
			info.shared = !shared;
			throw e;
		}

		await this.writeManifest();
	}

	// =========================================================================
	// Arrangement access — workspace-aware
	// All public methods accept an optional workspaceId; default = active.
	// =========================================================================

	private bucketFor(workspaceId: WorkspaceId): Map<string, ArrangementCollection> {
		let bucket = this.cache.get(workspaceId);
		if (!bucket) {
			bucket = new Map();
			this.cache.set(workspaceId, bucket);
		}
		return bucket;
	}

	private markDirty(workspaceId: WorkspaceId, uid: string): void {
		let set = this.dirty.get(workspaceId);
		if (!set) {
			set = new Set();
			this.dirty.set(workspaceId, set);
		}
		set.add(uid);
	}

	/** Get all arrangements for a UID, sorted newest-first. */
	get(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): TimestampedArrangement[] | null {
		const collection = this.bucketFor(workspaceId).get(uid);
		if (!collection || collection.arrangements.length === 0) return null;
		return [...collection.arrangements].sort((a, b) => b.savedAt - a.savedAt);
	}

	getLatest(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): WindowArrangementV2 | null {
		const collection = this.bucketFor(workspaceId).get(uid);
		if (!collection || collection.arrangements.length === 0) return null;
		const sorted = [...collection.arrangements].sort((a, b) => b.savedAt - a.savedAt);
		return sorted[0].arrangement;
	}

	getAll(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): TimestampedArrangement[] {
		const collection = this.bucketFor(workspaceId).get(uid);
		if (!collection) return [];
		return [...collection.arrangements].sort((a, b) => b.savedAt - a.savedAt);
	}

	getCount(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): number {
		return this.bucketFor(workspaceId).get(uid)?.arrangements.length ?? 0;
	}

	has(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): boolean {
		const collection = this.bucketFor(workspaceId).get(uid);
		return collection !== undefined && collection.arrangements.length > 0;
	}

	set(uid: string, context: WindowArrangementV2, maxArrangements = 1, workspaceId: WorkspaceId = this.activeWorkspaceId): void {
		const bucket = this.bucketFor(workspaceId);
		let collection = bucket.get(uid);
		if (!collection) {
			collection = { arrangements: [] };
		}

		const timestamped: TimestampedArrangement = {
			arrangement: context,
			savedAt: Date.now()
		};
		collection.arrangements.push(timestamped);
		collection.arrangements.sort((a, b) => a.savedAt - b.savedAt);

		while (collection.arrangements.length > maxArrangements) {
			collection.arrangements.shift();
		}

		bucket.set(uid, collection);
		this.markDirty(workspaceId, uid);
		this.scheduleSave();
	}

	deleteArrangement(uid: string, savedAt: number, workspaceId: WorkspaceId = this.activeWorkspaceId): void {
		const bucket = this.bucketFor(workspaceId);
		const collection = bucket.get(uid);
		if (!collection) return;

		collection.arrangements = collection.arrangements.filter(a => a.savedAt !== savedAt);

		if (collection.arrangements.length === 0) {
			bucket.delete(uid);
		} else {
			bucket.set(uid, collection);
		}

		this.markDirty(workspaceId, uid);
		this.scheduleSave();
	}

	async delete(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): Promise<void> {
		const bucket = this.bucketFor(workspaceId);
		bucket.delete(uid);
		this.dirty.get(workspaceId)?.delete(uid);

		const filePath = `${this.getWorkspaceFolder(workspaceId)}/${uid}.json`;
		try {
			if (await this.adapter.exists(filePath)) {
				await this.adapter.remove(filePath);
			}
		} catch (e) {
			Logger.warn(`Failed to delete context file: ${filePath}`, e);
		}
	}

	clearUid(uid: string, workspaceId: WorkspaceId = this.activeWorkspaceId): void {
		const bucket = this.bucketFor(workspaceId);
		const collection = bucket.get(uid);
		if (collection) {
			collection.arrangements = [];
			bucket.set(uid, collection);
			this.markDirty(workspaceId, uid);
		}
	}

	/**
	 * Clear all arrangements across all workspaces. Used by backup restore in
	 * overwrite mode.
	 */
	async clearAll(): Promise<void> {
		for (const wsId of Array.from(this.cache.keys())) {
			const bucket = this.cache.get(wsId);
			if (!bucket) continue;
			for (const uid of Array.from(bucket.keys())) {
				await this.delete(uid, wsId);
			}
			bucket.clear();
			this.dirty.delete(wsId);
		}
	}

	/** All UIDs in the active workspace. */
	getAllUids(workspaceId: WorkspaceId = this.activeWorkspaceId): string[] {
		return Array.from(this.bucketFor(workspaceId).keys());
	}

	/** All UIDs across the listed workspaces (union; deduplicated). */
	getAllUidsAcross(workspaceIds: WorkspaceId[]): string[] {
		const set = new Set<string>();
		for (const wsId of workspaceIds) {
			for (const uid of this.bucketFor(wsId).keys()) {
				set.add(uid);
			}
		}
		return Array.from(set);
	}

	/**
	 * Find which workspaces have arrangements for a given UID.
	 */
	workspacesWithUid(uid: string): WorkspaceId[] {
		const result: WorkspaceId[] = [];
		for (const [wsId, bucket] of this.cache.entries()) {
			const c = bucket.get(uid);
			if (c && c.arrangements.length > 0) result.push(wsId);
		}
		return result;
	}

	// =========================================================================
	// Copy / move arrangements between workspaces
	// =========================================================================

	/**
	 * Copy all arrangements for a UID from one workspace to another.
	 */
	copyArrangements(uid: string, fromWs: WorkspaceId, toWs: WorkspaceId, policy: ConflictPolicy, maxArrangements: number): CopyResult {
		const result: CopyResult = { copied: 0, skipped: 0, overwritten: 0 };
		if (fromWs === toWs) return result;

		const source = this.bucketFor(fromWs).get(uid);
		if (!source || source.arrangements.length === 0) return result;

		const targetBucket = this.bucketFor(toWs);
		const existing = targetBucket.get(uid);

		if (existing && existing.arrangements.length > 0) {
			if (policy === 'skip') {
				result.skipped = source.arrangements.length;
				return result;
			}
			if (policy === 'overwrite') {
				targetBucket.delete(uid);
				result.overwritten = existing.arrangements.length;
			}
		}

		// Merge (or now-empty after overwrite): append, dedupe by savedAt, prune.
		const merged = [...(targetBucket.get(uid)?.arrangements ?? [])];
		for (const ts of source.arrangements) {
			if (!merged.some(m => m.savedAt === ts.savedAt)) {
				merged.push(ts);
				result.copied++;
			} else {
				result.skipped++;
			}
		}
		merged.sort((a, b) => a.savedAt - b.savedAt);
		while (merged.length > maxArrangements) {
			merged.shift();
		}
		targetBucket.set(uid, { arrangements: merged });
		this.markDirty(toWs, uid);
		this.scheduleSave();
		return result;
	}

	moveArrangements(uid: string, fromWs: WorkspaceId, toWs: WorkspaceId, policy: ConflictPolicy, maxArrangements: number): CopyResult {
		const result = this.copyArrangements(uid, fromWs, toWs, policy, maxArrangements);
		if (fromWs !== toWs && (result.copied > 0 || result.overwritten > 0)) {
			// Remove from source.
			const sourceBucket = this.bucketFor(fromWs);
			sourceBucket.delete(uid);
			this.markDirty(fromWs, uid);
			this.scheduleSave();
		}
		return result;
	}

	/**
	 * Bulk copy/move: every UID in fromWs → toWs.
	 */
	bulkCopy(fromWs: WorkspaceId, toWs: WorkspaceId, policy: ConflictPolicy, maxArrangements: number): { uids: number; copied: number; skipped: number; overwritten: number } {
		const stats = { uids: 0, copied: 0, skipped: 0, overwritten: 0 };
		const sourceBucket = this.bucketFor(fromWs);
		for (const uid of Array.from(sourceBucket.keys())) {
			const r = this.copyArrangements(uid, fromWs, toWs, policy, maxArrangements);
			stats.uids++;
			stats.copied += r.copied;
			stats.skipped += r.skipped;
			stats.overwritten += r.overwritten;
		}
		return stats;
	}

	bulkMove(fromWs: WorkspaceId, toWs: WorkspaceId, policy: ConflictPolicy, maxArrangements: number): { uids: number; copied: number; skipped: number; overwritten: number } {
		const stats = { uids: 0, copied: 0, skipped: 0, overwritten: 0 };
		const sourceBucket = this.bucketFor(fromWs);
		for (const uid of Array.from(sourceBucket.keys())) {
			const r = this.moveArrangements(uid, fromWs, toWs, policy, maxArrangements);
			stats.uids++;
			stats.copied += r.copied;
			stats.skipped += r.skipped;
			stats.overwritten += r.overwritten;
		}
		return stats;
	}

	// =========================================================================
	// Persistence
	// =========================================================================

	private scheduleSave(): void {
		if (this.saveTimeoutCleanup) {
			this.saveTimeoutCleanup();
			this.saveTimeoutCleanup = null;
		}
		this.debouncedFlush().catch(error => {
			Logger.error('Failed to flush dirty data:', error);
		});
	}

	async flushDirty(): Promise<void> {
		if (this.dirty.size === 0 && !this.manifestDirty) return;

		if (this.manifestDirty) {
			try {
				await this.writeManifest();
				this.manifestDirty = false;
			} catch (e) {
				Logger.error('Failed to flush manifest:', e);
			}
		}

		let totalSaved = 0;
		for (const [wsId, uidSet] of Array.from(this.dirty.entries())) {
			const folder = this.getWorkspaceFolder(wsId);
			try {
				if (!await this.adapter.exists(folder)) {
					const parent = folder.substring(0, folder.lastIndexOf('/'));
					if (parent && !await this.adapter.exists(parent)) {
						await this.adapter.mkdir(parent);
					}
					await this.adapter.mkdir(folder);
				}
			} catch (e) {
				Logger.error(`Failed to ensure workspace folder ${folder}:`, e);
				continue;
			}

			const toSave = Array.from(uidSet);
			uidSet.clear();

			for (const uid of toSave) {
				const collection = this.bucketFor(wsId).get(uid);
				const filePath = `${folder}/${uid}.json`;

				if (collection && collection.arrangements.length > 0) {
					try {
						const json = JSON.stringify(collection);
						await this.adapter.write(filePath, json);
						totalSaved++;
					} catch (e) {
						Logger.error(`Failed to save context: ${wsId}/${uid}`, e);
						uidSet.add(uid);
					}
				} else {
					try {
						if (await this.adapter.exists(filePath)) {
							await this.adapter.remove(filePath);
						}
					} catch (e) {
						Logger.warn(`Failed to delete empty context file: ${filePath}`, e);
					}
				}
			}

			if (uidSet.size === 0) {
				this.dirty.delete(wsId);
			}
		}

		if (PerfTimer.isEnabled()) {
			Logger.info(`Saved ${totalSaved} context(s) to disk`);
		}
	}

	async cleanup(): Promise<void> {
		if (this.saveTimeoutCleanup) {
			this.saveTimeoutCleanup();
			this.saveTimeoutCleanup = null;
		}
		await this.flushDirty();
	}

	isInitialized(): boolean {
		return this.initialized;
	}

	async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}
	}
}
