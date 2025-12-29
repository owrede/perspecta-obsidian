/**
 * Window Capture Service
 *
 * Captures the current state of Obsidian windows, including:
 * - Main window workspace layout
 * - Popout window states
 * - Sidebar states
 * - Tab groups and splits
 *
 * @module services/window-capture
 *
 * ## Obsidian API Usage
 * - `App.workspace.rootSplit` - Main window workspace root (internal)
 * - `App.workspace.leftSplit` / `rightSplit` - Sidebar access (internal)
 * - `App.workspace.floatingSplit` - Popout windows container (internal)
 * - `WorkspaceLeaf.view` - Access to view and file information
 *
 * ## Internal API Dependencies
 * This module uses internal Obsidian APIs that are not officially documented.
 * Fallbacks are provided where possible.
 *
 * @see types/obsidian-internal for type definitions
 */

import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	TabState,
	TabGroupState,
	WorkspaceNodeState,
	WindowStateV2,
	SidebarState,
	ScreenInfo,
	WindowArrangementV2,
	UID_FRONTMATTER_KEY
} from '../types';
import {
	ExtendedWorkspace,
	ExtendedView,
	WorkspaceSplit,
	WorkspaceTabContainer,
	FloatingWindowContainer,
	hasFloatingSplit,
	isSplit,
	getCurrentTabIndex,
	getScrollPosition,
	getCanvasViewport,
	hasFile
} from '../types/obsidian-internal';
import { physicalToVirtual, getPhysicalScreen } from '../utils/coordinates';
import { PerfTimer } from '../utils/perf-timer';
import { PROXY_VIEW_TYPE } from '../ui/proxy-view';

function getPropertiesCollapsed(view: ExtendedView): boolean | undefined {
	const containerEl = view?.containerEl as HTMLElement | undefined;
	if (!containerEl) return undefined;

	const metadataEl = containerEl.querySelector('.metadata-container') as HTMLElement | null;
	if (!metadataEl) return undefined;

	if (metadataEl.classList.contains('is-collapsed') || metadataEl.classList.contains('collapsed')) {
		return true;
	}

	const toggleEl = metadataEl.querySelector('[aria-expanded]') as HTMLElement | null;
	if (toggleEl) {
		const expanded = toggleEl.getAttribute('aria-expanded');
		if (expanded === 'true') return false;
		if (expanded === 'false') return true;
	}

	return false;
}

/**
 * Options for window capture.
 */
export interface CaptureOptions {
	/** Enable debug logging */
	debug?: boolean;
	/** Include scroll positions */
	includeScroll?: boolean;
	/** Include canvas viewports */
	includeCanvasViewport?: boolean;
}

const DEFAULT_OPTIONS: CaptureOptions = {
	debug: false,
	includeScroll: true,
	includeCanvasViewport: true
};

/**
 * Window Capture Service
 *
 * Provides methods for capturing the current state of Obsidian windows.
 */
export class WindowCaptureService {
	private app: App;
	private focusedWindowIndex: number;

	constructor(app: App, focusedWindowIndex = -1) {
		this.app = app;
		this.focusedWindowIndex = focusedWindowIndex;
	}

	/**
	 * Updates the focused window index.
	 * Called by focus tracking when window focus changes.
	 *
	 * @param index - Index of focused popout window (-1 for main window)
	 */
	setFocusedWindowIndex(index: number): void {
		this.focusedWindowIndex = index;
	}

	/**
	 * Captures the complete window arrangement.
	 *
	 * @param options - Capture options
	 * @returns Complete window arrangement state
	 *
	 * @example
	 * ```typescript
	 * const capture = new WindowCaptureService(app);
	 * const arrangement = capture.captureWindowArrangement();
	 * ```
	 */
	captureWindowArrangement(options: CaptureOptions = {}): WindowArrangementV2 {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		PerfTimer.mark('captureWindowArrangement:start');

		const workspace = this.app.workspace as unknown as ExtendedWorkspace;

		// Capture main window
		const main = this.captureWindowState(workspace.rootSplit, window, opts);
		PerfTimer.mark('captureMainWindow');

		// Capture popout windows
		const popouts = this.capturePopoutStates(opts);
		PerfTimer.mark('capturePopouts');

		// Capture sidebar states
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

	/**
	 * Captures the state of a single window.
	 *
	 * @param rootSplit - Root split of the window
	 * @param win - Window object
	 * @param options - Capture options
	 * @returns Window state
	 */
	captureWindowState(
		rootSplit: WorkspaceSplit | null,
		win: Window,
		options: CaptureOptions = {}
	): WindowStateV2 {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		// Get physical window dimensions
		const physical = {
			x: win.screenX,
			y: win.screenY,
			width: win.outerWidth,
			height: win.outerHeight
		};

		// Convert to virtual coordinate system for cross-screen compatibility
		const virtual = physicalToVirtual(physical);

		if (opts.debug) {
			console.log(`[Perspecta] captureWindowState:`, { physical, virtual });
		}

		return {
			root: rootSplit ? this.captureSplitOrTabs(rootSplit, opts) : { type: 'tabs', tabs: [] },
			x: virtual.x,
			y: virtual.y,
			width: virtual.width,
			height: virtual.height
		};
	}

	/**
	 * Captures all popout window states.
	 *
	 * @param options - Capture options
	 * @returns Array of popout window states
	 */
	capturePopoutStates(options: CaptureOptions = {}): WindowStateV2[] {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const states: WindowStateV2[] = [];
		const workspace = this.app.workspace as unknown;

		// Check for floatingSplit availability
		if (!hasFloatingSplit(workspace)) {
			if (opts.debug) {
				console.log('[Perspecta] No floatingSplit available');
			}
			return states;
		}

		// Track seen windows to prevent duplicates
		const seenWindows = new Set<Window>();

		for (const container of workspace.floatingSplit.children) {
			const win = container?.win;
			if (!win || win === window) continue;

			// Skip if we've already captured this window
			if (seenWindows.has(win)) {
				if (opts.debug) {
					console.log('[Perspecta] Skipping duplicate window in capturePopoutStates');
				}
				continue;
			}
			seenWindows.add(win);

			if (opts.debug) {
				console.log(`[Perspecta] capturePopoutStates container:`, {
					containerType: container?.constructor?.name,
					containerChildren: container?.children?.length
				});
			}

			// Capture container state
			if (container?.children && container.children.length > 0) {
				const virtual = physicalToVirtual({
					x: win.screenX,
					y: win.screenY,
					width: win.outerWidth,
					height: win.outerHeight
				});

				// Check if this is a proxy window
				const isProxy = this.isProxyWindow(container);

				states.push({
					root: this.captureSplitOrTabs(container as unknown as WorkspaceSplit, opts),
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
	 * Captures a split or tab group.
	 *
	 * @param node - Workspace node (split or tab container)
	 * @param options - Capture options
	 * @returns Workspace node state
	 */
	captureSplitOrTabs(
		node: WorkspaceSplit | WorkspaceTabContainer | unknown,
		options: CaptureOptions = {}
	): WorkspaceNodeState {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		if (!node) {
			return { type: 'tabs', tabs: [] };
		}

		// Check if this is a split
		if (isSplit(node)) {
			const children: WorkspaceNodeState[] = [];
			const sizes: number[] = [];

			for (const child of node.children) {
				const childState = this.captureSplitOrTabs(child, opts);
				if (childState.type === 'split' || childState.tabs.length > 0) {
					children.push(childState);
					// Get size from various possible properties
					const size = (child as WorkspaceTabContainer).dimension
						?? (child as WorkspaceTabContainer).size
						?? 50;
					sizes.push(size);
				}
			}

			// Collapse single-child splits
			if (children.length === 1) return children[0];
			if (children.length === 0) return { type: 'tabs', tabs: [] };

			if (opts.debug) {
				console.log(`[Perspecta] captureSplitOrTabs: direction=${node.direction}, children=${children.length}`);
			}

			return { type: 'split', direction: node.direction, children, sizes };
		}

		// Otherwise treat as tab container
		return this.captureTabGroup(node as WorkspaceTabContainer, opts);
	}

	/**
	 * Captures a tab group state.
	 *
	 * @param tabContainer - Tab container to capture
	 * @param options - Capture options
	 * @returns Tab group state
	 */
	captureTabGroup(tabContainer: WorkspaceTabContainer, options: CaptureOptions = {}): TabGroupState {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const tabs: TabState[] = [];
		const children = tabContainer?.children || [];

		// Get active tab index
		const currentTabIndex = getCurrentTabIndex(tabContainer);

		if (opts.debug && PerfTimer.isEnabled()) {
			console.log(`[Perspecta] captureTabGroup: ${children.length} children, currentTab=${currentTabIndex}`);
		}

		for (let i = 0; i < children.length; i++) {
			const leaf = children[i] as WorkspaceLeaf;
			const view = leaf?.view as unknown as ExtendedView;

			if (hasFile(view)) {
				const file = view.file;
				// Get UID from frontmatter cache - use the file from hasFile check
				const tFile = this.app.vault.getAbstractFileByPath(file.path);
				const cache = tFile instanceof TFile ? this.app.metadataCache.getFileCache(tFile) : null;
				const uid = cache?.frontmatter?.[UID_FRONTMATTER_KEY] as string | undefined;

				// Get scroll position if enabled
				const scroll = opts.includeScroll ? getScrollPosition(view) : undefined;

				// Get canvas viewport if enabled
				let canvasViewport: { tx: number; ty: number; zoom: number } | undefined;
				if (opts.includeCanvasViewport) {
					const viewport = getCanvasViewport(view);
					if (viewport) {
						canvasViewport = {
							tx: viewport.tx,
							ty: viewport.ty,
							zoom: viewport.tZoom
						};
					}
				}

				const isActive = i === currentTabIndex;

				if (opts.debug && PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   tab[${i}]: ${file.basename}, active=${isActive}`);
				}

				tabs.push({
					path: file.path,
					active: isActive,
					uid,
					name: file.basename,
					scroll: typeof scroll === 'number' ? scroll : undefined,
					propertiesCollapsed: getPropertiesCollapsed(view),
					canvasViewport
				});
			}
		}

		return { type: 'tabs', tabs };
	}

	/**
	 * Captures sidebar state.
	 *
	 * @param side - 'left' or 'right'
	 * @returns Sidebar state
	 */
	captureSidebarState(side: 'left' | 'right'): SidebarState {
		const workspace = this.app.workspace as unknown as ExtendedWorkspace;
		const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;

		if (!sidebar) {
			return { collapsed: true };
		}

		let activeTab: string | undefined;

		try {
			// Method 1: Try to get from activeTabGroup
			const activeTabGroup = (sidebar as { activeTabGroup?: { currentTab?: WorkspaceLeaf } }).activeTabGroup;
			if (activeTabGroup?.currentTab) {
				activeTab = activeTabGroup.currentTab?.view?.getViewType?.();
			}

			// Method 2: Check children for active tab
			if (!activeTab && sidebar.children) {
				for (const child of sidebar.children) {
					const container = child as WorkspaceTabContainer;
					if (container.children) {
						const current = container.children[getCurrentTabIndex(container)];
						const currentLeaf = current as unknown as WorkspaceLeaf;
						if (currentLeaf?.view?.getViewType && typeof currentLeaf.view.getViewType === 'function') {
							activeTab = currentLeaf.view.getViewType();
							break;
						}
					}
				}
			}

			// Method 3: Legacy API fallback
			if (!activeTab) {
				const leaf = side === 'left' ? workspace.leftLeaf : workspace.rightLeaf;
				activeTab = leaf?.view?.getViewType?.();
			}
		} catch {
			// Silently ignore errors accessing sidebar state
		}

		return {
			collapsed: (sidebar as { collapsed?: boolean }).collapsed ?? false,
			activeTab
		};
	}

	/**
	 * Checks if a popout container contains a proxy view.
	 *
	 * @param container - Floating window container
	 * @returns true if proxy view is present
	 */
	private isProxyWindow(container: FloatingWindowContainer): boolean {
		if (!container?.children) return false;

		for (const child of container.children) {
			// Direct leaf check
			if ((child as unknown as WorkspaceLeaf)?.view?.getViewType?.() === PROXY_VIEW_TYPE) {
				return true;
			}
			// Check nested children
			const asContainer = child as WorkspaceTabContainer;
			if (asContainer?.children) {
				for (const leaf of asContainer.children) {
					if ((leaf as WorkspaceLeaf)?.view?.getViewType?.() === PROXY_VIEW_TYPE) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Gets all popout Window objects.
	 *
	 * @returns Array of Window objects for popout windows
	 */
	getPopoutWindowObjects(): Window[] {
		const windows: Window[] = [];
		const seen = new Set<Window>([window]);

		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.view?.containerEl?.win;
			if (win && !seen.has(win)) {
				seen.add(win);
				windows.push(win);
			}
		});

		return windows;
	}
}

/**
 * Creates a new WindowCaptureService instance.
 *
 * @param app - Obsidian App instance
 * @param focusedWindowIndex - Initial focused window index
 * @returns WindowCaptureService instance
 */
export function createWindowCaptureService(app: App, focusedWindowIndex = -1): WindowCaptureService {
	return new WindowCaptureService(app, focusedWindowIndex);
}
