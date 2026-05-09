// ============================================================================
// Canvas Viewport Apply
// ----------------------------------------------------------------------------
// Sets pan + zoom on a canvas view, preferring the absolute setViewport API
// over relative zoomBy/panTo. Pure function — takes a canvas-shaped object
// (matches the internal CanvasViewport interface) plus the saved values.
//
// History: through v0.1.37 this lived inside PerspectaPlugin and used
// `zoomBy(viewport.zoom / currentZoom)` — a multiplicative delta against
// canvas.tZoom, which is *not* a multiplier. zoomBy is additive (it shifts
// tZoom by the passed value), so the delta math gave wrong results, in some
// cases zooming the wrong direction. Fixed in v0.1.38 by switching to
// setViewport (absolute set) with direct-assignment as a fallback.
// ============================================================================

import { CanvasViewport } from '../types/obsidian-internal';

export interface SavedCanvasViewport {
	tx: number;
	ty: number;
	zoom: number;
}

export type ApplyStrategy = 'setViewport' | 'directAssign';

export interface ApplyResult {
	strategy: ApplyStrategy;
	before: SavedCanvasViewport;
	after: SavedCanvasViewport;
}

/**
 * Apply a saved viewport to a canvas. Returns the strategy used plus
 * before/after snapshots so callers can log or assert in tests.
 *
 * Throws only if the underlying canvas API throws — never returns null.
 * The canvas argument must already be confirmed-canvas (use isCanvasView
 * upstream).
 */
export function applyCanvasViewport(canvas: CanvasViewport, saved: SavedCanvasViewport): ApplyResult {
	const before: SavedCanvasViewport = {
		tx: canvas.tx,
		ty: canvas.ty,
		zoom: canvas.tZoom,
	};

	let strategy: ApplyStrategy;
	if (typeof canvas.setViewport === 'function') {
		canvas.setViewport(saved.tx, saved.ty, saved.zoom);
		strategy = 'setViewport';
	} else {
		// Direct property assignment — works because the internal canvas type
		// declares tx/ty/tZoom as plain mutable number fields.
		canvas.tx = saved.tx;
		canvas.ty = saved.ty;
		canvas.tZoom = saved.zoom;
		strategy = 'directAssign';
	}

	if (typeof canvas.markViewportChanged === 'function') {
		canvas.markViewportChanged();
	}
	if (typeof canvas.requestFrame === 'function') {
		canvas.requestFrame();
	}

	const after: SavedCanvasViewport = {
		tx: canvas.tx,
		ty: canvas.ty,
		zoom: canvas.tZoom,
	};

	return { strategy, before, after };
}
