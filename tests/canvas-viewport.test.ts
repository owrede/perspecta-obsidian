import { describe, expect, it, vi } from 'vitest';
import { applyCanvasViewport } from '../src/utils/canvas-viewport';
import type { CanvasViewport } from '../src/types/obsidian-internal';

// Build a mock canvas that mimics Obsidian's internal CanvasViewport surface.
// The default starts at (0, 0) with zoom 0 (= "1x" in Obsidian's log-zoom
// convention).
function makeMockCanvas(opts: {
	tx?: number;
	ty?: number;
	tZoom?: number;
	hasSetViewport?: boolean;
} = {}): CanvasViewport & {
	__setViewportCalls: Array<[number, number, number]>;
	__markViewportChangedCalls: number;
	__requestFrameCalls: number;
} {
	const calls: Array<[number, number, number]> = [];
	const canvas: Partial<CanvasViewport> & {
		__setViewportCalls: Array<[number, number, number]>;
		__markViewportChangedCalls: number;
		__requestFrameCalls: number;
	} = {
		tx: opts.tx ?? 0,
		ty: opts.ty ?? 0,
		tZoom: opts.tZoom ?? 0,
		__setViewportCalls: calls,
		__markViewportChangedCalls: 0,
		__requestFrameCalls: 0,
		markViewportChanged: vi.fn(function (this: { __markViewportChangedCalls: number }) {
			this.__markViewportChangedCalls++;
		}) as unknown as () => void,
		requestFrame: vi.fn(function (this: { __requestFrameCalls: number }) {
			this.__requestFrameCalls++;
		}) as unknown as () => void,
	};

	if (opts.hasSetViewport !== false) {
		canvas.setViewport = vi.fn(function (
			this: { tx: number; ty: number; tZoom: number; __setViewportCalls: Array<[number, number, number]> },
			tx: number,
			ty: number,
			zoom: number
		) {
			calls.push([tx, ty, zoom]);
			this.tx = tx;
			this.ty = ty;
			this.tZoom = zoom;
		}) as unknown as (tx: number, ty: number, zoom: number) => void;
	}

	// Bind methods to canvas for `this` context.
	if (canvas.markViewportChanged) {
		canvas.markViewportChanged = canvas.markViewportChanged.bind(canvas);
	}
	if (canvas.requestFrame) {
		canvas.requestFrame = canvas.requestFrame.bind(canvas);
	}
	if (canvas.setViewport) {
		canvas.setViewport = canvas.setViewport.bind(canvas);
	}

	return canvas as CanvasViewport & {
		__setViewportCalls: Array<[number, number, number]>;
		__markViewportChangedCalls: number;
		__requestFrameCalls: number;
	};
}

describe('applyCanvasViewport', () => {
	// The v0.1.38 regression test. Through v0.1.37 the code computed
	// `zoomDelta = saved.zoom / canvas.tZoom`, then called
	// `canvas.zoomBy(zoomDelta)`. This was wrong on two axes:
	//   - tZoom is not a multiplier (it's a log-style "zoom step")
	//   - zoomBy is additive, not multiplicative
	// So when restoring zoom=2 from a current state of zoom=1, the old
	// code would call `zoomBy(2)`, which set tZoom to 3 (additive), not 2.
	// And when current was 0 (default) the `|| 1` mask hid that the math
	// was bogus, sometimes producing a NEGATIVE zoom step that zoomed OUT.
	describe('v0.1.38 zoom-direction regression', () => {
		it('sets the absolute zoom regardless of current zoom', () => {
			const canvas = makeMockCanvas({ tZoom: 0 });

			applyCanvasViewport(canvas, { tx: 100, ty: 200, zoom: 1.5 });

			expect(canvas.tZoom).toBe(1.5);
		});

		it('does not zoom in the wrong direction when restoring from a non-default current zoom', () => {
			// User saves a zoomed-out viewport (tZoom = -2), but the canvas
			// currently shows a zoomed-in state (tZoom = 1). The old delta
			// math: -2 / 1 = -2 → zoomBy(-2) → ends at tZoom -1 (wrong, and
			// indistinguishable from a "zoomed out a little" result).
			// Correct behavior: tZoom = -2 exactly.
			const canvas = makeMockCanvas({ tZoom: 1 });

			applyCanvasViewport(canvas, { tx: 0, ty: 0, zoom: -2 });

			expect(canvas.tZoom).toBe(-2);
		});

		it('handles negative saved zoom (zoomed-out states)', () => {
			const canvas = makeMockCanvas({ tZoom: 0 });

			applyCanvasViewport(canvas, { tx: 0, ty: 0, zoom: -1.5 });

			expect(canvas.tZoom).toBe(-1.5);
		});

		it('preserves direction: saved zoom > current → restored canvas reflects saved zoom (not 2x of it)', () => {
			// The old zoomBy/zoomDelta path treated tZoom as a multiplier:
			// saved=2, current=1 → delta=2 → zoomBy(2) → end at 3 (way too zoomed in).
			const canvas = makeMockCanvas({ tZoom: 1 });

			applyCanvasViewport(canvas, { tx: 0, ty: 0, zoom: 2 });

			expect(canvas.tZoom).toBe(2); // exactly 2, not 3
		});
	});

	describe('strategy selection', () => {
		it('uses setViewport when available', () => {
			const canvas = makeMockCanvas({ hasSetViewport: true });

			const result = applyCanvasViewport(canvas, { tx: 50, ty: 60, zoom: 0.5 });

			expect(result.strategy).toBe('setViewport');
			expect(canvas.__setViewportCalls).toEqual([[50, 60, 0.5]]);
		});

		it('falls back to direct property assignment when setViewport is unavailable', () => {
			const canvas = makeMockCanvas({ hasSetViewport: false });

			const result = applyCanvasViewport(canvas, { tx: 50, ty: 60, zoom: 0.5 });

			expect(result.strategy).toBe('directAssign');
			expect(canvas.tx).toBe(50);
			expect(canvas.ty).toBe(60);
			expect(canvas.tZoom).toBe(0.5);
		});
	});

	describe('frame & viewport-change notification', () => {
		it('calls markViewportChanged and requestFrame after applying', () => {
			const canvas = makeMockCanvas();

			applyCanvasViewport(canvas, { tx: 0, ty: 0, zoom: 1 });

			expect(canvas.__markViewportChangedCalls).toBe(1);
			expect(canvas.__requestFrameCalls).toBe(1);
		});
	});

	describe('return value', () => {
		it('reports before/after snapshots accurately', () => {
			const canvas = makeMockCanvas({ tx: 10, ty: 20, tZoom: 0.5 });

			const result = applyCanvasViewport(canvas, { tx: 100, ty: 200, zoom: 2 });

			expect(result.before).toEqual({ tx: 10, ty: 20, zoom: 0.5 });
			expect(result.after).toEqual({ tx: 100, ty: 200, zoom: 2 });
		});
	});

	describe('pan position', () => {
		it('sets pan absolutely (saved values, not deltas)', () => {
			const canvas = makeMockCanvas({ tx: 1000, ty: -500, tZoom: 0 });

			applyCanvasViewport(canvas, { tx: 100, ty: 200, zoom: 0 });

			// 100 and 200, not 1100 and -300.
			expect(canvas.tx).toBe(100);
			expect(canvas.ty).toBe(200);
		});

		it('handles negative pan coordinates', () => {
			const canvas = makeMockCanvas();

			applyCanvasViewport(canvas, { tx: -100, ty: -200, zoom: 1 });

			expect(canvas.tx).toBe(-100);
			expect(canvas.ty).toBe(-200);
		});
	});
});
