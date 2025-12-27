// ============================================================================
// Virtual Coordinate System
// ============================================================================
// Uses MacBook Pro 16" as reference (1728x1117 at default scaling)
// All saved coordinates are normalized to this virtual space, then scaled
// to the actual screen dimensions on restore.

import { ScreenInfo, WindowStateV2 } from '../types';

// ============================================================================
// Geometry Validation
// ============================================================================

/** Minimum valid window dimension (width or height) */
const MIN_WINDOW_SIZE = 100;
/** Maximum valid window dimension (prevents overflow) */
const MAX_WINDOW_SIZE = 10000;
/** Maximum valid coordinate (prevents off-screen placement) */
const MAX_COORDINATE = 20000;
/** Minimum valid coordinate (allows for multi-monitor with negative coords) */
const MIN_COORDINATE = -10000;

/**
 * Validates that a number is finite and within reasonable bounds.
 */
function isValidNumber(n: unknown): n is number {
	return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n);
}

/**
 * Validates geometry values and returns sanitized values or null if invalid.
 * This prevents infinite loops and freezes from corrupted data.
 */
export function validateGeometry(
	geometry: { x?: number; y?: number; width?: number; height?: number } | null | undefined
): { x: number; y: number; width: number; height: number } | null {
	if (!geometry) return null;
	
	const { x, y, width, height } = geometry;
	
	// Check all values are valid numbers
	if (!isValidNumber(x) || !isValidNumber(y) || !isValidNumber(width) || !isValidNumber(height)) {
		console.warn('[Perspecta] Invalid geometry: non-finite values detected', geometry);
		return null;
	}
	
	// Check dimensions are reasonable
	if (width < MIN_WINDOW_SIZE || height < MIN_WINDOW_SIZE) {
		console.warn('[Perspecta] Invalid geometry: dimensions too small', geometry);
		return null;
	}
	
	if (width > MAX_WINDOW_SIZE || height > MAX_WINDOW_SIZE) {
		console.warn('[Perspecta] Invalid geometry: dimensions too large', geometry);
		return null;
	}
	
	// Check coordinates are reasonable
	if (x < MIN_COORDINATE || x > MAX_COORDINATE || y < MIN_COORDINATE || y > MAX_COORDINATE) {
		console.warn('[Perspecta] Invalid geometry: coordinates out of bounds', geometry);
		return null;
	}
	
	return { x, y, width, height };
}

/**
 * Sanitizes geometry by clamping values to valid ranges.
 * Use this when you want to proceed with best-effort values rather than failing.
 */
export function sanitizeGeometry(
	geometry: { x?: number; y?: number; width?: number; height?: number } | null | undefined,
	defaults: { x: number; y: number; width: number; height: number } = { x: 100, y: 100, width: 800, height: 600 }
): { x: number; y: number; width: number; height: number } {
	if (!geometry) return defaults;
	
	let { x, y, width, height } = geometry;
	
	// Replace invalid numbers with defaults
	x = isValidNumber(x) ? x : defaults.x;
	y = isValidNumber(y) ? y : defaults.y;
	width = isValidNumber(width) ? width : defaults.width;
	height = isValidNumber(height) ? height : defaults.height;
	
	// Clamp to valid ranges
	width = Math.max(MIN_WINDOW_SIZE, Math.min(MAX_WINDOW_SIZE, width));
	height = Math.max(MIN_WINDOW_SIZE, Math.min(MAX_WINDOW_SIZE, height));
	x = Math.max(MIN_COORDINATE, Math.min(MAX_COORDINATE, x));
	y = Math.max(MIN_COORDINATE, Math.min(MAX_COORDINATE, y));
	
	return { x, y, width, height };
}

/**
 * Extended Screen interface with non-standard but widely supported properties.
 * availLeft and availTop are supported in Chrome, Safari, Firefox (with prefix),
 * but not in the TypeScript lib.dom.d.ts definitions.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Screen/availLeft
 */
interface ExtendedScreen extends Screen {
	/** X coordinate of the first pixel not allocated to system UI (non-standard) */
	availLeft?: number;
	/** Y coordinate of the first pixel not allocated to system UI (non-standard) */
	availTop?: number;
}

export const VIRTUAL_SCREEN = {
	width: 1728,
	height: 1117
};

// Global debug flag for coordinate conversions
let coordinateDebug = false;

export function setCoordinateDebug(enabled: boolean) {
	coordinateDebug = enabled;
}

export interface PhysicalScreen {
	width: number;
	height: number;
	x: number;  // screen.availLeft (left edge of available area)
	y: number;  // screen.availTop (top edge, below menu bar on macOS)
}

export function getPhysicalScreen(): PhysicalScreen {
	const screen = window.screen as ExtendedScreen;
	return {
		width: screen.availWidth,
		height: screen.availHeight,
		x: screen.availLeft ?? 0,
		y: screen.availTop ?? 0
	};
}

// Convert physical coordinates to virtual (for saving)
export function physicalToVirtual(physical: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
	const screen = getPhysicalScreen();
	const scaleX = VIRTUAL_SCREEN.width / screen.width;
	const scaleY = VIRTUAL_SCREEN.height / screen.height;

	const result = {
		x: Math.round((physical.x - screen.x) * scaleX),
		y: Math.round((physical.y - screen.y) * scaleY),
		width: Math.round(physical.width * scaleX),
		height: Math.round(physical.height * scaleY)
	};

	if (coordinateDebug) {
		console.log(`[Perspecta] physicalToVirtual:`, {
			physical,
			screen,
			virtualRef: VIRTUAL_SCREEN,
			scale: { x: scaleX.toFixed(3), y: scaleY.toFixed(3) },
			result
		});
	}

	return result;
}

// Convert virtual coordinates to physical (for restoring)
export function virtualToPhysical(
	virtual: { x: number; y: number; width: number; height: number },
	sourceScreen?: ScreenInfo
): { x: number; y: number; width: number; height: number } {
	// Validate input - use sanitized defaults if invalid
	const safeVirtual = sanitizeGeometry(virtual);
	
	const screen = getPhysicalScreen();
	
	// Guard against invalid screen values (could cause division issues)
	if (screen.width <= 0 || screen.height <= 0) {
		console.warn('[Perspecta] Invalid screen dimensions, using defaults');
		return { x: 100, y: 100, width: 800, height: 600 };
	}
	
	const scaleX = screen.width / VIRTUAL_SCREEN.width;
	const scaleY = screen.height / VIRTUAL_SCREEN.height;

	let x = Math.round(safeVirtual.x * scaleX) + screen.x;
	let y = Math.round(safeVirtual.y * scaleY) + screen.y;
	let width = Math.round(safeVirtual.width * scaleX);
	let height = Math.round(safeVirtual.height * scaleY);

	// Ensure minimum window size
	width = Math.max(MIN_WINDOW_SIZE, width);
	height = Math.max(MIN_WINDOW_SIZE, height);
	
	// Ensure window fits within screen bounds
	width = Math.min(width, screen.width);
	height = Math.min(height, screen.height);
	x = Math.max(screen.x, Math.min(x, screen.x + screen.width - width));
	y = Math.max(screen.y, Math.min(y, screen.y + screen.height - height));

	const result = { x, y, width, height };

	if (coordinateDebug) {
		console.log(`[Perspecta] virtualToPhysical:`, {
			virtual: safeVirtual,
			screen,
			virtualRef: VIRTUAL_SCREEN,
			sourceScreen,
			scale: { x: scaleX.toFixed(3), y: scaleY.toFixed(3) },
			result
		});
	}

	return result;
}

// Calculate the aspect ratio difference between source and target screens
export function getAspectRatioDifference(sourceScreen?: ScreenInfo): number {
	if (!sourceScreen) return 0;
	const targetScreen = getPhysicalScreen();
	const targetAspectRatio = targetScreen.width / targetScreen.height;
	return Math.abs(sourceScreen.aspectRatio - targetAspectRatio);
}

// Check if we need to tile windows due to significant aspect ratio difference
export function needsTiling(sourceScreen?: ScreenInfo): boolean {
	if (!sourceScreen) return false;
	const diff = getAspectRatioDifference(sourceScreen);
	// Threshold: if aspect ratios differ by more than 0.5, tile windows
	return diff > 0.5;
}

// Calculate tiled window positions for when aspect ratios differ significantly
export function calculateTiledLayout(
	windowCount: number,
	_mainWindowState: WindowStateV2
): { x: number; y: number; width: number; height: number }[] {
	const screen = getPhysicalScreen();
	const results: { x: number; y: number; width: number; height: number }[] = [];

	if (windowCount === 0) return results;

	// For a single window (main only), use full screen
	if (windowCount === 1) {
		results.push({
			x: screen.x,
			y: screen.y,
			width: screen.width,
			height: screen.height
		});
		return results;
	}

	// For 2 windows, split horizontally (side by side)
	if (windowCount === 2) {
		const halfWidth = Math.floor(screen.width / 2);
		results.push({
			x: screen.x,
			y: screen.y,
			width: halfWidth,
			height: screen.height
		});
		results.push({
			x: screen.x + halfWidth,
			y: screen.y,
			width: screen.width - halfWidth,
			height: screen.height
		});
		return results;
	}

	// For 3+ windows, use a grid layout
	// Main window takes left half, popouts share right half vertically
	const mainWidth = Math.floor(screen.width / 2);
	results.push({
		x: screen.x,
		y: screen.y,
		width: mainWidth,
		height: screen.height
	});

	const popoutCount = windowCount - 1;
	const popoutWidth = screen.width - mainWidth;
	const popoutHeight = Math.floor(screen.height / popoutCount);

	for (let i = 0; i < popoutCount; i++) {
		const isLast = i === popoutCount - 1;
		results.push({
			x: screen.x + mainWidth,
			y: screen.y + (i * popoutHeight),
			width: popoutWidth,
			height: isLast ? screen.height - (i * popoutHeight) : popoutHeight
		});
	}

	return results;
}
