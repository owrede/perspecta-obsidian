// ============================================================================
// Storage Migrations & Housekeeping
// ----------------------------------------------------------------------------
// Functions that move arrangement data between the two storage modes
// (frontmatter ↔ external) and clean up legacy frontmatter properties.
//
// These functions take the storage stores and an indicator-refresh
// callback as parameters — no plugin-instance coupling, so they can
// be unit-tested with mocked stores.
// ============================================================================

import { App } from 'obsidian';
import { ExternalContextStore } from '../storage/external-store';
import {
	getContextFromFrontmatter,
	removeContextFromFrontmatter,
	saveContextToFrontmatter,
} from '../storage/frontmatter-store';
import { WindowArrangement, WindowArrangementV1, WindowArrangementV2 } from '../types';
import { briefPause } from '../utils/async-utils';
import { Logger } from '../utils/logger';
import { addUidToFile, cleanupOldUid, generateUid, getUidFromCache } from '../utils/uid';

export interface MigrationConfig {
	app: App;
	externalStore: ExternalContextStore;
	/**
	 * Called after migration completes. Implementations typically refresh
	 * file-explorer indicators and persist the storageMode setting.
	 */
	onAfterMigrate: (newMode: 'frontmatter' | 'external') => Promise<void>;
}

/**
 * Strip the legacy `uid` frontmatter property from any markdown file that
 * already has the canonical `perspecta-uid`. Returns the count of files
 * cleaned. Safe to run repeatedly — does nothing on already-clean files.
 */
export async function cleanupOldUidProperties(app: App): Promise<number> {
	const files = app.vault.getMarkdownFiles();
	let cleaned = 0;

	for (const file of files) {
		try {
			if (await cleanupOldUid(app, file)) {
				cleaned++;
			}
		} catch (e) {
			Logger.warn(`Failed to cleanup ${file.path}:`, e);
		}
	}

	return cleaned;
}

/**
 * Move all frontmatter-stored arrangements into the external store.
 * Each migrated file gets a UID added if it didn't already have one,
 * and the perspecta-arrangement line is stripped from its frontmatter.
 */
export async function migrateToExternalStorage(
	cfg: MigrationConfig
): Promise<{ migrated: number; errors: number }> {
	const { app, externalStore, onAfterMigrate } = cfg;
	const files = app.vault.getMarkdownFiles();
	let migrated = 0;
	let errors = 0;

	await externalStore.ensureInitialized();

	for (const file of files) {
		try {
			const context = getContextFromFrontmatter(app, file);
			if (!context) continue;

			let uid = getUidFromCache(app, file);
			if (!uid) {
				uid = generateUid();
				await addUidToFile(app, file, uid);
				await briefPause(); // give the metadata cache a moment
			}

			const v2 = normalizeToV2(context);
			externalStore.set(uid, v2);

			await removeContextFromFrontmatter(app, file);

			migrated++;
		} catch (e) {
			Logger.error(`Failed to migrate ${file.path}:`, e);
			errors++;
		}
	}

	await externalStore.flushDirty();
	await onAfterMigrate('external');

	return { migrated, errors };
}

/**
 * Move all external-store arrangements back into note frontmatter.
 * The external entry is deleted only after the frontmatter write succeeds.
 */
export async function migrateToFrontmatter(
	cfg: MigrationConfig
): Promise<{ migrated: number; errors: number }> {
	const { app, externalStore, onAfterMigrate } = cfg;
	const files = app.vault.getMarkdownFiles();
	let migrated = 0;
	let errors = 0;

	await externalStore.ensureInitialized();

	for (const file of files) {
		try {
			const uid = getUidFromCache(app, file);
			if (!uid) continue;

			const context = externalStore.getLatest(uid);
			if (!context) continue;

			await saveContextToFrontmatter(app, file, context);
			await externalStore.delete(uid);

			migrated++;
		} catch (e) {
			Logger.error(`Failed to migrate ${file.path}:`, e);
			errors++;
		}
	}

	await onAfterMigrate('frontmatter');

	return { migrated, errors };
}

/**
 * Promote a v1 arrangement to v2 in-place. v1 stored a flat tabs array;
 * v2 wraps each window's tabs in a tab-group node so splits can be expressed.
 *
 * Exported so the migration tools can normalise old-format frontmatter
 * arrangements found during migrateToExternalStorage.
 */
export function normalizeToV2(arr: WindowArrangement): WindowArrangementV2 {
	if (arr.v === 2) return arr as WindowArrangementV2;

	const v1 = arr as WindowArrangementV1;
	return {
		v: 2,
		ts: v1.ts,
		focusedWindow: v1.focusedWindow,
		main: {
			root: { type: 'tabs', tabs: v1.main.tabs },
			x: v1.main.x,
			y: v1.main.y,
			width: v1.main.width,
			height: v1.main.height,
		},
		popouts: v1.popouts.map(p => ({
			root: { type: 'tabs', tabs: p.tabs },
			x: p.x,
			y: p.y,
			width: p.width,
			height: p.height,
		})),
		leftSidebar: v1.leftSidebar,
		rightSidebar: v1.rightSidebar,
	};
}
