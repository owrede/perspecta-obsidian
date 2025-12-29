/**
 * Window Restore Service
 *
 * Restores window arrangements including:
 * - Main window workspace layout
 * - Popout window recreation
 * - Split proportions
 * - Tab groups
 * - Scroll positions
 *
 * @module services/window-restore
 *
 * ## Obsidian API Usage
 * - `App.workspace.createLeafInParent()` - Create leaves in specific containers
 * - `App.workspace.createLeafBySplit()` - Create splits from existing leaves
 * - `App.workspace.openPopoutLeaf()` - Create popout windows
 * - `WorkspaceLeaf.openFile()` - Open files in leaves
 * - `WorkspaceLeaf.detach()` - Close leaves
 *
 * ## Internal API Dependencies
 * - `workspace.rootSplit` - Main window root
 * - `workspace.floatingSplit` - Popout windows
 * - `leaf.parent` - Access parent containers
 *
 * @see types/obsidian-internal for type definitions
 */

import { App, TFile, WorkspaceLeaf, Notice } from 'obsidian';
import {
	TabState,
	SplitState,
	TabGroupState,
	WorkspaceNodeState,
	WindowStateV2,
	SidebarState,
	ScreenInfo,
	WindowArrangementV1,
	WindowArrangementV2,
	WindowArrangement
} from '../types';
import {
	ExtendedWorkspace,
	WorkspaceSplit,
	WorkspaceTabContainer,
	setContainerDimension,
	triggerWorkspaceResize,
	applyScrollPosition
} from '../types/obsidian-internal';
import {
	virtualToPhysical,
	getPhysicalScreen,
	needsTiling,
	calculateTiledLayout,
	validateGeometry,
	sanitizeGeometry
} from '../utils/coordinates';
import { resolveFile } from '../utils/file-resolver';
import { PerfTimer } from '../utils/perf-timer';
import { TIMING, LIMITS } from '../utils/constants';
import { delay, retryAsync, withTimeout, safeTimeout } from '../utils/async-utils';

function setPropertiesCollapsed(view: unknown, collapsed: boolean): void {
	const containerEl = (view as { containerEl?: HTMLElement })?.containerEl;
	if (!containerEl) {
		return;
	}

	// Method 1: Try the standard metadata-container approach
	const metadataEl = containerEl.querySelector('.metadata-container') as HTMLElement | null;
	if (metadataEl) {
		const isCollapsed = metadataEl.classList.contains('is-collapsed') || metadataEl.classList.contains('collapsed');

		if (isCollapsed === collapsed) {
			return;
		}

		// The toggle is the .metadata-properties-heading element
		const toggle = metadataEl.querySelector('.metadata-properties-heading') as HTMLElement | null;
		if (toggle) {
			try {
				toggle.click();
				return;
			} catch (e) {
				// Try alternative click method
				try {
					const event = new MouseEvent('click', { bubbles: true, cancelable: true });
					toggle.dispatchEvent(event);
					return;
				} catch (e2) {
					// Continue to fallback methods
				}
			}
		}
	}

	// Method 2: Try alternative selectors for properties toggle
	const possibleToggles = containerEl.querySelectorAll(
		'.metadata-toggle, .properties-toggle, [aria-label*="properties"], [aria-label*="Properties"], .clickable-icon'
	) as NodeListOf<HTMLElement>;

	for (let i = 0; i < possibleToggles.length; i++) {
		const toggle = possibleToggles[i];
		const ariaExpanded = toggle.getAttribute('aria-expanded');

		if ((collapsed && ariaExpanded === 'true') || (!collapsed && ariaExpanded === 'false')) {
			try {
				toggle.click();
				return;
			} catch (e) {
				// Continue to next toggle
			}
		}
	}

	// Method 3: Try to find the collapse button by text content
	const allButtons = Array.from(containerEl.querySelectorAll('button, .clickable-icon') as NodeListOf<HTMLElement>);

	for (const button of allButtons) {
		const text = button.textContent?.toLowerCase() || '';
		const ariaLabel = button.getAttribute('aria-label')?.toLowerCase() || '';

		if (text.includes('properties') || ariaLabel.includes('properties') ||
			text.includes('metadata') || ariaLabel.includes('metadata')) {

			const ariaExpanded = button.getAttribute('aria-expanded');
			if ((collapsed && ariaExpanded === 'true') || (!collapsed && ariaExpanded === 'false')) {
				try {
					button.click();
					return;
				} catch (e) {
					// Continue to next button
				}
			}
		}
	}
}

/**
 * Options for window restoration.
 */
export interface RestoreOptions {
	/** Enable debug logging */
	debug?: boolean;
	/** Restore scroll positions */
	restoreScroll?: boolean;
	/** Restore canvas viewports */
	restoreCanvasViewport?: boolean;
	/** Delay between split operations (ms) */
	splitDelay?: number;
}

const DEFAULT_OPTIONS: RestoreOptions = {
	debug: false,
	restoreScroll: true,
	restoreCanvasViewport: true,
	splitDelay: 50
};

/**
 * Tracks path corrections made during restoration.
 * Used to update stored contexts with corrected paths.
 */
export interface PathCorrection {
	oldPath: string;
	newPath: string;
	newName: string;
}

/**
 * Pending tab activation to be processed after windows are ready.
 */
interface PendingTabActivation {
	container: WorkspaceTabContainer;
	targetIndex: number;
}

/**
 * Window Restore Service
 *
 * Provides methods for restoring window arrangements.
 */
export class WindowRestoreService {
	private app: App;
	private pathCorrections: Map<string, PathCorrection> = new Map();
	private pendingTabActivations: PendingTabActivation[] = [];
	private scrollTimeoutCleanup: (() => void) | null = null;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Gets path corrections made during the last restore operation.
	 * These should be used to update stored context data.
	 */
	getPathCorrections(): Map<string, PathCorrection> {
		return this.pathCorrections;
	}

	/**
	 * Clears accumulated path corrections.
	 */
	clearPathCorrections(): void {
		this.pathCorrections.clear();
	}

	/**
	 * Normalizes a window arrangement to V2 format.
	 *
	 * @param arrangement - V1 or V2 arrangement
	 * @returns V2 arrangement
	 */
	normalizeToV2(arrangement: WindowArrangement): WindowArrangementV2 {
		if (arrangement.v === 2) {
			return arrangement as WindowArrangementV2;
		}

		const v1 = arrangement as WindowArrangementV1;
		return {
			v: 2,
			ts: v1.ts,
			focusedWindow: v1.focusedWindow,
			main: {
				root: { type: 'tabs', tabs: v1.main.tabs },
				x: v1.main.x,
				y: v1.main.y,
				width: v1.main.width,
				height: v1.main.height
			},
			popouts: v1.popouts.map(p => ({
				root: { type: 'tabs', tabs: p.tabs },
				x: p.x,
				y: p.y,
				width: p.width,
				height: p.height
			})),
			leftSidebar: v1.leftSidebar,
			rightSidebar: v1.rightSidebar
		};
	}

	/**
	 * Applies a complete window arrangement.
	 *
	 * @param arrangement - Arrangement to restore
	 * @param contextNotePath - Path of the context note (for focus)
	 * @param options - Restore options
	 * @returns The focused window, or null
	 */
	async applyArrangement(
		arrangement: WindowArrangement,
		contextNotePath?: string,
		options: RestoreOptions = {}
	): Promise<Window | null> {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		this.pathCorrections.clear();
		this.pendingTabActivations = [];

		// Maximum number of popouts to prevent runaway window creation
		const MAX_POPOUTS = 20;

		try {
			PerfTimer.mark('applyArrangement:start');

			const v2 = this.normalizeToV2(arrangement);
			PerfTimer.mark('normalizeToV2');

			// Validate arrangement structure
			if (!v2 || typeof v2 !== 'object') {
				console.error('[Perspecta] Invalid arrangement: not an object');
				new Notice('Cannot restore: invalid arrangement data', 4000);
				return null;
			}

			if (!v2.main || typeof v2.main !== 'object') {
				console.error('[Perspecta] Invalid arrangement: missing main window');
				new Notice('Cannot restore: missing main window data', 4000);
				return null;
			}

			// Validate and limit popouts
			if (!Array.isArray(v2.popouts)) {
				console.warn('[Perspecta] Invalid popouts array, using empty');
				v2.popouts = [];
			}

			if (v2.popouts.length > MAX_POPOUTS) {
				console.warn(`[Perspecta] Too many popouts (${v2.popouts.length}), limiting to ${MAX_POPOUTS}`);
				v2.popouts = v2.popouts.slice(0, MAX_POPOUTS);
			}

			// Check if we need to tile due to aspect ratio mismatch
			const useTiling = needsTiling(v2.sourceScreen);
			let tiledPositions: ReturnType<typeof calculateTiledLayout> = [];

			if (useTiling) {
				const windowCount = 1 + v2.popouts.length;
				tiledPositions = calculateTiledLayout(windowCount, v2.main);

				if (opts.debug) {
					console.log(`[Perspecta] Using tiled layout:`, {
						sourceAspect: v2.sourceScreen?.aspectRatio?.toFixed(2),
						targetAspect: (getPhysicalScreen().width / getPhysicalScreen().height).toFixed(2),
						windowCount,
						tiledPositions
					});
				}

				new Notice(`Screen shape changed - tiling ${windowCount} windows`, 4000);
			}
			PerfTimer.mark('checkTilingNeeded');

			// Close existing popouts
			const popoutWindows = this.getPopoutWindowObjects();
			PerfTimer.mark('getPopoutWindowObjects');

			for (const win of popoutWindows) {
				this.closePopoutWindow(win);
			}
			PerfTimer.mark('closePopoutWindows');

			// Get and prepare main window
			const mainLeaves = this.getMainWindowLeaves();
			PerfTimer.mark('getMainWindowLeaves');

			// Detach extra leaves
			for (let i = 1; i < mainLeaves.length; i++) {
				mainLeaves[i].detach();
			}
			PerfTimer.mark('detachExtraLeaves');

			// Restore main window geometry
			if (useTiling && tiledPositions.length > 0) {
				this.restoreWindowGeometryDirect(window, tiledPositions[0]);
			} else {
				this.restoreWindowGeometry(window, v2.main, v2.sourceScreen);
			}
			PerfTimer.mark('restoreWindowGeometry');

			// Restore main workspace
			const workspace = this.app.workspace as unknown as ExtendedWorkspace;
			await this.restoreWorkspaceNode(workspace.rootSplit, v2.main.root, mainLeaves[0], opts);
			PerfTimer.mark('restoreMainWorkspace');

			// Restore popouts with deduplication
			const restoredPaths = new Set<string>();
			for (let i = 0; i < v2.popouts.length; i++) {
				const firstTab = this.getFirstTab(v2.popouts[i].root);
				const popoutPath = firstTab?.path;

				if (popoutPath && restoredPaths.has(popoutPath)) {
					continue;
				}
				if (popoutPath) {
					restoredPaths.add(popoutPath);
				}

				const tiledPosition = useTiling && tiledPositions.length > i + 1
					? tiledPositions[i + 1]
					: undefined;

				await this.restorePopoutWindow(v2.popouts[i], v2.sourceScreen, tiledPosition, opts);
				PerfTimer.mark(`restorePopout[${i}]`);
			}

			// Process pending tab activations
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

			// Schedule scroll restoration
			if (opts.restoreScroll) {
				this.scheduleScrollRestoration(v2.main.root);
				for (const popout of v2.popouts) {
					this.scheduleScrollRestoration(popout.root);
				}
				PerfTimer.mark('scheduleScrollRestoration');
			}

			// Schedule Properties (frontmatter) collapse/expand restoration
			PerfTimer.mark('schedulePropertiesRestoration');
			this.schedulePropertiesRestoration(v2.main.root);
			for (const popout of v2.popouts) {
				this.schedulePropertiesRestoration(popout.root);
			}

			// Focus the context note window
			let contextNoteWin: Window | null = null;
			if (contextNotePath) {
				contextNoteWin = this.findWindowContainingFile(contextNotePath);
			}

			const focusedWin = contextNoteWin ?? this.getFocusedWindow(v2);

			if (focusedWin) {
				if (contextNotePath && contextNoteWin) {
					this.activateLeafByPath(contextNoteWin, contextNotePath);
				} else {
					this.activateWindowLeaf(focusedWin, v2);
				}
				focusedWin.focus();
			}
			PerfTimer.mark('activateFocusedWindow');

			return focusedWin;
		} catch (e) {
			new Notice('Error restoring context: ' + (e as Error).message, 4000);
			return null;
		}
	}

	// =========================================================================
	// Properties (Frontmatter) UI Restoration
	// =========================================================================

	private schedulePropertiesRestoration(state: WorkspaceNodeState): void {
		const propsMap = new Map<string, boolean>();
		this.collectPropertiesState(state, propsMap);
		if (propsMap.size === 0) {
			return;
		}

		// Try multiple times with increasing delays
		const tryRestore = (attempt: number) => {
			safeTimeout(() => {
				let restoredCount = 0;
				this.app.workspace.iterateAllLeaves(leaf => {
					const filePath = (leaf.view as { file?: TFile }).file?.path;
					if (!filePath) return;
					const collapsed = propsMap.get(filePath);
					if (collapsed === undefined) return;
					setPropertiesCollapsed(leaf.view, collapsed);
					restoredCount++;
				});

				// If this was the last attempt, check if we need to try again
				if (attempt < 3 && restoredCount > 0) {
					// Wait a bit and check if the properties actually changed
					safeTimeout(() => {
						let needsRetry = false;
						this.app.workspace.iterateAllLeaves(leaf => {
							const filePath = (leaf.view as { file?: TFile }).file?.path;
							if (!filePath) return;
							const desired = propsMap.get(filePath);
							if (desired === undefined) return;

							// Check current state
							const containerEl = (leaf.view as { containerEl?: HTMLElement })?.containerEl;
							if (containerEl) {
								const metadataEl = containerEl.querySelector('.metadata-container') as HTMLElement | null;
								if (metadataEl) {
									const isCollapsed = metadataEl.classList.contains('is-collapsed') || metadataEl.classList.contains('collapsed');
									if (isCollapsed !== desired) {
										needsRetry = true;
									}
								}
							}
						});

						if (needsRetry) {
							tryRestore(attempt + 1);
						}
					}, 1000);
				}
			}, TIMING.INDICATORS_REFRESH_DELAY + (attempt - 1) * 1000); // Increase delay each attempt
		};

		// Start with first attempt
		tryRestore(1);
	}

	private collectPropertiesState(state: WorkspaceNodeState, map: Map<string, boolean>): void {
		if (state.type === 'tabs') {
			for (const tab of state.tabs) {
				if (tab.propertiesCollapsed !== undefined) {
					map.set(tab.path, tab.propertiesCollapsed);
				}
			}
			return;
		}
		for (const child of state.children) {
			this.collectPropertiesState(child, map);
		}
	}

	// =========================================================================
	// Workspace Node Restoration
	// =========================================================================

	/**
	 * Restores a workspace node (split or tabs).
	 */
	private async restoreWorkspaceNode(
		parent: WorkspaceSplit | null,
		state: WorkspaceNodeState,
		existingLeaf?: WorkspaceLeaf,
		options: RestoreOptions = {}
	): Promise<WorkspaceLeaf | undefined> {
		if (!state?.type) {
			if ('tabs' in state) {
				return this.restoreTabGroup(parent, { type: 'tabs', tabs: (state as { tabs: TabState[] }).tabs }, existingLeaf, options);
			}
			return existingLeaf;
		}

		return state.type === 'tabs'
			? this.restoreTabGroup(parent, state, existingLeaf, options)
			: this.restoreSplit(parent, state as SplitState, existingLeaf, options);
	}

	/**
	 * Restores a tab group.
	 */
	private async restoreTabGroup(
		parent: WorkspaceSplit | null,
		state: TabGroupState,
		existingLeaf?: WorkspaceLeaf,
		options: RestoreOptions = {}
	): Promise<WorkspaceLeaf | undefined> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		if (!state.tabs?.length) return existingLeaf;

		// Find active tab and reorder tabs (inactive first, active last)
		let activeTabIdx = state.tabs.findIndex(t => t.active);
		if (activeTabIdx < 0) activeTabIdx = 0;

		const reorderedTabs: { tab: TabState; originalIndex: number }[] = [];
		for (let i = 0; i < state.tabs.length; i++) {
			reorderedTabs.push({ tab: state.tabs[i], originalIndex: i });
		}
		reorderedTabs.sort((a, b) => {
			if (a.tab.active && !b.tab.active) return 1;
			if (!a.tab.active && b.tab.active) return -1;
			return a.originalIndex - b.originalIndex;
		});

		if (opts.debug && PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restoreTabGroup: ${state.tabs.length} tabs`);
		}

		let firstLeaf: WorkspaceLeaf | undefined;
		let container: WorkspaceTabContainer | null = null;
		let isFirstTabOpened = false;

		for (let i = 0; i < reorderedTabs.length; i++) {
			const { tab, originalIndex } = reorderedTabs[i];
			const tabStart = performance.now();

			// Resolve file with fallbacks
			const { file, method, error } = resolveFile(this.app, tab);
			if (!file) {
				if (opts.debug) {
					console.log(`[Perspecta] File not found: ${tab.path}`, error);
				}
				continue;
			}

			// Track path corrections
			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					oldPath: tab.path,
					newPath: file.path,
					newName: file.basename
				});
			}

			let leaf: WorkspaceLeaf;

			if (!isFirstTabOpened && existingLeaf) {
				await existingLeaf.openFile(file);
				leaf = existingLeaf;
				container = (existingLeaf as unknown as { parent: WorkspaceTabContainer }).parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else if (!isFirstTabOpened) {
				leaf = this.app.workspace.createLeafInParent(parent as unknown as WorkspaceLeaf['parent'], 0);
				await leaf.openFile(file);
				container = (leaf as unknown as { parent: WorkspaceTabContainer }).parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else {
				if (!container) continue;
				const childCount = container.children?.length ?? 0;
				leaf = this.app.workspace.createLeafInParent(container as unknown as WorkspaceLeaf['parent'], childCount);
				await leaf.openFile(file);
			}

			const elapsed = performance.now() - tabStart;
			if (opts.debug && PerfTimer.isEnabled()) {
				const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
				console.log(`[Perspecta] ${flag} openFile[${originalIndex}]: ${file.basename} - ${elapsed.toFixed(1)}ms`);
			}
		}

		return firstLeaf;
	}

	/**
	 * Restores a split structure.
	 */
	private async restoreSplit(
		parent: WorkspaceSplit | null,
		state: SplitState,
		existingLeaf?: WorkspaceLeaf,
		options: RestoreOptions = {}
	): Promise<WorkspaceLeaf | undefined> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		if (!state.children.length) return existingLeaf;

		// Set parent direction
		if (parent && parent.direction !== state.direction) {
			parent.direction = state.direction;
		}

		let firstLeaf = existingLeaf;

		// Process first child
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs') {
			const firstTab = firstChild.tabs[0];
			if (firstTab && existingLeaf) {
				const { file, method } = resolveFile(this.app, firstTab);
				if (file) {
					if (method !== 'path') {
						this.pathCorrections.set(firstTab.path, {
							oldPath: firstTab.path,
							newPath: file.path,
							newName: file.basename
						});
					}
					await existingLeaf.openFile(file);
				}
			}
			if (firstChild.tabs.length > 1 && existingLeaf) {
				await this.restoreRemainingTabs(existingLeaf, firstChild.tabs, 1, opts);
			}
			firstLeaf = existingLeaf;
		} else {
			firstLeaf = await this.buildNestedSplit(existingLeaf, firstChild, opts);
		}

		// Add siblings
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			await delay(TIMING.WINDOW_SPLIT_DELAY);

			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);

			await delay(TIMING.WINDOW_SPLIT_DELAY);

			if (child.type === 'tabs') {
				const firstTab = child.tabs[0];
				if (firstTab) {
					const { file, method } = resolveFile(this.app, firstTab);
					if (file) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, {
								oldPath: firstTab.path,
								newPath: file.path,
								newName: file.basename
							});
						}
						await newLeaf.openFile(file);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1, opts);
				}
			} else {
				const firstTab = this.getFirstTabFromNode(child);
				if (firstTab) {
					const { file, method } = resolveFile(this.app, firstTab);
					if (file) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, {
								oldPath: firstTab.path,
								newPath: file.path,
								newName: file.basename
							});
						}
						await newLeaf.openFile(file);
					}
				}
				await this.buildNestedSplit(newLeaf, child, opts);
			}
		}

		// Apply saved sizes
		if (state.sizes && state.sizes.length > 0 && firstLeaf) {
			await this.applySplitSizes(firstLeaf, state.sizes);
		}

		return firstLeaf;
	}

	/**
	 * Builds a nested split structure.
	 */
	private async buildNestedSplit(
		existingLeaf: WorkspaceLeaf | undefined,
		state: SplitState,
		options: RestoreOptions = {}
	): Promise<WorkspaceLeaf | undefined> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		if (!state.children.length) return existingLeaf;

		const firstLeaf = existingLeaf;

		// Open first file
		const firstTab = this.getFirstTabFromNode(state);
		if (firstTab && existingLeaf) {
			const { file, method } = resolveFile(this.app, firstTab);
			if (file) {
				if (method !== 'path') {
					this.pathCorrections.set(firstTab.path, {
						oldPath: firstTab.path,
						newPath: file.path,
						newName: file.basename
					});
				}
				await existingLeaf.openFile(file);
			}
		}

		// Build rest of structure
		for (let i = 0; i < state.children.length; i++) {
			const child = state.children[i];
			await delay(TIMING.WINDOW_SPLIT_DELAY);

			if (i === 0) {
				if (child.type === 'tabs' && child.tabs.length > 1) {
					await this.restoreRemainingTabs(existingLeaf!, child.tabs, 1, opts);
				}
				continue;
			}

			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);
			await delay(TIMING.WINDOW_SPLIT_DELAY);

			if (child.type === 'tabs') {
				const tab = child.tabs[0];
				if (tab) {
					const { file, method } = resolveFile(this.app, tab);
					if (file) {
						if (method !== 'path') {
							this.pathCorrections.set(tab.path, {
								oldPath: tab.path,
								newPath: file.path,
								newName: file.basename
							});
						}
						await newLeaf.openFile(file);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1, opts);
				}
			} else {
				await this.buildNestedSplit(newLeaf, child, opts);
			}
		}

		if (state.sizes && state.sizes.length > 0 && firstLeaf) {
			await this.applySplitSizes(firstLeaf, state.sizes);
		}

		return firstLeaf;
	}

	/**
	 * Restores remaining tabs in a tab group.
	 */
	private async restoreRemainingTabs(
		leaf: WorkspaceLeaf,
		tabs: TabState[],
		startIndex: number,
		_options: RestoreOptions = {}
	): Promise<void> {
		const container = (leaf as unknown as { parent: WorkspaceTabContainer }).parent;
		if (!container) return;

		for (let i = startIndex; i < tabs.length; i++) {
			const tab = tabs[i];
			const { file, method } = resolveFile(this.app, tab);
			if (!file) continue;

			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					oldPath: tab.path,
					newPath: file.path,
					newName: file.basename
				});
			}

			const childCount = container.children?.length ?? 0;
			const newLeaf = this.app.workspace.createLeafInParent(container as unknown as WorkspaceLeaf['parent'], childCount);
			await newLeaf.openFile(file);
		}

		// Queue tab activation
		const activeIdx = tabs.findIndex(t => t.active);
		if (activeIdx >= 0) {
			this.pendingTabActivations.push({ container, targetIndex: activeIdx });
		}
	}

	/**
	 * Applies split sizes to children.
	 */
	private async applySplitSizes(anyLeaf: WorkspaceLeaf, sizes: number[]): Promise<void> {
		await delay(TIMING.SCROLL_RESTORATION_DELAY);

		let parent = (anyLeaf as unknown as { parent?: WorkspaceSplit | null }).parent ?? null;
		let attempts = 0;

		while (parent && attempts < 5) {
			if (parent.children?.length === sizes.length && parent.direction) {
				break;
			}
			parent = parent.parent ?? null;
			attempts++;
		}

		if (!parent?.children || parent.children.length !== sizes.length) {
			return;
		}

		// Normalize sizes
		const total = sizes.reduce((a, b) => a + b, 0);
		const normalizedSizes = sizes.map(s => (s / total) * 100);

		for (let i = 0; i < normalizedSizes.length; i++) {
			const child = parent.children[i];
			if (child) {
				setContainerDimension(child, normalizedSizes[i]);
			}
		}

		triggerWorkspaceResize(this.app.workspace, (this.app.workspace as unknown as ExtendedWorkspace).rootSplit);
	}

	/**
	 * Processes pending tab activations.
	 */
	private processPendingTabActivations(): void {
		for (const { container, targetIndex } of this.pendingTabActivations) {
			if (container?.children && targetIndex < container.children.length) {
				const targetLeaf = container.children[targetIndex] as WorkspaceLeaf;
				this.app.workspace.setActiveLeaf(targetLeaf, { focus: false });
			}
		}
		this.pendingTabActivations = [];
	}

	// =========================================================================
	// Popout Window Restoration
	// =========================================================================

	/**
	 * Restores a popout window.
	 */
	private async restorePopoutWindow(
		state: WindowStateV2,
		sourceScreen?: ScreenInfo,
		tiledPosition?: { x: number; y: number; width: number; height: number },
		options: RestoreOptions = {}
	): Promise<void> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		// Calculate target geometry with validation
		let geometry: { x: number; y: number; width: number; height: number };
		const defaultGeometry = { x: 100, y: 100, width: 800, height: 600 };

		if (tiledPosition) {
			// Validate tiled position
			const validated = validateGeometry(tiledPosition);
			geometry = validated ?? defaultGeometry;
		} else if (state.x !== undefined && state.y !== undefined && state.width !== undefined && state.height !== undefined) {
			// Validate virtual coordinates before conversion
			const virtualGeometry = { x: state.x, y: state.y, width: state.width, height: state.height };
			const validated = validateGeometry(virtualGeometry);
			if (!validated) {
				console.warn('[Perspecta] Skipping popout with invalid geometry:', virtualGeometry);
				return;
			}
			geometry = virtualToPhysical(validated, sourceScreen);
		} else {
			geometry = defaultGeometry;
		}

		// Final validation of computed geometry
		const safeGeometry = sanitizeGeometry(geometry, defaultGeometry);
		
		// Log if geometry was corrected
		if (safeGeometry.width !== geometry.width || safeGeometry.height !== geometry.height) {
			console.warn('[Perspecta] Geometry was sanitized:', { original: geometry, sanitized: safeGeometry });
		}

		// Get first file to open
		const firstTab = this.getFirstTab(state.root);
		if (!firstTab) return;

		const { file } = resolveFile(this.app, firstTab);
		if (!file) return;

		// Create popout with validated size
		let popoutLeaf;
		try {
			popoutLeaf = this.app.workspace.openPopoutLeaf({
				size: { width: safeGeometry.width, height: safeGeometry.height }
			});
		} catch (e) {
			console.error('[Perspecta] Failed to create popout window:', e);
			return;
		}

		try {
			await popoutLeaf.openFile(file);
		} catch (e) {
			console.error('[Perspecta] Failed to open file in popout:', e);
			return;
		}
		
		await delay(TIMING.TAB_ACTIVATION_DELAY);

		// Position window with validated coordinates
		const win = popoutLeaf.view?.containerEl?.win;
		if (win && win !== window) {
			try {
				win.moveTo(safeGeometry.x, safeGeometry.y);
				win.resizeTo(safeGeometry.width, safeGeometry.height);
			} catch (e) {
				console.warn('[Perspecta] Window positioning failed:', e);
			}
		}

		// Restore workspace structure
		await this.restoreWorkspaceNode(
			(popoutLeaf as unknown as { parent?: WorkspaceSplit }).parent ?? null,
			state.root,
			popoutLeaf,
			opts
		);
	}

	// =========================================================================
	// Window Geometry
	// =========================================================================

	/**
	 * Restores main window geometry.
	 */
	restoreWindowGeometry(win: Window, state: WindowStateV2, sourceScreen?: ScreenInfo): void {
		if (state.x === undefined || state.y === undefined || state.width === undefined || state.height === undefined) {
			return;
		}

		// Validate virtual coordinates first
		const virtualGeometry = { x: state.x, y: state.y, width: state.width, height: state.height };
		const validated = validateGeometry(virtualGeometry);
		if (!validated) {
			console.warn('[Perspecta] Skipping main window geometry restore due to invalid values:', virtualGeometry);
			return;
		}

		const physical = virtualToPhysical(validated, sourceScreen);
		
		// Final validation of physical coordinates
		const safePhysical = sanitizeGeometry(physical);

		try {
			win.moveTo(safePhysical.x, safePhysical.y);
			win.resizeTo(safePhysical.width, safePhysical.height);
		} catch (e) {
			console.warn('[Perspecta] Main window geometry restore failed:', e);
		}
	}

	/**
	 * Restores window to exact physical coordinates.
	 */
	restoreWindowGeometryDirect(win: Window, geometry: { x: number; y: number; width: number; height: number }): void {
		// Validate geometry before applying
		const validated = validateGeometry(geometry);
		if (!validated) {
			console.warn('[Perspecta] Skipping direct geometry restore due to invalid values:', geometry);
			return;
		}
		
		const safeGeometry = sanitizeGeometry(validated);
		
		try {
			win.moveTo(safeGeometry.x, safeGeometry.y);
			win.resizeTo(safeGeometry.width, safeGeometry.height);
		} catch (e) {
			console.warn('[Perspecta] Direct window geometry restore failed:', e);
		}
	}

	// =========================================================================
	// Sidebar Restoration
	// =========================================================================

	/**
	 * Restores sidebar state.
	 */
	restoreSidebarState(side: 'left' | 'right', state: SidebarState): void {
		const workspace = this.app.workspace as unknown as ExtendedWorkspace;
		const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;

		if (!sidebar) return;

		// Restore collapse state
		const sidebarWithMethods = sidebar as unknown as { collapse?: () => void; expand?: () => void };
		if (state.collapsed && typeof sidebarWithMethods.collapse === 'function') {
			sidebarWithMethods.collapse();
		} else if (!state.collapsed && typeof sidebarWithMethods.expand === 'function') {
			sidebarWithMethods.expand();
		}

		// Restore active tab
		if (state.activeTab) {
			this.app.workspace.getLeavesOfType(state.activeTab).forEach(leaf => {
				const leafWin = leaf.view?.containerEl?.win;
				if (!leafWin || leafWin === window) {
					this.app.workspace.revealLeaf(leaf);
				}
			});
		}
	}

	// =========================================================================
	// Scroll Position Restoration
	// =========================================================================

	/**
	 * Schedules scroll position restoration for all views.
	 */
	scheduleScrollRestoration(state: WorkspaceNodeState): void {
		const scrollMap = new Map<string, number>();
		const canvasMap = new Map<string, { tx: number; ty: number; zoom: number }>();

		this.collectPositions(state, scrollMap, canvasMap);

		// Apply after delay using safe timeout
		const cleanup = safeTimeout(() => {
			this.app.workspace.iterateAllLeaves(leaf => {
				const filePath = (leaf.view as { file?: TFile }).file?.path;
				if (!filePath) return;

				const scroll = scrollMap.get(filePath);
				if (scroll !== undefined) {
					applyScrollPosition(leaf.view, scroll);
				}

				const viewport = canvasMap.get(filePath);
				if (viewport) {
					const canvas = (leaf.view as { canvas?: { setViewport?: (tx: number, ty: number, zoom: number) => void } }).canvas;
					if (canvas?.setViewport) {
						canvas.setViewport(viewport.tx, viewport.ty, viewport.zoom);
					}
				}
			});
		}, TIMING.INDICATORS_REFRESH_DELAY);
		
		// Store cleanup function for potential cancellation
		this.scrollTimeoutCleanup = cleanup;
	}

	/**
	 * Collects scroll and canvas positions from state.
	 */
	private collectPositions(
		state: WorkspaceNodeState,
		scrollMap: Map<string, number>,
		canvasMap: Map<string, { tx: number; ty: number; zoom: number }>
	): void {
		if (state.type === 'tabs') {
			for (const tab of state.tabs) {
				if (tab.scroll !== undefined) {
					scrollMap.set(tab.path, tab.scroll);
				}
				if (tab.canvasViewport) {
					canvasMap.set(tab.path, tab.canvasViewport);
				}
			}
		} else {
			for (const child of state.children) {
				this.collectPositions(child, scrollMap, canvasMap);
			}
		}
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Gets the first tab from a workspace node.
	 */
	getFirstTab(state: WorkspaceNodeState): TabState | null {
		if (state.type === 'tabs') {
			return state.tabs[0] || null;
		}
		for (const child of state.children) {
			const tab = this.getFirstTab(child);
			if (tab) return tab;
		}
		return null;
	}

	/**
	 * Gets first tab from node (alias for compatibility).
	 */
	private getFirstTabFromNode(state: WorkspaceNodeState): TabState | null {
		return this.getFirstTab(state);
	}

	/**
	 * Gets all popout Window objects.
	 */
	getPopoutWindowObjects(): Window[] {
		const windows: Window[] = [];
		const seen = new Set<Window>([window]);

		this.app.workspace.iterateAllLeaves(leaf => {
			const win = leaf.view?.containerEl?.win;
			if (win && !seen.has(win)) {
				seen.add(win);
				windows.push(win);
			}
		});

		return windows;
	}

	/**
	 * Closes a popout window.
	 */
	closePopoutWindow(win: Window): void {
		if (win === window) return;

		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view?.containerEl?.win === win) {
				leaf.detach();
			}
		});
	}

	/**
	 * Gets main window leaves.
	 */
	getMainWindowLeaves(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];

		this.app.workspace.iterateAllLeaves(leaf => {
			const win = leaf.view?.containerEl?.win;
			if ((!win || win === window) && this.isInRootSplit(leaf)) {
				leaves.push(leaf);
			}
		});

		return leaves;
	}

	/**
	 * Checks if leaf is in root split.
	 */
	private isInRootSplit(leaf: WorkspaceLeaf): boolean {
		let parent = (leaf as unknown as { parent?: WorkspaceSplit | null }).parent;
		const workspace = this.app.workspace as unknown as ExtendedWorkspace;

		while (parent) {
			if (parent === workspace.rootSplit) return true;
			parent = parent.parent ?? null;
		}

		return false;
	}

	/**
	 * Finds window containing a file.
	 */
	findWindowContainingFile(path: string): Window | null {
		let foundWin: Window | null = null;

		this.app.workspace.iterateAllLeaves(leaf => {
			const file = (leaf.view as { file?: TFile }).file;
			if (file?.path === path) {
				foundWin = leaf.view?.containerEl?.win || window;
			}
		});

		return foundWin;
	}

	/**
	 * Gets the window that should be focused.
	 */
	getFocusedWindow(arrangement: WindowArrangementV2): Window | null {
		if (arrangement.focusedWindow === -1) {
			return window;
		}

		const popoutWindows = this.getPopoutWindowObjects();
		if (arrangement.focusedWindow >= 0 && arrangement.focusedWindow < popoutWindows.length) {
			return popoutWindows[arrangement.focusedWindow];
		}

		return window;
	}

	/**
	 * Activates leaf containing a file.
	 */
	activateLeafByPath(win: Window, path: string): void {
		this.app.workspace.iterateAllLeaves(leaf => {
			const file = (leaf.view as { file?: TFile }).file;
			if (file?.path === path && leaf.view?.containerEl?.win === win) {
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
			}
		});
	}

	/**
	 * Activates appropriate leaf in window.
	 */
	activateWindowLeaf(win: Window, _arrangement: WindowArrangementV2): void {
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view?.containerEl?.win === win) {
				this.app.workspace.setActiveLeaf(leaf, { focus: true });
				return;
			}
		});
	}
}

/**
 * Creates a new WindowRestoreService instance.
 */
export function createWindowRestoreService(app: App): WindowRestoreService {
	return new WindowRestoreService(app);
}
