// ============================================================================
// Compact Arrangement Codec
// ----------------------------------------------------------------------------
// Encodes/decodes WindowArrangementV2 to and from the compact base64 JSON
// blob stored in markdown frontmatter. Short keys keep the encoded string
// short; see CompactArrangement in src/types.ts for the wire format.
// ============================================================================

import {
	CompactArrangement,
	CompactNode,
	CompactSplit,
	CompactTab,
	CompactWindow,
	FRONTMATTER_KEY,
	SplitState,
	TabState,
	WindowArrangementV2,
	WindowStateV2,
	WorkspaceNodeState,
} from '../types';
import { decodeBase64, encodeBase64 } from '../utils/base64';
import { Logger } from '../utils/logger';

/**
 * Encode an arrangement as a frontmatter line: `perspecta-arrangement: "<base64>"`.
 */
export function encodeArrangement(arr: WindowArrangementV2): string {
	const compact = createCompactArrangement(arr);
	const json = JSON.stringify(compact);
	const base64 = encodeBase64(json);
	return `${FRONTMATTER_KEY}: "${base64}"`;
}

/**
 * Decode a base64 blob back to WindowArrangementV2. Returns null on parse error.
 */
export function decodeArrangement(encoded: string): WindowArrangementV2 | null {
	try {
		const json = decodeBase64(encoded);
		const compact = JSON.parse(json) as CompactArrangement;
		return expandCompactArrangement(compact);
	} catch (e) {
		Logger.error('Failed to decode arrangement:', e);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export function createCompactArrangement(arr: WindowArrangementV2): CompactArrangement {
	const compact: CompactArrangement = {
		v: arr.v,
		ts: arr.ts,
		f: arr.focusedWindow,
		m: compactWindow(arr.main),
	};

	if (arr.popouts.length > 0) {
		compact.p = arr.popouts.map(compactWindow);
	}

	if (arr.leftSidebar) {
		compact.ls = { c: arr.leftSidebar.collapsed };
		if (arr.leftSidebar.activeTab) compact.ls.t = arr.leftSidebar.activeTab;
	}

	if (arr.rightSidebar) {
		compact.rs = { c: arr.rightSidebar.collapsed };
		if (arr.rightSidebar.activeTab) compact.rs.t = arr.rightSidebar.activeTab;
	}

	if (arr.sourceScreen) {
		// Just store aspect ratio - that's all we really need
		compact.ar = Math.round(arr.sourceScreen.aspectRatio * 100) / 100;
	}

	if (arr.wallpaper) {
		compact.wp = arr.wallpaper;
	}

	return compact;
}

function compactWindow(win: WindowStateV2): CompactWindow {
	const compact: CompactWindow = {
		r: compactNode(win.root),
	};

	if (win.x !== undefined && win.y !== undefined && win.width !== undefined && win.height !== undefined) {
		compact.g = [win.x, win.y, win.width, win.height];
	}

	return compact;
}

function compactNode(node: WorkspaceNodeState): CompactNode {
	if (node.type === 'tabs') {
		return node.tabs.map((tab): CompactTab => {
			if (tab.active) {
				// Active marker at index 2 → uid (or null placeholder) at index 1
				return [tab.path, tab.uid ?? null, 1];
			}
			if (tab.uid) {
				return [tab.path, tab.uid];
			}
			return tab.path;
		});
	}

	// Split: preserve sizes so frontmatter-mode restore doesn't fall back to 50/50.
	// Older arrangements without `s` still decode (sizes become undefined).
	const split: CompactSplit = {
		d: node.direction === 'horizontal' ? 'h' : 'v',
		c: node.children.map(compactNode),
	};
	if (node.sizes && node.sizes.length > 0) {
		split.s = node.sizes;
	}
	return split;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export function expandCompactArrangement(compact: CompactArrangement): WindowArrangementV2 {
	const arr: WindowArrangementV2 = {
		v: 2,
		ts: compact.ts || Date.now(),
		focusedWindow: compact.f ?? -1,
		main: expandWindow(compact.m),
		popouts: (compact.p || []).map(expandWindow),
	};

	if (compact.ls) {
		arr.leftSidebar = { collapsed: compact.ls.c, activeTab: compact.ls.t };
	}

	if (compact.rs) {
		arr.rightSidebar = { collapsed: compact.rs.c, activeTab: compact.rs.t };
	}

	if (compact.ar) {
		// Reconstruct screen info from aspect ratio (exact dimensions not needed)
		arr.sourceScreen = {
			width: Math.round(1117 * compact.ar),
			height: 1117,
			aspectRatio: compact.ar,
		};
	}

	if (compact.wp) {
		arr.wallpaper = compact.wp;
	}

	return arr;
}

function expandWindow(compact: CompactWindow): WindowStateV2 {
	const win: WindowStateV2 = {
		root: expandNode(compact.r),
	};

	if (compact.g) {
		win.x = compact.g[0];
		win.y = compact.g[1];
		win.width = compact.g[2];
		win.height = compact.g[3];
	}

	return win;
}

function expandNode(compact: CompactNode): WorkspaceNodeState {
	if (Array.isArray(compact)) {
		const tabs: TabState[] = compact.map(item => {
			if (typeof item === 'string') {
				return { path: item, active: false, name: item.split('/').pop()?.replace(/\.md$/, '') };
			}
			// [path, uid|null, active?]
			const path = item[0];
			const uid = item[1] || undefined;
			const active = item[2] === 1;
			return { path, uid, active, name: path.split('/').pop()?.replace(/\.md$/, '') };
		});
		return { type: 'tabs', tabs };
	}

	const node: SplitState = {
		type: 'split',
		direction: compact.d === 'h' ? 'horizontal' : 'vertical',
		children: compact.c.map(expandNode),
	};
	if (compact.s && compact.s.length > 0) {
		node.sizes = compact.s;
	}
	return node;
}
