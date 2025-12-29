/**
 * Perspecta Settings Tab
 *
 * Tabbed settings interface for the Perspecta plugin.
 * Manages configuration across multiple categories:
 * - Changelog
 * - Context settings
 * - Storage modes (frontmatter vs external)
 * - Backup and restore
 * - Experimental features (proxy windows, wallpaper)
 * - Debug options
 *
 * @module ui/settings-tab
 */

import { App, Notice, Platform, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type PerspectaPlugin from '../main';
import { renderChangelogToContainer } from '../changelog';
import { getWallpaperPlatformNotes } from '../utils/wallpaper';
import { ExtendedApp } from '../types/obsidian-internal';

type SettingsTab = 'changelog' | 'context' | 'storage' | 'backup' | 'experimental' | 'debug';

export class PerspectaSettingTab extends PluginSettingTab {
	plugin: PerspectaPlugin;
	private currentTab: SettingsTab = 'changelog';

	constructor(app: App, plugin: PerspectaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Plugin title
		containerEl.createEl('h1', { text: 'Perspecta', cls: 'perspecta-settings-title' });

		const buildInfo = containerEl.createDiv({ cls: 'setting-item-description' });
		buildInfo.style.marginTop = '6px';
		buildInfo.style.marginBottom = '18px';
		buildInfo.setText(`Version: v${this.plugin.manifest.version}`);
		this.app.vault.adapter.stat(`${this.plugin.manifest.dir}/main.js`).then(stat => {
			if (!stat?.mtime) return;
			buildInfo.setText(`Version: v${this.plugin.manifest.version} (main.js: ${new Date(stat.mtime).toLocaleString()})`);
		}).catch(() => {
			// ignore
		});

		// Create tab navigation
		const tabNav = containerEl.createDiv({ cls: 'perspecta-settings-tabs' });

		const tabs: { id: SettingsTab; label: string }[] = [
			{ id: 'changelog', label: 'Changelog' },
			{ id: 'context', label: 'Context' },
			{ id: 'storage', label: 'Storage' },
			{ id: 'backup', label: 'Backup' },
			{ id: 'experimental', label: 'Experimental' },
			{ id: 'debug', label: 'Debug' }
		];

		tabs.forEach(tab => {
			const tabEl = tabNav.createEl('button', {
				cls: `perspecta-settings-tab ${this.currentTab === tab.id ? 'is-active' : ''}`,
				text: tab.label
			});
			tabEl.addEventListener('click', () => {
				this.currentTab = tab.id;
				this.display();
			});
		});

		// Render content based on current tab
		switch (this.currentTab) {
			case 'changelog':
				this.displayChangelog(containerEl);
				break;
			case 'context':
				this.displayContextSettings(containerEl);
				break;
			case 'storage':
				this.displayStorageSettings(containerEl);
				break;
			case 'backup':
				this.displayBackupSettings(containerEl);
				break;
			case 'experimental':
				this.displayExperimentalSettings(containerEl);
				break;
			case 'debug':
				this.displayDebugSettings(containerEl);
				break;
		}
	}

	private displayChangelog(containerEl: HTMLElement): void {
		renderChangelogToContainer(containerEl);
	}

	private displayContextSettings(containerEl: HTMLElement): void {
		// Display current hotkeys (read-only, configured via Obsidian's Hotkeys settings)
		const saveHotkey = this.getHotkeyDisplay('perspecta-obsidian:save-context');
		const restoreHotkey = this.getHotkeyDisplay('perspecta-obsidian:restore-context');

		new Setting(containerEl)
			.setName('Hotkeys')
			.setDesc('Customize in Settings → Hotkeys')
			.addButton(btn => btn
				.setButtonText(`Save: ${saveHotkey}`)
				.setDisabled(true))
			.addButton(btn => btn
				.setButtonText(`Restore: ${restoreHotkey}`)
				.setDisabled(true));

		new Setting(containerEl).setName('Seconds for focus note highlight').setDesc('0 = disabled')
			.addText(t => t.setValue(String(this.plugin.settings.focusTintDuration)).onChange(async v => {
				const n = parseFloat(v);
				if (!isNaN(n) && n >= 0) { this.plugin.settings.focusTintDuration = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl).setName('Auto-generate file UIDs')
			.setDesc('Automatically add unique IDs to files in saved contexts. This allows files to be found even after moving or renaming.')
			.addToggle(t => t.setValue(this.plugin.settings.autoGenerateUids).onChange(async v => {
				this.plugin.settings.autoGenerateUids = v; await this.plugin.saveSettings();
			}));
	}

	private displayStorageSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Perspecta folder')
			.setDesc('Folder in your vault for Perspecta data (backups, scripts). Created if it doesn\'t exist.')
			.addText(t => t
				.setPlaceholder('perspecta')
				.setValue(this.plugin.settings.perspectaFolderPath)
				.onChange(async v => {
					this.plugin.settings.perspectaFolderPath = v.trim() || 'perspecta';
					await this.plugin.saveSettings();
				}));

		// Obsidian Sync info box
		const syncInfoBox = containerEl.createDiv({ cls: 'perspecta-info-box' });
		const syncInfoIcon = syncInfoBox.createSpan({ cls: 'perspecta-info-box-icon' });
		setIcon(syncInfoIcon, 'info');
		const syncInfoContent = syncInfoBox.createDiv({ cls: 'perspecta-info-box-content' });
		syncInfoContent.createEl('strong', { text: 'Obsidian Sync Users' });
		syncInfoContent.createEl('p', {
			text: 'To sync window arrangements across devices, enable "Sync all other types" in Settings → Sync → Selective sync. This allows JSON context files to sync between your devices.'
		});

		new Setting(containerEl).setName('Store window arrangements in frontmatter')
			.setDesc('When enabled, context data is stored in note frontmatter (syncs with note). When disabled, context is stored externally in the plugin folder (keeps notes cleaner, requires perspecta-uid in frontmatter).')
			.addToggle(t => t.setValue(this.plugin.settings.storageMode === 'frontmatter').onChange(async v => {
				this.plugin.settings.storageMode = v ? 'frontmatter' : 'external';
				await this.plugin.saveSettings();
				// Initialize external store if switching to external mode
				if (!v) {
					await this.plugin.externalStore.initialize();
				}
				// Refresh display to update button visibility
				this.display();
			}));

		// Multi-arrangement settings (only shown for external storage mode)
		if (this.plugin.settings.storageMode === 'external') {
			new Setting(containerEl).setName('Maximum arrangements per note')
				.setDesc('How many window arrangements to store per note. Older arrangements are automatically removed when the limit is reached.')
				.addDropdown(d => d
					.addOptions({
						'1': '1',
						'2': '2',
						'3': '3',
						'4': '4',
						'5': '5'
					})
					.setValue(String(this.plugin.settings.maxArrangementsPerNote))
					.onChange(async v => {
						this.plugin.settings.maxArrangementsPerNote = parseInt(v);
						await this.plugin.saveSettings();
						// Refresh to show/hide auto-confirm option
						this.display();
					}));

			// Auto-confirm only relevant when max is 1
			if (this.plugin.settings.maxArrangementsPerNote === 1) {
				new Setting(containerEl).setName('Auto-confirm overwrite')
					.setDesc('Skip confirmation when overwriting an existing arrangement. Only applies when storing a single arrangement per note.')
					.addToggle(t => t.setValue(this.plugin.settings.autoConfirmOverwrite).onChange(async v => {
						this.plugin.settings.autoConfirmOverwrite = v;
						await this.plugin.saveSettings();
					}));
			}
		}

		// Migration buttons - show based on current storage mode
		if (this.plugin.settings.storageMode === 'frontmatter') {
			new Setting(containerEl)
				.setName('Migrate to external storage')
				.setDesc('Move all context data from note frontmatter to the plugin folder. This cleans up your notes by removing perspecta-arrangement properties.')
				.addButton(btn => btn
					.setButtonText('Migrate to external')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Migrating...');
						try {
							const result = await this.plugin.migrateToExternalStorage();
							new Notice(`Migration complete: ${result.migrated} contexts moved${result.errors > 0 ? `, ${result.errors} errors` : ''}`, 4000);
							this.display(); // Refresh to show updated state
						} catch (e) {
							new Notice('Migration failed: ' + (e as Error).message, 4000);
							btn.setDisabled(false);
							btn.setButtonText('Migrate to external');
						}
					}));
		} else {
			new Setting(containerEl)
				.setName('Migrate to frontmatter')
				.setDesc('Move all context data from the plugin folder into note frontmatter. This makes contexts portable with your notes.')
				.addButton(btn => btn
					.setButtonText('Migrate to frontmatter')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Migrating...');
						try {
							const result = await this.plugin.migrateToFrontmatter();
							new Notice(`Migration complete: ${result.migrated} contexts moved${result.errors > 0 ? `, ${result.errors} errors` : ''}`, 4000);
							this.display(); // Refresh to show updated state
						} catch (e) {
							new Notice('Migration failed: ' + (e as Error).message, 4000);
							btn.setDisabled(false);
							btn.setButtonText('Migrate to frontmatter');
						}
					}));
		}

		new Setting(containerEl)
			.setName('Clean up old uid properties')
			.setDesc('Remove obsolete "uid" properties from notes that already have "perspecta-uid". This cleans up leftover data from earlier versions.')
			.addButton(btn => btn
				.setButtonText('Clean up')
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('Cleaning...');
					try {
						const count = await this.plugin.cleanupOldUidProperties();
						new Notice(count > 0 ? `Cleaned up ${count} file${count > 1 ? 's' : ''}` : 'No old uid properties found', 4000);
					} catch (e) {
						new Notice('Cleanup failed: ' + (e as Error).message, 4000);
					}
					btn.setDisabled(false);
					btn.setButtonText('Clean up');
				}));
	}

	private displayBackupSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Backup arrangements')
			.setDesc(`Create a backup of all stored arrangements to the ${this.plugin.settings.perspectaFolderPath}/backups folder.`)
			.addButton(btn => btn
				.setButtonText('Create backup')
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('Backing up...');
					try {
						const result = await this.plugin.backupArrangements();
						new Notice(`Backup created: ${result.count} arrangements saved to ${result.path}`, 4000);
						this.display(); // Refresh to show new backup in restore list
					} catch (e) {
						new Notice('Backup failed: ' + (e as Error).message, 4000);
					}
					btn.setDisabled(false);
					btn.setButtonText('Create backup');
				}));

		// Restore from backup
		new Setting(containerEl)
			.setName('Restore from backup')
			.setDesc('Restore arrangements from a previous backup. This will overwrite existing arrangements with the same UIDs.');

		// Create backup list container below the setting
		const backupListContainer = containerEl.createDiv({ cls: 'perspecta-backup-list-container' });

		// Fetch available backups and create list
		this.plugin.listBackups().then(backups => {
			if (backups.length === 0) {
				backupListContainer.createDiv({
					cls: 'perspecta-backup-empty',
					text: 'No backups available'
				});
			} else {
				backups.forEach(backup => {
					const item = backupListContainer.createDiv({ cls: 'perspecta-backup-item' });

					const info = item.createDiv({ cls: 'perspecta-backup-info' });
					info.createDiv({ cls: 'perspecta-backup-name', text: backup.name });
					info.createDiv({
						cls: 'perspecta-backup-date',
						text: backup.date.toLocaleString()
					});

					const restoreBtn = item.createEl('button', {
						cls: 'perspecta-backup-restore-btn',
						text: 'Restore'
					});

					restoreBtn.addEventListener('click', async () => {
						restoreBtn.disabled = true;
						restoreBtn.textContent = 'Restoring...';
						try {
							const result = await this.plugin.restoreFromBackup(backup.path);
							if (result.cancelled) {
								// User cancelled, no notice needed
							} else {
								new Notice(`Restore complete: ${result.restored} arrangements restored${result.errors > 0 ? `, ${result.errors} errors` : ''}`, 4000);
							}
						} catch (e) {
							new Notice('Restore failed: ' + (e as Error).message, 4000);
						}
						restoreBtn.disabled = false;
						restoreBtn.textContent = 'Restore';
					});
				});
			}
		});
	}

	private displayExperimentalSettings(containerEl: HTMLElement): void {
		// Warning banner
		const warning = containerEl.createDiv({ cls: 'perspecta-experimental-warning' });
		warning.createSpan({ cls: 'perspecta-experimental-warning-icon', text: '⚠️' });
		warning.createSpan({ text: 'These features are experimental and may change or break in future updates.' });

		// Performance section
		containerEl.createEl('h4', { text: 'Performance' });

		new Setting(containerEl)
			.setName('Parallel popout window creation')
			.setDesc('Create popout windows in parallel instead of sequentially. Can improve restoration speed by 30-50% when restoring multiple popout windows.')
			.addToggle(t => t.setValue(this.plugin.settings.enableParallelPopoutCreation).onChange(async v => {
				this.plugin.settings.enableParallelPopoutCreation = v;
				await this.plugin.saveSettings();
			}));

		// Proxy windows section
		containerEl.createEl('h4', { text: 'Proxy windows' });

		new Setting(containerEl)
			.setName('Enable proxy windows')
			.setDesc('Allows converting popout windows to minimalist "proxy" windows that show only the note title. Click the title to restore its arrangement.')
			.addToggle(t => t.setValue(this.plugin.settings.enableProxyWindows).onChange(async v => {
				this.plugin.settings.enableProxyWindows = v;
				await this.plugin.saveSettings();
				// Refresh to show/hide related options
				this.display();
			}));

		if (this.plugin.settings.enableProxyWindows) {
			new Setting(containerEl)
				.setName('Preview scale')
				.setDesc('Scale factor for the note preview in proxy windows (10% to 100%)')
				.addSlider(slider => slider
					.setLimits(10, 100, 5)
					.setValue(this.plugin.settings.proxyPreviewScale * 100)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.proxyPreviewScale = value / 100;
						await this.plugin.saveSettings();
					}));

			const infoDiv = containerEl.createDiv({ cls: 'setting-item-description' });
			infoDiv.style.marginTop = '12px';
			infoDiv.style.marginBottom = '12px';
			// Build instructions using safe DOM methods (no innerHTML)
			const strongEl = infoDiv.createEl('strong');
			strongEl.textContent = 'How to use:';
			infoDiv.createEl('br');
			infoDiv.appendText('• Use command "Convert to proxy window" on any popout window');
			infoDiv.createEl('br');
			infoDiv.appendText('• The proxy shows a scaled preview of the note content');
			infoDiv.createEl('br');
			infoDiv.appendText('• Click the expand icon (↗) to restore the full window');
			infoDiv.createEl('br');
			infoDiv.appendText('• If the note has a saved arrangement, click anywhere to restore it');
		}

		// Wallpaper settings
		containerEl.createEl('h4', { text: 'Desktop wallpaper' });

		new Setting(containerEl)
			.setName('Save wallpaper with context')
			.setDesc('Capture the current desktop wallpaper when saving a context. The wallpaper can be restored when switching between projects.')
			.addToggle(t => t.setValue(this.plugin.settings.enableWallpaperCapture).onChange(async v => {
				this.plugin.settings.enableWallpaperCapture = v;
				await this.plugin.saveSettings();
				this.display();
			}));

		// Only show additional wallpaper options when capture is enabled
		if (this.plugin.settings.enableWallpaperCapture) {
			new Setting(containerEl)
				.setName('Restore wallpaper with context')
				.setDesc('Automatically change the desktop wallpaper to match the saved context when restoring.')
				.addToggle(t => t.setValue(this.plugin.settings.enableWallpaperRestore).onChange(async v => {
					this.plugin.settings.enableWallpaperRestore = v;
					await this.plugin.saveSettings();
				}));

			new Setting(containerEl)
				.setName('Store wallpapers in vault')
				.setDesc(`Copy wallpapers to ${this.plugin.settings.perspectaFolderPath}/wallpapers/ for portability. When disabled, the original system path is stored.`)
				.addToggle(t => t.setValue(this.plugin.settings.storeWallpapersLocally).onChange(async v => {
					this.plugin.settings.storeWallpapersLocally = v;
					await this.plugin.saveSettings();
				}));
		}

		const wallpaperInfoDiv = containerEl.createDiv({ cls: 'setting-item-description' });
		wallpaperInfoDiv.style.marginTop = '12px';
		wallpaperInfoDiv.style.marginBottom = '12px';
		// Platform support info
		const platformStrong = wallpaperInfoDiv.createEl('strong');
		platformStrong.textContent = 'Platform support:';
		wallpaperInfoDiv.appendText(' ' + getWallpaperPlatformNotes());
	}

	private displayDebugSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Show debug modal on save')
			.setDesc('Show a modal with context details when saving')
			.addToggle(t => t.setValue(this.plugin.settings.showDebugModal).onChange(async v => {
				this.plugin.settings.showDebugModal = v; await this.plugin.saveSettings();
			}));

		new Setting(containerEl).setName('Show debug modal on restore')
			.setDesc('Show a modal comparing stored vs actual state after restoring')
			.addToggle(t => t.setValue(this.plugin.settings.showDebugModalOnRestore).onChange(async v => {
				this.plugin.settings.showDebugModalOnRestore = v; await this.plugin.saveSettings();
			}));

		new Setting(containerEl).setName('Enable debug logging')
			.setDesc('Log performance timing to the developer console (Cmd+Shift+I)')
			.addToggle(t => t.setValue(this.plugin.settings.enableDebugLogging).onChange(async v => {
				this.plugin.settings.enableDebugLogging = v; await this.plugin.saveSettings();
			}));
	}

	private getHotkeyDisplay(commandId: string): string {
		// Access Obsidian's internal hotkey manager to get current hotkey for a command
		const extApp = this.app as ExtendedApp;
		const hotkeyManager = extApp.hotkeyManager;
		if (!hotkeyManager) return 'Not set';

		// Get custom hotkeys first, then fall back to defaults
		const customHotkeys = hotkeyManager.customKeys?.[commandId];
		const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
		const hotkeys = customHotkeys?.length ? customHotkeys : defaultHotkeys;

		if (!hotkeys || hotkeys.length === 0) return 'Not set';

		const hotkey = hotkeys[0];
		const parts: string[] = [];

		// Use platform-appropriate modifier display
		const isMac = Platform.isMacOS;
		if (hotkey.modifiers?.includes('Mod')) {
			parts.push(isMac ? '⌘' : 'Ctrl');
		}
		if (hotkey.modifiers?.includes('Ctrl')) {
			parts.push(isMac ? '⌃' : 'Ctrl');
		}
		if (hotkey.modifiers?.includes('Alt')) {
			parts.push(isMac ? '⌥' : 'Alt');
		}
		if (hotkey.modifiers?.includes('Shift')) {
			parts.push(isMac ? '⇧' : 'Shift');
		}
		if (hotkey.modifiers?.includes('Meta')) {
			parts.push(isMac ? '⌘' : 'Win');
		}

		parts.push(hotkey.key?.toUpperCase() || '?');
		return parts.join(isMac ? '' : '+');
	}
}
