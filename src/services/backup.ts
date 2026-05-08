// ============================================================================
// Backup Service
// ----------------------------------------------------------------------------
// Backs up and restores arrangement data stored in the external store.
// Backups are timestamped JSON files written to <perspectaFolder>/backups/.
//
// Frontmatter-mode arrangements are NOT backed up by this module — they live
// in the user's notes and are part of the user's normal vault backup. Only
// the external store (.obsidian/plugins/perspecta-obsidian/contexts/) is
// vulnerable to plugin removal/reinstall, which is why a backup feature
// exists in the first place.
// ============================================================================

import { App, Notice } from 'obsidian';
import { ExternalContextStore } from '../storage/external-store';
import { WindowArrangementV2 } from '../types';
import { showRestoreModeSelector, RestoreMode } from '../ui/modals';
import { Logger } from '../utils/logger';

export interface BackupConfig {
	app: App;
	externalStore: ExternalContextStore;
	/** Vault-relative path to the perspecta folder (no trailing slash). */
	perspectaFolderPath: string;
	/** Maximum arrangements to keep per UID when restoring in merge mode. */
	maxArrangementsPerNote: number;
	/** Called after a successful restore to refresh file-explorer indicators. */
	onAfterRestore: () => Promise<void>;
}

function getBackupFolderPath(perspectaFolderPath: string): string {
	const basePath = perspectaFolderPath.replace(/\/+$/, '');
	return `${basePath}/backups`;
}

/**
 * Write all external-store arrangements to a timestamped JSON file.
 * Returns the file path and the count of UIDs backed up.
 */
export async function backupArrangements(
	cfg: Pick<BackupConfig, 'app' | 'externalStore' | 'perspectaFolderPath'>
): Promise<{ count: number; path: string }> {
	const { app, externalStore, perspectaFolderPath } = cfg;

	await externalStore.ensureInitialized();

	const allArrangements: Record<string, unknown> = {};
	const uids = externalStore.getAllUids();

	for (const uid of uids) {
		const arrangements = externalStore.getAll(uid);
		if (arrangements.length > 0) {
			allArrangements[uid] = arrangements;
		}
	}

	const backupFolder = getBackupFolderPath(perspectaFolderPath);
	if (!(await app.vault.adapter.exists(backupFolder))) {
		await app.vault.createFolder(backupFolder);
	}

	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const backupFileName = `arrangements-backup-${timestamp}.json`;
	const backupPath = `${backupFolder}/${backupFileName}`;

	const backupData = {
		version: 1,
		createdAt: now.toISOString(),
		arrangementCount: Object.keys(allArrangements).length,
		arrangements: allArrangements,
	};

	await app.vault.create(backupPath, JSON.stringify(backupData, null, 2));

	return { count: Object.keys(allArrangements).length, path: backupPath };
}

/**
 * List all backup files in the backups folder, newest first.
 */
export async function listBackups(
	cfg: Pick<BackupConfig, 'app' | 'perspectaFolderPath'>
): Promise<{ name: string; path: string; date: Date }[]> {
	const { app, perspectaFolderPath } = cfg;
	const backupFolder = getBackupFolderPath(perspectaFolderPath);

	if (!(await app.vault.adapter.exists(backupFolder))) {
		return [];
	}

	const files = await app.vault.adapter.list(backupFolder);
	const backups: { name: string; path: string; date: Date }[] = [];

	for (const filePath of files.files) {
		if (!filePath.endsWith('.json')) continue;

		const fileName = filePath.split('/').pop() || '';
		// arrangements-backup-YYYY-MM-DDTHH-MM-SS.json
		const match = fileName.match(/arrangements-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json/);
		if (!match) continue;

		const dateStr = match[1].replace(/-/g, (m, offset) => (offset > 9 ? ':' : '-')).replace('T', 'T');
		const date = new Date(dateStr.slice(0, 10) + 'T' + dateStr.slice(11).replace(/-/g, ':'));
		backups.push({ name: fileName, path: filePath, date });
	}

	backups.sort((a, b) => b.date.getTime() - a.date.getTime());
	return backups;
}

/**
 * Restore arrangements from a backup file.
 *
 * - `mode = 'overwrite'`: clears the external store first, then restores.
 * - `mode = 'merge'`: combines backup with existing per UID, keeping the
 *   newest `maxArrangementsPerNote` entries.
 * - `mode` undefined: shows the mode selector modal.
 */
export async function restoreFromBackup(
	cfg: BackupConfig,
	backupPath: string,
	mode?: RestoreMode
): Promise<{ restored: number; errors: number; cancelled?: boolean }> {
	const { app, externalStore, maxArrangementsPerNote, onAfterRestore } = cfg;
	const backupName = backupPath.split('/').pop() || 'backup';

	if (!mode) {
		const result = await showRestoreModeSelector(backupName);
		if (result.cancelled) {
			return { restored: 0, errors: 0, cancelled: true };
		}
		mode = result.mode;
	}

	let backupData: { arrangements?: Record<string, unknown> };
	try {
		const content = await app.vault.adapter.read(backupPath);
		backupData = JSON.parse(content);
	} catch (e) {
		Logger.error('Failed to parse backup file:', e);
		new Notice('Failed to parse backup file. The file may be corrupted.');
		return { restored: 0, errors: 1 };
	}

	if (!backupData.arrangements || typeof backupData.arrangements !== 'object') {
		new Notice('Invalid backup file format');
		return { restored: 0, errors: 1 };
	}

	await externalStore.ensureInitialized();

	let restored = 0;
	let errors = 0;

	if (mode === 'overwrite') {
		await externalStore.clearAll();
	}

	for (const [uid, arrangements] of Object.entries(backupData.arrangements)) {
		try {
			const backupArrangements = arrangements as Array<{ arrangement: WindowArrangementV2; savedAt: number }>;

			if (mode === 'merge') {
				const existing = externalStore.get(uid) || [];
				const combined = [...existing];

				for (const backupItem of backupArrangements) {
					const alreadyExists = combined.some(e => e.savedAt === backupItem.savedAt);
					if (!alreadyExists) {
						combined.push(backupItem);
					}
				}

				combined.sort((a, b) => b.savedAt - a.savedAt);
				const trimmed = combined.slice(0, maxArrangementsPerNote);

				externalStore.clearUid(uid);
				for (const item of trimmed) {
					externalStore.set(uid, item.arrangement, maxArrangementsPerNote);
				}
			} else {
				// overwrite: just restore from backup
				for (const item of backupArrangements) {
					externalStore.set(uid, item.arrangement, maxArrangementsPerNote);
				}
			}
			restored++;
		} catch (e) {
			Logger.error(`Failed to restore arrangements for UID ${uid}:`, e);
			errors++;
		}
	}

	await externalStore.flushDirty();
	await onAfterRestore();

	return { restored, errors };
}
