// ============================================================================
// Types and Interfaces
// ============================================================================

export interface TabState {
	path: string;
	active: boolean;
	uid?: string;   // Unique ID from frontmatter (for move/rename resilience)
	name?: string;  // Filename without extension (fallback for search)
	scroll?: number; // Scroll position (from view.currentMode.getScroll())
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
	enableDebugLogging: boolean;
	focusTintDuration: number;
	autoGenerateUids: boolean;
	storageMode: StorageMode;
	maxArrangementsPerNote: number;
	autoConfirmOverwrite: boolean;
}

export const DEFAULT_SETTINGS: PerspectaSettings = {
	enableVisualMapping: true,
	enableAutomation: true,
	automationScriptsPath: 'perspecta/scripts/',
	perspectaFolderPath: 'perspecta',
	showDebugModal: true,
	enableDebugLogging: false,
	focusTintDuration: 8,
	autoGenerateUids: true,
	storageMode: 'frontmatter',
	maxArrangementsPerNote: 1,
	autoConfirmOverwrite: false
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
