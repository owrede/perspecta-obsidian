import { App, Menu, MenuItem, Platform, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, WorkspaceLeaf, Notice, setIcon } from 'obsidian';

// Import types
import {
	TabState,
	SplitState,
	TabGroupState,
	WorkspaceNodeState,
	WindowStateV1,
	WindowStateV2,
	SidebarState,
	ScreenInfo,
	WindowArrangementV1,
	WindowArrangementV2,
	WindowArrangement,
	PerspectaSettings,
	DEFAULT_SETTINGS,
	FRONTMATTER_KEY,
	UID_FRONTMATTER_KEY,
	TimestampedArrangement
} from './types';

// Import utilities
import { PerfTimer } from './utils/perf-timer';
import {
	setCoordinateDebug,
	getPhysicalScreen,
	physicalToVirtual,
	virtualToPhysical,
	needsTiling,
	calculateTiledLayout
} from './utils/coordinates';
import { generateUid, getUidFromCache, addUidToFile, cleanupOldUid } from './utils/uid';

// Import storage
import {
	getContextFromFrontmatter,
	markdownHasContext,
	saveContextToMarkdown
} from './storage/markdown';
import {
	getUidFromCanvas,
	getContextFromCanvas,
	addUidToCanvas,
	saveContextToCanvas,
	canvasHasContext
} from './storage/canvas';
import {
	getUidFromBase,
	getContextFromBase,
	addUidToBase,
	saveContextToBase,
	baseHasContext
} from './storage/base';
import { ExternalContextStore } from './storage/external-store';

// Import UI components
import { showArrangementSelector, showConfirmOverwrite } from './ui/modals';
import { ProxyNoteView, PROXY_VIEW_TYPE, ProxyViewState } from './ui/proxy-view';

// ============================================================================
// Unified file helpers (works for markdown, canvas, and base files)
// ============================================================================

// Get UID from file (works for markdown, canvas, and base)
async function getUidFromFile(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension === 'canvas') {
		return getUidFromCanvas(app, file);
	}
	if (file.extension === 'base') {
		return getUidFromBase(app, file);
	}
	return getUidFromCache(app, file);
}

// Add UID to file (works for markdown, canvas, and base)
async function addUidToAnyFile(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension === 'canvas') {
		await addUidToCanvas(app, file, uid);
	} else if (file.extension === 'base') {
		await addUidToBase(app, file, uid);
	} else {
		await addUidToFile(app, file, uid);
	}
}

// Resolve a file using fallback strategy: path → UID → filename
function resolveFile(app: App, tab: TabState): { file: TFile | null; method: 'path' | 'uid' | 'name' | 'not_found' } {
	const fileByPath = app.vault.getAbstractFileByPath(tab.path);
	if (fileByPath instanceof TFile) {
		return { file: fileByPath, method: 'path' };
	}

	if (tab.uid) {
		const files = app.vault.getMarkdownFiles();
		for (const file of files) {
			const fileUid = getUidFromCache(app, file);
			if (fileUid === tab.uid) {
				return { file, method: 'uid' };
			}
		}
	}

	if (tab.name) {
		const files = app.vault.getMarkdownFiles();
		const matches = files.filter(f => f.basename === tab.name);
		if (matches.length === 1) {
			return { file: matches[0], method: 'name' };
		}
	}

	return { file: null, method: 'not_found' };
}

// Global debug flag for coordinate conversions
let COORDINATE_DEBUG = false;

// ============================================================================
// Main Plugin Class
// ============================================================================

export default class PerspectaPlugin extends Plugin {
	settings: PerspectaSettings;
	private focusedWindowIndex: number = -1;
	private windowFocusListeners: Map<Window, () => void> = new Map();
	private filesWithContext = new Set<string>();
	private refreshIndicatorsTimeout: ReturnType<typeof setTimeout> | null = null;
	private isClosingWindow = false; // Guard against operations during window close
	externalStore: ExternalContextStore;  // External context storage

	async onload() {
		await this.loadSettings();

		// Initialize external store
		this.externalStore = new ExternalContextStore({ app: this.app, manifest: this.manifest });
		if (this.settings.storageMode === 'external') {
			await this.externalStore.initialize();
		}

		// Register proxy view (experimental)
		this.registerView(PROXY_VIEW_TYPE, (leaf) => new ProxyNoteView(leaf));

		this.addRibbonIcon('layout-grid', 'Perspecta', () => {});

		this.addCommand({
			id: 'save-context',
			name: 'Save context',
			callback: () => this.saveContext()
		});

		this.addCommand({
			id: 'restore-context',
			name: 'Restore context',
			callback: () => this.restoreContext()
		});

		this.addCommand({
			id: 'show-context-details',
			name: 'Show context details',
			callback: () => this.showContextDetails()
		});

		this.addCommand({
			id: 'convert-to-proxy',
			name: 'Convert to proxy window',
			checkCallback: (checking: boolean) => {
				// Only available if proxy windows are enabled
				if (!this.settings.enableProxyWindows) return false;

				// Only available in popout windows
				const activeLeaf = this.app.workspace.activeLeaf;
				if (!activeLeaf) return false;

				const win = activeLeaf.view.containerEl.win;
				if (!win || win === window) return false; // Must be a popout, not main window

				const file = (activeLeaf.view as any)?.file as TFile | undefined;
				if (!file) return false;

				if (!checking) {
					this.convertToProxyWindow(activeLeaf, file);
				}
				return true;
			}
		});

		this.setupFocusTracking();
		this.setupContextIndicator();
		this.setupFileExplorerIndicators();

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item: MenuItem) => {
						item.setTitle('Remember note context').setIcon('target')
							.onClick(() => this.saveContext(file));
					});
				}
			})
		);

		this.registerDomEvent(document, 'auxclick', (evt: MouseEvent) => {
			if (evt.button === 1) {
				const link = (evt.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement;
				if (link) {
					evt.preventDefault();
					const href = link.getAttribute('data-href');
					if (href) {
						const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
						if (file instanceof TFile) this.openInNewWindow(file);
					}
				}
			}
		});

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			if (evt.altKey && evt.button === 0) {
				const link = (evt.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement;
				if (link) {
					evt.preventDefault();
					evt.stopPropagation();
					const href = link.getAttribute('data-href');
					if (href) {
						const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
						if (file instanceof TFile) this.openInNewWindow(file);
					}
				}
			}
		}, true);

		this.addSettingTab(new PerspectaSettingTab(this.app, this));
	}

	async onunload() {
		// Cleanup external store (flush pending saves)
		await this.externalStore.cleanup();

		this.windowFocusListeners.forEach((listener, win) => {
			win.removeEventListener('focus', listener);
		});
		this.windowFocusListeners.clear();
	}

	// ============================================================================
	// Focus Tracking
	// ============================================================================

	private setupFocusTracking() {
		this.registerDomEvent(window, 'focus', () => this.focusedWindowIndex = -1);
		this.registerEvent(
			this.app.workspace.on('window-open', (_: any, win: Window) => {
				this.trackPopoutWindowFocus(win);
			})
		);
		this.registerEvent(
			this.app.workspace.on('window-close', (_: any, win: Window) => {
				// Debug timing (uncomment to debug window close performance)
				// const start = performance.now();
				// console.log(`[Perspecta] Window close event START`);

				// Set guard to prevent other handlers from doing work during close
				this.isClosingWindow = true;

				// Clean up our focus listener for this window
				const listener = this.windowFocusListeners.get(win);
				if (listener) {
					win.removeEventListener('focus', listener);
					this.windowFocusListeners.delete(win);
				}

				// Debug timing (uncomment to debug window close performance)
				// const elapsed = performance.now() - start;
				// console.log(`[Perspecta] Window close event END (${elapsed.toFixed(1)}ms)`);

				// Reset guard after a short delay to allow Obsidian to finish cleanup
				setTimeout(() => {
					this.isClosingWindow = false;
				}, 100);

				// Debug: Check if main thread gets blocked after our handler (uncomment to debug)
				// const closeTime = performance.now();
				// setTimeout(() => {
				// 	const delay = performance.now() - closeTime;
				// 	if (delay > 100) {
				// 		console.warn(`[Perspecta] ⚠ Main thread was blocked for ${delay.toFixed(0)}ms after window close`);
				// 	}
				// }, 0);
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (this.isClosingWindow) {
					// console.log(`[Perspecta] layout-change skipped (window closing)`);
					return;
				}
				// console.log(`[Perspecta] layout-change event`);
			})
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (this.isClosingWindow) return;
				// Debug: uncomment to log leaf changes
				// const path = (leaf?.view as any)?.file?.path || 'unknown';
				// console.log(`[Perspecta] active-leaf-change: ${path}`);
			})
		);
	}

	private trackPopoutWindowFocus(win: Window) {
		if (this.windowFocusListeners.has(win)) return;
		const listener = () => {
			// Skip if we're in the middle of closing a window
			if (this.isClosingWindow) {
				// console.log(`[Perspecta] popoutFocusHandler skipped (window closing)`);
				return;
			}
			PerfTimer.begin('popoutFocusHandler');
			const popouts = this.getPopoutWindowObjects();
			PerfTimer.mark('getPopoutWindowObjects');
			this.focusedWindowIndex = popouts.indexOf(win);
			PerfTimer.end('popoutFocusHandler');
		};
		win.addEventListener('focus', listener);
		this.windowFocusListeners.set(win, listener);
	}

	// ============================================================================
	// Window Arrangement Capture (Optimized)
	// ============================================================================

	private captureWindowArrangement(): WindowArrangementV2 {
		PerfTimer.mark('captureWindowArrangement:start');
		const workspace = this.app.workspace as any;

		const main = this.captureWindowState(workspace.rootSplit, window);
		PerfTimer.mark('captureMainWindow');

		const popouts = this.capturePopoutStates();
		PerfTimer.mark('capturePopouts');

		const leftSidebar = this.captureSidebarState('left');
		const rightSidebar = this.captureSidebarState('right');
		PerfTimer.mark('captureSidebars');

		// Capture source screen info for cross-screen restoration
		const screen = getPhysicalScreen();
		const sourceScreen: ScreenInfo = {
			width: screen.width,
			height: screen.height,
			aspectRatio: screen.width / screen.height
		};

		return {
			v: 2,
			ts: Date.now(),
			main,
			popouts,
			focusedWindow: this.focusedWindowIndex,
			leftSidebar,
			rightSidebar,
			sourceScreen
		};
	}

	private captureWindowState(rootSplit: any, win: Window): WindowStateV2 {
		const physical = {
			x: win.screenX,
			y: win.screenY,
			width: win.outerWidth,
			height: win.outerHeight
		};

		// Convert physical coordinates to virtual coordinate system
		const virtual = physicalToVirtual(physical);

		console.log(`[Perspecta] captureWindowState:`, { physical, virtual });

		return {
			root: this.captureSplitOrTabs(rootSplit),
			x: virtual.x,
			y: virtual.y,
			width: virtual.width,
			height: virtual.height
		};
	}

	private capturePopoutStates(): WindowStateV2[] {
		const states: WindowStateV2[] = [];
		const workspace = this.app.workspace as any;
		const floatingSplit = workspace.floatingSplit;
		if (!floatingSplit?.children) return states;

		for (const container of floatingSplit.children) {
			const win = container?.win;
			if (!win || win === window) continue;

			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] capturePopoutStates container:`, {
					containerType: container?.constructor?.name,
					containerDirection: container?.direction,
					containerChildren: container?.children?.length,
					firstChildType: container?.children?.[0]?.constructor?.name,
					firstChildDirection: container?.children?.[0]?.direction
				});
			}

			// The container itself may be a split (when popout has multiple panes)
			// or it may contain a single tab group. We capture from the container level.
			if (container?.children?.length > 0) {
				// Convert physical coordinates to virtual coordinate system
				const virtual = physicalToVirtual({
					x: win.screenX,
					y: win.screenY,
					width: win.outerWidth,
					height: win.outerHeight
				});

				// Check if this is a proxy window
				const isProxy = this.isProxyWindow(container);

				// Capture from the container - it handles both splits and single tab groups
				states.push({
					root: this.captureSplitOrTabs(container),
					x: virtual.x,
					y: virtual.y,
					width: virtual.width,
					height: virtual.height,
					isProxy
				});
			}
		}
		return states;
	}

	/**
	 * Check if a popout container contains a proxy view
	 */
	private isProxyWindow(container: any): boolean {
		if (!container?.children) return false;

		// Check all leaves in this container for proxy view type
		for (const child of container.children) {
			// Direct leaf check
			if (child?.view?.getViewType?.() === PROXY_VIEW_TYPE) {
				return true;
			}
			// Check nested children (for tab groups)
			if (child?.children) {
				for (const leaf of child.children) {
					if (leaf?.view?.getViewType?.() === PROXY_VIEW_TYPE) {
						return true;
					}
				}
			}
		}
		return false;
	}

	private captureSplitOrTabs(node: any): WorkspaceNodeState {
		if (!node) return { type: 'tabs', tabs: [] };

		if (node.direction && Array.isArray(node.children)) {
			const children: WorkspaceNodeState[] = [];
			const sizes: number[] = [];

			for (const child of node.children) {
				const childState = this.captureSplitOrTabs(child);
				if (childState.type === 'split' || childState.tabs.length > 0) {
					children.push(childState);
					// Capture the size/dimension of each child
					// Obsidian uses 'dimension' property for split sizes
					const size = child.dimension ?? child.size ?? child.width ?? child.height;
					sizes.push(size ?? 50); // Default to 50 if not found
				}
			}
			if (children.length === 1) return children[0];
			if (children.length === 0) return { type: 'tabs', tabs: [] };

			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] captureSplitOrTabs: direction=${node.direction}, children=${children.length}, sizes=${JSON.stringify(sizes)}`);
				// Debug: log all properties on the first child to discover size property
				if (node.children[0]) {
					const props = Object.keys(node.children[0]).filter(k =>
						typeof node.children[0][k] === 'number' ||
						(typeof node.children[0][k] === 'string' && !k.startsWith('_'))
					);
					console.log(`[Perspecta] Child properties:`, props.map(p => `${p}=${node.children[0][p]}`));
				}
			}

			return { type: 'split', direction: node.direction, children, sizes };
		}
		return this.captureTabGroup(node);
	}

	private captureTabGroup(tabContainer: any): TabGroupState {
		const tabs: TabState[] = [];
		const children = tabContainer?.children || [];

		// Get the active leaf within THIS tab container (not the global active leaf)
		// tabContainer.currentTab is the index of the active tab in this group
		const currentTabIndex = tabContainer?.currentTab ?? 0;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] captureTabGroup: ${children.length} children, currentTab=${tabContainer?.currentTab}, using index=${currentTabIndex}`);
		}

		for (let i = 0; i < children.length; i++) {
			const leaf = children[i];
			const file = (leaf?.view as any)?.file as TFile | undefined;
			if (file) {
				// Get UID from frontmatter cache (if exists)
				const uid = getUidFromCache(this.app, file);
				// Get filename without extension for fallback search
				const name = file.basename;
				// Get scroll position if available
				const scroll = (leaf?.view as any)?.currentMode?.getScroll?.();

				const isActive = i === currentTabIndex;
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   tab[${i}]: ${file.basename}, active=${isActive}, scroll=${scroll}`);
				}

				tabs.push({
					path: file.path,
					active: isActive,
					uid,
					name,
					scroll: typeof scroll === 'number' ? scroll : undefined
				});
			}
		}
		return { type: 'tabs', tabs };
	}

	private captureSidebarState(side: 'left' | 'right'): SidebarState {
		const workspace = this.app.workspace as any;
		const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;
		if (!sidebar) return { collapsed: true };

		let activeTab: string | undefined;
		try {
			const leaf = side === 'left' ? workspace.leftLeaf : workspace.rightLeaf;
			activeTab = leaf?.view?.getViewType?.();
		} catch { /* ignore */ }

		return { collapsed: sidebar.collapsed ?? false, activeTab };
	}

	private getPopoutWindowObjects(): Window[] {
		const start = performance.now();
		const windows: Window[] = [];
		const seen = new Set<Window>([window]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.view?.containerEl?.win;
			if (win && !seen.has(win)) {
				seen.add(win);
				windows.push(win);
			}
		});
		const elapsed = performance.now() - start;
		if (elapsed > 20) {
			console.warn(`[Perspecta] ⚠ SLOW getPopoutWindowObjects: ${elapsed.toFixed(1)}ms`);
		}
		return windows;
	}

	// ============================================================================
	// Context Save (Optimized)
	// ============================================================================

	async saveContext(file?: TFile) {
		PerfTimer.begin('saveContext');

		const targetFile = file ?? this.app.workspace.getActiveFile();
		PerfTimer.mark('getActiveFile');

		if (!targetFile) {
			new Notice('No active file to save context to', 4000);
			return;
		}

		// Check for supported file types
		const isMarkdown = targetFile.extension === 'md';
		const isCanvas = targetFile.extension === 'canvas';
		const isBase = targetFile.extension === 'base';

		if (!isMarkdown && !isCanvas && !isBase) {
			new Notice(`Cannot save context to ${targetFile.extension} files. Please use a markdown, canvas, or base file.`, 4000);
			PerfTimer.end('saveContext');
			return;
		}

		let context = this.captureWindowArrangement();
		PerfTimer.mark('captureWindowArrangement');

		// Auto-generate UIDs for files that don't have them (always needed for external storage)
		if (this.settings.autoGenerateUids || this.settings.storageMode === 'external') {
			context = await this.ensureUidsForContext(context);
			PerfTimer.mark('ensureUidsForContext');
		}

		// Save based on file type and storage mode
		let saved = true;
		if (isCanvas) {
			// Canvas files always store context in the JSON
			await saveContextToCanvas(this.app, targetFile, context);
			this.filesWithContext.add(targetFile.path);
			this.debouncedRefreshIndicators();
			PerfTimer.mark('saveContextToCanvas');
		} else if (isBase) {
			// Base files always store context in the YAML
			await saveContextToBase(this.app, targetFile, context);
			this.filesWithContext.add(targetFile.path);
			this.debouncedRefreshIndicators();
			PerfTimer.mark('saveContextToBase');
		} else if (this.settings.storageMode === 'external') {
			saved = await this.saveContextExternal(targetFile, context);
			PerfTimer.mark('saveContextExternal');
		} else {
			await this.saveArrangementToNote(targetFile, context);
			PerfTimer.mark('saveArrangementToNote');
		}

		// Only show confirmation if save was not cancelled
		if (saved) {
			if (this.settings.showDebugModal) {
				this.showContextDebugModal(context, targetFile.name);
				PerfTimer.mark('showContextDebugModal');
			} else {
				new Notice(`Context saved to ${targetFile.name}`, 4000);
			}
		}

		PerfTimer.end('saveContext');
	}

	// Save context to external store (using file's UID as key)
	// Returns true if save was successful, false if cancelled
	private async saveContextExternal(file: TFile, context: WindowArrangementV2): Promise<boolean> {
		// Get the file's UID (must exist since we ensured UIDs above)
		let uid = getUidFromCache(this.app, file);
		if (!uid) {
			// Fallback: add UID now if somehow missing
			uid = generateUid();
			await addUidToFile(this.app, file, uid);
			// Wait for cache update
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		// Initialize external store if not already
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		const maxArrangements = this.settings.maxArrangementsPerNote;
		const existingCount = this.externalStore.getCount(uid);

		// If max is 1 and there's already an arrangement, ask for confirmation (unless auto-confirm is on)
		if (maxArrangements === 1 && existingCount > 0 && !this.settings.autoConfirmOverwrite) {
			const existingArrangements = this.externalStore.getAll(uid);
			if (existingArrangements.length > 0) {
				const result = await showConfirmOverwrite(existingArrangements[0], file.name);
				if (!result.confirmed) {
					return false; // User cancelled
				}
			}
		}

		this.externalStore.set(uid, context, maxArrangements);

		// Remove perspecta-arrangement from frontmatter (if present) to avoid duplication
		await this.removeArrangementFromFrontmatter(file);

		this.filesWithContext.add(file.path);
		this.debouncedRefreshIndicators();
		return true;
	}

	// Remove perspecta-arrangement property from a file's frontmatter
	private async removeArrangementFromFrontmatter(file: TFile): Promise<boolean> {
		const content = await this.app.vault.read(file);
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);

		if (!match) return false;

		const fm = match[1];
		// Check if arrangement exists in frontmatter
		if (!fm.includes(`${FRONTMATTER_KEY}:`)) return false;

		// Remove arrangement (both old multi-line YAML and new single-line format)
		let newFm = fm
			.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')  // Old multi-line
			.replace(/perspecta-arrangement: ".*"\n?/g, '')  // New single-line
			.trim();

		// If frontmatter is empty now (except whitespace), we could remove it entirely
		// but better to keep it if there's other content
		const newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);

		if (newContent !== content) {
			await this.app.vault.modify(file, newContent);
			return true;
		}
		return false;
	}

	// ============================================================================
	// Storage Migration & Cleanup
	// ============================================================================

	// Clean up old 'uid' properties from all files that have perspecta-uid
	async cleanupOldUidProperties(): Promise<number> {
		const files = this.app.vault.getMarkdownFiles();
		let cleaned = 0;

		for (const file of files) {
			try {
				if (await cleanupOldUid(this.app, file)) {
					cleaned++;
				}
			} catch (e) {
				console.warn(`[Perspecta] Failed to cleanup ${file.path}:`, e);
			}
		}

		return cleaned;
	}

	// Migrate all contexts from frontmatter to external storage
	async migrateToExternalStorage(): Promise<{ migrated: number; errors: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let migrated = 0;
		let errors = 0;

		// Initialize external store
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		for (const file of files) {
			try {
				// Check if file has context in frontmatter
				const context = this.getContextFromNote(file);
				if (!context) continue;

				// Ensure file has a UID
				let uid = getUidFromCache(this.app, file);
				if (!uid) {
					uid = generateUid();
					await addUidToFile(this.app, file, uid);
					await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause for cache
				}

				// Save to external store
				const v2 = this.normalizeToV2(context);
				this.externalStore.set(uid, v2);

				// Remove from frontmatter
				await this.removeArrangementFromFrontmatter(file);

				migrated++;
			} catch (e) {
				console.error(`[Perspecta] Failed to migrate ${file.path}:`, e);
				errors++;
			}
		}

		// Flush to disk
		await this.externalStore.flushDirty();

		// Update settings
		this.settings.storageMode = 'external';
		await this.saveSettings();

		// Refresh indicators
		this.filesWithContext.clear();
		await this.setupFileExplorerIndicators();

		return { migrated, errors };
	}

	// Migrate all contexts from external storage to frontmatter
	async migrateToFrontmatter(): Promise<{ migrated: number; errors: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let migrated = 0;
		let errors = 0;

		// Initialize external store to load all contexts
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		for (const file of files) {
			try {
				// Check if file has a UID with stored context
				const uid = getUidFromCache(this.app, file);
				if (!uid) continue;

				const context = this.externalStore.get(uid);
				if (!context) continue;

				// Save to frontmatter
				await this.saveArrangementToNote(file, context);

				// Delete from external store
				await this.externalStore.delete(uid);

				migrated++;
			} catch (e) {
				console.error(`[Perspecta] Failed to migrate ${file.path}:`, e);
				errors++;
			}
		}

		// Update settings
		this.settings.storageMode = 'frontmatter';
		await this.saveSettings();

		// Refresh indicators
		this.filesWithContext.clear();
		await this.setupFileExplorerIndicators();

		return { migrated, errors };
	}

	// Get the backup folder path
	private getBackupFolderPath(): string {
		const basePath = this.settings.perspectaFolderPath.replace(/\/+$/, ''); // Remove trailing slashes
		return `${basePath}/backups`;
	}

	// Backup all arrangements to the perspecta folder
	async backupArrangements(): Promise<{ count: number; path: string }> {
		// Initialize external store if needed
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		// Collect all arrangements from external store
		const allArrangements: Record<string, unknown> = {};
		const uids = this.externalStore.getAllUids();

		for (const uid of uids) {
			const arrangements = this.externalStore.getAll(uid);
			if (arrangements.length > 0) {
				allArrangements[uid] = arrangements;
			}
		}

		// Create backup folder if it doesn't exist
		const backupFolder = this.getBackupFolderPath();
		if (!await this.app.vault.adapter.exists(backupFolder)) {
			await this.app.vault.createFolder(backupFolder);
		}

		// Generate backup filename with timestamp
		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const backupFileName = `arrangements-backup-${timestamp}.json`;
		const backupPath = `${backupFolder}/${backupFileName}`;

		// Create backup data with metadata
		const backupData = {
			version: 1,
			createdAt: now.toISOString(),
			arrangementCount: Object.keys(allArrangements).length,
			arrangements: allArrangements
		};

		// Write backup file
		await this.app.vault.create(backupPath, JSON.stringify(backupData, null, 2));

		return { count: Object.keys(allArrangements).length, path: backupPath };
	}

	// List available backups
	async listBackups(): Promise<{ name: string; path: string; date: Date }[]> {
		const backupFolder = this.getBackupFolderPath();

		if (!await this.app.vault.adapter.exists(backupFolder)) {
			return [];
		}

		const files = await this.app.vault.adapter.list(backupFolder);
		const backups: { name: string; path: string; date: Date }[] = [];

		for (const filePath of files.files) {
			if (filePath.endsWith('.json')) {
				const fileName = filePath.split('/').pop() || '';
				// Parse date from filename: arrangements-backup-YYYY-MM-DDTHH-MM-SS.json
				const match = fileName.match(/arrangements-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json/);
				if (match) {
					const dateStr = match[1].replace(/-/g, (m, offset) => offset > 9 ? ':' : '-').replace('T', 'T');
					const date = new Date(dateStr.slice(0, 10) + 'T' + dateStr.slice(11).replace(/-/g, ':'));
					backups.push({ name: fileName, path: filePath, date });
				}
			}
		}

		// Sort by date, newest first
		backups.sort((a, b) => b.date.getTime() - a.date.getTime());
		return backups;
	}

	// Restore arrangements from a backup file
	async restoreFromBackup(backupPath: string): Promise<{ restored: number; errors: number }> {
		// Read backup file
		const content = await this.app.vault.adapter.read(backupPath);
		const backupData = JSON.parse(content);

		if (!backupData.arrangements || typeof backupData.arrangements !== 'object') {
			throw new Error('Invalid backup file format');
		}

		// Initialize external store if needed
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		let restored = 0;
		let errors = 0;

		for (const [uid, arrangements] of Object.entries(backupData.arrangements)) {
			try {
				// Restore each arrangement
				const arrList = arrangements as Array<{ arrangement: unknown; savedAt: number }>;
				for (const item of arrList) {
					this.externalStore.set(uid, item.arrangement as any, this.settings.maxArrangementsPerNote);
				}
				restored++;
			} catch (e) {
				console.error(`[Perspecta] Failed to restore arrangements for UID ${uid}:`, e);
				errors++;
			}
		}

		// Flush to disk
		await this.externalStore.flushDirty();

		// Refresh indicators
		this.filesWithContext.clear();
		await this.setupFileExplorerIndicators();

		return { restored, errors };
	}

	// Generate UIDs for any files in the context that don't have them
	private async ensureUidsForContext(context: WindowArrangementV2): Promise<WindowArrangementV2> {
		const filesToUpdate: { file: TFile; uid: string }[] = [];

		// Collect files needing UIDs from main window
		this.collectFilesNeedingUids(context.main.root, filesToUpdate);

		// Collect files needing UIDs from popouts
		for (const popout of context.popouts) {
			this.collectFilesNeedingUids(popout.root, filesToUpdate);
		}

		// Write UIDs to files
		for (const { file, uid } of filesToUpdate) {
			try {
				await addUidToFile(this.app, file, uid);
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta] Added UID to ${file.path}: ${uid}`);
				}
			} catch (e) {
				console.warn(`[Perspecta] Failed to add UID to ${file.path}:`, e);
			}
		}

		// Wait for metadata cache to update (if we added any UIDs)
		if (filesToUpdate.length > 0) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		// Re-capture to get the new UIDs
		if (filesToUpdate.length > 0) {
			return this.captureWindowArrangement();
		}

		return context;
	}

	// Helper to collect files that need UIDs from a workspace node
	private collectFilesNeedingUids(node: WorkspaceNodeState, result: { file: TFile; uid: string }[]): void {
		if (node.type === 'tabs') {
			for (const tab of node.tabs) {
				if (!tab.uid) {
					const file = this.app.vault.getAbstractFileByPath(tab.path);
					if (file instanceof TFile && file.extension === 'md') {
						// Check cache again in case we already collected this file
						const existingUid = getUidFromCache(this.app, file);
						if (!existingUid) {
							result.push({ file, uid: generateUid() });
						}
					}
				}
			}
		} else if (node.type === 'split') {
			for (const child of node.children) {
				this.collectFilesNeedingUids(child, result);
			}
		}
	}

	private async saveArrangementToNote(file: TFile, arrangement: WindowArrangementV2) {
		const readStart = performance.now();
		const content = await this.app.vault.read(file);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ vault.read: ${(performance.now() - readStart).toFixed(1)}ms`);
		}

		const fmStart = performance.now();
		const newContent = this.updateFrontmatter(content, arrangement);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ updateFrontmatter: ${(performance.now() - fmStart).toFixed(1)}ms`);
		}

		const writeStart = performance.now();
		await this.app.vault.modify(file, newContent);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ vault.modify: ${(performance.now() - writeStart).toFixed(1)}ms`);
		}
	}

	private updateFrontmatter(content: string, arrangement: WindowArrangementV2): string {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		const encoded = this.encodeArrangement(arrangement);

		if (match) {
			// Remove old arrangement (both old multi-line YAML and new single-line format)
			let fm = match[1]
				.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')  // Old multi-line
				.replace(/perspecta-arrangement: ".*"/g, '')  // New single-line
				.trim();
			fm = fm ? fm + '\n' + encoded : encoded;
			return content.replace(frontmatterRegex, `---\n${fm}\n---`);
		}
		return `---\n${encoded}\n---\n${content}`;
	}

	// Encode arrangement as compact base64 JSON blob
	private encodeArrangement(arr: WindowArrangementV2): string {
		// Create minimal JSON structure - omit defaults and use short keys
		const compact = this.createCompactArrangement(arr);
		const json = JSON.stringify(compact);
		const base64 = btoa(unescape(encodeURIComponent(json)));
		return `${FRONTMATTER_KEY}: "${base64}"`;
	}

	// Create compact arrangement with minimal data
	private createCompactArrangement(arr: WindowArrangementV2): any {
		const compact: any = {
			v: arr.v,
			ts: arr.ts,
			f: arr.focusedWindow,  // short key: focusedWindow
			m: this.compactWindow(arr.main)  // short key: main
		};

		if (arr.popouts.length > 0) {
			compact.p = arr.popouts.map(p => this.compactWindow(p));  // short key: popouts
		}

		if (arr.leftSidebar) {
			compact.ls = { c: arr.leftSidebar.collapsed };  // short keys
			if (arr.leftSidebar.activeTab) compact.ls.t = arr.leftSidebar.activeTab;
		}

		if (arr.rightSidebar) {
			compact.rs = { c: arr.rightSidebar.collapsed };
			if (arr.rightSidebar.activeTab) compact.rs.t = arr.rightSidebar.activeTab;
		}

		if (arr.sourceScreen) {
			// Just store aspect ratio - that's all we really need
			compact.ar = Math.round(arr.sourceScreen.aspectRatio * 100) / 100;
		}

		return compact;
	}

	private compactWindow(win: WindowStateV2): any {
		const compact: any = {
			r: this.compactNode(win.root)  // short key: root
		};

		// Store geometry as array [x, y, w, h] if present
		if (win.x !== undefined && win.y !== undefined && win.width !== undefined && win.height !== undefined) {
			compact.g = [win.x, win.y, win.width, win.height];  // short key: geometry
		}

		return compact;
	}

	private compactNode(node: WorkspaceNodeState): any {
		if (node.type === 'tabs') {
			// Compact tab format: array of [path, uid?, active?]
			// Only include uid if present, only include active marker for active tab
			return node.tabs.map(tab => {
				const arr: any[] = [tab.path];
				if (tab.uid) arr.push(tab.uid);
				else if (tab.active) arr.push(null);  // placeholder for uid
				if (tab.active) arr.push(1);  // 1 = active
				return arr.length === 1 ? tab.path : arr;  // Just path string if no extras
			});
		} else {
			// Split format: { d: direction, c: children }
			return {
				d: node.direction === 'horizontal' ? 'h' : 'v',
				c: node.children.map(child => this.compactNode(child))
			};
		}
	}

	// Decode base64 JSON blob back to WindowArrangementV2
	private decodeArrangement(encoded: string): WindowArrangementV2 | null {
		try {
			const json = decodeURIComponent(escape(atob(encoded)));
			const compact = JSON.parse(json);
			return this.expandCompactArrangement(compact);
		} catch (e) {
			console.error('[Perspecta] Failed to decode arrangement:', e);
			return null;
		}
	}

	private expandCompactArrangement(compact: any): WindowArrangementV2 {
		const arr: WindowArrangementV2 = {
			v: compact.v || 2,
			ts: compact.ts || Date.now(),
			focusedWindow: compact.f ?? -1,
			main: this.expandWindow(compact.m),
			popouts: (compact.p || []).map((p: any) => this.expandWindow(p))
		};

		if (compact.ls) {
			arr.leftSidebar = { collapsed: compact.ls.c, activeTab: compact.ls.t };
		}

		if (compact.rs) {
			arr.rightSidebar = { collapsed: compact.rs.c, activeTab: compact.rs.t };
		}

		if (compact.ar) {
			// Reconstruct screen info from aspect ratio (we don't need exact dimensions)
			arr.sourceScreen = {
				width: Math.round(1117 * compact.ar),  // Use reference height
				height: 1117,
				aspectRatio: compact.ar
			};
		}

		return arr;
	}

	private expandWindow(compact: any): WindowStateV2 {
		const win: WindowStateV2 = {
			root: this.expandNode(compact.r)
		};

		if (compact.g) {
			win.x = compact.g[0];
			win.y = compact.g[1];
			win.width = compact.g[2];
			win.height = compact.g[3];
		}

		return win;
	}

	private expandNode(compact: any): WorkspaceNodeState {
		// Array = tabs, Object with d/c = split
		if (Array.isArray(compact)) {
			const tabs: TabState[] = compact.map(item => {
				if (typeof item === 'string') {
					// Just path
					return { path: item, active: false, name: item.split('/').pop()?.replace(/\.md$/, '') };
				} else {
					// Array: [path, uid?, active?]
					const path = item[0];
					const uid = item[1] || undefined;
					const active = item[2] === 1;
					return { path, uid, active, name: path.split('/').pop()?.replace(/\.md$/, '') };
				}
			});
			return { type: 'tabs', tabs };
		} else {
			return {
				type: 'split',
				direction: compact.d === 'h' ? 'horizontal' : 'vertical',
				children: compact.c.map((child: any) => this.expandNode(child))
			};
		}
	}

	// ============================================================================
	// Context Restore (Optimized)
	// ============================================================================

	// Track path corrections during restore (populated by restoreTabGroup and helpers)
	private pathCorrections: Map<string, { newPath: string; newName: string }> = new Map();

	async restoreContext(file?: TFile, forceLatest: boolean = false) {
		const fullStart = performance.now();
		PerfTimer.begin('restoreContext');

		// Reset path corrections tracking
		this.pathCorrections.clear();

		const targetFile = file ?? this.app.workspace.getActiveFile();
		PerfTimer.mark('getActiveFile');

		if (!targetFile) { new Notice('No active file', 4000); return; }

		// Get context - may show selector if multiple arrangements exist (unless forceLatest)
		const contextResult = await this.getContextForFileWithSelection(targetFile, forceLatest);
		PerfTimer.mark('getContextForFileWithSelection');

		if (!contextResult || contextResult.cancelled) {
			PerfTimer.end('restoreContext');
			return;
		}

		const context = contextResult.context;
		if (!context) { new Notice('No context found in this note', 4000); return; }

		const focusedWin = await this.applyArrangement(context, targetFile.path);
		PerfTimer.mark('applyArrangement');

		// If any files were resolved via fallback, update the saved context with corrected paths
		if (this.pathCorrections.size > 0) {
			await this.updateContextWithCorrectedPaths(targetFile, context);
			PerfTimer.mark('updateContextWithCorrectedPaths');
			const count = this.pathCorrections.size;
			new Notice(`Context restored (${count} file path${count > 1 ? 's' : ''} updated)`, 4000);
		} else {
			this.showNoticeInWindow(focusedWin, 'Context restored');
		}
		PerfTimer.end('restoreContext');

		// Measure time until next idle - this captures rendering/painting time
		if (PerfTimer.isEnabled()) {
			requestIdleCallback(() => {
				const totalTime = performance.now() - fullStart;
				console.log(`[Perspecta] 🏁 Full restore (including render): ${totalTime.toFixed(0)}ms`);
			}, { timeout: 5000 });
		}
	}

	// Get context with potential user selection for multiple arrangements
	// If forceLatest is true, always use the most recent arrangement without showing selector
	private async getContextForFileWithSelection(file: TFile, forceLatest: boolean = false): Promise<{ context: WindowArrangement | null; cancelled: boolean }> {
		// Canvas files store context directly in their JSON (single arrangement)
		if (file.extension === 'canvas') {
			return { context: await getContextFromCanvas(this.app, file), cancelled: false };
		}

		// Base files store context directly in their YAML (single arrangement)
		if (file.extension === 'base') {
			return { context: await getContextFromBase(this.app, file), cancelled: false };
		}

		// For markdown files with external storage, check for multiple arrangements
		if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, file);
			if (uid) {
				// Initialize store if needed
				if (!this.externalStore['initialized']) {
					await this.externalStore.initialize();
				}

				const arrangements = this.externalStore.getAll(uid);

				if (arrangements.length === 0) {
					// No arrangements in external store, fall back to frontmatter
					return { context: this.getContextFromNote(file), cancelled: false };
				}

				if (arrangements.length === 1 || forceLatest) {
					// Single arrangement or forceLatest - use the most recent one
					// Arrangements are sorted by savedAt descending, so first is most recent
					return { context: arrangements[0].arrangement, cancelled: false };
				}

				// Multiple arrangements - show selector with delete callback
				const result = await showArrangementSelector(
					arrangements,
					file.name,
					(savedAt: number) => {
						// Delete the arrangement from the store
						this.externalStore.deleteArrangement(uid, savedAt);
					}
				);
				if (result.cancelled) {
					return { context: null, cancelled: true };
				}
				return { context: result.arrangement.arrangement, cancelled: false };
			}
		}

		// Fall back to frontmatter (for backward compatibility or frontmatter mode)
		return { context: this.getContextFromNote(file), cancelled: false };
	}

	// Get context for file - handles markdown, canvas, base, and external storage
	private async getContextForFile(file: TFile): Promise<WindowArrangement | null> {
		// Canvas files store context directly in their JSON
		if (file.extension === 'canvas') {
			return getContextFromCanvas(this.app, file);
		}

		// Base files store context directly in their YAML
		if (file.extension === 'base') {
			return getContextFromBase(this.app, file);
		}

		// For markdown files, check external storage first (if enabled)
		if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, file);
			if (uid) {
				// Initialize store if needed
				if (!this.externalStore['initialized']) {
					await this.externalStore.initialize();
				}
				const context = this.externalStore.get(uid);
				if (context) return context;
			}
		}

		// Fall back to frontmatter (for backward compatibility or frontmatter mode)
		return this.getContextFromNote(file);
	}

	private getContextFromNote(file: TFile): WindowArrangement | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const rawValue = cache?.frontmatter?.[FRONTMATTER_KEY];

		if (!rawValue) return null;

		// Check if it's the new base64 format (string) or old YAML format (object)
		if (typeof rawValue === 'string') {
			// New compact format - decode from base64
			return this.decodeArrangement(rawValue);
		} else {
			// Old YAML format - return as-is (backward compatibility)
			return rawValue as WindowArrangement;
		}
	}

	// Update saved context with corrected file paths after fallback resolution
	private async updateContextWithCorrectedPaths(contextFile: TFile, originalContext: WindowArrangement): Promise<void> {
		if (this.pathCorrections.size === 0) return;

		// Re-capture the current arrangement (which now has correct paths)
		const correctedContext = this.captureWindowArrangement();

		// Preserve original metadata
		correctedContext.ts = originalContext.ts;
		correctedContext.focusedWindow = originalContext.focusedWindow;

		// Preserve source screen info if it existed
		const v2Original = this.normalizeToV2(originalContext);
		if (v2Original.sourceScreen) {
			correctedContext.sourceScreen = v2Original.sourceScreen;
		}

		// Save the corrected context based on file type and storage mode
		if (contextFile.extension === 'canvas') {
			// Canvas files store context in their JSON
			await saveContextToCanvas(this.app, contextFile, correctedContext);
		} else if (contextFile.extension === 'base') {
			// Base files store context in their YAML
			await saveContextToBase(this.app, contextFile, correctedContext);
		} else if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, contextFile);
			if (uid) {
				this.externalStore.set(uid, correctedContext);
			}
		} else {
			await this.saveArrangementToNote(contextFile, correctedContext);
		}

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Updated context with ${this.pathCorrections.size} corrected paths:`);
			this.pathCorrections.forEach((correction, oldPath) => {
				console.log(`  ${oldPath} → ${correction.newPath}`);
			});
		}
	}

	private async applyArrangement(arrangement: WindowArrangement, contextNotePath?: string): Promise<Window | null> {
		try {
			PerfTimer.mark('applyArrangement:start');

			const v2 = this.normalizeToV2(arrangement);
			PerfTimer.mark('normalizeToV2');

			// Check if we need to tile windows due to aspect ratio mismatch
			const useTiling = needsTiling(v2.sourceScreen);
			let tiledPositions: { x: number; y: number; width: number; height: number }[] = [];

			if (useTiling) {
				const windowCount = 1 + v2.popouts.length;
				tiledPositions = calculateTiledLayout(windowCount, v2.main);
				if (COORDINATE_DEBUG) {
					console.log(`[Perspecta] Using tiled layout due to aspect ratio mismatch:`, {
						sourceAspect: v2.sourceScreen?.aspectRatio?.toFixed(2),
						targetAspect: (getPhysicalScreen().width / getPhysicalScreen().height).toFixed(2),
						windowCount,
						tiledPositions
					});
				}
				new Notice(`Screen shape changed - tiling ${windowCount} windows`, 4000);
			}
			PerfTimer.mark('checkTilingNeeded');

			// Close popouts
			const popoutWindows = this.getPopoutWindowObjects();
			PerfTimer.mark('getPopoutWindowObjects');

			for (const win of popoutWindows) {
				this.closePopoutWindow(win);
			}
			PerfTimer.mark('closePopoutWindows');

			// Get main window leaves (single iteration)
			const mainLeaves = this.getMainWindowLeaves();
			PerfTimer.mark('getMainWindowLeaves');

			for (let i = 1; i < mainLeaves.length; i++) mainLeaves[i].detach();
			PerfTimer.mark('detachExtraLeaves');

			// Restore geometry - use tiled position if aspect ratios differ
			if (useTiling && tiledPositions.length > 0) {
				this.restoreWindowGeometryDirect(window, tiledPositions[0]);
			} else {
				this.restoreWindowGeometry(window, v2.main, v2.sourceScreen);
			}
			PerfTimer.mark('restoreWindowGeometry');

			// Restore main workspace
			const workspace = this.app.workspace as any;
			await this.restoreWorkspaceNode(workspace.rootSplit, v2.main.root, mainLeaves[0]);
			PerfTimer.mark('restoreMainWorkspace');

			// Restore popouts
			for (let i = 0; i < v2.popouts.length; i++) {
				const tiledPosition = useTiling && tiledPositions.length > i + 1 ? tiledPositions[i + 1] : undefined;
				await this.restorePopoutWindow(v2.popouts[i], v2.sourceScreen, tiledPosition);
				PerfTimer.mark(`restorePopout[${i}]`);
			}

			// Process pending tab activations after a delay to ensure windows are fully ready
			// Use requestAnimationFrame + setTimeout to wait for both rendering and event loop
			if (this.pendingTabActivations.length > 0) {
				requestAnimationFrame(() => {
					setTimeout(() => {
						this.processPendingTabActivations();
					}, 100);
				});
			}

			// Restore sidebars
			if (v2.leftSidebar) this.restoreSidebarState('left', v2.leftSidebar);
			if (v2.rightSidebar) this.restoreSidebarState('right', v2.rightSidebar);
			PerfTimer.mark('restoreSidebars');

			// Schedule scroll position restoration for all leaves
			this.scheduleScrollRestoration(v2.main.root);
			for (const popout of v2.popouts) {
				this.scheduleScrollRestoration(popout.root);
			}
			PerfTimer.mark('scheduleScrollRestoration');

			// Find and focus the window containing the context note (the note used to restore)
			// This ensures the context note is active and its window is in foreground
			let contextNoteWin: Window | null = null;
			if (contextNotePath) {
				contextNoteWin = this.findWindowContainingFile(contextNotePath);
			}

			// Fall back to the originally focused window if context note window not found
			const focusedWin = contextNoteWin ?? this.getFocusedWindow(v2);

			if (focusedWin) {
				// Activate the leaf containing the context note (or the originally active leaf)
				if (contextNotePath && contextNoteWin) {
					this.activateLeafByPath(contextNoteWin, contextNotePath);
				} else {
					this.activateWindowLeaf(focusedWin, v2);
				}
				focusedWin.focus();
				this.showFocusTint(focusedWin);
			}
			PerfTimer.mark('activateFocusedWindow');

			return focusedWin;
		} catch (e) {
			new Notice('Error restoring context: ' + (e as Error).message, 4000);
			return null;
		}
	}

	private getMainWindowLeaves(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.view?.containerEl?.win;
			if ((!win || win === window) && this.isInRootSplit(leaf)) {
				leaves.push(leaf);
			}
		});
		return leaves;
	}

	private normalizeToV2(arr: WindowArrangement): WindowArrangementV2 {
		if (arr.v === 2) return arr as WindowArrangementV2;
		const v1 = arr as WindowArrangementV1;
		return {
			v: 2, ts: v1.ts, focusedWindow: v1.focusedWindow,
			main: { root: { type: 'tabs', tabs: v1.main.tabs }, x: v1.main.x, y: v1.main.y, width: v1.main.width, height: v1.main.height },
			popouts: v1.popouts.map(p => ({ root: { type: 'tabs', tabs: p.tabs }, x: p.x, y: p.y, width: p.width, height: p.height })),
			leftSidebar: v1.leftSidebar, rightSidebar: v1.rightSidebar
		};
	}

	private async restoreWorkspaceNode(parent: any, state: WorkspaceNodeState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state?.type) {
			if ('tabs' in state) return this.restoreTabGroup(parent, { type: 'tabs', tabs: (state as any).tabs }, existingLeaf);
			return existingLeaf;
		}
		return state.type === 'tabs'
			? this.restoreTabGroup(parent, state, existingLeaf)
			: this.restoreSplit(parent, state as SplitState, existingLeaf);
	}

	private async restoreTabGroup(parent: any, state: TabGroupState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state.tabs?.length) return existingLeaf;

		// Find the active tab index
		let activeTabIdx = state.tabs.findIndex(t => t.active);
		if (activeTabIdx < 0) activeTabIdx = 0;

		// Reorder tabs: open inactive tabs first, active tab LAST
		// This makes Obsidian naturally select the last-opened tab as active
		const reorderedTabs: { tab: TabState; originalIndex: number }[] = [];
		for (let i = 0; i < state.tabs.length; i++) {
			reorderedTabs.push({ tab: state.tabs[i], originalIndex: i });
		}
		// Sort: inactive first, active last
		reorderedTabs.sort((a, b) => {
			if (a.tab.active && !b.tab.active) return 1;
			if (!a.tab.active && b.tab.active) return -1;
			return a.originalIndex - b.originalIndex;
		});

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restoreTabGroup: ${state.tabs.length} tabs, active at index ${activeTabIdx}`);
			console.log(`[Perspecta]   Opening order: ${reorderedTabs.map(r => r.tab.name || r.tab.path).join(' → ')}`);
		}

		let firstLeaf: WorkspaceLeaf | undefined;
		let container: any = null;
		let isFirstTabOpened = false;

		for (let i = 0; i < reorderedTabs.length; i++) {
			const { tab, originalIndex } = reorderedTabs[i];
			const tabStart = performance.now();

			// Use fallback resolution: path → UID → filename
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ✗ File not found: ${tab.path} (tried path, uid: ${tab.uid || 'none'}, name: ${tab.name || 'none'})`);
				}
				continue;
			}

			// Track if we found a file via fallback (for path correction)
			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ↪ Resolved ${tab.path} → ${file.path} (via ${method})`);
				}
			}

			let leaf: WorkspaceLeaf;
			if (!isFirstTabOpened && existingLeaf) {
				// Use existing leaf for the first tab we open
				await existingLeaf.openFile(file);
				leaf = existingLeaf;
				container = existingLeaf.parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else if (!isFirstTabOpened) {
				// No existing leaf, create new one
				leaf = this.app.workspace.createLeafInParent(parent, 0);
				await leaf.openFile(file);
				container = leaf.parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else {
				// Subsequent tabs go into the same container
				if (!container) continue;
				leaf = this.app.workspace.createLeafInParent(container, (container as any).children?.length ?? 0);
				await leaf.openFile(file);
			}

			const elapsed = performance.now() - tabStart;
			if (PerfTimer.isEnabled()) {
				const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
				const methodSuffix = method !== 'path' ? ` [${method}]` : '';
				console.log(`[Perspecta]   ${flag} openFile[${originalIndex}]: ${file.basename} - ${elapsed.toFixed(1)}ms${methodSuffix}${tab.active ? ' [ACTIVE]' : ''}`);
			}
		}

		return firstLeaf;
	}

	/**
	 * Restore a split structure.
	 *
	 * The challenge: Obsidian's getLeaf('split') creates splits at the LEAF level,
	 * not at the container level. So if we have a horizontal container [A, B] and
	 * split vertically from B, we get [A, vertical[B, C]] instead of vertical[[A,B], C].
	 *
	 * Solution: Use createLeafBySplit with the FIRST leaf of a nested structure.
	 * When we split from the first leaf in a different direction, Obsidian properly
	 * wraps the entire sibling group.
	 *
	 * For:
	 *   vertical split
	 *   ├── horizontal split (A | B)
	 *   └── C
	 *
	 * Order:
	 * 1. Start with leaf (A)
	 * 2. Build horizontal: split from A → B (now [A, B] in horizontal)
	 * 3. Split vertically from A (FIRST leaf) → C
	 *    This should wrap [A, B] as a unit
	 */
	private async restoreSplit(parent: any, state: SplitState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state.children.length) return existingLeaf;

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplit START: direction=${state.direction}, children=${state.children.length}, parent:`, {
				type: parent?.constructor?.name,
				direction: parent?.direction
			});
		}

		// Set the parent container's direction
		if (parent && parent.direction !== state.direction) {
			parent.direction = state.direction;
			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] restoreSplit: changed parent direction to ${state.direction}`);
			}
		}

		let firstLeaf = existingLeaf;

		// Process first child - this may create nested structure
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs') {
			// Simple tabs
			const firstTab = firstChild.tabs[0];
			if (firstTab && existingLeaf) {
				const { file: f, method } = resolveFile(this.app, firstTab);
				if (f) {
					if (method !== 'path') {
						this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
					}
					await existingLeaf.openFile(f);
				}
			}
			if (firstChild.tabs.length > 1 && existingLeaf) {
				await this.restoreRemainingTabs(existingLeaf, firstChild.tabs, 1);
			}
			firstLeaf = existingLeaf;
		} else {
			// First child is a nested split - build it first
			firstLeaf = await this.buildNestedSplit(existingLeaf, firstChild);
		}

		// Now add siblings at THIS level
		// KEY: Split from the FIRST leaf to properly wrap nested structures
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			// Small delay to ensure previous split operations are fully established
			await new Promise(resolve => setTimeout(resolve, 50));

			// Use createLeafBySplit from the FIRST leaf
			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);

			// Wait for the split to be established
			await new Promise(resolve => setTimeout(resolve, 50));

			if (child.type === 'tabs') {
				const firstTab = child.tabs[0];
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
				}
			} else {
				// Nested split
				const firstTab = this.getFirstTabFromNode(child);
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				await this.buildNestedSplit(newLeaf, child);
			}
		}

		// Apply saved sizes to the split children
		if (state.sizes && state.sizes.length > 0 && firstLeaf) {
			await this.applySplitSizes(firstLeaf, state.sizes);
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplit END: direction=${state.direction}`);
		}

		return firstLeaf;
	}

	/**
	 * Apply saved sizes to a split container.
	 * Gets the parent container from any leaf and sets dimension on its children.
	 */
	private async applySplitSizes(anyLeaf: WorkspaceLeaf, sizes: number[]): Promise<void> {
		// Longer delay to ensure layout is fully ready
		await new Promise(resolve => setTimeout(resolve, 200));

		// Navigate up the parent chain to find the split container with matching child count
		let parent = (anyLeaf as any).parent;
		let attempts = 0;
		const maxAttempts = 5;

		while (parent && attempts < maxAttempts) {
			if (parent.children?.length === sizes.length && parent.direction) {
				// Found the right split container
				break;
			}
			parent = parent.parent;
			attempts++;
		}

		if (!parent?.children || parent.children.length !== sizes.length) {
			console.log(`[Perspecta] applySplitSizes: could not find matching parent - expected ${sizes.length} children`);
			return;
		}

		// Normalize sizes to percentages that sum to 100
		const total = sizes.reduce((a, b) => a + b, 0);
		const normalizedSizes = sizes.map(s => (s / total) * 100);

		console.log(`[Perspecta] applySplitSizes: found parent with ${parent.children.length} children, direction=${parent.direction}, applying sizes:`, normalizedSizes);

		// Apply dimension to each child using setDimension if available, otherwise direct assignment
		for (let i = 0; i < normalizedSizes.length; i++) {
			const child = parent.children[i];
			if (child && normalizedSizes[i] !== undefined) {
				if (typeof child.setDimension === 'function') {
					child.setDimension(normalizedSizes[i]);
					console.log(`[Perspecta] applySplitSizes: called child[${i}].setDimension(${normalizedSizes[i]})`);
				} else {
					child.dimension = normalizedSizes[i];
					console.log(`[Perspecta] applySplitSizes: set child[${i}].dimension = ${normalizedSizes[i]}`);
				}
			}
		}

		// Trigger resize - try multiple methods
		// Method 1: parent's onResize
		if (typeof parent.onResize === 'function') {
			parent.onResize();
			console.log(`[Perspecta] applySplitSizes: called parent.onResize()`);
		}

		// Method 2: workspace requestResize (used by obsidian-resize-split plugin)
		const workspace = this.app.workspace as any;
		if (typeof workspace.requestResize === 'function') {
			workspace.requestResize();
			console.log(`[Perspecta] applySplitSizes: called workspace.requestResize()`);
		}

		// Method 3: root split's onResize
		const rootSplit = workspace.rootSplit;
		if (rootSplit && typeof rootSplit.onResize === 'function') {
			rootSplit.onResize();
			console.log(`[Perspecta] applySplitSizes: called rootSplit.onResize()`);
		}

		// Method 4: trigger window resize event (forces Obsidian to recalculate layout)
		window.dispatchEvent(new Event('resize'));
		console.log(`[Perspecta] applySplitSizes: dispatched window resize event`);
	}

	/**
	 * Apply scroll position to a leaf's view.
	 * Must be called after the file is fully loaded.
	 */
	private applyScrollPosition(leaf: WorkspaceLeaf, scroll: number | undefined): void {
		if (scroll === undefined || scroll === 0) return;

		// Delay to ensure view is fully rendered
		setTimeout(() => {
			const view = leaf.view as any;
			if (view?.currentMode?.applyScroll) {
				view.currentMode.applyScroll(scroll);
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta] applyScrollPosition: scrolled to ${scroll}`);
				}
			}
		}, 100);
	}

	/**
	 * Collect scroll positions from a workspace node state and apply them to matching leaves.
	 */
	private scheduleScrollRestoration(state: WorkspaceNodeState): void {
		// Build a map of path -> scroll from the state
		const scrollMap = new Map<string, number>();
		this.collectScrollPositions(state, scrollMap);

		if (scrollMap.size === 0) return;

		console.log(`[Perspecta] scheduleScrollRestoration: ${scrollMap.size} scroll positions to restore`);

		// Apply scroll positions after a longer delay to ensure all views in splits are loaded
		// Re-iterate leaves inside timeout since split views may not exist yet when this is called
		setTimeout(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				const file = (leaf.view as any)?.file as TFile | undefined;
				if (file && scrollMap.has(file.path)) {
					const scroll = scrollMap.get(file.path);
					if (scroll !== undefined && scroll > 0) {
						const view = leaf.view as any;
						if (view?.currentMode?.applyScroll) {
							view.currentMode.applyScroll(scroll);
							console.log(`[Perspecta] scheduleScrollRestoration: ${file.basename} -> ${scroll}`);
						}
					}
				}
			});
		}, 500);
	}

	private collectScrollPositions(node: WorkspaceNodeState, map: Map<string, number>): void {
		if (node.type === 'tabs') {
			for (const tab of node.tabs) {
				if (tab.scroll !== undefined && tab.scroll > 0) {
					map.set(tab.path, tab.scroll);
				}
			}
		} else {
			for (const child of node.children) {
				this.collectScrollPositions(child, map);
			}
		}
	}

	/**
	 * Build a nested split structure starting from a leaf.
	 * Returns the first leaf in the created structure.
	 */
	private async buildNestedSplit(startLeaf: WorkspaceLeaf | undefined, state: SplitState): Promise<WorkspaceLeaf | undefined> {
		if (!state.children.length || !startLeaf) {
			return startLeaf;
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] buildNestedSplit: direction=${state.direction}, children=${state.children.length}`);
		}

		let firstLeaf: WorkspaceLeaf = startLeaf;

		// Process first child into startLeaf
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs') {
			const firstTab = firstChild.tabs[0];
			if (firstTab) {
				const { file: f, method } = resolveFile(this.app, firstTab);
				if (f) {
					if (method !== 'path') {
						this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
					}
					await startLeaf.openFile(f);
				}
			}
			if (firstChild.tabs.length > 1) {
				await this.restoreRemainingTabs(startLeaf, firstChild.tabs, 1);
			}
			firstLeaf = startLeaf;
		} else {
			// Recursively build nested split
			const result = await this.buildNestedSplit(startLeaf, firstChild);
			if (result) firstLeaf = result;
		}

		// Add siblings - split from FIRST leaf to keep them at same level
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			// Small delay to ensure previous operations are fully established
			await new Promise(resolve => setTimeout(resolve, 50));

			// Split from firstLeaf
			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);

			// Wait for the split to be established
			await new Promise(resolve => setTimeout(resolve, 50));

			if (child.type === 'tabs') {
				const firstTab = child.tabs[0];
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
				}
			} else {
				// Nested split
				const firstTab = this.getFirstTabFromNode(child);
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				await this.buildNestedSplit(newLeaf, child);
			}
		}

		// Apply saved sizes to the split children
		if (state.sizes && state.sizes.length > 0 && firstLeaf) {
			await this.applySplitSizes(firstLeaf, state.sizes);
		}

		return firstLeaf;
	}

	private async restorePopoutWindow(
		state: WindowStateV2,
		sourceScreen?: ScreenInfo,
		tiledPosition?: { x: number; y: number; width: number; height: number }
	) {
		const popoutStart = performance.now();

		// Handle proxy windows specially
		if (state.isProxy && this.settings.enableProxyWindows) {
			await this.restoreProxyWindow(state, sourceScreen, tiledPosition);
			return;
		}

		// For simple tabs root, find any tab to start with (we'll reorder later)
		// For splits, use the first tab as before
		const firstTab = this.getFirstTab(state.root);
		if (!firstTab) return;

		// Use fallback resolution: path → UID → filename
		const { file, method } = resolveFile(this.app, firstTab);
		if (!file) return;

		// Track path corrections for fallback resolutions
		if (method !== 'path') {
			this.pathCorrections.set(firstTab.path, {
				newPath: file.path,
				newName: file.basename
			});
		}

		// Create the popout with a placeholder file first
		const openPopoutStart = performance.now();
		const popoutLeaf = this.app.workspace.openPopoutLeaf();
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]     ✓ openPopoutLeaf: ${(performance.now() - openPopoutStart).toFixed(1)}ms`);
		}

		const openFileStart = performance.now();
		await popoutLeaf.openFile(file);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]     ✓ openFile (popout first): ${(performance.now() - openFileStart).toFixed(1)}ms`);
		}

		const win = popoutLeaf.view?.containerEl?.win;
		if (win) {
			if (tiledPosition) {
				// Use pre-calculated tiled position
				this.restoreWindowGeometryDirect(win, tiledPosition);
			} else {
				// Use normal virtual-to-physical conversion
				this.restoreWindowGeometry(win, state, sourceScreen);
			}
		}

		if (state.root.type === 'tabs') {
			// Simple tabs - restore all tabs with active tab opened LAST
			await this.restorePopoutTabs(popoutLeaf, state.root.tabs);
		} else if (state.root.type === 'split') {
			// For complex splits, use outer-first approach:
			// First create all outer splits, then fill in nested structures
			await this.restoreSplitOuterFirst(popoutLeaf, state.root);
		}
	}

	/**
	 * Restore a proxy window (minimalist window showing just the note title)
	 */
	private async restoreProxyWindow(
		state: WindowStateV2,
		sourceScreen?: ScreenInfo,
		tiledPosition?: { x: number; y: number; width: number; height: number }
	) {
		// Get the first tab's file path from the state
		const firstTab = this.getFirstTab(state.root);
		if (!firstTab) return;

		// Use fallback resolution: path → UID → filename
		const { file } = resolveFile(this.app, firstTab);
		if (!file) return;

		// Check if this file has a saved arrangement for the proxy to reference
		let arrangementUid: string | undefined;
		const uid = await getUidFromFile(this.app, file);
		if (uid) {
			arrangementUid = uid;
		}

		// Calculate the actual size to use (from stored state or tiled position)
		let initialWidth = 250;
		let initialHeight = 80;

		if (tiledPosition) {
			initialWidth = tiledPosition.width;
			initialHeight = tiledPosition.height;
		} else if (state.width !== undefined && state.height !== undefined) {
			// Convert virtual coordinates to physical
			const physical = virtualToPhysical({
				x: state.x || 0,
				y: state.y || 0,
				width: state.width,
				height: state.height
			});
			initialWidth = physical.width;
			initialHeight = physical.height;
		}

		// Create a new proxy popout with the correct size
		const proxyLeaf = this.app.workspace.openPopoutLeaf({
			size: { width: initialWidth, height: initialHeight }
		});

		// Set the view to proxy type
		await proxyLeaf.setViewState({
			type: PROXY_VIEW_TYPE,
			state: {
				filePath: file.path,
				arrangementUid
			} as ProxyViewState
		});

		// Wait for view to be ready
		await new Promise(resolve => setTimeout(resolve, 100));

		// Restore window position (and size if needed)
		const win = proxyLeaf.view?.containerEl?.win;
		if (win) {
			if (tiledPosition) {
				this.restoreWindowGeometryDirect(win, tiledPosition);
			} else {
				this.restoreWindowGeometry(win, state, sourceScreen);
			}
		}

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]     ✓ restoreProxyWindow: ${file.basename}`);
		}
	}

	// Restore split using "outer-first" approach:
	// 1. First create all siblings at the current level
	// 2. Then recursively fill in any nested splits
	private async restoreSplitOuterFirst(existingLeaf: WorkspaceLeaf, state: SplitState): Promise<void> {
		if (!state.children.length) return;

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplitOuterFirst: direction=${state.direction}, children=${state.children.length}`);
		}

		// Step 1: Create all leaf placeholders at THIS level first
		// This ensures the outer split structure is correct before we subdivide
		const leafSlots: WorkspaceLeaf[] = [];

		// existingLeaf will be slot 0 (first child)
		leafSlots.push(existingLeaf);

		// getLeaf('split') creates a new pane AFTER the active leaf
		// So we iterate forward: each new split goes after the previous one
		// This gives us the correct order: [existingLeaf, new1, new2, ...]

		let lastLeaf = existingLeaf;
		for (let i = 1; i < state.children.length; i++) {
			this.app.workspace.setActiveLeaf(lastLeaf, { focus: false });
			const newLeaf = this.app.workspace.getLeaf('split', state.direction);

			// Open the first file of this child (use fallback resolution)
			const childFirstTab = this.getFirstTabFromNode(state.children[i]);
			if (childFirstTab) {
				const { file: f, method } = resolveFile(this.app, childFirstTab);
				if (f) {
					// Track path corrections for fallback resolutions
					if (method !== 'path') {
						this.pathCorrections.set(childFirstTab.path, {
							newPath: f.path,
							newName: f.basename
						});
					}
					await newLeaf.openFile(f);
				}
			}

			leafSlots.push(newLeaf);
			lastLeaf = newLeaf; // Next split will be after this one
		}

		// Now open the first file in the existing leaf (which is slot 0, use fallback resolution)
		const firstTab = this.getFirstTabFromNode(state.children[0]);
		if (firstTab) {
			const { file: f, method } = resolveFile(this.app, firstTab);
			if (f) {
				// Track path corrections for fallback resolutions
				if (method !== 'path') {
					this.pathCorrections.set(firstTab.path, {
						newPath: f.path,
						newName: f.basename
					});
				}
				await existingLeaf.openFile(f);
			}
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplitOuterFirst: created ${leafSlots.length} leaf slots`);
			leafSlots.forEach((leaf, idx) => {
				const path = (leaf?.view as any)?.file?.path || 'unknown';
				console.log(`  slot[${idx}]: ${path}`);
			});
		}

		// Step 2: Now fill in nested structures for each child
		for (let i = 0; i < state.children.length; i++) {
			const child = state.children[i];
			const leafSlot = leafSlots[i];

			if (child.type === 'tabs') {
				// Add remaining tabs to this slot
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(leafSlot, child.tabs, 1);
				}
			} else if (child.type === 'split') {
				// This child is a nested split - recursively restore it
				// The leafSlot already has the first file, now we need to add the nested structure
				await this.restoreNestedSplitInPlace(leafSlot, child);
			}
		}

		// Step 3: Apply split sizes if available
		if (state.sizes?.length && leafSlots.length > 0) {
			await this.applySplitSizes(leafSlots[0], state.sizes);
		}
	}

	// Restore a nested split within an existing leaf's position
	private async restoreNestedSplitInPlace(leafSlot: WorkspaceLeaf, state: SplitState): Promise<void> {
		if (state.children.length <= 1) {
			// Only one child, just fill in its content
			if (state.children[0]?.type === 'tabs' && state.children[0].tabs.length > 1) {
				await this.restoreRemainingTabs(leafSlot, state.children[0].tabs, 1);
			}
			return;
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreNestedSplitInPlace: direction=${state.direction}, children=${state.children.length}`);
		}

		// The leafSlot already has the first child's first file
		// We need to create splits for remaining children in the NESTED direction

		// First, handle remaining tabs in first child if any
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs' && firstChild.tabs.length > 1) {
			await this.restoreRemainingTabs(leafSlot, firstChild.tabs, 1);
		} else if (firstChild.type === 'split') {
			// First child is also a split - need deeper recursion
			await this.restoreNestedSplitInPlace(leafSlot, firstChild);
		}

		// Now create splits for remaining children
		// Track last leaf so splits are created in order (each after the previous)
		let lastLeaf = leafSlot;
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			this.app.workspace.setActiveLeaf(lastLeaf, { focus: false });
			const newLeaf = this.app.workspace.getLeaf('split', state.direction);
			lastLeaf = newLeaf;

			// Open first file (use fallback resolution)
			const childFirstTab = this.getFirstTabFromNode(child);
			if (childFirstTab) {
				const { file: f, method } = resolveFile(this.app, childFirstTab);
				if (f) {
					// Track path corrections for fallback resolutions
					if (method !== 'path') {
						this.pathCorrections.set(childFirstTab.path, {
							newPath: f.path,
							newName: f.basename
						});
					}
					await newLeaf.openFile(f);
				}
			}

			// Handle child's structure
			if (child.type === 'tabs' && child.tabs.length > 1) {
				await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
			} else if (child.type === 'split') {
				await this.restoreNestedSplitInPlace(newLeaf, child);
			}
		}

		// Apply split sizes if available
		if (state.sizes?.length) {
			await this.applySplitSizes(leafSlot, state.sizes);
		}
	}

	// Get the first tab from any node (tabs or split) - returns full TabState for fallback resolution
	private getFirstTabFromNode(node: WorkspaceNodeState): TabState | null {
		if (node.type === 'tabs') {
			return node.tabs[0] || null;
		} else if (node.type === 'split' && node.children.length > 0) {
			return this.getFirstTabFromNode(node.children[0]);
		}
		return null;
	}

	/**
	 * Restore tabs in a popout window, preserving both tab ORDER and active state.
	 *
	 * Strategy:
	 * 1. Open all tabs in the correct order (preserving visual tab order)
	 * 2. Track which leaf corresponds to the active tab
	 * 3. Schedule the active tab to be selected after the window is fully ready
	 */
	private async restorePopoutTabs(existingLeaf: WorkspaceLeaf, tabs: TabState[]) {
		if (tabs.length <= 1) return; // Only one tab, nothing to do

		// Find which tab should be active
		let activeTabIndex = tabs.findIndex(t => t.active);
		if (activeTabIndex < 0) activeTabIndex = 0;

		const container = existingLeaf.parent as any;
		if (!container) return;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restorePopoutTabs: ${tabs.length} tabs, active at index ${activeTabIndex}`);
		}

		// Track leaves as we open them (in correct order)
		const openedLeaves: WorkspaceLeaf[] = [];

		// existingLeaf already has tabs[0] open
		openedLeaves.push(existingLeaf);

		// Open remaining tabs in order (tabs[1], tabs[2], etc.)
		for (let i = 1; i < tabs.length; i++) {
			const tab = tabs[i];
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ✗ File not found: ${tab.path}`);
				}
				continue;
			}

			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
			}

			const leaf = this.app.workspace.createLeafInParent(container, container.children?.length ?? 0);
			await leaf.openFile(file);
			openedLeaves.push(leaf);

			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   ✓ Opened[${i}]: ${file.basename}`);
			}
		}

		// Now all tabs are open in correct order
		// The last-opened tab is currently "active" in Obsidian's view
		// We need to make the correct tab active

		const activeLeaf = openedLeaves[activeTabIndex];
		if (!activeLeaf) return;

		// Schedule tab activation for after restore completes
		// Store in a queue that will be processed after all popouts are restored
		this.pendingTabActivations.push({
			container,
			activeTabIndex,
			activeLeaf
		});

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   Queued tab activation for index ${activeTabIndex}`);
		}
	}

	// Queue of pending tab activations to process after restore
	private pendingTabActivations: Array<{
		container: any;
		activeTabIndex: number;
		activeLeaf: WorkspaceLeaf;
	}> = [];

	/**
	 * Process all pending tab activations after windows are fully initialized
	 */
	private processPendingTabActivations() {
		if (this.pendingTabActivations.length === 0) return;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Processing ${this.pendingTabActivations.length} pending tab activations`);
		}

		for (const { container, activeTabIndex, activeLeaf } of this.pendingTabActivations) {
			// Try multiple methods to activate the tab

			// Method 1: Set currentTab and call updateTabDisplay if available
			if (typeof container.currentTab !== 'undefined') {
				container.currentTab = activeTabIndex;
				if (typeof container.updateTabDisplay === 'function') {
					container.updateTabDisplay();
				}
				if (typeof container.onResize === 'function') {
					container.onResize();
				}
			}

			// Method 2: Use selectTab
			if (typeof container.selectTab === 'function') {
				container.selectTab(activeLeaf);
			}

			// Method 3: Focus the active leaf's view
			if (activeLeaf.view?.containerEl) {
				activeLeaf.view.containerEl.focus();
			}

			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   Activated tab at index ${activeTabIndex}`);
			}
		}

		// Clear the queue
		this.pendingTabActivations = [];
	}

	private async restoreRemainingTabs(existingLeaf: WorkspaceLeaf, tabs: TabState[], startIndex: number) {
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restoreRemainingTabs: ${tabs.length} total tabs, starting from index ${startIndex}`);
		}

		// Find which tab should be active
		let activeTabIndex = 0;
		for (let i = 0; i < tabs.length; i++) {
			if (tabs[i].active) {
				activeTabIndex = i;
				break;
			}
		}

		// Strategy: Open inactive tabs first, then open the active tab last
		// This way Obsidian naturally makes the last-opened tab active
		const parent = existingLeaf.parent;
		if (!parent) return;

		// Collect all tabs to open (excluding the first one which is already open via existingLeaf)
		const tabsToOpen: { tab: TabState; index: number }[] = [];
		for (let i = startIndex; i < tabs.length; i++) {
			tabsToOpen.push({ tab: tabs[i], index: i });
		}

		// Reorder: put inactive tabs first, active tab last
		tabsToOpen.sort((a, b) => {
			if (a.tab.active && !b.tab.active) return 1;  // active goes last
			if (!a.tab.active && b.tab.active) return -1; // inactive goes first
			return a.index - b.index; // maintain original order otherwise
		});

		// If the active tab is the first tab (index 0, already in existingLeaf),
		// we need to reopen it last to make it active
		const activeIsFirstTab = activeTabIndex === 0;

		// Open tabs in the reordered sequence
		for (const { tab, index } of tabsToOpen) {
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   tab[${index}]: file not found for ${tab.path}`);
				}
				continue;
			}

			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
			}

			const leaf = this.app.workspace.createLeafInParent(parent, (parent as any).children?.length ?? 0);
			await leaf.openFile(file);
			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   tab[${index}]: opened ${file.basename}, active=${tab.active}`);
			}
		}

		// If active tab was the first tab (in existingLeaf), we need to switch to it
		if (activeIsFirstTab) {
			// Re-activate the first leaf by opening its file again or using setActiveLeaf
			setTimeout(() => {
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: false });
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   Activated first tab (existingLeaf)`);
				}
			}, 100);
		}
	}

	private getFirstTab(node: WorkspaceNodeState): TabState | null {
		if (node.type === 'tabs') return node.tabs[0] || null;
		for (const child of node.children) {
			const tab = this.getFirstTab(child);
			if (tab) return tab;
		}
		return null;
	}

	private closePopoutWindow(win: Window) {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.containerEl?.win === win) leaves.push(leaf);
		});
		leaves.forEach(l => l.detach());
	}

	private getFocusedWindow(arr: WindowArrangementV2): Window | null {
		if (arr.focusedWindow === -1) return window;
		const popouts = this.getPopoutWindowObjects();
		const win = popouts[arr.focusedWindow];
		// Skip proxy windows, fall back to main window
		if (win && win.document.body.classList.contains('perspecta-proxy-window')) {
			return window;
		}
		return win ?? window;
	}

	private findWindowContainingFile(filePath: string): Window | null {
		let foundWin: Window | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!foundWin && (leaf.view as any)?.file?.path === filePath) {
				const win = leaf.view?.containerEl?.win ?? window;
				// Skip proxy windows
				if (win !== window && win.document.body.classList.contains('perspecta-proxy-window')) {
					return;
				}
				foundWin = win;
			}
		});
		return foundWin;
	}

	private activateLeafByPath(win: Window, filePath: string) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.containerEl?.win === win && (leaf.view as any)?.file?.path === filePath) {
				this.app.workspace.setActiveLeaf(leaf, { focus: false });
			}
		});
	}

	private activateWindowLeaf(win: Window, arr: WindowArrangementV2) {
		const start = performance.now();
		const root = win === window ? arr.main.root : arr.popouts[this.getPopoutWindowObjects().indexOf(win)]?.root;
		if (!root) return;

		const activePath = this.findActiveTabPath(root);
		if (!activePath) return;

		// Find the target leaf without using iterateAllLeaves during the search
		let targetLeaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!targetLeaf && leaf.view?.containerEl?.win === win && (leaf.view as any)?.file?.path === activePath) {
				targetLeaf = leaf;
			}
		});

		if (targetLeaf) {
			// Use focus: false to avoid slow window focus operations
			// We'll focus the window separately with win.focus()
			this.app.workspace.setActiveLeaf(targetLeaf, { focus: false });
		}

		const elapsed = performance.now() - start;
		if (elapsed > 50) {
			console.warn(`[Perspecta] ⚠ SLOW activateWindowLeaf: ${elapsed.toFixed(1)}ms`);
		}
	}

	private findActiveTabPath(node: WorkspaceNodeState): string | null {
		if (node.type === 'tabs') {
			return node.tabs.find(t => t.active)?.path || node.tabs[0]?.path || null;
		}
		for (const child of node.children) {
			const path = this.findActiveTabPath(child);
			if (path) return path;
		}
		return null;
	}

	private restoreWindowGeometry(win: Window, state: WindowStateV2, sourceScreen?: ScreenInfo) {
		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometry called`, {
				hasCoords: state.x !== undefined && state.y !== undefined,
				hasSize: state.width !== undefined && state.height !== undefined,
				state: { x: state.x, y: state.y, width: state.width, height: state.height },
				sourceScreen
			});
		}

		if (state.width === undefined || state.height === undefined ||
			state.x === undefined || state.y === undefined) {
			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] restoreWindowGeometry: missing coordinates, skipping`);
			}
			return;
		}

		// Convert virtual coordinates to physical screen coordinates
		const physical = virtualToPhysical({
			x: state.x,
			y: state.y,
			width: state.width,
			height: state.height
		}, sourceScreen);

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometry: applying`, physical);
		}

		try { win.resizeTo(physical.width, physical.height); } catch { /* ignore */ }
		try { win.moveTo(physical.x, physical.y); } catch { /* ignore */ }
	}

	// Apply geometry directly without virtual-to-physical conversion (used for tiled layouts)
	private restoreWindowGeometryDirect(win: Window, geometry: { x: number; y: number; width: number; height: number }) {
		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometryDirect: applying`, geometry);
		}

		try { win.resizeTo(geometry.width, geometry.height); } catch { /* ignore */ }
		try { win.moveTo(geometry.x, geometry.y); } catch { /* ignore */ }
	}

	private isInRootSplit(leaf: WorkspaceLeaf): boolean {
		const el = leaf.view?.containerEl;
		return el ? !el.closest('.mod-left-split') && !el.closest('.mod-right-split') : true;
	}

	private restoreSidebarState(side: 'left' | 'right', state: SidebarState) {
		try {
			const workspace = this.app.workspace as any;
			const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;
			if (!sidebar) return;

			if (state.collapsed) { sidebar.collapse?.(); return; }
			sidebar.expand?.();

			const views = state.activeTab ? [state.activeTab, side === 'left' ? 'file-explorer' : 'backlink'] : [side === 'left' ? 'file-explorer' : 'backlink'];
			for (const viewType of views) {
				const leaves = this.app.workspace.getLeavesOfType(viewType);
				const leaf = leaves.find(l => l.view?.containerEl?.closest(side === 'left' ? '.mod-left-split' : '.mod-right-split'));
				if (leaf) { this.app.workspace.revealLeaf(leaf); break; }
			}
		} catch { /* ignore */ }
	}

	private showFocusTint(win: Window) {
		const duration = this.settings.focusTintDuration;
		if (duration <= 0) return;

		// Don't show focus tint in proxy windows
		if (win.document.body.classList.contains('perspecta-proxy-window')) {
			return;
		}

		const overlay = win.document.createElement('div');
		overlay.className = 'perspecta-focus-tint';
		overlay.style.animationDuration = `${duration}s`;
		win.document.body.appendChild(overlay);
		overlay.addEventListener('animationend', () => overlay.remove());
		setTimeout(() => overlay.parentNode && overlay.remove(), duration * 1000 + 500);
	}

	private showNoticeInWindow(win: Window | null, message: string, timeout: number = 4000) {
		if (win && win !== window) {
			// Don't show notices in proxy windows
			if (win.document.body.classList.contains('perspecta-proxy-window')) {
				new Notice(message, timeout);
				return;
			}
			const el = win.document.createElement('div');
			el.className = 'notice';
			el.textContent = message;
			let container = win.document.body.querySelector('.notice-container');
			if (!container) {
				container = win.document.createElement('div');
				container.className = 'notice-container';
				win.document.body.appendChild(container);
			}
			container.appendChild(el);
			setTimeout(() => el.remove(), timeout);
		} else {
			new Notice(message, timeout);
		}
	}

	// ============================================================================
	// Context Details View
	// ============================================================================

	private async showContextDetails() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file', 4000);
			return;
		}

		const context = await this.getContextForFile(file);
		if (!context) {
			new Notice('No context found in this note', 4000);
			return;
		}

		// Get the window containing the active file
		const activeLeaf = this.app.workspace.activeLeaf;
		const targetWindow = activeLeaf?.view?.containerEl?.win ?? window;

		const v2 = this.normalizeToV2(context);
		this.showContextDetailsModal(v2, file.name, targetWindow);
	}

	private showContextDetailsModal(context: WindowArrangementV2, fileName: string, targetWindow: Window) {
		const doc = targetWindow.document;

		const overlay = doc.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = doc.createElement('div');
		modal.className = 'perspecta-debug-modal perspecta-details-modal';

		// Header
		const h3 = modal.createEl('h3', { text: 'Context Details' });

		const header = modal.createDiv({ cls: 'perspecta-details-header' });
		header.createSpan({ cls: 'perspecta-details-file', text: fileName });
		const date = new Date(context.ts);
		header.createSpan({ cls: 'perspecta-details-date', text: date.toLocaleDateString() + ' ' + date.toLocaleTimeString() });

		const content = modal.createDiv({ cls: 'perspecta-details-content' });

		// Main window
		const mainSection = content.createDiv({ cls: 'perspecta-window-section' });
		mainSection.createDiv({ cls: 'perspecta-window-title', text: 'Main Window' });
		this.buildNodeDetailsDOM(mainSection, context.main.root, context.focusedWindow === -1);

		// Popouts
		context.popouts.forEach((p, i) => {
			const popoutSection = content.createDiv({ cls: 'perspecta-window-section' });
			popoutSection.createDiv({ cls: 'perspecta-window-title', text: `Popout ${i + 1}` });
			this.buildNodeDetailsDOM(popoutSection, p.root, context.focusedWindow === i);
		});

		// Screen info
		if (context.sourceScreen) {
			const ar = context.sourceScreen.aspectRatio;
			const screenType = ar > 2 ? 'ultrawide' : ar > 1.7 ? 'wide' : 'standard';
			content.createDiv({ cls: 'perspecta-screen-info', text: `Screen: ${screenType} (${ar.toFixed(2)})` });
		}

		const closeBtn = modal.createEl('button', { cls: 'perspecta-details-close', text: 'Close' });

		const closeModal = () => { modal.remove(); overlay.remove(); };
		overlay.onclick = closeModal;
		closeBtn.addEventListener('click', closeModal);

		doc.body.appendChild(overlay);
		doc.body.appendChild(modal);
	}

	private buildNodeDetailsDOM(container: HTMLElement, node: WorkspaceNodeState, isFocusedWindow: boolean, sizePercent?: string): void {
		if (node.type === 'tabs') {
			const tabList = container.createDiv({ cls: 'perspecta-tab-list' });
			if (sizePercent) {
				tabList.createSpan({ cls: 'perspecta-size-badge', text: sizePercent });
			}
			for (const t of node.tabs) {
				const name = t.path.split('/').pop()?.replace(/\.md$/, '') || t.path;
				const folder = t.path.includes('/') ? t.path.split('/').slice(0, -1).join('/') : '';
				const classes = ['perspecta-tab-item'];
				if (t.active) classes.push('perspecta-tab-active');
				if (t.active && isFocusedWindow) classes.push('perspecta-tab-focused');

				const tabItem = tabList.createDiv({ cls: classes.join(' ') });
				tabItem.createSpan({ cls: 'perspecta-tab-name', text: name });
				if (t.uid) {
					tabItem.createSpan({ cls: 'perspecta-uid-badge', text: 'uid', attr: { title: 'Has UID for move/rename resilience' } });
				}
				if (folder) {
					tabItem.createSpan({ cls: 'perspecta-tab-folder', text: folder });
				}
			}
		} else {
			const icon = node.direction === 'horizontal' ? '↔' : '↕';
			const sizes = node.sizes;
			const total = sizes?.reduce((a, b) => a + b, 0) || 0;
			const percentages = sizes?.map(s => total > 0 ? Math.round((s / total) * 100) + '%' : undefined);

			const splitDiv = container.createDiv({ cls: 'perspecta-split' });
			const splitHeader = splitDiv.createDiv({ cls: 'perspecta-split-header' });
			splitHeader.appendText(`${icon} Split (${node.direction})`);
			if (sizePercent) {
				splitHeader.createSpan({ cls: 'perspecta-size-badge', text: sizePercent });
			}

			const childrenDiv = splitDiv.createDiv({ cls: 'perspecta-split-children' });
			node.children.forEach((child, i) => {
				this.buildNodeDetailsDOM(childrenDiv, child, isFocusedWindow, percentages?.[i]);
			});
		}
	}

	// ============================================================================
	// Debug Modal (Save Confirmation)
	// ============================================================================

	private showContextDebugModal(context: WindowArrangementV2, fileName: string) {
		const overlay = document.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = document.createElement('div');
		modal.className = 'perspecta-debug-modal';

		modal.createEl('h3', { text: 'Context Saved' });

		const fileP = modal.createEl('p');
		fileP.createEl('strong', { text: 'File: ' });
		fileP.appendText(fileName);

		const focusedP = modal.createEl('p');
		focusedP.createEl('strong', { text: 'Focused: ' });
		focusedP.appendText(context.focusedWindow === -1 ? 'Main' : `Popout #${context.focusedWindow + 1}`);

		modal.createEl('h4', { text: 'Main Window' });
		this.buildDebugNodeDOM(modal, context.main.root, 0);

		if (context.popouts.length) {
			modal.createEl('h4', { text: `Popouts (${context.popouts.length})` });
			context.popouts.forEach((p, i) => {
				modal.createEl('p', { text: `Popout #${i + 1}:` });
				this.buildDebugNodeDOM(modal, p.root, 0);
			});
		}

		const closeBtn = modal.createEl('button', { cls: 'perspecta-debug-close', text: 'Close' });

		const closeModal = () => { modal.remove(); overlay.remove(); };
		overlay.onclick = closeModal;
		closeBtn.addEventListener('click', closeModal);

		document.body.appendChild(overlay);
		document.body.appendChild(modal);
	}

	private buildDebugNodeDOM(container: HTMLElement, node: WorkspaceNodeState, depth: number, sizePercent?: string): void {
		const wrapper = container.createDiv({ cls: `perspecta-debug-node perspecta-debug-depth-${depth}` });

		if (node.type === 'tabs') {
			const header = wrapper.createSpan({ cls: 'perspecta-debug-muted', text: 'Tabs' });
			if (sizePercent) {
				header.createSpan({ cls: 'perspecta-debug-size', text: ` (${sizePercent})` });
			}
			for (const t of node.tabs) {
				const tabLine = wrapper.createDiv({ cls: 'perspecta-debug-tab' });
				tabLine.appendText(`📄 ${t.path.split('/').pop() || t.path}`);
				if (t.active) tabLine.appendText(' ✓');
			}
		} else {
			const sizes = node.sizes;
			const total = sizes?.reduce((a, b) => a + b, 0) || 0;
			const percentages = sizes?.map(s => total > 0 ? Math.round((s / total) * 100) + '%' : undefined);

			const icon = node.direction === 'horizontal' ? '↔️' : '↕️';
			const header = wrapper.createDiv();
			header.appendText(`${icon} `);
			header.createEl('strong', { text: 'Split' });
			header.appendText(` (${node.direction})`);
			if (sizePercent) {
				header.createSpan({ cls: 'perspecta-debug-size', text: ` (${sizePercent})` });
			}

			node.children.forEach((child, i) => {
				this.buildDebugNodeDOM(wrapper, child, depth + 1, percentages?.[i]);
			});
		}
	}

	// ============================================================================
	// Context Indicator
	// ============================================================================

	private setupContextIndicator() {
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.isClosingWindow) return;
			this.updateContextIndicator(file);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (this.isClosingWindow) return;
			if (file === this.app.workspace.getActiveFile()) this.updateContextIndicator(file);
			this.updateFileExplorerIndicator(file);
		}));
	}

	private updateContextIndicator(file: TFile | null) {
		PerfTimer.begin('updateContextIndicator');
		document.querySelectorAll('.view-header-title-container .perspecta-context-indicator').forEach(el => el.remove());
		PerfTimer.mark('removeOldIndicators');

		if (!file) {
			PerfTimer.end('updateContextIndicator');
			return;
		}

		// Check frontmatter
		const hasContextFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;

		// Check external storage
		let hasContextExternal = false;
		if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, file);
			if (uid && this.externalStore.has(uid)) {
				hasContextExternal = true;
			}
		}

		const hasContext = hasContextFrontmatter || hasContextExternal;
		PerfTimer.mark('checkHasContext');

		if (hasContext) {
			const header = document.querySelector('.workspace-leaf.mod-active .view-header-title-container');
			if (header && !header.querySelector('.perspecta-context-indicator')) {
				const icon = this.createTargetIcon();
				icon.setAttribute('aria-label', 'Has saved context - click to restore');
				icon.addEventListener('click', () => this.restoreContext(file));
				header.appendChild(icon);
			}
		}
		PerfTimer.end('updateContextIndicator');
	}

	private createTargetIcon(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'perspecta-context-indicator';
		setIcon(el, 'target');
		return el;
	}

	// ============================================================================
	// File Explorer Indicators
	// ============================================================================

	private async setupFileExplorerIndicators() {
		PerfTimer.begin('setupFileExplorerIndicators');
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
		if (this.settings.storageMode === 'external') {
			if (!this.externalStore['initialized']) {
				await this.externalStore.initialize();
			}
			const uidsWithContext = this.externalStore.getAllUids();
			for (const file of mdFiles) {
				const uid = getUidFromCache(this.app, file);
				if (uid && uidsWithContext.includes(uid)) {
					this.filesWithContext.add(file.path);
				}
			}
			PerfTimer.mark('scanForContextFiles (external)');
		}

		this.registerEvent(this.app.workspace.on('layout-change', () => this.debouncedRefreshIndicators()));
		setTimeout(() => this.refreshFileExplorerIndicators(), 500);
		PerfTimer.end('setupFileExplorerIndicators');
	}

	private async updateFileExplorerIndicator(file: TFile) {
		let hasContext = false;

		if (file.extension === 'canvas') {
			// Canvas files store context in their JSON
			hasContext = await canvasHasContext(this.app, file);
		} else if (file.extension === 'base') {
			// Base files store context in their YAML
			hasContext = await baseHasContext(this.app, file);
		} else {
			// Markdown files: check frontmatter
			hasContext = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;

			// Also check external storage if enabled
			if (!hasContext && this.settings.storageMode === 'external') {
				const uid = getUidFromCache(this.app, file);
				if (uid && this.externalStore.has(uid)) {
					hasContext = true;
				}
			}
		}

		hasContext ? this.filesWithContext.add(file.path) : this.filesWithContext.delete(file.path);
		this.debouncedRefreshIndicators();
	}

	private debouncedRefreshIndicators() {
		if (this.refreshIndicatorsTimeout) clearTimeout(this.refreshIndicatorsTimeout);
		this.refreshIndicatorsTimeout = setTimeout(() => {
			// Skip if we're in the middle of closing a window
			if (this.isClosingWindow) {
				// console.log(`[Perspecta] refreshFileExplorerIndicators skipped (window closing)`);
				this.refreshIndicatorsTimeout = null;
				return;
			}
			this.refreshFileExplorerIndicators();
			this.refreshIndicatorsTimeout = null;
		}, 100);
	}

	private refreshFileExplorerIndicators() {
		PerfTimer.begin('refreshFileExplorerIndicators');
		document.querySelectorAll('.nav-file-title .perspecta-context-indicator').forEach(el => el.remove());
		PerfTimer.mark('removeOldIndicators');

		this.filesWithContext.forEach(path => {
			const el = document.querySelector(`.nav-file-title[data-path="${CSS.escape(path)}"]`);
			if (el && !el.querySelector('.perspecta-context-indicator')) {
				const icon = this.createTargetIcon();
				icon.setAttribute('aria-label', 'Has saved context');
				el.insertBefore(icon, el.firstChild);
			}
		});
		PerfTimer.mark(`addIndicators (${this.filesWithContext.size} files)`);
		PerfTimer.end('refreshFileExplorerIndicators');
	}

	// ============================================================================
	// Utility
	// ============================================================================

	async openInNewWindow(file: TFile) {
		const leaf = this.app.workspace.openPopoutLeaf();
		await leaf.openFile(file);
	}

	/**
	 * Convert a popout window to a minimalist proxy window (experimental)
	 */
	async convertToProxyWindow(leaf: WorkspaceLeaf, file: TFile) {
		// Get current window position
		const win = leaf.view.containerEl.win;
		const x = win?.screenX || 100;
		const y = win?.screenY || 100;

		// Check if this file has a saved arrangement
		let arrangementUid: string | undefined;
		const uid = await getUidFromFile(this.app, file);
		if (uid && this.settings.storageMode === 'external') {
			const arrangements = this.externalStore.getAll(uid);
			if (arrangements.length > 0) {
				arrangementUid = uid;
			}
		} else if (this.settings.storageMode === 'frontmatter' && file.extension === 'md') {
			const hasContext = await markdownHasContext(this.app, file);
			if (hasContext) {
				arrangementUid = uid || 'frontmatter';
			}
		}

		// Close the current leaf first and wait a moment for cleanup
		leaf.detach();
		await new Promise(resolve => setTimeout(resolve, 100));

		// Open a new proxy leaf with small initial size
		const proxyLeaf = this.app.workspace.openPopoutLeaf({
			size: { width: 250, height: 50 }
		});

		// Set the view to proxy type
		await proxyLeaf.setViewState({
			type: PROXY_VIEW_TYPE,
			state: {
				filePath: file.path,
				arrangementUid
			} as ProxyViewState
		});

		// Wait for view to be ready, then position
		await new Promise(resolve => setTimeout(resolve, 100));

		// Try to position the window at the original location
		const newWin = proxyLeaf.view?.containerEl?.win;
		if (newWin && newWin !== window) {
			try {
				newWin.moveTo(x, y);
			} catch (e) {
				// Silently fail - window positioning may not be allowed
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		PerfTimer.setEnabled(this.settings.enableDebugLogging);
		COORDINATE_DEBUG = this.settings.enableDebugLogging;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		PerfTimer.setEnabled(this.settings.enableDebugLogging);
		COORDINATE_DEBUG = this.settings.enableDebugLogging;
	}
}

// ============================================================================
// Settings Tab
// ============================================================================

type SettingsTab = 'changelog' | 'context' | 'storage' | 'backup' | 'experimental' | 'debug';

class PerspectaSettingTab extends PluginSettingTab {
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
		containerEl.createEl('h2', { text: 'Changelog' });

		// Version 0.1.6
		const v016 = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		v016.createEl('h3', { text: 'v0.1.6' });
		const v016List = v016.createEl('ul');
		v016List.createEl('li', { text: 'Experimental: Proxy windows - minimalist window showing only note title' });
		v016List.createEl('li', { text: 'Click proxy to restore latest arrangement, Shift+click for selector' });
		v016List.createEl('li', { text: 'Click proxy without arrangement to expand to full window' });
		v016List.createEl('li', { text: 'Proxy window positions and sizes saved/restored with arrangements' });
		v016List.createEl('li', { text: 'Added Experimental settings tab to enable/disable proxy windows' });
		v016List.createEl('li', { text: 'Fixed notifications not auto-dismissing (4 second timeout)' });
		v016List.createEl('li', { text: 'Notifications and focus tints no longer appear in proxy windows' });

		// Version 0.1.3
		const v013 = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		v013.createEl('h3', { text: 'v0.1.3' });
		const v013List = v013.createEl('ul');
		v013List.createEl('li', { text: 'Multi-arrangement storage: store up to 5 arrangements per note' });
		v013List.createEl('li', { text: 'Arrangement selector modal with visual SVG previews' });
		v013List.createEl('li', { text: 'Delete button to remove specific arrangements from history' });
		v013List.createEl('li', { text: 'Confirmation dialog when overwriting single arrangement' });
		v013List.createEl('li', { text: 'Backup & restore functionality to perspecta folder' });
		v013List.createEl('li', { text: 'SVG previews show windows, splits, sidebars, and focus highlight' });
		v013List.createEl('li', { text: 'Instant tooltips on SVG areas showing note names' });
		v013List.createEl('li', { text: 'Renamed "Focus tint duration" setting for clarity' });
		v013List.createEl('li', { text: 'Fixed notification toast not disappearing' });

		// Version 0.1.2
		const v012 = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		v012.createEl('h3', { text: 'v0.1.2' });
		const v012List = v012.createEl('ul');
		v012List.createEl('li', { text: 'Improved plugin compliance with Obsidian guidelines' });

		// Version 0.1.1
		const v011 = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		v011.createEl('h3', { text: 'v0.1.1' });
		const v011List = v011.createEl('ul');
		v011List.createEl('li', { text: 'Save and restore scroll position for all tabs' });
		v011List.createEl('li', { text: 'Save and restore split sizes (pane proportions)' });

		// Version 0.1.0
		const v010 = containerEl.createDiv({ cls: 'perspecta-changelog-version' });
		v010.createEl('h3', { text: 'v0.1.0' });
		const v010List = v010.createEl('ul');
		v010List.createEl('li', { text: 'Initial release' });
		v010List.createEl('li', { text: 'Save and restore window arrangements (tabs, splits, popouts)' });
		v010List.createEl('li', { text: 'External storage mode for cleaner notes' });
		v010List.createEl('li', { text: 'Frontmatter storage mode for portability' });
		v010List.createEl('li', { text: 'Auto-generate UIDs for file tracking' });
		v010List.createEl('li', { text: 'Context indicators in file explorer' });
		v010List.createEl('li', { text: 'Focus tint animation on restore' });
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
							new Notice(`Restore complete: ${result.restored} arrangements restored${result.errors > 0 ? `, ${result.errors} errors` : ''}`, 4000);
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
			const infoDiv = containerEl.createDiv({ cls: 'setting-item-description' });
			infoDiv.style.marginTop = '12px';
			infoDiv.style.marginBottom = '12px';
			infoDiv.innerHTML = `
				<strong>How to use:</strong><br>
				• Use command "Convert to proxy window" on any popout window<br>
				• The proxy shows only the note title<br>
				• Click the expand icon (↗) to restore the full window<br>
				• If the note has a saved arrangement, click the title to restore it
			`;
		}
	}

	private displayDebugSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Show debug modal on save')
			.setDesc('Show a modal with context details when saving')
			.addToggle(t => t.setValue(this.plugin.settings.showDebugModal).onChange(async v => {
				this.plugin.settings.showDebugModal = v; await this.plugin.saveSettings();
			}));

		new Setting(containerEl).setName('Enable debug logging')
			.setDesc('Log performance timing to the developer console (Cmd+Shift+I)')
			.addToggle(t => t.setValue(this.plugin.settings.enableDebugLogging).onChange(async v => {
				this.plugin.settings.enableDebugLogging = v; await this.plugin.saveSettings();
			}));
	}

	private getHotkeyDisplay(commandId: string): string {
		// Access Obsidian's internal hotkey manager to get current hotkey for a command
		const hotkeyManager = (this.app as any).hotkeyManager;
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
