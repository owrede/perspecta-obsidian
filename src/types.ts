// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Generic Result type for operations that can fail.
 * Provides type-safe error handling without exceptions.
 *
 * @example
 * ```typescript
 * function doOperation(): Result<string> {
 *   if (error) return { success: false, error: 'Something went wrong' };
 *   return { success: true, data: 'result' };
 * }
 *
 * const result = doOperation();
 * if (result.success) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export type Result<T> =
	| { success: true; data: T }
	| { success: false; error: string };

/**
 * Helper to create a successful result.
 */
export function ok<T>(data: T): Result<T> {
	return { success: true, data };
}

/**
 * Helper to create a failed result.
 */
export function err<T>(error: string): Result<T> {
	return { success: false, error };
}

export interface TabState {
	path: string;
	active: boolean;
	uid?: string;   // Unique ID from frontmatter (for move/rename resilience)
	name?: string;  // Filename without extension (fallback for search)
	scroll?: number; // Scroll position (from view.currentMode.getScroll())
	propertiesCollapsed?: boolean; // Whether Properties (frontmatter) section is collapsed in Live Preview
	// Canvas viewport state
	canvasViewport?: {
		tx: number;    // Horizontal pan position
		ty: number;    // Vertical pan position
		zoom: number;  // Zoom level
	};
}

export interface SplitState {
	type: 'split';
	direction: 'horizontal' | 'vertical';
	children: (SplitState | TabGroupState)[];
	sizes?: number[];  // Relative sizes for each child (maps to Obsidian's 'dimension' property)
}

export interface TabGroupState {
	type: 'tabs';
	tabs: TabState[];
}

export type WorkspaceNodeState = SplitState | TabGroupState;

export interface WindowStateV2 {
	root: WorkspaceNodeState;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	isProxy?: boolean;  // True if this is a minimalist proxy window
}

export interface WindowStateV1 {
	tabs: TabState[];
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface SidebarState {
	collapsed: boolean;
	activeTab?: string;
}

export interface ScreenInfo {
	width: number;
	height: number;
	aspectRatio: number;
}

export interface WindowArrangementV2 {
	v: 2;
	ts: number;
	main: WindowStateV2;
	popouts: WindowStateV2[];
	focusedWindow: number;
	leftSidebar?: SidebarState;
	rightSidebar?: SidebarState;
	sourceScreen?: ScreenInfo;
	wallpaper?: string;  // Desktop wallpaper path (experimental)
}

export interface WindowArrangementV1 {
	v: 1;
	ts: number;
	main: WindowStateV1;
	popouts: WindowStateV1[];
	focusedWindow: number;
	leftSidebar?: SidebarState;
	rightSidebar?: SidebarState;
}

export type WindowArrangement = WindowArrangementV1 | WindowArrangementV2;

export type StorageMode = 'frontmatter' | 'external';

export interface PerspectaSettings {
	enableVisualMapping: boolean;
	enableAutomation: boolean;
	automationScriptsPath: string;
	perspectaFolderPath: string;
	showDebugModal: boolean;
	showDebugModalOnRestore: boolean;
	enableDebugLogging: boolean;
	focusTintDuration: number;
	autoGenerateUids: boolean;
	storageMode: StorageMode;
	maxArrangementsPerNote: number;
	autoConfirmOverwrite: boolean;
	// Experimental features
	enableProxyWindows: boolean;
	proxyPreviewScale: number;  // Scale factor for proxy window preview (0.1 to 1.0)
	enableWallpaperCapture: boolean;  // Save desktop wallpaper with context
	enableWallpaperRestore: boolean;  // Restore wallpaper when restoring context
	storeWallpapersLocally: boolean;  // Copy wallpapers to perspecta/wallpapers folder
	// Performance settings
	enableParallelPopoutCreation: boolean;  // Create popout windows in parallel for faster restoration
}

export const DEFAULT_SETTINGS: PerspectaSettings = {
	enableVisualMapping: true,
	enableAutomation: true,
	automationScriptsPath: 'perspecta/scripts/',
	perspectaFolderPath: 'perspecta',
	showDebugModal: true,
	showDebugModalOnRestore: true,
	enableDebugLogging: false,
	focusTintDuration: 8,
	autoGenerateUids: true,
	storageMode: 'frontmatter',
	maxArrangementsPerNote: 1,
	autoConfirmOverwrite: false,
	// Experimental features
	enableProxyWindows: false,
	proxyPreviewScale: 0.35,
	enableWallpaperCapture: false,
	enableWallpaperRestore: false,
	storeWallpapersLocally: true,  // Default to local storage for portability
	// Performance settings
	enableParallelPopoutCreation: false  // Default to sequential for safety
};

// Timestamped arrangement for multi-arrangement storage
export interface TimestampedArrangement {
	arrangement: WindowArrangementV2;
	savedAt: number;  // Unix timestamp when saved
}

// Collection of arrangements for a single file
export interface ArrangementCollection {
	arrangements: TimestampedArrangement[];
}

export const FRONTMATTER_KEY = 'perspecta-arrangement';
export const UID_FRONTMATTER_KEY = 'perspecta-uid';

// Physical screen interface for coordinate system
export interface PhysicalScreen {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	isPrimary: boolean;
}

// Canvas file data structure
// Note: Canvas stores context as actual JSON object, not base64 encoded
export interface CanvasData {
	nodes?: unknown[];
	edges?: unknown[];
	perspecta?: {
		uid?: string;
		context?: WindowArrangement;
	};
}

// Base file data structure
export interface BaseData {
	perspecta?: {
		uid?: string;
		context?: string;
	};
	views?: unknown[];
	[key: string]: unknown;
}
