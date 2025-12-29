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

// ============================================================================
// Non-Linear Center-Preserving X-Axis Scaling
// ============================================================================
// When screens have different aspect ratios, linear scaling causes windows
// to stretch/compress proportionally across the entire screen. This results
// in windows in the center becoming too wide/narrow.
//
// This non-linear approach:
// - Preserves window proportions in the CENTER of the screen
// - Absorbs aspect ratio differences at the LEFT/RIGHT EDGES
// - Uses a piecewise-linear symmetric transform φ(u) on normalized X coords

// Configuration for center-preserving transform
const CENTER_ZONE_MIN = 0.15;  // Half-width of center zone at minimum distortion
const CENTER_ZONE_MAX = 0.35;  // Half-width of center zone at maximum distortion
const CENTER_SLOPE_MIN = 0.5;  // Flattest center slope (most preservation)
const CENTER_SLOPE_MAX = 1.0;  // Linear (no preservation)
const AR_RATIO_MAX = 1.0;      // AR ratio difference at which full effect kicks in

interface TransformParams {
	c: number;  // Half-width of center zone in normalized [0,1] coords
	b: number;  // Slope in center zone
	a: number;  // Slope in edge zones
}

/**
 * Calculate transform parameters based on aspect ratio difference.
 */
function calculateTransformParams(arSource: number, arTarget: number): TransformParams {
	const r = Math.max(arSource, arTarget) / Math.min(arSource, arTarget);
	const d = r - 1;  // 0 for equal AR, grows with difference
	const s = Math.min(d / AR_RATIO_MAX, 1);  // Strength in [0, 1]
	
	// Center zone width grows with distortion
	const c = CENTER_ZONE_MIN + (CENTER_ZONE_MAX - CENTER_ZONE_MIN) * s;
	// Center slope decreases with distortion (more conservative)
	const b = CENTER_SLOPE_MAX - (CENTER_SLOPE_MAX - CENTER_SLOPE_MIN) * s;
	// Edge slope computed from continuity constraint
	const a = (0.5 - b * c) / (0.5 - c);
	
	return { c, b, a };
}

/**
 * Forward transform φ(u): maps normalized X coordinate through center-preserving curve.
 * - u ∈ [0,1] normalized input
 * - Returns φ(u) ∈ [0,1]
 * - φ(0)=0, φ(0.5)=0.5, φ(1)=1, symmetric
 */
function phiForward(u: number, params: TransformParams): number {
	const { c, b, a } = params;
	
	// Clamp to [0,1]
	u = Math.max(0, Math.min(1, u));
	
	if (u <= 0.5) {
		if (u <= 0.5 - c) {
			// Left edge zone
			return a * u;
		} else {
			// Center zone
			return b * (u - 0.5) + 0.5;
		}
	} else {
		// Symmetric right side: φ(u) = 1 - φ(1 - u)
		return 1 - phiForward(1 - u, params);
	}
}

/**
 * Inverse transform φ⁻¹(y): inverts the center-preserving curve.
 * - y ∈ [0,1] normalized input (in transformed space)
 * - Returns u ∈ [0,1]
 */
function phiInverse(y: number, params: TransformParams): number {
	const { c, b, a } = params;
	
	// Clamp to [0,1]
	y = Math.max(0, Math.min(1, y));
	
	// Boundary value in output space at edge of center zone
	const yC = 0.5 - b * c;
	
	if (y <= 0.5) {
		if (y <= yC) {
			// Left edge zone
			return y / a;
		} else {
			// Center zone
			return (y - 0.5) / b + 0.5;
		}
	} else {
		// Symmetric right side
		return 1 - phiInverse(1 - y, params);
	}
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
// Uses non-linear center-preserving transform on X-axis
export function physicalToVirtual(physical: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
	const screen = getPhysicalScreen();
	
	// Aspect ratios
	const arPhys = screen.width / screen.height;
	const arVirt = VIRTUAL_SCREEN.width / VIRTUAL_SCREEN.height;
	
	// Calculate transform parameters based on AR difference
	const params = calculateTransformParams(arPhys, arVirt);
	
	// Determine direction: use forward if target (virtual) is wider
	const useForward = arVirt >= arPhys;
	const phi = useForward ? phiForward : phiInverse;
	
	// Normalize X coordinates to [0, 1]
	const uL = (physical.x - screen.x) / screen.width;
	const uR = (physical.x + physical.width - screen.x) / screen.width;
	
	// Apply non-linear transform to both edges
	const vL = phi(uL, params);
	const vR = phi(uR, params);
	
	// Convert back to virtual coordinates
	const virtualX = vL * VIRTUAL_SCREEN.width;
	const virtualWidth = (vR - vL) * VIRTUAL_SCREEN.width;
	
	// Y-axis remains linear
	const scaleY = VIRTUAL_SCREEN.height / screen.height;
	const virtualY = (physical.y - screen.y) * scaleY;
	const virtualHeight = physical.height * scaleY;

	const result = {
		x: Math.round(virtualX),
		y: Math.round(virtualY),
		width: Math.round(virtualWidth),
		height: Math.round(virtualHeight)
	};

	if (coordinateDebug) {
		console.log(`[Perspecta] physicalToVirtual (non-linear):`, {
			physical,
			screen,
			virtualRef: VIRTUAL_SCREEN,
			aspectRatios: { physical: arPhys.toFixed(3), virtual: arVirt.toFixed(3) },
			transformParams: { c: params.c.toFixed(3), b: params.b.toFixed(3), a: params.a.toFixed(3) },
			normalized: { uL: uL.toFixed(3), uR: uR.toFixed(3), vL: vL.toFixed(3), vR: vR.toFixed(3) },
			result
		});
	}

	return result;
}

// Convert virtual coordinates to physical (for restoring)
// Uses non-linear center-preserving transform on X-axis
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
	
	// Aspect ratios
	const arVirt = VIRTUAL_SCREEN.width / VIRTUAL_SCREEN.height;
	const arPhys = screen.width / screen.height;
	
	// Calculate transform parameters based on AR difference
	const params = calculateTransformParams(arVirt, arPhys);
	
	// Determine direction: use forward if target (physical) is wider
	const useForward = arPhys >= arVirt;
	const phi = useForward ? phiForward : phiInverse;
	
	// Normalize virtual X coordinates to [0, 1]
	const uL = safeVirtual.x / VIRTUAL_SCREEN.width;
	const uR = (safeVirtual.x + safeVirtual.width) / VIRTUAL_SCREEN.width;
	
	// Apply non-linear transform to both edges
	const pL = phi(uL, params);
	const pR = phi(uR, params);
	
	// Convert to physical coordinates
	let x = Math.round(screen.x + pL * screen.width);
	let width = Math.round((pR - pL) * screen.width);
	
	// Y-axis remains linear
	const scaleY = screen.height / VIRTUAL_SCREEN.height;
	let y = Math.round(screen.y + safeVirtual.y * scaleY);
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
		console.log(`[Perspecta] virtualToPhysical (non-linear):`, {
			virtual: safeVirtual,
			screen,
			virtualRef: VIRTUAL_SCREEN,
			sourceScreen,
			aspectRatios: { virtual: arVirt.toFixed(3), physical: arPhys.toFixed(3) },
			transformParams: { c: params.c.toFixed(3), b: params.b.toFixed(3), a: params.a.toFixed(3) },
			normalized: { uL: uL.toFixed(3), uR: uR.toFixed(3), pL: pL.toFixed(3), pR: pR.toFixed(3) },
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
