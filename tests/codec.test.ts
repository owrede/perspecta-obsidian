import { describe, expect, it } from 'vitest';
import {
	createCompactArrangement,
	decodeArrangement,
	encodeArrangement,
	expandCompactArrangement,
} from '../src/storage/codec';
import { FRONTMATTER_KEY, WindowArrangementV2 } from '../src/types';

// Round-trip: V2 → encoded frontmatter line → V2. Should preserve every
// field that survives the lossy compact format. Anything *not* round-tripped
// here is something the codec deliberately drops (e.g., source screen exact
// dimensions are reconstructed from aspect ratio).
function roundTrip(arr: WindowArrangementV2): WindowArrangementV2 {
	const line = encodeArrangement(arr);
	// encodeArrangement returns `perspecta-arrangement: "<base64>"` —
	// strip the prefix and surrounding quotes to get back the raw blob.
	const match = line.match(/^perspecta-arrangement: "(.+)"$/);
	if (!match) throw new Error(`unexpected encoded line shape: ${line}`);
	const decoded = decodeArrangement(match[1]);
	if (!decoded) throw new Error('decodeArrangement returned null');
	return decoded;
}

function makeMinimalV2(): WindowArrangementV2 {
	return {
		v: 2,
		ts: 1700000000000,
		focusedWindow: 0,
		main: {
			root: { type: 'tabs', tabs: [{ path: 'note.md', active: true, name: 'note' }] },
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
		},
		popouts: [],
	};
}

describe('codec', () => {
	describe('encodeArrangement', () => {
		it('produces a frontmatter-line shape', () => {
			const line = encodeArrangement(makeMinimalV2());
			expect(line.startsWith(`${FRONTMATTER_KEY}: "`)).toBe(true);
			expect(line.endsWith('"')).toBe(true);
		});
	});

	describe('round-trip', () => {
		it('preserves a minimal arrangement', () => {
			const arr = makeMinimalV2();
			const back = roundTrip(arr);
			expect(back.v).toBe(2);
			expect(back.ts).toBe(arr.ts);
			expect(back.focusedWindow).toBe(0);
			expect(back.main.x).toBe(0);
			expect(back.main.width).toBe(1200);
			const tabs = back.main.root.type === 'tabs' ? back.main.root.tabs : [];
			expect(tabs[0].path).toBe('note.md');
			expect(tabs[0].active).toBe(true);
		});

		// This is the v0.1.31 regression test: the codec used to drop split
		// `sizes`, so frontmatter-mode restore landed on a default 50/50.
		// External-storage mode was unaffected (it stores raw V2 JSON).
		it('preserves split sizes (v0.1.31 regression)', () => {
			const arr: WindowArrangementV2 = {
				...makeMinimalV2(),
				main: {
					root: {
						type: 'split',
						direction: 'vertical',
						sizes: [25, 75],
						children: [
							{ type: 'tabs', tabs: [{ path: 'a.md', active: false, name: 'a' }] },
							{ type: 'tabs', tabs: [{ path: 'b.md', active: true, name: 'b' }] },
						],
					},
					x: 0,
					y: 0,
					width: 1200,
					height: 800,
				},
			};
			const back = roundTrip(arr);
			expect(back.main.root.type).toBe('split');
			if (back.main.root.type !== 'split') return;
			expect(back.main.root.direction).toBe('vertical');
			expect(back.main.root.sizes).toEqual([25, 75]);
			expect(back.main.root.children).toHaveLength(2);
		});

		it('preserves nested splits with sizes at every level', () => {
			const arr: WindowArrangementV2 = {
				...makeMinimalV2(),
				main: {
					root: {
						type: 'split',
						direction: 'horizontal',
						sizes: [60, 40],
						children: [
							{ type: 'tabs', tabs: [{ path: 'a.md', active: true, name: 'a' }] },
							{
								type: 'split',
								direction: 'vertical',
								sizes: [30, 70],
								children: [
									{ type: 'tabs', tabs: [{ path: 'b.md', active: false, name: 'b' }] },
									{ type: 'tabs', tabs: [{ path: 'c.md', active: false, name: 'c' }] },
								],
							},
						],
					},
				},
				popouts: [],
			};
			const back = roundTrip(arr);
			if (back.main.root.type !== 'split') throw new Error('expected split');
			expect(back.main.root.sizes).toEqual([60, 40]);
			const inner = back.main.root.children[1];
			if (inner.type !== 'split') throw new Error('expected nested split');
			expect(inner.sizes).toEqual([30, 70]);
		});

		it('preserves UIDs and active tab markers in compact tab arrays', () => {
			const arr: WindowArrangementV2 = {
				...makeMinimalV2(),
				main: {
					root: {
						type: 'tabs',
						tabs: [
							{ path: 'a.md', active: false, name: 'a', uid: 'uid-a' },
							{ path: 'b.md', active: true, name: 'b', uid: 'uid-b' },
							{ path: 'c.md', active: false, name: 'c' /* no uid */ },
						],
					},
				},
			};
			const back = roundTrip(arr);
			if (back.main.root.type !== 'tabs') throw new Error('expected tabs');
			expect(back.main.root.tabs[0]).toMatchObject({ path: 'a.md', uid: 'uid-a', active: false });
			expect(back.main.root.tabs[1]).toMatchObject({ path: 'b.md', uid: 'uid-b', active: true });
			expect(back.main.root.tabs[2]).toMatchObject({ path: 'c.md', active: false });
			expect(back.main.root.tabs[2].uid).toBeUndefined();
		});

		it('preserves popouts with their own splits and geometry', () => {
			const arr: WindowArrangementV2 = {
				...makeMinimalV2(),
				popouts: [
					{
						root: { type: 'tabs', tabs: [{ path: 'p1.md', active: true, name: 'p1' }] },
						x: 100,
						y: 200,
						width: 800,
						height: 600,
					},
					{
						root: {
							type: 'split',
							direction: 'vertical',
							sizes: [50, 50],
							children: [
								{ type: 'tabs', tabs: [{ path: 'p2a.md', active: true, name: 'p2a' }] },
								{ type: 'tabs', tabs: [{ path: 'p2b.md', active: false, name: 'p2b' }] },
							],
						},
						x: 1000,
						y: 100,
						width: 600,
						height: 900,
					},
				],
			};
			const back = roundTrip(arr);
			expect(back.popouts).toHaveLength(2);
			expect(back.popouts[0]).toMatchObject({ x: 100, y: 200, width: 800, height: 600 });
			expect(back.popouts[1].x).toBe(1000);
			if (back.popouts[1].root.type !== 'split') throw new Error('expected split');
			expect(back.popouts[1].root.sizes).toEqual([50, 50]);
		});

		it('preserves sidebars and wallpaper', () => {
			const arr: WindowArrangementV2 = {
				...makeMinimalV2(),
				leftSidebar: { collapsed: false, activeTab: 'file-explorer' },
				rightSidebar: { collapsed: true },
				wallpaper: '/Users/x/wp.jpg',
			};
			const back = roundTrip(arr);
			expect(back.leftSidebar).toEqual({ collapsed: false, activeTab: 'file-explorer' });
			expect(back.rightSidebar?.collapsed).toBe(true);
			expect(back.wallpaper).toBe('/Users/x/wp.jpg');
		});
	});

	describe('compaction shape', () => {
		// The wire format uses short keys to keep the encoded blob tiny.
		// Pin the keys here so a future rename is a deliberate, reviewed
		// schema change (and would need a migration).
		it('uses the documented short keys', () => {
			const arr = makeMinimalV2();
			const compact = createCompactArrangement(arr);
			expect(compact).toHaveProperty('v');
			expect(compact).toHaveProperty('ts');
			expect(compact).toHaveProperty('f'); // focusedWindow
			expect(compact).toHaveProperty('m'); // main
			expect(compact.m).toHaveProperty('r'); // root
			expect(compact.m).toHaveProperty('g'); // geometry
		});

		it('omits popouts/sidebars/wallpaper when empty', () => {
			const arr = makeMinimalV2();
			const compact = createCompactArrangement(arr);
			expect(compact).not.toHaveProperty('p');
			expect(compact).not.toHaveProperty('ls');
			expect(compact).not.toHaveProperty('rs');
			expect(compact).not.toHaveProperty('wp');
		});

		it('includes split sizes under the `s` key (v0.1.31 fix)', () => {
			const compact = createCompactArrangement({
				...makeMinimalV2(),
				main: {
					root: {
						type: 'split',
						direction: 'horizontal',
						sizes: [25, 75],
						children: [
							{ type: 'tabs', tabs: [] },
							{ type: 'tabs', tabs: [] },
						],
					},
				},
			});
			// compact.m.r is the compact node for the main root
			const root = compact.m.r;
			expect(Array.isArray(root)).toBe(false); // splits are objects, tabs are arrays
			if (Array.isArray(root)) return;
			expect(root.s).toEqual([25, 75]);
			expect(root.d).toBe('h');
		});
	});

	describe('decodeArrangement', () => {
		it('returns null on garbage input', () => {
			expect(decodeArrangement('not-base64-at-all!@#$')).toBeNull();
		});

		it('handles legacy blobs without split sizes (forward compat)', () => {
			// Construct a compact blob the OLD way (no `s` field) and confirm
			// it still decodes to a valid arrangement — sizes just become
			// undefined, matching the pre-v0.1.31 broken-but-functional behavior.
			//
			// Wire shape: each child of a split's `c` is itself a compact node
			// (a tabs array or another split object).
			const legacyCompact = {
				v: 2,
				ts: 1700000000000,
				f: 0,
				m: {
					r: {
						d: 'h',
						c: [
							[['a.md', null, 1]],   // child 0: a tabs node with one active tab
							['b.md'],              // child 1: a tabs node with one path-only tab
						],
						// note: no `s`
					},
				},
			};
			const arr = expandCompactArrangement(legacyCompact);
			if (arr.main.root.type !== 'split') throw new Error('expected split');
			expect(arr.main.root.sizes).toBeUndefined();
			expect(arr.main.root.children).toHaveLength(2);
			const child0 = arr.main.root.children[0];
			if (child0.type !== 'tabs') throw new Error('expected tabs');
			expect(child0.tabs[0]).toMatchObject({ path: 'a.md', active: true });
		});
	});
});
