/**
 * Type Definitions for Internal Obsidian APIs
 *
 * These types define undocumented Obsidian internal APIs that Perspecta depends on.
 * They provide type safety and documentation for internal API usage.
 *
 * ## WARNING: Internal APIs
 * These APIs are not part of Obsidian's public API and may change without notice.
 * All usages should have fallback behavior when these APIs are unavailable.
 *
 * ## Version Compatibility
 * These types were documented based on Obsidian v1.4+.
 * Future versions may modify or remove these interfaces.
 *
 * @module types/obsidian-internal
 */

import type { App, WorkspaceLeaf, View } from 'obsidian';

// ============================================================================
// Workspace Internal Types
// ============================================================================

/**
 * Extended Workspace interface with internal properties.
 * The floatingSplit property provides access to popout windows.
 *
 * @internal
 */
export interface ExtendedWorkspace {
	/**
	 * The main content split containing the workspace leaves.
	 * This is the root container for the main window's workspace.
	 */
	rootSplit: WorkspaceSplit | null;

	/**
	 * Container for popout/floating windows.
	 * Each child represents a separate popout window.
	 *
	 * @availability Available when popout windows exist
	 * @fallback Check for undefined before accessing
	 */
	floatingSplit?: {
		children: FloatingWindowContainer[];
	};

	/**
	 * The left sidebar split.
	 * Contains file explorer, search, and other left-side panels.
	 */
	leftSplit?: WorkspaceSidebarSplit;

	/**
	 * The right sidebar split.
	 * Contains backlinks, outgoing links, and other right-side panels.
	 */
	rightSplit?: WorkspaceSidebarSplit;

	/**
	 * Currently active leaf in the left sidebar.
	 * @deprecated Use leftSplit.activeTabGroup instead
	 */
	leftLeaf?: WorkspaceLeaf;

	/**
	 * Currently active leaf in the right sidebar.
	 * @deprecated Use rightSplit.activeTabGroup instead
	 */
	rightLeaf?: WorkspaceLeaf;

	/**
	 * Request a workspace resize/redraw.
	 * Called after modifying split sizes.
	 */
	requestResize?: () => void;
}

/**
 * A workspace split container that can hold multiple children.
 * Can be either horizontal or vertical orientation.
 *
 * @internal
 */
export interface WorkspaceSplit {
	/**
	 * Direction of the split.
	 * 'horizontal' = children arranged left to right
	 * 'vertical' = children arranged top to bottom
	 */
	direction: 'horizontal' | 'vertical';

	/**
	 * Child elements (can be splits or tab containers).
	 */
	children: Array<WorkspaceSplit | WorkspaceTabContainer | WorkspaceLeaf>;

	/**
	 * Parent container, if any.
	 */
	parent?: WorkspaceSplit | null;

	/**
	 * Trigger a resize recalculation.
	 */
	onResize?: () => void;
}

/**
 * A container for workspace tabs (tab group).
 *
 * @internal
 */
export interface WorkspaceTabContainer {
	/**
	 * Leaves within this tab container.
	 */
	children: WorkspaceLeaf[];

	/**
	 * Index of the currently active tab.
	 * Zero-indexed.
	 */
	currentTab?: number;

	/**
	 * The dimension/size of this container relative to siblings.
	 * Used for split proportions.
	 */
	dimension?: number;

	/**
	 * Alternative property for size (older API).
	 */
	size?: number;

	/**
	 * Set the dimension of this container.
	 * More reliable than direct property assignment.
	 *
	 * @param value - New dimension value
	 */
	setDimension?: (value: number) => void;

	/**
	 * Parent split container.
	 */
	parent?: WorkspaceSplit | null;

	/**
	 * Active tab group for nested structures.
	 */
	activeTabGroup?: {
		currentTab?: WorkspaceLeaf;
	};

	/**
	 * Update tab display after changes.
	 */
	updateTabDisplay?: () => void;

	/**
	 * Trigger resize handler.
	 */
	onResize?: () => void;

	/**
	 * Select a tab by index.
	 */
	selectTab?: (index: number) => void;
}

/**
 * Container for a floating/popout window.
 *
 * @internal
 */
export interface FloatingWindowContainer {
	/**
	 * The Window object for this popout.
	 */
	win?: Window;

	/**
	 * Child elements in this floating window.
	 */
	children?: Array<WorkspaceSplit | WorkspaceTabContainer>;

	/**
	 * Direction of the container (for split windows).
	 */
	direction?: 'horizontal' | 'vertical';
}

/**
 * Sidebar split with collapse state.
 *
 * @internal
 */
export interface WorkspaceSidebarSplit extends WorkspaceSplit {
	/**
	 * Whether the sidebar is collapsed.
	 */
	collapsed?: boolean;

	/**
	 * The currently active tab group in the sidebar.
	 */
	activeTabGroup?: {
		currentTab?: WorkspaceLeaf;
	};
}

// ============================================================================
// View Internal Types
// ============================================================================

/**
 * Extended View interface with internal properties.
 *
 * @internal
 */
export interface ExtendedView extends View {
	/**
	 * The file currently open in this view (for file views).
	 */
	file?: {
		path: string;
		basename: string;
		extension: string;
	};

	/**
	 * Current editing mode (for markdown views).
	 */
	currentMode?: ViewMode;

	/**
	 * Canvas object for canvas views.
	 */
	canvas?: CanvasViewport;
}

/**
 * View mode with scroll control.
 *
 * @internal
 */
export interface ViewMode {
	/**
	 * Get the current scroll position.
	 */
	getScroll?: () => number;

	/**
	 * Apply a scroll position.
	 *
	 * @param position - Scroll position to apply
	 */
	applyScroll?: (position: number) => void;
}

/**
 * Canvas viewport state.
 *
 * @internal
 */
export interface CanvasViewport {
	/**
	 * Horizontal translation (pan X).
	 */
	tx: number;

	/**
	 * Vertical translation (pan Y).
	 */
	ty: number;

	/**
	 * Zoom level.
	 */
	tZoom: number;

	/**
	 * Apply viewport transformation.
	 */
	setViewport?: (tx: number, ty: number, zoom: number) => void;

	/**
	 * Zoom by a delta factor.
	 */
	zoomBy?: (delta: number) => void;

	/**
	 * Pan to a specific position.
	 */
	panTo?: (x: number, y: number) => void;

	/**
	 * Mark viewport as changed.
	 */
	markViewportChanged?: () => void;

	/**
	 * Request a frame update.
	 */
	requestFrame?: () => void;
}

// ============================================================================
// Metadata Type Manager
// ============================================================================

/**
 * Metadata type manager for configuring property types and visibility.
 *
 * @internal
 */
export interface MetadataTypeManager {
	/**
	 * Property configurations.
	 */
	properties?: Record<string, PropertyConfig>;

	/**
	 * Property type definitions.
	 */
	types?: Record<string, PropertyType>;

	/**
	 * Set the type for a property.
	 *
	 * @param name - Property name
	 * @param type - Property type (text, number, date, etc.)
	 */
	setType?: (name: string, type: string) => void;

	/**
	 * Save configuration changes.
	 */
	save?: () => void;
}

/**
 * Property configuration in metadata manager.
 *
 * @internal
 */
export interface PropertyConfig {
	name: string;
	type: string;
	hidden?: boolean;
}

/**
 * Property type definition.
 *
 * @internal
 */
export interface PropertyType {
	type: string;
	hidden?: boolean;
}

// ============================================================================
// Extended App Interface
// ============================================================================

/**
 * Extended App interface with internal properties.
 *
 * @internal
 */
export interface ExtendedApp extends App {
	/**
	 * Metadata type manager for property configuration.
	 */
	metadataTypeManager?: MetadataTypeManager;

	/**
	 * Hotkey manager for accessing configured hotkeys.
	 */
	hotkeyManager?: HotkeyManager;
}

/**
 * Hotkey manager interface.
 *
 * @internal
 */
export interface HotkeyManager {
	/**
	 * Custom hotkey configurations.
	 */
	customKeys?: Record<string, Hotkey[]>;

	/**
	 * Default hotkey configurations.
	 */
	defaultKeys?: Record<string, Hotkey[]>;
}

/**
 * Individual hotkey configuration.
 *
 * @internal
 */
export interface Hotkey {
	/**
	 * Modifier keys (Mod, Ctrl, Alt, Shift, Meta).
	 */
	modifiers?: string[];

	/**
	 * The key to press.
	 */
	key?: string;
}

// ============================================================================
// Extended Leaf Interface
// ============================================================================

/**
 * Extended WorkspaceLeaf with internal properties.
 * Note: This is a standalone type, not extending WorkspaceLeaf to avoid conflicts.
 *
 * @internal
 */
export interface ExtendedWorkspaceLeaf {
	/**
	 * Parent container.
	 */
	parent?: WorkspaceSplit | WorkspaceTabContainer | null;

	/**
	 * Extended view with internal properties.
	 */
	view: ExtendedView;
}

/**
 * Safely cast a WorkspaceLeaf to access internal properties.
 *
 * @param leaf - The leaf to cast
 * @returns The leaf as unknown (use property access carefully)
 */
export function asExtendedLeaf(leaf: WorkspaceLeaf): { parent?: unknown; view: View } {
	return leaf as unknown as { parent?: unknown; view: View };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a workspace has floatingSplit.
 *
 * @param workspace - Workspace to check
 * @returns true if floatingSplit is available
 */
export function hasFloatingSplit(workspace: unknown): workspace is ExtendedWorkspace & { floatingSplit: NonNullable<ExtendedWorkspace['floatingSplit']> } {
	if (workspace === null || typeof workspace !== 'object') return false;
	const ws = workspace as Record<string, unknown>;
	if (!('floatingSplit' in ws) || ws.floatingSplit === undefined || ws.floatingSplit === null) return false;
	const fs = ws.floatingSplit as Record<string, unknown>;
	return Array.isArray(fs.children);
}

/**
 * Type guard to check if a container is a split.
 *
 * @param container - Container to check
 * @returns true if container is a split
 */
export function isSplit(container: unknown): container is WorkspaceSplit {
	return (
		container !== null &&
		typeof container === 'object' &&
		'direction' in container &&
		'children' in container &&
		Array.isArray((container as WorkspaceSplit).children)
	);
}

/**
 * Type guard to check if a container is a tab container.
 *
 * @param container - Container to check
 * @returns true if container is a tab container
 */
export function isTabContainer(container: unknown): container is WorkspaceTabContainer {
	return (
		container !== null &&
		typeof container === 'object' &&
		'children' in container &&
		Array.isArray((container as WorkspaceTabContainer).children) &&
		!('direction' in container)
	);
}

/**
 * Type guard to check if an app has metadataTypeManager.
 *
 * @param app - App to check
 * @returns true if metadataTypeManager is available
 */
export function hasMetadataTypeManager(app: unknown): app is ExtendedApp & { metadataTypeManager: MetadataTypeManager } {
	if (app === null || typeof app !== 'object') return false;
	const a = app as Record<string, unknown>;
	return 'metadataTypeManager' in a && a.metadataTypeManager !== undefined && a.metadataTypeManager !== null;
}

/**
 * Type guard to check if a view has file property.
 *
 * @param view - View to check
 * @returns true if view has file
 */
export function hasFile(view: unknown): view is ExtendedView & { file: NonNullable<ExtendedView['file']> } {
	if (view === null || typeof view !== 'object') return false;
	const v = view as Record<string, unknown>;
	return 'file' in v && v.file !== undefined && v.file !== null;
}

/**
 * Type guard to check if a view has currentMode with scroll methods.
 *
 * @param view - View to check
 * @returns true if view has scrollable mode
 */
export function hasScrollableMode(view: unknown): view is ExtendedView & { currentMode: ViewMode & { getScroll: () => number; applyScroll: (n: number) => void } } {
	if (view === null || typeof view !== 'object') return false;
	const v = view as Record<string, unknown>;
	if (!('currentMode' in v) || v.currentMode === undefined || v.currentMode === null) return false;
	const mode = v.currentMode as Record<string, unknown>;
	return typeof mode.getScroll === 'function' && typeof mode.applyScroll === 'function';
}

/**
 * Type guard to check if a view is a canvas view.
 *
 * @param view - View to check
 * @returns true if view has canvas viewport
 */
export function isCanvasView(view: unknown): view is ExtendedView & { canvas: CanvasViewport } {
	if (view === null || typeof view !== 'object') return false;
	const v = view as Record<string, unknown>;
	if (!('canvas' in v) || v.canvas === undefined || v.canvas === null) return false;
	const canvas = v.canvas as Record<string, unknown>;
	return typeof canvas.tx === 'number';
}

// ============================================================================
// Safe Accessors with Fallbacks
// ============================================================================

/**
 * Safely get the floatingSplit children with fallback.
 *
 * @param workspace - Workspace to access
 * @returns Array of floating window containers or empty array
 */
export function getFloatingWindowContainers(workspace: unknown): FloatingWindowContainer[] {
	if (hasFloatingSplit(workspace)) {
		return workspace.floatingSplit.children;
	}
	return [];
}

/**
 * Safely get the current tab index from a container.
 *
 * @param container - Container to check
 * @returns Current tab index or 0
 */
export function getCurrentTabIndex(container: unknown): number {
	if (container === null || typeof container !== 'object') return 0;
	const c = container as Record<string, unknown>;
	if ('currentTab' in c && typeof c.currentTab === 'number') {
		return c.currentTab;
	}
	return 0;
}

/**
 * Safely get the scroll position from a view.
 *
 * @param view - View to check
 * @returns Scroll position or undefined
 */
export function getScrollPosition(view: unknown): number | undefined {
	if (hasScrollableMode(view)) {
		return view.currentMode.getScroll();
	}
	return undefined;
}

/**
 * Safely apply scroll position to a view.
 *
 * @param view - View to scroll
 * @param position - Position to scroll to
 * @returns true if scroll was applied
 */
export function applyScrollPosition(view: unknown, position: number): boolean {
	if (hasScrollableMode(view)) {
		view.currentMode.applyScroll(position);
		return true;
	}
	return false;
}

/**
 * Safely get canvas viewport from a view.
 *
 * @param view - View to check
 * @returns Canvas viewport or undefined
 */
export function getCanvasViewport(view: unknown): CanvasViewport | undefined {
	if (isCanvasView(view)) {
		return view.canvas;
	}
	return undefined;
}

/**
 * Safely set dimension on a container.
 *
 * @param container - Container to modify
 * @param dimension - Dimension value
 * @returns true if dimension was set
 */
export function setContainerDimension(container: unknown, dimension: number): boolean {
	if (container === null || typeof container !== 'object') {
		return false;
	}

	const c = container as WorkspaceTabContainer;

	// Prefer setDimension method if available
	if (typeof c.setDimension === 'function') {
		c.setDimension(dimension);
		return true;
	}

	// Fall back to direct property assignment
	if ('dimension' in c) {
		c.dimension = dimension;
		return true;
	}

	return false;
}

/**
 * Safely trigger workspace resize.
 *
 * @param workspace - Workspace to resize
 * @param rootSplit - Root split to resize (optional)
 * @returns true if resize was triggered
 */
export function triggerWorkspaceResize(workspace: unknown, rootSplit?: unknown): boolean {
	let triggered = false;

	const ws = workspace as ExtendedWorkspace;

	// Method 1: workspace.requestResize
	if (typeof ws.requestResize === 'function') {
		ws.requestResize();
		triggered = true;
	}

	// Method 2: rootSplit.onResize
	if (rootSplit && typeof (rootSplit as WorkspaceSplit).onResize === 'function') {
		(rootSplit as WorkspaceSplit).onResize!();
		triggered = true;
	}

	// Method 3: Dispatch resize event
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event('resize'));
		triggered = true;
	}

	return triggered;
}

// ============================================================================
// Additional Type Guards and Helpers
// ============================================================================

/**
 * Type guard to check if an object has a parent property.
 *
 * @param obj - Object to check
 * @returns true if obj has parent property
 */
export function hasParent(obj: unknown): obj is { parent: unknown } {
	return (
		obj !== null &&
		typeof obj === 'object' &&
		'parent' in obj
	);
}

/**
 * Type guard to check if container has children array.
 *
 * @param container - Container to check
 * @returns true if container has children
 */
export function hasChildren(container: unknown): container is { children: unknown[] } {
	return (
		container !== null &&
		typeof container === 'object' &&
		'children' in container &&
		Array.isArray((container as { children: unknown[] }).children)
	);
}

/**
 * Type guard for state objects that have tabs property.
 *
 * @param state - State to check
 * @returns true if state has tabs
 */
export function hasTabs(state: unknown): state is { tabs: unknown[] } {
	return (
		state !== null &&
		typeof state === 'object' &&
		'tabs' in state &&
		Array.isArray((state as { tabs: unknown[] }).tabs)
	);
}

/**
 * Type guard to check if a leaf has tabGroup or parent with setActiveLeaf.
 *
 * @param leaf - Leaf to check
 * @returns Object with tabGroup access methods if available
 */
export function getLeafTabGroup(leaf: unknown): { setActiveLeaf?: (leaf: unknown) => void; selectTab?: (index: number) => void; children?: unknown[] } | null {
	if (leaf === null || typeof leaf !== 'object') return null;

	const l = leaf as Record<string, unknown>;
	const tabGroup = l.tabGroup ?? l.parent;

	if (tabGroup === null || typeof tabGroup !== 'object') return null;

	return tabGroup as { setActiveLeaf?: (leaf: unknown) => void; selectTab?: (index: number) => void; children?: unknown[] };
}

/**
 * Get the file path from a leaf's view if available.
 *
 * @param leaf - WorkspaceLeaf to check
 * @returns File path or undefined
 */
export function getLeafFilePath(leaf: { view: unknown }): string | undefined {
	if (hasFile(leaf.view)) {
		return leaf.view.file.path;
	}
	return undefined;
}

/**
 * Cast workspace to ExtendedWorkspace for internal API access.
 * Always check for property existence before use.
 *
 * @param workspace - Workspace to cast
 * @returns ExtendedWorkspace
 */
export function asExtendedWorkspace(workspace: unknown): ExtendedWorkspace {
	return workspace as ExtendedWorkspace;
}
