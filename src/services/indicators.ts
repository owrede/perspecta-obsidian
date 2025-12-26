/**
 * File Explorer Indicators Service
 *
 * Manages visual indicators in the file explorer for files that have saved contexts.
 * Uses incremental updates via metadata cache events for better performance.
 *
 * @module services/indicators
 */

import { App, TFile, setIcon } from 'obsidian';
import { FRONTMATTER_KEY } from '../types';
import { canvasHasContext } from '../storage/canvas';
import { baseHasContext } from '../storage/base';
import { getUidFromCache } from '../utils/uid';
import { ExternalContextStore } from '../storage/external-store';
import { PerfTimer } from '../utils/perf-timer';

/**
 * Configuration for the indicators service.
 */
export interface IndicatorsConfig {
	app: App;
	externalStore: ExternalContextStore;
	getStorageMode: () => 'frontmatter' | 'external';
	isClosingWindow: () => boolean;
	isUnloading: () => boolean;
}

/**
 * File Explorer Indicators Service
 *
 * Tracks files with saved contexts and renders visual indicators
 * in the file explorer.
 */
export class IndicatorsService {
	private app: App;
	private externalStore: ExternalContextStore;
	private getStorageMode: () => 'frontmatter' | 'external';
	private isClosingWindow: () => boolean;
	private isUnloading: () => boolean;
	
	private filesWithContext = new Set<string>();
	private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
	private eventUnsubscribers: (() => void)[] = [];

	constructor(config: IndicatorsConfig) {
		this.app = config.app;
		this.externalStore = config.externalStore;
		this.getStorageMode = config.getStorageMode;
		this.isClosingWindow = config.isClosingWindow;
		this.isUnloading = config.isUnloading;
	}

	/**
	 * Initialize the service: scan for existing contexts and set up event listeners.
	 */
	async initialize(): Promise<void> {
		PerfTimer.begin('IndicatorsService.initialize');
		
		await this.scanForContextFiles();
		this.setupEventListeners();
		
		// Initial render after a short delay to let the file explorer load
		setTimeout(() => this.refresh(), 500);
		
		PerfTimer.end('IndicatorsService.initialize');
	}

	/**
	 * Clean up resources.
	 */
	cleanup(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.eventUnsubscribers.forEach(unsub => unsub());
		this.eventUnsubscribers = [];
		this.filesWithContext.clear();
	}

	/**
	 * Check if a file has a saved context.
	 */
	hasContext(path: string): boolean {
		return this.filesWithContext.has(path);
	}

	/**
	 * Get all file paths that have saved contexts.
	 */
	getFilesWithContext(): string[] {
		return Array.from(this.filesWithContext);
	}

	/**
	 * Manually add a file to the context tracking set.
	 * Call after saving a new context.
	 */
	markFileHasContext(path: string): void {
		this.filesWithContext.add(path);
		this.debouncedRefresh();
	}

	/**
	 * Manually remove a file from the context tracking set.
	 * Call after removing a context.
	 */
	markFileNoContext(path: string): void {
		this.filesWithContext.delete(path);
		this.debouncedRefresh();
	}

	/**
	 * Scan all files for existing contexts.
	 */
	private async scanForContextFiles(): Promise<void> {
		const mdFiles = this.app.vault.getMarkdownFiles();
		PerfTimer.mark(`getMarkdownFiles (${mdFiles.length} files)`);

		// Scan for markdown files with context in frontmatter
		for (const file of mdFiles) {
			if (this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY]) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark('scanForContextFiles (frontmatter)');

		// Scan for canvas files with context
		const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
		for (const file of canvasFiles) {
			if (await canvasHasContext(this.app, file)) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark(`scanForContextFiles (canvas: ${canvasFiles.length} files)`);

		// Scan for base files with context
		const baseFiles = this.app.vault.getFiles().filter(f => f.extension === 'base');
		for (const file of baseFiles) {
			if (await baseHasContext(this.app, file)) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark(`scanForContextFiles (base: ${baseFiles.length} files)`);

		// If using external storage, also check for files whose UIDs have saved contexts
		if (this.getStorageMode() === 'external') {
			await this.externalStore.ensureInitialized();
			const uidsWithContext = this.externalStore.getAllUids();
			for (const file of mdFiles) {
				const uid = getUidFromCache(this.app, file);
				if (uid && uidsWithContext.includes(uid)) {
					this.filesWithContext.add(file.path);
				}
			}
			PerfTimer.mark('scanForContextFiles (external)');
		}
	}

	/**
	 * Set up event listeners for incremental updates.
	 */
	private setupEventListeners(): void {
		// Metadata changes (frontmatter updates)
		const metadataRef = this.app.metadataCache.on('changed', (file) => {
			if (this.isClosingWindow() || this.isUnloading()) return;
			if (['md', 'canvas', 'base'].includes(file.extension)) {
				this.updateFileIndicator(file);
			}
		});
		this.eventUnsubscribers.push(() => this.app.metadataCache.offref(metadataRef));

		// File renames
		const renameRef = this.app.vault.on('rename', (file, oldPath) => {
			if (this.isClosingWindow() || this.isUnloading()) return;
			if (this.filesWithContext.has(oldPath)) {
				this.filesWithContext.delete(oldPath);
				this.filesWithContext.add(file.path);
				this.debouncedRefresh();
			}
		});
		this.eventUnsubscribers.push(() => this.app.vault.offref(renameRef));

		// File deletions
		const deleteRef = this.app.vault.on('delete', (file) => {
			if (this.isClosingWindow() || this.isUnloading()) return;
			if (this.filesWithContext.has(file.path)) {
				this.filesWithContext.delete(file.path);
				this.debouncedRefresh();
			}
		});
		this.eventUnsubscribers.push(() => this.app.vault.offref(deleteRef));

		// Layout changes (file explorer visibility)
		const layoutRef = this.app.workspace.on('layout-change', () => {
			this.debouncedRefresh();
		});
		this.eventUnsubscribers.push(() => this.app.workspace.offref(layoutRef));
	}

	/**
	 * Update indicator for a single file.
	 */
	private async updateFileIndicator(file: TFile): Promise<void> {
		let hasContext = false;

		if (file.extension === 'canvas') {
			hasContext = await canvasHasContext(this.app, file);
		} else if (file.extension === 'base') {
			hasContext = await baseHasContext(this.app, file);
		} else {
			// Markdown files: check frontmatter
			hasContext = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] !== null;

			// Also check external storage if enabled
			if (!hasContext && this.getStorageMode() === 'external') {
				const uid = getUidFromCache(this.app, file);
				if (uid && this.externalStore.has(uid)) {
					hasContext = true;
				}
			}
		}

		if (hasContext) {
			this.filesWithContext.add(file.path);
		} else {
			this.filesWithContext.delete(file.path);
		}
		
		this.debouncedRefresh();
	}

	/**
	 * Debounced refresh to batch multiple updates.
	 */
	private debouncedRefresh(): void {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			if (this.isClosingWindow()) {
				this.refreshTimeout = null;
				return;
			}
			this.refresh();
			this.refreshTimeout = null;
		}, 100);
	}

	/**
	 * Refresh all indicators in the file explorer.
	 */
	private refresh(): void {
		PerfTimer.begin('IndicatorsService.refresh');
		
		// Remove all existing indicators
		document.querySelectorAll('.nav-file-title .perspecta-context-indicator').forEach(el => el.remove());
		PerfTimer.mark('removeOldIndicators');

		// Add indicators for files with context
		this.filesWithContext.forEach(path => {
			const el = document.querySelector(`.nav-file-title[data-path="${CSS.escape(path)}"]`);
			if (el && !el.querySelector('.perspecta-context-indicator')) {
				const icon = this.createTargetIcon();
				icon.setAttribute('aria-label', 'Has saved context');
				el.insertBefore(icon, el.firstChild);
			}
		});
		
		PerfTimer.mark(`addIndicators (${this.filesWithContext.size} files)`);
		PerfTimer.end('IndicatorsService.refresh');
	}

	/**
	 * Create the target icon element for indicators.
	 */
	private createTargetIcon(): HTMLSpanElement {
		const span = document.createElement('span');
		span.classList.add('perspecta-context-indicator');
		setIcon(span, 'target');
		return span;
	}
}
