import { App, Menu, MenuItem, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, WorkspaceLeaf, Notice } from 'obsidian';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface TabState {
	path: string;
	active: boolean;
}

interface SplitState {
	type: 'split';
	direction: 'horizontal' | 'vertical';
	children: (SplitState | TabGroupState)[];
}

interface TabGroupState {
	type: 'tabs';
	tabs: TabState[];
}

type WorkspaceNodeState = SplitState | TabGroupState;

interface WindowStateV2 {
	root: WorkspaceNodeState;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

interface WindowStateV1 {
	tabs: TabState[];
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

interface SidebarState {
	collapsed: boolean;
	activeTab?: string;
}

interface WindowArrangementV2 {
	v: 2;
	ts: number;
	main: WindowStateV2;
	popouts: WindowStateV2[];
	focusedWindow: number;
	leftSidebar?: SidebarState;
	rightSidebar?: SidebarState;
}

interface WindowArrangementV1 {
	v: 1;
	ts: number;
	main: WindowStateV1;
	popouts: WindowStateV1[];
	focusedWindow: number;
	leftSidebar?: SidebarState;
	rightSidebar?: SidebarState;
}

type WindowArrangement = WindowArrangementV1 | WindowArrangementV2;

interface PerspectaSettings {
	enableVisualMapping: boolean;
	enableAutomation: boolean;
	automationScriptsPath: string;
	saveArrangementHotkey: string;
	restoreArrangementHotkey: string;
	showDebugModal: boolean;
	enableDebugLogging: boolean;
	focusTintDuration: number;
}

const DEFAULT_SETTINGS: PerspectaSettings = {
	enableVisualMapping: true,
	enableAutomation: true,
	automationScriptsPath: 'perspecta/scripts/',
	saveArrangementHotkey: 'Shift+Meta+S',
	restoreArrangementHotkey: 'Shift+Meta+R',
	showDebugModal: true,
	enableDebugLogging: false,
	focusTintDuration: 8
};

const FRONTMATTER_KEY = 'perspecta-arrangement';

// ============================================================================
// Virtual Coordinate System
// ============================================================================
// Uses MacBook Pro 16" as reference (1728x1117 at default scaling)
// All saved coordinates are normalized to this virtual space, then scaled
// to the actual screen dimensions on restore.

const VIRTUAL_SCREEN = {
	width: 1728,
	height: 1117
};

interface PhysicalScreen {
	width: number;
	height: number;
	x: number;  // screen.availLeft (left edge of available area)
	y: number;  // screen.availTop (top edge, below menu bar on macOS)
}

function getPhysicalScreen(): PhysicalScreen {
	return {
		width: window.screen.availWidth,
		height: window.screen.availHeight,
		x: (window.screen as any).availLeft ?? 0,
		y: (window.screen as any).availTop ?? 0
	};
}

// Convert physical coordinates to virtual (for saving)
function physicalToVirtual(physical: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
	const screen = getPhysicalScreen();
	const scaleX = VIRTUAL_SCREEN.width / screen.width;
	const scaleY = VIRTUAL_SCREEN.height / screen.height;

	return {
		x: Math.round((physical.x - screen.x) * scaleX),
		y: Math.round((physical.y - screen.y) * scaleY),
		width: Math.round(physical.width * scaleX),
		height: Math.round(physical.height * scaleY)
	};
}

// Convert virtual coordinates to physical (for restoring)
function virtualToPhysical(virtual: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
	const screen = getPhysicalScreen();
	const scaleX = screen.width / VIRTUAL_SCREEN.width;
	const scaleY = screen.height / VIRTUAL_SCREEN.height;

	let x = Math.round(virtual.x * scaleX) + screen.x;
	let y = Math.round(virtual.y * scaleY) + screen.y;
	let width = Math.round(virtual.width * scaleX);
	let height = Math.round(virtual.height * scaleY);

	// Ensure window fits within screen bounds
	width = Math.min(width, screen.width);
	height = Math.min(height, screen.height);
	x = Math.max(screen.x, Math.min(x, screen.x + screen.width - width));
	y = Math.max(screen.y, Math.min(y, screen.y + screen.height - height));

	return { x, y, width, height };
}

// Performance timing helper - controlled by settings.enableDebugLogging
class PerfTimer {
	private static enabled = false; // Controlled by plugin settings
	private static times: { label: string; elapsed: number }[] = [];
	private static start: number = 0;
	private static lastMark: number = 0;

	static begin(operation: string) {
		if (!this.enabled) return;
		this.times = [];
		this.start = performance.now();
		this.lastMark = this.start;
		console.log(`[Perspecta] ▶ ${operation} started`);
	}

	static mark(label: string) {
		if (!this.enabled) return;
		const now = performance.now();
		const elapsed = now - this.lastMark;
		this.times.push({ label, elapsed });
		this.lastMark = now;
		if (elapsed > 50) {
			console.warn(`[Perspecta] ⚠ SLOW: ${label}: ${elapsed.toFixed(1)}ms`);
		}
	}

	static end(operation: string) {
		if (!this.enabled) return;
		const total = performance.now() - this.start;
		console.log(`[Perspecta] ◼ ${operation} completed in ${total.toFixed(1)}ms`);
		if (total > 200) {
			console.log('[Perspecta] Breakdown:');
			for (const t of this.times) {
				const flag = t.elapsed > 50 ? '⚠' : '✓';
				console.log(`  ${flag} ${t.label}: ${t.elapsed.toFixed(1)}ms`);
			}
		}
	}

	static setEnabled(enabled: boolean) {
		this.enabled = enabled;
	}
}

// ============================================================================
// Main Plugin Class
// ============================================================================

export default class PerspectaPlugin extends Plugin {
	settings: PerspectaSettings;
	private focusedWindowIndex: number = -1;
	private windowFocusListeners: Map<Window, () => void> = new Map();
	private registeredHotkeyWindows = new Set<Window>();
	private filesWithContext = new Set<string>();
	private refreshIndicatorsTimeout: ReturnType<typeof setTimeout> | null = null;
	private isClosingWindow = false; // Guard against operations during window close

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('layout-grid', 'Perspecta', () => {});

		this.addCommand({
			id: 'save-context',
			name: 'Save context',
			callback: () => this.saveContext()
		});

		this.addCommand({
			id: 'restore-context',
			name: 'Restore context',
			callback: () => this.restoreContext()
		});

		this.registerHotkeyListeners();
		this.setupFocusTracking();
		this.setupContextIndicator();
		this.setupFileExplorerIndicators();

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item: MenuItem) => {
						item.setTitle('Remember note context').setIcon('target')
							.onClick(() => this.saveContext(file));
					});
				}
			})
		);

		this.registerDomEvent(document, 'auxclick', (evt: MouseEvent) => {
			if (evt.button === 1) {
				const link = (evt.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement;
				if (link) {
					evt.preventDefault();
					const href = link.getAttribute('data-href');
					if (href) {
						const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
						if (file instanceof TFile) this.openInNewWindow(file);
					}
				}
			}
		});

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			if (evt.altKey && evt.button === 0) {
				const link = (evt.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement;
				if (link) {
					evt.preventDefault();
					evt.stopPropagation();
					const href = link.getAttribute('data-href');
					if (href) {
						const file = this.app.metadataCache.getFirstLinkpathDest(href, '');
						if (file instanceof TFile) this.openInNewWindow(file);
					}
				}
			}
		}, true);

		this.addSettingTab(new PerspectaSettingTab(this.app, this));
	}

	onunload() {
		this.windowFocusListeners.forEach((listener, win) => {
			win.removeEventListener('focus', listener);
		});
		this.windowFocusListeners.clear();
	}

	// ============================================================================
	// Hotkey Management
	// ============================================================================

	private hotkeyHandler = (evt: KeyboardEvent) => {
		if (this.matchesHotkey(evt, this.settings.saveArrangementHotkey)) {
			evt.preventDefault();
			this.saveContext();
		} else if (this.matchesHotkey(evt, this.settings.restoreArrangementHotkey)) {
			evt.preventDefault();
			this.restoreContext();
		}
	};

	private registerHotkeyListeners() {
		this.registerDomEvent(document, 'keydown', this.hotkeyHandler);
		this.registerEvent(
			this.app.workspace.on('window-open', (_: any, win: Window) => {
				this.registerHotkeyOnWindow(win);
			})
		);
	}

	private registerHotkeyOnWindow(win: Window) {
		if (this.registeredHotkeyWindows.has(win)) return;
		this.registeredHotkeyWindows.add(win);
		win.document.addEventListener('keydown', this.hotkeyHandler);
		win.addEventListener('unload', () => this.registeredHotkeyWindows.delete(win));
	}

	private matchesHotkey(evt: KeyboardEvent, hotkey: string): boolean {
		const parts = hotkey.split('+').map(p => p.trim().toLowerCase());
		const needsShift = parts.includes('shift');
		const needsMeta = parts.includes('meta') || parts.includes('cmd');
		const needsCtrl = parts.includes('ctrl') || parts.includes('control');
		const needsAlt = parts.includes('alt') || parts.includes('option');
		const modifiers = ['shift', 'meta', 'cmd', 'ctrl', 'control', 'alt', 'option'];
		const key = hotkey.split('+').find(p => !modifiers.includes(p.trim().toLowerCase()));

		if (needsShift !== evt.shiftKey || needsMeta !== evt.metaKey ||
			needsCtrl !== evt.ctrlKey || needsAlt !== evt.altKey) return false;
		if (key) {
			const eventKey = evt.key.length === 1 ? evt.key.toUpperCase() : evt.key;
			if (eventKey !== key) return false;
		}
		return true;
	}

	// ============================================================================
	// Focus Tracking
	// ============================================================================

	private setupFocusTracking() {
		this.registerDomEvent(window, 'focus', () => this.focusedWindowIndex = -1);
		this.registerEvent(
			this.app.workspace.on('window-open', (_: any, win: Window) => {
				this.trackPopoutWindowFocus(win);
			})
		);
		this.registerEvent(
			this.app.workspace.on('window-close', (_: any, win: Window) => {
				// Debug timing (uncomment to debug window close performance)
				// const start = performance.now();
				// console.log(`[Perspecta] Window close event START`);

				// Set guard to prevent other handlers from doing work during close
				this.isClosingWindow = true;

				// Clean up our focus listener for this window
				const listener = this.windowFocusListeners.get(win);
				if (listener) {
					win.removeEventListener('focus', listener);
					this.windowFocusListeners.delete(win);
				}

				// Clean up registered hotkey window
				if (this.registeredHotkeyWindows.has(win)) {
					this.registeredHotkeyWindows.delete(win);
				}

				// Debug timing (uncomment to debug window close performance)
				// const elapsed = performance.now() - start;
				// console.log(`[Perspecta] Window close event END (${elapsed.toFixed(1)}ms)`);

				// Reset guard after a short delay to allow Obsidian to finish cleanup
				setTimeout(() => {
					this.isClosingWindow = false;
				}, 100);

				// Debug: Check if main thread gets blocked after our handler (uncomment to debug)
				// const closeTime = performance.now();
				// setTimeout(() => {
				// 	const delay = performance.now() - closeTime;
				// 	if (delay > 100) {
				// 		console.warn(`[Perspecta] ⚠ Main thread was blocked for ${delay.toFixed(0)}ms after window close`);
				// 	}
				// }, 0);
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (this.isClosingWindow) {
					// console.log(`[Perspecta] layout-change skipped (window closing)`);
					return;
				}
				// console.log(`[Perspecta] layout-change event`);
			})
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (this.isClosingWindow) return;
				// Debug: uncomment to log leaf changes
				// const path = (leaf?.view as any)?.file?.path || 'unknown';
				// console.log(`[Perspecta] active-leaf-change: ${path}`);
			})
		);
	}

	private trackPopoutWindowFocus(win: Window) {
		if (this.windowFocusListeners.has(win)) return;
		const listener = () => {
			// Skip if we're in the middle of closing a window
			if (this.isClosingWindow) {
				// console.log(`[Perspecta] popoutFocusHandler skipped (window closing)`);
				return;
			}
			PerfTimer.begin('popoutFocusHandler');
			const popouts = this.getPopoutWindowObjects();
			PerfTimer.mark('getPopoutWindowObjects');
			this.focusedWindowIndex = popouts.indexOf(win);
			PerfTimer.end('popoutFocusHandler');
		};
		win.addEventListener('focus', listener);
		this.windowFocusListeners.set(win, listener);
	}

	// ============================================================================
	// Window Arrangement Capture (Optimized)
	// ============================================================================

	private captureWindowArrangement(): WindowArrangementV2 {
		PerfTimer.mark('captureWindowArrangement:start');
		const workspace = this.app.workspace as any;

		const main = this.captureWindowState(workspace.rootSplit, window);
		PerfTimer.mark('captureMainWindow');

		const popouts = this.capturePopoutStates();
		PerfTimer.mark('capturePopouts');

		const leftSidebar = this.captureSidebarState('left');
		const rightSidebar = this.captureSidebarState('right');
		PerfTimer.mark('captureSidebars');

		return {
			v: 2,
			ts: Date.now(),
			main,
			popouts,
			focusedWindow: this.focusedWindowIndex,
			leftSidebar,
			rightSidebar
		};
	}

	private captureWindowState(rootSplit: any, win: Window): WindowStateV2 {
		// Convert physical coordinates to virtual coordinate system
		const virtual = physicalToVirtual({
			x: win.screenX,
			y: win.screenY,
			width: win.outerWidth,
			height: win.outerHeight
		});

		return {
			root: this.captureSplitOrTabs(rootSplit),
			x: virtual.x,
			y: virtual.y,
			width: virtual.width,
			height: virtual.height
		};
	}

	private capturePopoutStates(): WindowStateV2[] {
		const states: WindowStateV2[] = [];
		const workspace = this.app.workspace as any;
		const floatingSplit = workspace.floatingSplit;
		if (!floatingSplit?.children) return states;

		for (const container of floatingSplit.children) {
			const win = container?.win;
			if (!win || win === window) continue;
			const popoutRoot = container?.children?.[0];
			if (popoutRoot) {
				// Convert physical coordinates to virtual coordinate system
				const virtual = physicalToVirtual({
					x: win.screenX,
					y: win.screenY,
					width: win.outerWidth,
					height: win.outerHeight
				});

				states.push({
					root: this.captureSplitOrTabs(popoutRoot),
					x: virtual.x,
					y: virtual.y,
					width: virtual.width,
					height: virtual.height
				});
			}
		}
		return states;
	}

	private captureSplitOrTabs(node: any): WorkspaceNodeState {
		if (!node) return { type: 'tabs', tabs: [] };

		if (node.direction && Array.isArray(node.children)) {
			const children: WorkspaceNodeState[] = [];
			for (const child of node.children) {
				const childState = this.captureSplitOrTabs(child);
				if (childState.type === 'split' || childState.tabs.length > 0) {
					children.push(childState);
				}
			}
			if (children.length === 1) return children[0];
			if (children.length === 0) return { type: 'tabs', tabs: [] };
			return { type: 'split', direction: node.direction, children };
		}
		return this.captureTabGroup(node);
	}

	private captureTabGroup(tabContainer: any): TabGroupState {
		const tabs: TabState[] = [];
		const children = tabContainer?.children || [];
		const activeLeaf = this.app.workspace.activeLeaf;

		for (const leaf of children) {
			const file = (leaf?.view as any)?.file as TFile | undefined;
			if (file) {
				tabs.push({ path: file.path, active: leaf === activeLeaf });
			}
		}
		return { type: 'tabs', tabs };
	}

	private captureSidebarState(side: 'left' | 'right'): SidebarState {
		const workspace = this.app.workspace as any;
		const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;
		if (!sidebar) return { collapsed: true };

		let activeTab: string | undefined;
		try {
			const leaf = side === 'left' ? workspace.leftLeaf : workspace.rightLeaf;
			activeTab = leaf?.view?.getViewType?.();
		} catch { /* ignore */ }

		return { collapsed: sidebar.collapsed ?? false, activeTab };
	}

	private getPopoutWindowObjects(): Window[] {
		const start = performance.now();
		const windows: Window[] = [];
		const seen = new Set<Window>([window]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.view?.containerEl?.win;
			if (win && !seen.has(win)) {
				seen.add(win);
				windows.push(win);
			}
		});
		const elapsed = performance.now() - start;
		if (elapsed > 20) {
			console.warn(`[Perspecta] ⚠ SLOW getPopoutWindowObjects: ${elapsed.toFixed(1)}ms`);
		}
		return windows;
	}

	// ============================================================================
	// Context Save (Optimized)
	// ============================================================================

	async saveContext(file?: TFile) {
		PerfTimer.begin('saveContext');

		const targetFile = file ?? this.app.workspace.getActiveFile();
		PerfTimer.mark('getActiveFile');

		if (!targetFile) {
			new Notice('No active file to save context to');
			return;
		}

		const context = this.captureWindowArrangement();
		PerfTimer.mark('captureWindowArrangement');

		await this.saveArrangementToNote(targetFile, context);
		PerfTimer.mark('saveArrangementToNote');

		if (this.settings.showDebugModal) {
			this.showContextDebugModal(context, targetFile.name);
			PerfTimer.mark('showContextDebugModal');
		} else {
			new Notice(`Context saved to ${targetFile.name}`);
		}

		PerfTimer.end('saveContext');
	}

	private async saveArrangementToNote(file: TFile, arrangement: WindowArrangementV2) {
		const content = await this.app.vault.read(file);
		const newContent = this.updateFrontmatter(content, arrangement);
		await this.app.vault.modify(file, newContent);
	}

	private updateFrontmatter(content: string, arrangement: WindowArrangementV2): string {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		const yaml = this.arrangementToYaml(arrangement);

		if (match) {
			let fm = match[1].replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '').trim();
			fm = fm ? fm + '\n' + yaml : yaml;
			return content.replace(frontmatterRegex, `---\n${fm}\n---`);
		}
		return `---\n${yaml}\n---\n${content}`;
	}

	private arrangementToYaml(arr: WindowArrangementV2): string {
		const lines: string[] = [`${FRONTMATTER_KEY}:`];
		lines.push(`  v: ${arr.v}`, `  ts: ${arr.ts}`, `  focusedWindow: ${arr.focusedWindow}`);

		lines.push('  main:');
		this.nodeToYaml(arr.main.root, lines, 4);
		if (arr.main.x !== undefined) lines.push(`    x: ${arr.main.x}`);
		if (arr.main.y !== undefined) lines.push(`    y: ${arr.main.y}`);
		if (arr.main.width !== undefined) lines.push(`    width: ${arr.main.width}`);
		if (arr.main.height !== undefined) lines.push(`    height: ${arr.main.height}`);

		if (arr.popouts.length > 0) {
			lines.push('  popouts:');
			for (const p of arr.popouts) {
				lines.push('    -');
				this.nodeToYaml(p.root, lines, 6);
				if (p.x !== undefined) lines.push(`      x: ${p.x}`);
				if (p.y !== undefined) lines.push(`      y: ${p.y}`);
				if (p.width !== undefined) lines.push(`      width: ${p.width}`);
				if (p.height !== undefined) lines.push(`      height: ${p.height}`);
			}
		}

		if (arr.leftSidebar) {
			lines.push('  leftSidebar:', `    collapsed: ${arr.leftSidebar.collapsed}`);
			if (arr.leftSidebar.activeTab) lines.push(`    activeTab: "${arr.leftSidebar.activeTab}"`);
		}
		if (arr.rightSidebar) {
			lines.push('  rightSidebar:', `    collapsed: ${arr.rightSidebar.collapsed}`);
			if (arr.rightSidebar.activeTab) lines.push(`    activeTab: "${arr.rightSidebar.activeTab}"`);
		}

		return lines.join('\n');
	}

	private nodeToYaml(node: WorkspaceNodeState, lines: string[], indent: number): void {
		const pad = ' '.repeat(indent);
		lines.push(`${pad}root:`);

		if (node.type === 'tabs') {
			lines.push(`${pad}  type: tabs`, `${pad}  tabs:`);
			for (const tab of node.tabs) {
				lines.push(`${pad}    - path: "${tab.path}"`, `${pad}      active: ${tab.active}`);
			}
		} else {
			lines.push(`${pad}  type: split`, `${pad}  direction: ${node.direction}`, `${pad}  children:`);
			for (const child of node.children) {
				lines.push(`${pad}    -`);
				this.childNodeToYaml(child, lines, indent + 6);
			}
		}
	}

	private childNodeToYaml(node: WorkspaceNodeState, lines: string[], indent: number): void {
		const pad = ' '.repeat(indent);
		if (node.type === 'tabs') {
			lines.push(`${pad}type: tabs`, `${pad}tabs:`);
			for (const tab of node.tabs) {
				lines.push(`${pad}  - path: "${tab.path}"`, `${pad}    active: ${tab.active}`);
			}
		} else {
			lines.push(`${pad}type: split`, `${pad}direction: ${node.direction}`, `${pad}children:`);
			for (const child of node.children) {
				lines.push(`${pad}  -`);
				this.childNodeToYaml(child, lines, indent + 4);
			}
		}
	}

	// ============================================================================
	// Context Restore (Optimized)
	// ============================================================================

	async restoreContext(file?: TFile) {
		PerfTimer.begin('restoreContext');

		const targetFile = file ?? this.app.workspace.getActiveFile();
		PerfTimer.mark('getActiveFile');

		if (!targetFile) { new Notice('No active file'); return; }

		const context = this.getContextFromNote(targetFile);
		PerfTimer.mark('getContextFromNote');

		if (!context) { new Notice('No context found in this note'); return; }

		const focusedWin = await this.applyArrangement(context);
		PerfTimer.mark('applyArrangement');

		this.showNoticeInWindow(focusedWin, 'Context restored');
		PerfTimer.end('restoreContext');
	}

	private getContextFromNote(file: TFile): WindowArrangement | null {
		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter?.[FRONTMATTER_KEY] as WindowArrangement || null;
	}

	private async applyArrangement(arrangement: WindowArrangement): Promise<Window | null> {
		try {
			PerfTimer.mark('applyArrangement:start');

			const v2 = this.normalizeToV2(arrangement);
			PerfTimer.mark('normalizeToV2');

			// Close popouts
			const popoutWindows = this.getPopoutWindowObjects();
			PerfTimer.mark('getPopoutWindowObjects');

			for (const win of popoutWindows) {
				this.closePopoutWindow(win);
			}
			PerfTimer.mark('closePopoutWindows');

			// Get main window leaves (single iteration)
			const mainLeaves = this.getMainWindowLeaves();
			PerfTimer.mark('getMainWindowLeaves');

			for (let i = 1; i < mainLeaves.length; i++) mainLeaves[i].detach();
			PerfTimer.mark('detachExtraLeaves');

			// Restore geometry
			this.restoreWindowGeometry(window, v2.main);
			PerfTimer.mark('restoreWindowGeometry');

			// Restore main workspace
			const workspace = this.app.workspace as any;
			await this.restoreWorkspaceNode(workspace.rootSplit, v2.main.root, mainLeaves[0]);
			PerfTimer.mark('restoreMainWorkspace');

			// Restore popouts
			for (let i = 0; i < v2.popouts.length; i++) {
				await this.restorePopoutWindow(v2.popouts[i]);
				PerfTimer.mark(`restorePopout[${i}]`);
			}

			// Restore sidebars
			if (v2.leftSidebar) this.restoreSidebarState('left', v2.leftSidebar);
			if (v2.rightSidebar) this.restoreSidebarState('right', v2.rightSidebar);
			PerfTimer.mark('restoreSidebars');

			// Activate focused window
			const focusedWin = this.getFocusedWindow(v2);
			if (focusedWin) {
				this.activateWindowLeaf(focusedWin, v2);
				focusedWin.focus();
				this.showFocusTint(focusedWin);
			}
			PerfTimer.mark('activateFocusedWindow');

			return focusedWin;
		} catch (e) {
			new Notice('Error restoring context: ' + (e as Error).message);
			return null;
		}
	}

	private getMainWindowLeaves(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const win = leaf.view?.containerEl?.win;
			if ((!win || win === window) && this.isInRootSplit(leaf)) {
				leaves.push(leaf);
			}
		});
		return leaves;
	}

	private normalizeToV2(arr: WindowArrangement): WindowArrangementV2 {
		if (arr.v === 2) return arr as WindowArrangementV2;
		const v1 = arr as WindowArrangementV1;
		return {
			v: 2, ts: v1.ts, focusedWindow: v1.focusedWindow,
			main: { root: { type: 'tabs', tabs: v1.main.tabs }, x: v1.main.x, y: v1.main.y, width: v1.main.width, height: v1.main.height },
			popouts: v1.popouts.map(p => ({ root: { type: 'tabs', tabs: p.tabs }, x: p.x, y: p.y, width: p.width, height: p.height })),
			leftSidebar: v1.leftSidebar, rightSidebar: v1.rightSidebar
		};
	}

	private async restoreWorkspaceNode(parent: any, state: WorkspaceNodeState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state?.type) {
			if ('tabs' in state) return this.restoreTabGroup(parent, { type: 'tabs', tabs: (state as any).tabs }, existingLeaf);
			return existingLeaf;
		}
		return state.type === 'tabs'
			? this.restoreTabGroup(parent, state, existingLeaf)
			: this.restoreSplit(parent, state as SplitState, existingLeaf);
	}

	private async restoreTabGroup(parent: any, state: TabGroupState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state.tabs?.length) return existingLeaf;

		let firstLeaf: WorkspaceLeaf | undefined;
		let activeTabPath: string | null = null;

		for (let i = 0; i < state.tabs.length; i++) {
			const tab = state.tabs[i];
			const tabStart = performance.now();

			const file = this.app.vault.getAbstractFileByPath(tab.path);
			if (!(file instanceof TFile)) continue;

			if (tab.active) activeTabPath = tab.path;

			let leaf: WorkspaceLeaf;
			if (i === 0 && existingLeaf) {
				await existingLeaf.openFile(file);
				leaf = existingLeaf;
			} else if (i === 0) {
				leaf = this.app.workspace.createLeafInParent(parent, 0);
				await leaf.openFile(file);
			} else {
				const container = firstLeaf?.parent;
				if (!container) continue;
				leaf = this.app.workspace.createLeafInParent(container, (container as any).children?.length ?? 0);
				await leaf.openFile(file);
			}

			const elapsed = performance.now() - tabStart;
			if (elapsed > 50) {
				console.warn(`[Perspecta] ⚠ SLOW openFile: ${tab.path} took ${elapsed.toFixed(1)}ms`);
			}

			if (i === 0) firstLeaf = leaf;
		}

		if (activeTabPath && firstLeaf) {
			const iterateStart = performance.now();
			this.app.workspace.iterateAllLeaves((leaf) => {
				if ((leaf.view as any)?.file?.path === activeTabPath) {
					this.app.workspace.setActiveLeaf(leaf, { focus: false });
				}
			});
			const iterateElapsed = performance.now() - iterateStart;
			if (iterateElapsed > 50) {
				console.warn(`[Perspecta] ⚠ SLOW iterateAllLeaves in restoreTabGroup: ${iterateElapsed.toFixed(1)}ms`);
			}
		}

		return firstLeaf;
	}

	private async restoreSplit(parent: any, state: SplitState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state.children.length) return existingLeaf;

		let firstLeaf = await this.restoreWorkspaceNode(parent, state.children[0], existingLeaf);

		for (let i = 1; i < state.children.length; i++) {
			if (firstLeaf) this.app.workspace.setActiveLeaf(firstLeaf, { focus: false });

			// Obsidian's workspace stores direction as the axis of the split line:
			// - 'horizontal' in storage = horizontal divider = notes stacked vertically (top/bottom)
			// - 'vertical' in storage = vertical divider = notes side by side (left/right)
			// But getLeaf('split', direction) expects the arrangement direction:
			// - 'horizontal' = arrange horizontally = notes side by side (left/right)
			// - 'vertical' = arrange vertically = notes stacked (top/bottom)
			// So we need to SWAP the direction when restoring
			const restoreDirection = state.direction === 'horizontal' ? 'vertical' : 'horizontal';
			const newLeaf = this.app.workspace.getLeaf('split', restoreDirection);
			await this.restoreWorkspaceNode(newLeaf.parent, state.children[i], newLeaf);
		}

		return firstLeaf;
	}

	private async restorePopoutWindow(state: WindowStateV2) {
		const firstTab = this.getFirstTab(state.root);
		if (!firstTab) return;

		const file = this.app.vault.getAbstractFileByPath(firstTab.path);
		if (!(file instanceof TFile)) return;

		const popoutLeaf = this.app.workspace.openPopoutLeaf();
		await popoutLeaf.openFile(file);

		const win = popoutLeaf.view?.containerEl?.win;
		if (win) this.restoreWindowGeometry(win, state);

		if (state.root.type === 'tabs' && state.root.tabs.length > 1) {
			for (let i = 1; i < state.root.tabs.length; i++) {
				const tab = state.root.tabs[i];
				const f = this.app.vault.getAbstractFileByPath(tab.path);
				if (!(f instanceof TFile)) continue;
				const parent = popoutLeaf.parent;
				if (parent) {
					const leaf = this.app.workspace.createLeafInParent(parent, (parent as any).children?.length ?? 0);
					await leaf.openFile(f);
				}
			}
		} else if (state.root.type === 'split') {
			this.app.workspace.setActiveLeaf(popoutLeaf, { focus: false });
			for (let i = 1; i < state.root.children.length; i++) {
				// Swap direction (same reason as in restoreSplit)
				const restoreDirection = state.root.direction === 'horizontal' ? 'vertical' : 'horizontal';
				const newLeaf = this.app.workspace.getLeaf('split', restoreDirection);
				await this.restoreWorkspaceNode(newLeaf.parent, state.root.children[i], newLeaf);
			}
		}
	}

	private getFirstTab(node: WorkspaceNodeState): TabState | null {
		if (node.type === 'tabs') return node.tabs[0] || null;
		for (const child of node.children) {
			const tab = this.getFirstTab(child);
			if (tab) return tab;
		}
		return null;
	}

	private closePopoutWindow(win: Window) {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.containerEl?.win === win) leaves.push(leaf);
		});
		leaves.forEach(l => l.detach());
	}

	private getFocusedWindow(arr: WindowArrangementV2): Window | null {
		if (arr.focusedWindow === -1) return window;
		const popouts = this.getPopoutWindowObjects();
		return popouts[arr.focusedWindow] ?? window;
	}

	private activateWindowLeaf(win: Window, arr: WindowArrangementV2) {
		const start = performance.now();
		const root = win === window ? arr.main.root : arr.popouts[this.getPopoutWindowObjects().indexOf(win)]?.root;
		if (!root) return;

		const activePath = this.findActiveTabPath(root);
		if (!activePath) return;

		// Find the target leaf without using iterateAllLeaves during the search
		let targetLeaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!targetLeaf && leaf.view?.containerEl?.win === win && (leaf.view as any)?.file?.path === activePath) {
				targetLeaf = leaf;
			}
		});

		if (targetLeaf) {
			// Use focus: false to avoid slow window focus operations
			// We'll focus the window separately with win.focus()
			this.app.workspace.setActiveLeaf(targetLeaf, { focus: false });
		}

		const elapsed = performance.now() - start;
		if (elapsed > 50) {
			console.warn(`[Perspecta] ⚠ SLOW activateWindowLeaf: ${elapsed.toFixed(1)}ms`);
		}
	}

	private findActiveTabPath(node: WorkspaceNodeState): string | null {
		if (node.type === 'tabs') {
			return node.tabs.find(t => t.active)?.path || node.tabs[0]?.path || null;
		}
		for (const child of node.children) {
			const path = this.findActiveTabPath(child);
			if (path) return path;
		}
		return null;
	}

	private restoreWindowGeometry(win: Window, state: WindowStateV2) {
		if (state.width === undefined || state.height === undefined ||
			state.x === undefined || state.y === undefined) {
			return;
		}

		// Convert virtual coordinates to physical screen coordinates
		const physical = virtualToPhysical({
			x: state.x,
			y: state.y,
			width: state.width,
			height: state.height
		});

		try { win.resizeTo(physical.width, physical.height); } catch { /* ignore */ }
		try { win.moveTo(physical.x, physical.y); } catch { /* ignore */ }
	}

	private isInRootSplit(leaf: WorkspaceLeaf): boolean {
		const el = leaf.view?.containerEl;
		return el ? !el.closest('.mod-left-split') && !el.closest('.mod-right-split') : true;
	}

	private restoreSidebarState(side: 'left' | 'right', state: SidebarState) {
		try {
			const workspace = this.app.workspace as any;
			const sidebar = side === 'left' ? workspace.leftSplit : workspace.rightSplit;
			if (!sidebar) return;

			if (state.collapsed) { sidebar.collapse?.(); return; }
			sidebar.expand?.();

			const views = state.activeTab ? [state.activeTab, side === 'left' ? 'file-explorer' : 'backlink'] : [side === 'left' ? 'file-explorer' : 'backlink'];
			for (const viewType of views) {
				const leaves = this.app.workspace.getLeavesOfType(viewType);
				const leaf = leaves.find(l => l.view?.containerEl?.closest(side === 'left' ? '.mod-left-split' : '.mod-right-split'));
				if (leaf) { this.app.workspace.revealLeaf(leaf); break; }
			}
		} catch { /* ignore */ }
	}

	private showFocusTint(win: Window) {
		const duration = this.settings.focusTintDuration;
		if (duration <= 0) return;

		const overlay = win.document.createElement('div');
		overlay.className = 'perspecta-focus-tint';
		overlay.style.animationDuration = `${duration}s`;
		win.document.body.appendChild(overlay);
		overlay.addEventListener('animationend', () => overlay.remove());
		setTimeout(() => overlay.parentNode && overlay.remove(), duration * 1000 + 500);
	}

	private showNoticeInWindow(win: Window | null, message: string) {
		if (win && win !== window) {
			const el = win.document.createElement('div');
			el.className = 'notice';
			el.textContent = message;
			let container = win.document.body.querySelector('.notice-container');
			if (!container) {
				container = win.document.createElement('div');
				container.className = 'notice-container';
				win.document.body.appendChild(container);
			}
			container.appendChild(el);
			setTimeout(() => el.remove(), 4000);
		} else {
			new Notice(message);
		}
	}

	// ============================================================================
	// Debug Modal
	// ============================================================================

	private showContextDebugModal(context: WindowArrangementV2, fileName: string) {
		const overlay = document.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = document.createElement('div');
		modal.className = 'perspecta-debug-modal';

		let html = `<h3>Context Saved</h3>
			<p><strong>File:</strong> ${fileName}</p>
			<p><strong>Focused:</strong> ${context.focusedWindow === -1 ? 'Main' : `Popout #${context.focusedWindow + 1}`}</p>
			<h4>Main Window</h4>${this.renderNodeHtml(context.main.root)}`;

		if (context.popouts.length) {
			html += `<h4>Popouts (${context.popouts.length})</h4>`;
			context.popouts.forEach((p, i) => { html += `<p>Popout #${i + 1}:</p>${this.renderNodeHtml(p.root)}`; });
		}

		html += `<button class="perspecta-debug-close">Close</button>`;
		modal.innerHTML = html;

		overlay.onclick = () => { modal.remove(); overlay.remove(); };
		modal.querySelector('.perspecta-debug-close')?.addEventListener('click', () => { modal.remove(); overlay.remove(); });

		document.body.appendChild(overlay);
		document.body.appendChild(modal);
	}

	private renderNodeHtml(node: WorkspaceNodeState, depth = 0): string {
		const pad = '&nbsp;'.repeat(depth * 4);
		if (node.type === 'tabs') {
			return node.tabs.map(t => `${pad}📄 ${t.path.split('/').pop()}${t.active ? ' ✓' : ''}`).join('<br>') + '<br>';
		}
		let html = `${pad}${node.direction === 'horizontal' ? '↔️' : '↕️'} Split<br>`;
		for (const child of node.children) html += this.renderNodeHtml(child, depth + 1);
		return html;
	}

	// ============================================================================
	// Context Indicator
	// ============================================================================

	private setupContextIndicator() {
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.isClosingWindow) return;
			this.updateContextIndicator(file);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (this.isClosingWindow) return;
			if (file === this.app.workspace.getActiveFile()) this.updateContextIndicator(file);
			this.updateFileExplorerIndicator(file);
		}));
	}

	private updateContextIndicator(file: TFile | null) {
		PerfTimer.begin('updateContextIndicator');
		document.querySelectorAll('.view-header-title-container .perspecta-context-indicator').forEach(el => el.remove());
		PerfTimer.mark('removeOldIndicators');

		if (!file) {
			PerfTimer.end('updateContextIndicator');
			return;
		}

		const hasContext = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;
		PerfTimer.mark('checkHasContext');

		if (hasContext) {
			const header = document.querySelector('.workspace-leaf.mod-active .view-header-title-container');
			if (header && !header.querySelector('.perspecta-context-indicator')) {
				const icon = this.createTargetIcon();
				icon.setAttribute('aria-label', 'Has saved context - click to restore');
				icon.addEventListener('click', () => this.restoreContext(file));
				header.appendChild(icon);
			}
		}
		PerfTimer.end('updateContextIndicator');
	}

	private createTargetIcon(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'perspecta-context-indicator';
		el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
		return el;
	}

	// ============================================================================
	// File Explorer Indicators
	// ============================================================================

	private setupFileExplorerIndicators() {
		PerfTimer.begin('setupFileExplorerIndicators');
		const files = this.app.vault.getMarkdownFiles();
		PerfTimer.mark(`getMarkdownFiles (${files.length} files)`);

		for (const file of files) {
			if (this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY]) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark('scanForContextFiles');

		this.registerEvent(this.app.workspace.on('layout-change', () => this.debouncedRefreshIndicators()));
		setTimeout(() => this.refreshFileExplorerIndicators(), 500);
		PerfTimer.end('setupFileExplorerIndicators');
	}

	private updateFileExplorerIndicator(file: TFile) {
		const hasContext = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;
		hasContext ? this.filesWithContext.add(file.path) : this.filesWithContext.delete(file.path);
		this.debouncedRefreshIndicators();
	}

	private debouncedRefreshIndicators() {
		if (this.refreshIndicatorsTimeout) clearTimeout(this.refreshIndicatorsTimeout);
		this.refreshIndicatorsTimeout = setTimeout(() => {
			// Skip if we're in the middle of closing a window
			if (this.isClosingWindow) {
				// console.log(`[Perspecta] refreshFileExplorerIndicators skipped (window closing)`);
				this.refreshIndicatorsTimeout = null;
				return;
			}
			this.refreshFileExplorerIndicators();
			this.refreshIndicatorsTimeout = null;
		}, 100);
	}

	private refreshFileExplorerIndicators() {
		PerfTimer.begin('refreshFileExplorerIndicators');
		document.querySelectorAll('.nav-file-title .perspecta-context-indicator').forEach(el => el.remove());
		PerfTimer.mark('removeOldIndicators');

		this.filesWithContext.forEach(path => {
			const el = document.querySelector(`.nav-file-title[data-path="${CSS.escape(path)}"]`);
			if (el && !el.querySelector('.perspecta-context-indicator')) {
				const icon = this.createTargetIcon();
				icon.setAttribute('aria-label', 'Has saved context');
				el.insertBefore(icon, el.firstChild);
			}
		});
		PerfTimer.mark(`addIndicators (${this.filesWithContext.size} files)`);
		PerfTimer.end('refreshFileExplorerIndicators');
	}

	// ============================================================================
	// Utility
	// ============================================================================

	async openInNewWindow(file: TFile) {
		const leaf = this.app.workspace.openPopoutLeaf();
		await leaf.openFile(file);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		PerfTimer.setEnabled(this.settings.enableDebugLogging);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		PerfTimer.setEnabled(this.settings.enableDebugLogging);
	}
}

// ============================================================================
// Settings Tab
// ============================================================================

class PerspectaSettingTab extends PluginSettingTab {
	plugin: PerspectaPlugin;

	constructor(app: App, plugin: PerspectaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Perspecta Settings' });

		containerEl.createEl('h3', { text: 'Context' });
		this.addHotkeyRecorder(containerEl, 'Save context hotkey', this.plugin.settings.saveArrangementHotkey,
			async (v) => { this.plugin.settings.saveArrangementHotkey = v; await this.plugin.saveSettings(); });
		this.addHotkeyRecorder(containerEl, 'Restore context hotkey', this.plugin.settings.restoreArrangementHotkey,
			async (v) => { this.plugin.settings.restoreArrangementHotkey = v; await this.plugin.saveSettings(); });

		new Setting(containerEl).setName('Focus tint duration').setDesc('Seconds (0 = disabled)')
			.addText(t => t.setValue(String(this.plugin.settings.focusTintDuration)).onChange(async v => {
				const n = parseFloat(v);
				if (!isNaN(n) && n >= 0) { this.plugin.settings.focusTintDuration = n; await this.plugin.saveSettings(); }
			}));

		containerEl.createEl('h3', { text: 'Debug' });
		new Setting(containerEl).setName('Show debug modal on save')
			.setDesc('Show a modal with context details when saving')
			.addToggle(t => t.setValue(this.plugin.settings.showDebugModal).onChange(async v => {
				this.plugin.settings.showDebugModal = v; await this.plugin.saveSettings();
			}));

		new Setting(containerEl).setName('Enable debug logging')
			.setDesc('Log performance timing to the developer console (Cmd+Shift+I)')
			.addToggle(t => t.setValue(this.plugin.settings.enableDebugLogging).onChange(async v => {
				this.plugin.settings.enableDebugLogging = v; await this.plugin.saveSettings();
			}));
	}

	private addHotkeyRecorder(containerEl: HTMLElement, name: string, value: string, onChange: (v: string) => Promise<void>) {
		const setting = new Setting(containerEl).setName(name);
		const display = setting.controlEl.createEl('div', { cls: 'perspecta-hotkey-recorder', text: value || 'Click to set' });
		let recording = false;

		display.addEventListener('click', () => {
			recording = !recording;
			display.toggleClass('is-recording', recording);
			display.setText(recording ? 'Press keys...' : value || 'Click to set');
		});

		display.addEventListener('keydown', async (e) => {
			if (!recording || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			const parts: string[] = [];
			if (e.ctrlKey) parts.push('Ctrl');
			if (e.altKey) parts.push('Alt');
			if (e.shiftKey) parts.push('Shift');
			if (e.metaKey) parts.push('Meta');
			parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
			const hotkey = parts.join('+');
			display.setText(hotkey);
			recording = false;
			display.removeClass('is-recording');
			await onChange(hotkey);
		});

		display.setAttribute('tabindex', '0');
	}
}
