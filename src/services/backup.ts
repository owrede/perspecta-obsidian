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
//
// Format v2 (current) is workspace-aware:
//   { version: 2, createdAt, workspaces: {
//       <wsId>: { displayName, shared, arrangements: { <uid>: [...] } }
//   } }
//
// Format v1 (legacy) is read-only: all UIDs restored into the `default`
// bucket.
// ============================================================================

import { App, Notice } from 'obsidian';
import { ExternalContextStore } from '../storage/external-store';
import { WindowArrangementV2, DEFAULT_WORKSPACE_ID, WorkspaceId } from '../types';
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

interface BackupV1 {
	version: 1;
	createdAt: string;
	arrangementCount: number;
	arrangements: Record<string, Array<{ arrangement: WindowArrangementV2; savedAt: number }>>;
}

interface BackupV2WorkspaceEntry {
	displayName: string;
	shared: boolean;
	arrangements: Record<string, Array<{ arrangement: WindowArrangementV2; savedAt: number }>>;
}

interface BackupV2 {
	version: 2;
	createdAt: string;
	workspaceCount: number;
	totalArrangementCount: number;
	workspaces: Record<WorkspaceId, BackupV2WorkspaceEntry>;
}

function getBackupFolderPath(perspectaFolderPath: string): string {
	const basePath = perspectaFolderPath.replace(/\/+$/, '');
	return `${basePath}/backups`;
}

/**
 * Write all external-store arrangements to a timestamped JSON file.
 */
export async function backupArrangements(
	cfg: Pick<BackupConfig, 'app' | 'externalStore' | 'perspectaFolderPath'>
): Promise<{ count: number; path: string }> {
	const { app, externalStore, perspectaFolderPath } = cfg;

	await externalStore.ensureInitialized();

	const workspaces: Record<WorkspaceId, BackupV2WorkspaceEntry> = {};
	let totalArrangements = 0;

	for (const ws of externalStore.listWorkspaces()) {
		const uids = externalStore.getAllUids(ws.id);
		const arrangements: Record<string, Array<{ arrangement: WindowArrangementV2; savedAt: number }>> = {};
		for (const uid of uids) {
			const items = externalStore.getAll(uid, ws.id);
			if (items.length > 0) {
				arrangements[uid] = items;
				totalArrangements += items.length;
			}
		}
		workspaces[ws.id] = {
			displayName: ws.displayName,
			shared: ws.shared,
			arrangements,
		};
	}

	const backupFolder = getBackupFolderPath(perspectaFolderPath);
	if (!(await app.vault.adapter.exists(backupFolder))) {
		await app.vault.createFolder(backupFolder);
	}

	const now = new Date();
	const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const backupFileName = `arrangements-backup-${timestamp}.json`;
	const backupPath = `${backupFolder}/${backupFileName}`;

	const backupData: BackupV2 = {
		version: 2,
		createdAt: now.toISOString(),
		workspaceCount: Object.keys(workspaces).length,
		totalArrangementCount: totalArrangements,
		workspaces,
	};

	await app.vault.create(backupPath, JSON.stringify(backupData, null, 2));

	const uidCount = Object.values(workspaces).reduce((sum, w) => sum + Object.keys(w.arrangements).length, 0);
	return { count: uidCount, path: backupPath };
}

/**
 * List all backup files, newest first.
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
		const match = fileName.match(/arrangements-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json/);
		if (!match) continue;

		const dateStr = match[1].replace(/-/g, (m, offset) => (offset > 9 ? ':' : '-')).replace('T', 'T');
		const date = new Date(dateStr.slice(0, 10) + 'T' + dateStr.slice(11).replace(/-/g, ':'));
		backups.push({ name: fileName, path: filePath, date });
	}

	backups.sort((a, b) => b.date.getTime() - a.date.getTime());
	return backups;
}

function isV1(data: unknown): data is BackupV1 {
	return typeof data === 'object' && data !== null && (data as { version?: number }).version === 1;
}

function isV2(data: unknown): data is BackupV2 {
	return typeof data === 'object' && data !== null && (data as { version?: number }).version === 2;
}

/**
 * Restore arrangements from a backup file. Both v1 (legacy, single bucket) and
 * v2 (workspace-aware) are supported.
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

	let parsed: unknown;
	try {
		const content = await app.vault.adapter.read(backupPath);
		parsed = JSON.parse(content);
	} catch (e) {
		Logger.error('Failed to parse backup file:', e);
		new Notice('Failed to parse backup file. The file may be corrupted.');
		return { restored: 0, errors: 1 };
	}

	await externalStore.ensureInitialized();

	// Normalize either format into a workspace → uid → arrangements map.
	const normalized: Record<WorkspaceId, Record<string, Array<{ arrangement: WindowArrangementV2; savedAt: number }>>> = {};

	if (isV2(parsed)) {
		// Ensure all workspaces in the backup exist (recreate if missing).
		for (const [wsId, entry] of Object.entries(parsed.workspaces)) {
			if (!externalStore.hasWorkspace(wsId)) {
				try {
					await externalStore.createWorkspaceBucket(entry.displayName, wsId);
				} catch (e) {
					Logger.warn(`Failed to recreate workspace ${wsId}:`, e);
				}
			}
			normalized[wsId] = entry.arrangements;
		}
	} else if (isV1(parsed)) {
		// Legacy: everything goes into default.
		normalized[DEFAULT_WORKSPACE_ID] = parsed.arrangements;
	} else {
		new Notice('Invalid backup file format');
		return { restored: 0, errors: 1 };
	}

	let restored = 0;
	let errors = 0;

	if (mode === 'overwrite') {
		await externalStore.clearAll();
	}

	for (const [wsId, uidMap] of Object.entries(normalized)) {
		for (const [uid, backupArrangements] of Object.entries(uidMap)) {
			try {
				if (mode === 'merge') {
					const existing = externalStore.get(uid, wsId) || [];
					const combined = [...existing];
					for (const backupItem of backupArrangements) {
						if (!combined.some(e => e.savedAt === backupItem.savedAt)) {
							combined.push(backupItem);
						}
					}
					combined.sort((a, b) => b.savedAt - a.savedAt);
					const trimmed = combined.slice(0, maxArrangementsPerNote);
					externalStore.clearUid(uid, wsId);
					for (const item of trimmed) {
						externalStore.set(uid, item.arrangement, maxArrangementsPerNote, wsId);
					}
				} else {
					for (const item of backupArrangements) {
						externalStore.set(uid, item.arrangement, maxArrangementsPerNote, wsId);
					}
				}
				restored++;
			} catch (e) {
				Logger.error(`Failed to restore arrangements for UID ${uid} in workspace ${wsId}:`, e);
				errors++;
			}
		}
	}

	await externalStore.flushDirty();
	await onAfterRestore();

	return { restored, errors };
}
