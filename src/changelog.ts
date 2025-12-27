// ============================================================================
// Changelog Data - Single Source of Truth
// This file is used to generate both the settings UI changelog and CHANGELOG.md
// ============================================================================

export interface ChangelogEntry {
	version: string;
	date?: string;
	changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
	{
		version: '0.1.16',
		date: '2025-12-27',
		changes: [
			'Fixed: Add defensive geometry validation to prevent freezes on Windows',
			'Fixed: Validate all geometry before window.moveTo/resizeTo operations',
			'Fixed: Guard against NaN, negative, zero, and extremely large coordinate values',
			'Fixed: Limit maximum popouts to 20 to prevent runaway window creation',
			'Fixed: Add try/catch around openPopoutLeaf and openFile calls',
			'Improved: Log warnings for invalid data to aid debugging',
		],
	},
	{
		version: '0.1.15',
		date: '2025-12-26',
		changes: [
			'Performance: Incremental file explorer indicator updates via metadata events',
			'Refactor: New base64 utility replacing deprecated escape/unescape functions',
			'Refactor: Added ensureInitialized() API to external context store',
			'Refactor: Extracted IndicatorsService for better code organization',
			'Fixed: All 19 lint errors resolved, reduced warnings from 91 to 77',
			'Fixed: Backup restore now handles malformed files gracefully',
			'Fixed: File context menu now works for canvas and base files',
			'Improved: Better type safety with unknown instead of any in event handlers',
			'Improved: Consistent use of helper functions for internal API access',
		],
	},
	{
		version: '0.1.14',
		date: '2025-12-20',
		changes: [
			'Internal improvements and bug fixes',
		],
	},
	{
		version: '0.1.13',
		date: '2025-12-06',
		changes: [
			'Experimental: Save and restore desktop wallpaper with context',
			'Wallpaper support for macOS (AppleScript), Windows (PowerShell), Linux (GNOME)',
			'New settings to enable wallpaper capture and restore independently',
		],
	},
	{
		version: '0.1.12',
		date: '2025-12-06',
		changes: [
			'Save and restore active sidebar panel (File Explorer, Search, Bookmarks, etc.)',
			'Improved sidebar state capture with multiple fallback methods',
		],
	},
	{
		version: '0.1.11',
		date: '2025-12-06',
		changes: [
			'Proxy windows now show image thumbnails for image files',
			'Proxy windows show file type icon for PDFs and other binary files',
			'Fixed broken display when converting image/PDF windows to proxy',
		],
	},
	{
		version: '0.1.10',
		date: '2025-12-06',
		changes: [
			'Hide perspecta-uid property from Properties view (still visible in source mode)',
		],
	},
	{
		version: '0.1.9',
		date: '2025-12-06',
		changes: [
			'Removed excess padding from proxy window preview content',
			'Fixed bottom margin in proxy windows',
		],
	},
	{
		version: '0.1.8',
		date: '2025-12-06',
		changes: [
			'Unified changelog system - single source of truth for all changelogs',
			'Added CHANGELOG.md file auto-generated from changelog data',
			'Reorganized README features to match settings pane structure',
			'Added Convert to proxy window command documentation',
			'Added backup reminder to external storage warning',
		],
	},
	{
		version: '0.1.7',
		date: '2025-12-06',
		changes: [
			'Proxy windows now show scaled markdown preview of note content',
			'Draggable title bar - drag header to move proxy window',
			'Scrollable content - use mouse wheel or arrow keys to scroll preview',
			'Keyboard navigation: ↑/↓, j/k, Page Up/Down, Home/End, Enter/Space',
			'Configurable preview scale factor in Experimental settings (default 35%)',
			'Canvas viewport and zoom level now saved and restored',
			'Context indicator (target icon) now appears correctly in popout windows',
			'Fixed duplicate proxy windows when restoring contexts',
			'Fixed concurrent restore guard to prevent window duplication',
		],
	},
	{
		version: '0.1.6',
		date: '2025-12-05',
		changes: [
			'Experimental: Proxy windows - minimalist window showing only note title',
			'Click proxy to restore latest arrangement, Shift+click for selector',
			'Click proxy without arrangement to expand to full window',
			'Proxy window positions and sizes saved/restored with arrangements',
			'Added Experimental settings tab to enable/disable proxy windows',
			'Fixed notifications not auto-dismissing (4 second timeout)',
			'Notifications and focus tints no longer appear in proxy windows',
		],
	},
	{
		version: '0.1.3',
		date: '2025-12-04',
		changes: [
			'Multi-arrangement storage: store up to 5 arrangements per note',
			'Arrangement selector modal with visual SVG previews',
			'Delete button to remove specific arrangements from history',
			'Confirmation dialog when overwriting single arrangement',
			'Backup & restore functionality to perspecta folder',
			'SVG previews show windows, splits, sidebars, and focus highlight',
			'Instant tooltips on SVG areas showing note names',
			'Renamed "Focus tint duration" setting for clarity',
			'Fixed notification toast not disappearing',
		],
	},
	{
		version: '0.1.2',
		changes: [
			'Improved plugin compliance with Obsidian guidelines',
		],
	},
	{
		version: '0.1.1',
		changes: [
			'Save and restore scroll position for all tabs',
			'Save and restore split sizes (pane proportions)',
		],
	},
	{
		version: '0.1.0',
		changes: [
			'Initial release',
			'Save and restore window arrangements (tabs, splits, popouts)',
			'External storage mode for cleaner notes',
			'Frontmatter storage mode for portability',
			'Auto-generate UIDs for file tracking',
			'Context indicators in file explorer',
			'Focus tint animation on restore',
		],
	},
];

/**
 * Render the changelog into an HTML container element (for Obsidian settings)
 */
export function renderChangelogToContainer(containerEl: HTMLElement): void {
	containerEl.createEl('h2', { text: 'Changelog' });

	for (const entry of CHANGELOG) {
		const versionDiv = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		versionDiv.createEl('h3', { text: `v${entry.version}` });

		const list = versionDiv.createEl('ul');
		for (const change of entry.changes) {
			list.createEl('li', { text: change });
		}
	}
}

/**
 * Generate markdown changelog content (for CHANGELOG.md)
 */
export function generateChangelogMarkdown(): string {
	const lines: string[] = [
		'# Changelog',
		'',
		'All notable changes to Perspecta will be documented in this file.',
		'',
	];

	for (const entry of CHANGELOG) {
		lines.push(`## [${entry.version}]${entry.date ? ` - ${entry.date}` : ''}`);
		lines.push('');
		for (const change of entry.changes) {
			lines.push(`- ${change}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}
