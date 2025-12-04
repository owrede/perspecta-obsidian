import { App, Menu, MenuItem, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, WorkspaceLeaf, Notice, parseYaml, stringifyYaml } from 'obsidian';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface TabState {
	path: string;
	active: boolean;
	uid?: string;   // Unique ID from frontmatter (for move/rename resilience)
	name?: string;  // Filename without extension (fallback for search)
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

interface ScreenInfo {
	width: number;
	height: number;
	aspectRatio: number;
}

interface WindowArrangementV2 {
	v: 2;
	ts: number;
	main: WindowStateV2;
	popouts: WindowStateV2[];
	focusedWindow: number;
	leftSidebar?: SidebarState;
	rightSidebar?: SidebarState;
	sourceScreen?: ScreenInfo; // Screen dimensions where arrangement was saved
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

type StorageMode = 'frontmatter' | 'external';

interface PerspectaSettings {
	enableVisualMapping: boolean;
	enableAutomation: boolean;
	automationScriptsPath: string;
	showDebugModal: boolean;
	enableDebugLogging: boolean;
	focusTintDuration: number;
	autoGenerateUids: boolean;  // Auto-generate UIDs for files in saved contexts
	storageMode: StorageMode;   // Where to store context data
}

const DEFAULT_SETTINGS: PerspectaSettings = {
	enableVisualMapping: true,
	enableAutomation: true,
	automationScriptsPath: 'perspecta/scripts/',
	showDebugModal: true,
	enableDebugLogging: false,
	focusTintDuration: 8,
	autoGenerateUids: true,
	storageMode: 'frontmatter'
};

const FRONTMATTER_KEY = 'perspecta-arrangement';
const UID_FRONTMATTER_KEY = 'perspecta-uid';

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

// Global debug flag for coordinate conversions (set by plugin settings)
let COORDINATE_DEBUG = false;

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

	const result = {
		x: Math.round((physical.x - screen.x) * scaleX),
		y: Math.round((physical.y - screen.y) * scaleY),
		width: Math.round(physical.width * scaleX),
		height: Math.round(physical.height * scaleY)
	};

	if (COORDINATE_DEBUG) {
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
// sourceScreen: optional screen info from when arrangement was saved
function virtualToPhysical(
	virtual: { x: number; y: number; width: number; height: number },
	sourceScreen?: ScreenInfo
): { x: number; y: number; width: number; height: number } {
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

	const result = { x, y, width, height };

	if (COORDINATE_DEBUG) {
		console.log(`[Perspecta] virtualToPhysical:`, {
			virtual,
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
function getAspectRatioDifference(sourceScreen?: ScreenInfo): number {
	if (!sourceScreen) return 0;
	const targetScreen = getPhysicalScreen();
	const targetAspectRatio = targetScreen.width / targetScreen.height;
	return Math.abs(sourceScreen.aspectRatio - targetAspectRatio);
}

// Check if we need to tile windows due to significant aspect ratio difference
function needsTiling(sourceScreen?: ScreenInfo): boolean {
	// If no source screen info, assume we might need tiling for safety
	if (!sourceScreen) return false;

	const diff = getAspectRatioDifference(sourceScreen);
	// Threshold: if aspect ratios differ by more than 0.5, tile windows
	// e.g., UWHD (2.39) vs MacBook (1.54) = diff of 0.85 → needs tiling
	return diff > 0.5;
}

// Calculate tiled window positions for when aspect ratios differ significantly
// Returns an array of physical coordinates for each window (main + popouts)
function calculateTiledLayout(
	windowCount: number,
	mainWindowState: WindowStateV2
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

// Performance timing helper - controlled by settings.enableDebugLogging
class PerfTimer {
	private static enabled = false; // Controlled by plugin settings
	private static times: { label: string; elapsed: number; fromStart: number }[] = [];
	private static start: number = 0;
	private static lastMark: number = 0;
	private static currentOperation: string = '';

	static begin(operation: string) {
		if (!this.enabled) return;
		this.times = [];
		this.start = performance.now();
		this.lastMark = this.start;
		this.currentOperation = operation;
		console.log(`[Perspecta] ▶ ${operation} started at ${this.start.toFixed(0)}`);
	}

	static mark(label: string) {
		if (!this.enabled) return;
		const now = performance.now();
		const elapsed = now - this.lastMark;
		const fromStart = now - this.start;
		this.times.push({ label, elapsed, fromStart });
		this.lastMark = now;
		// Log every mark for detailed debugging
		const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
		console.log(`[Perspecta]   ${flag} ${label}: ${elapsed.toFixed(1)}ms (total: ${fromStart.toFixed(1)}ms)`);
	}

	static end(operation: string) {
		if (!this.enabled) return;
		const total = performance.now() - this.start;
		console.log(`[Perspecta] ◼ ${operation} completed in ${total.toFixed(1)}ms`);
		// Always show breakdown when debug is enabled
		if (this.times.length > 0) {
			console.log('[Perspecta] Full breakdown:');
			for (const t of this.times) {
				const flag = t.elapsed > 50 ? '⚠' : '✓';
				console.log(`  ${flag} ${t.label}: ${t.elapsed.toFixed(1)}ms (at ${t.fromStart.toFixed(1)}ms)`);
			}
		}
	}

	// For timing individual async operations
	static async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
		if (!this.enabled) return fn();
		const start = performance.now();
		try {
			return await fn();
		} finally {
			const elapsed = performance.now() - start;
			const fromStart = performance.now() - this.start;
			this.times.push({ label, elapsed, fromStart });
			const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
			console.log(`[Perspecta]   ${flag} ${label}: ${elapsed.toFixed(1)}ms (total: ${fromStart.toFixed(1)}ms)`);
		}
	}

	static setEnabled(enabled: boolean) {
		this.enabled = enabled;
	}

	static isEnabled(): boolean {
		return this.enabled;
	}
}

// ============================================================================
// UID Utilities
// ============================================================================

// Generate a UUID v4
function generateUid(): string {
	// Use crypto.randomUUID if available (modern browsers/Node)
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback for older environments
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

// Get UID from a file's frontmatter cache
function getUidFromCache(app: App, file: TFile): string | undefined {
	const cache = app.metadataCache.getFileCache(file);
	return cache?.frontmatter?.[UID_FRONTMATTER_KEY] as string | undefined;
}

// Add UID to a file's frontmatter (creates frontmatter if needed)
async function addUidToFile(app: App, file: TFile, uid: string): Promise<void> {
	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	let newContent: string;
	if (match) {
		// Has frontmatter - add uid if not present
		let fm = match[1];
		if (fm.includes(`${UID_FRONTMATTER_KEY}:`)) {
			// perspecta-uid already exists - just clean up old uid if present
			if (fm.match(/^uid:\s*["']?[^"'\n]+["']?\s*$/m)) {
				fm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
				newContent = content.replace(frontmatterRegex, `---\n${fm}\n---`);
				await app.vault.modify(file, newContent);
			}
			return;
		}
		// Remove old 'uid' property if present (migration from old format)
		fm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
		const newFm = `${UID_FRONTMATTER_KEY}: "${uid}"\n${fm}`;
		newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);
	} else {
		// No frontmatter - create it with uid
		newContent = `---\n${UID_FRONTMATTER_KEY}: "${uid}"\n---\n${content}`;
	}

	await app.vault.modify(file, newContent);
}

// Remove old 'uid' property from a file if it has perspecta-uid
async function cleanupOldUid(app: App, file: TFile): Promise<boolean> {
	const content = await app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return false;

	const fm = match[1];
	// Only clean up if file has perspecta-uid AND old uid
	if (!fm.includes(`${UID_FRONTMATTER_KEY}:`)) return false;
	if (!fm.match(/^uid:\s*["']?[^"'\n]+["']?\s*$/m)) return false;

	const newFm = fm.replace(/^uid:\s*["']?[^"'\n]+["']?\n?/gm, '').trim();
	const newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);

	if (newContent !== content) {
		await app.vault.modify(file, newContent);
		return true;
	}
	return false;
}

// ============================================================================
// Canvas file support
// Canvas files store perspecta data in a "perspecta" property within the JSON
// ============================================================================

interface CanvasData {
	nodes?: unknown[];
	edges?: unknown[];
	perspecta?: {
		uid?: string;
		context?: WindowArrangement;
	};
	[key: string]: unknown;
}

// ============================================================================
// Base file support
// Base files are YAML and store perspecta data as base64-encoded JSON (like markdown)
// ============================================================================

interface BaseData {
	views?: unknown[];
	perspecta?: {
		uid?: string;
		context?: string;  // base64-encoded JSON blob (same format as markdown frontmatter)
	};
	[key: string]: unknown;
}

// Get UID from a canvas file's JSON
async function getUidFromCanvas(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension !== 'canvas') return undefined;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return data.perspecta?.uid;
	} catch {
		return undefined;
	}
}

// Get context from a canvas file's JSON
async function getContextFromCanvas(app: App, file: TFile): Promise<WindowArrangement | null> {
	if (file.extension !== 'canvas') return null;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return data.perspecta?.context ?? null;
	} catch {
		return null;
	}
}

// Save UID to a canvas file's JSON
async function addUidToCanvas(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension !== 'canvas') return;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.uid = uid;

		await app.vault.modify(file, JSON.stringify(data, null, '\t'));
	} catch (e) {
		console.error('[Perspecta] Failed to add UID to canvas:', e);
	}
}

// Save context to a canvas file's JSON
async function saveContextToCanvas(app: App, file: TFile, context: WindowArrangement): Promise<void> {
	if (file.extension !== 'canvas') return;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.context = context;

		await app.vault.modify(file, JSON.stringify(data, null, '\t'));
	} catch (e) {
		console.error('[Perspecta] Failed to save context to canvas:', e);
		throw e;
	}
}

// Check if a canvas file has a context stored
async function canvasHasContext(app: App, file: TFile): Promise<boolean> {
	if (file.extension !== 'canvas') return false;
	try {
		const content = await app.vault.read(file);
		const data = JSON.parse(content) as CanvasData;
		return !!data.perspecta?.context;
	} catch {
		return false;
	}
}

// ============================================================================
// Base file functions (.base files are YAML)
// ============================================================================

// Get UID from a base file's YAML
async function getUidFromBase(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension !== 'base') return undefined;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		return data?.perspecta?.uid;
	} catch {
		return undefined;
	}
}

// Get context from a base file's YAML (stored as base64-encoded JSON)
async function getContextFromBase(app: App, file: TFile): Promise<WindowArrangement | null> {
	if (file.extension !== 'base') return null;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		const encoded = data?.perspecta?.context;
		if (!encoded) return null;

		// Decode from base64
		const json = decodeURIComponent(escape(atob(encoded)));
		return JSON.parse(json) as WindowArrangement;
	} catch {
		return null;
	}
}

// Save UID to a base file's YAML
async function addUidToBase(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension !== 'base') return;
	try {
		const content = await app.vault.read(file);
		const data = (content.trim() ? parseYaml(content) : {}) as BaseData;

		if (!data.perspecta) {
			data.perspecta = {};
		}
		data.perspecta.uid = uid;

		await app.vault.modify(file, stringifyYaml(data));
	} catch (e) {
		console.error('[Perspecta] Failed to add UID to base file:', e);
	}
}

// Save context to a base file's YAML (stored as base64-encoded JSON)
async function saveContextToBase(app: App, file: TFile, context: WindowArrangement): Promise<void> {
	if (file.extension !== 'base') return;
	try {
		const content = await app.vault.read(file);
		const data = (content.trim() ? parseYaml(content) : {}) as BaseData;

		if (!data.perspecta) {
			data.perspecta = {};
		}

		// Encode as base64 JSON blob (same format as markdown frontmatter)
		const json = JSON.stringify(context);
		const base64 = btoa(unescape(encodeURIComponent(json)));
		data.perspecta.context = base64;

		await app.vault.modify(file, stringifyYaml(data));
	} catch (e) {
		console.error('[Perspecta] Failed to save context to base file:', e);
		throw e;
	}
}

// Check if a base file has a context stored
async function baseHasContext(app: App, file: TFile): Promise<boolean> {
	if (file.extension !== 'base') return false;
	try {
		const content = await app.vault.read(file);
		const data = parseYaml(content) as BaseData;
		return !!data?.perspecta?.context;
	} catch {
		return false;
	}
}

// ============================================================================
// Unified file helpers (works for markdown, canvas, and base files)
// ============================================================================

// Get UID from file (works for markdown, canvas, and base)
async function getUidFromFile(app: App, file: TFile): Promise<string | undefined> {
	if (file.extension === 'canvas') {
		return getUidFromCanvas(app, file);
	}
	if (file.extension === 'base') {
		return getUidFromBase(app, file);
	}
	return getUidFromCache(app, file);
}

// Add UID to file (works for markdown, canvas, and base)
async function addUidToAnyFile(app: App, file: TFile, uid: string): Promise<void> {
	if (file.extension === 'canvas') {
		await addUidToCanvas(app, file, uid);
	} else if (file.extension === 'base') {
		await addUidToBase(app, file, uid);
	} else {
		await addUidToFile(app, file, uid);
	}
}

// ============================================================================

// Resolve a file using fallback strategy: path → UID → filename
// Returns the file and the resolution method used
function resolveFile(app: App, tab: TabState): { file: TFile | null; method: 'path' | 'uid' | 'name' | 'not_found' } {
	// 1. Try path first (fastest, most common case)
	const fileByPath = app.vault.getAbstractFileByPath(tab.path);
	if (fileByPath instanceof TFile) {
		return { file: fileByPath, method: 'path' };
	}

	// 2. Try UID lookup (file was moved/renamed)
	if (tab.uid) {
		const files = app.vault.getMarkdownFiles();
		for (const file of files) {
			const fileUid = getUidFromCache(app, file);
			if (fileUid === tab.uid) {
				return { file, method: 'uid' };
			}
		}
	}

	// 3. Try filename search (last resort, may have conflicts)
	if (tab.name) {
		const files = app.vault.getMarkdownFiles();
		const matches = files.filter(f => f.basename === tab.name);
		if (matches.length === 1) {
			// Unique match by name
			return { file: matches[0], method: 'name' };
		}
		// If multiple matches, we could try to find the best one
		// For now, skip ambiguous matches
	}

	return { file: null, method: 'not_found' };
}

// ============================================================================
// External Context Storage Manager
// ============================================================================

const CONTEXTS_FOLDER = 'contexts';

class ExternalContextStore {
	private plugin: PerspectaPlugin;
	private cache: Map<string, WindowArrangementV2> = new Map();
	private dirty: Set<string> = new Set();  // UIDs that need saving
	private saveTimeout: ReturnType<typeof setTimeout> | null = null;
	private initialized = false;

	constructor(plugin: PerspectaPlugin) {
		this.plugin = plugin;
	}

	// Get the contexts folder path
	private getContextsPath(): string {
		const adapter = this.plugin.app.vault.adapter;
		const pluginDir = this.plugin.manifest.dir;
		return `${pluginDir}/${CONTEXTS_FOLDER}`;
	}

	// Initialize: load all contexts into memory
	async initialize(): Promise<void> {
		if (this.initialized) return;

		const adapter = this.plugin.app.vault.adapter;
		const contextsPath = this.getContextsPath();

		try {
			// Ensure contexts folder exists
			if (!await adapter.exists(contextsPath)) {
				await adapter.mkdir(contextsPath);
			}

			// Load all context files
			const files = await adapter.list(contextsPath);
			for (const file of files.files) {
				if (file.endsWith('.json')) {
					try {
						const content = await adapter.read(file);
						const data = JSON.parse(content);
						const uid = file.split('/').pop()?.replace('.json', '');
						if (uid && data) {
							this.cache.set(uid, data as WindowArrangementV2);
						}
					} catch (e) {
						console.warn(`[Perspecta] Failed to load context file: ${file}`, e);
					}
				}
			}

			this.initialized = true;
			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta] External store initialized with ${this.cache.size} contexts`);
			}
		} catch (e) {
			console.error('[Perspecta] Failed to initialize external store:', e);
		}
	}

	// Get context by UID (instant from cache)
	get(uid: string): WindowArrangementV2 | null {
		return this.cache.get(uid) || null;
	}

	// Check if context exists
	has(uid: string): boolean {
		return this.cache.has(uid);
	}

	// Save context (updates cache immediately, debounces disk write)
	set(uid: string, context: WindowArrangementV2): void {
		this.cache.set(uid, context);
		this.dirty.add(uid);
		this.scheduleSave();
	}

	// Delete context
	async delete(uid: string): Promise<void> {
		this.cache.delete(uid);
		this.dirty.delete(uid);

		const adapter = this.plugin.app.vault.adapter;
		const filePath = `${this.getContextsPath()}/${uid}.json`;
		try {
			if (await adapter.exists(filePath)) {
				await adapter.remove(filePath);
			}
		} catch (e) {
			console.warn(`[Perspecta] Failed to delete context file: ${filePath}`, e);
		}
	}

	// Get all UIDs that have contexts
	getAllUids(): string[] {
		return Array.from(this.cache.keys());
	}

	// Schedule debounced save (2 second delay)
	private scheduleSave(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = setTimeout(() => this.flushDirty(), 2000);
	}

	// Force immediate save of all dirty contexts
	async flushDirty(): Promise<void> {
		if (this.dirty.size === 0) return;

		const adapter = this.plugin.app.vault.adapter;
		const contextsPath = this.getContextsPath();

		// Ensure folder exists
		if (!await adapter.exists(contextsPath)) {
			await adapter.mkdir(contextsPath);
		}

		const toSave = Array.from(this.dirty);
		this.dirty.clear();

		for (const uid of toSave) {
			const context = this.cache.get(uid);
			if (context) {
				const filePath = `${contextsPath}/${uid}.json`;
				try {
					const json = JSON.stringify(context);
					await adapter.write(filePath, json);
				} catch (e) {
					console.error(`[Perspecta] Failed to save context: ${uid}`, e);
					this.dirty.add(uid);  // Re-add to retry later
				}
			}
		}

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Saved ${toSave.length} context(s) to disk`);
		}
	}

	// Cleanup on plugin unload
	async cleanup(): Promise<void> {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		await this.flushDirty();
	}
}

// ============================================================================
// Main Plugin Class
// ============================================================================

export default class PerspectaPlugin extends Plugin {
	settings: PerspectaSettings;
	private focusedWindowIndex: number = -1;
	private windowFocusListeners: Map<Window, () => void> = new Map();
	private filesWithContext = new Set<string>();
	private refreshIndicatorsTimeout: ReturnType<typeof setTimeout> | null = null;
	private isClosingWindow = false; // Guard against operations during window close
	externalStore: ExternalContextStore;  // External context storage

	async onload() {
		await this.loadSettings();

		// Initialize external store
		this.externalStore = new ExternalContextStore(this);
		if (this.settings.storageMode === 'external') {
			await this.externalStore.initialize();
		}

		this.addRibbonIcon('layout-grid', 'Perspecta', () => {});

		this.addCommand({
			id: 'save-context',
			name: 'Save context',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 's' }],
			callback: () => this.saveContext()
		});

		this.addCommand({
			id: 'restore-context',
			name: 'Restore context',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'r' }],
			callback: () => this.restoreContext()
		});

		this.addCommand({
			id: 'show-context-details',
			name: 'Show context details',
			callback: () => this.showContextDetails()
		});
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

	async onunload() {
		// Cleanup external store (flush pending saves)
		await this.externalStore.cleanup();

		this.windowFocusListeners.forEach((listener, win) => {
			win.removeEventListener('focus', listener);
		});
		this.windowFocusListeners.clear();
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

		// Capture source screen info for cross-screen restoration
		const screen = getPhysicalScreen();
		const sourceScreen: ScreenInfo = {
			width: screen.width,
			height: screen.height,
			aspectRatio: screen.width / screen.height
		};

		return {
			v: 2,
			ts: Date.now(),
			main,
			popouts,
			focusedWindow: this.focusedWindowIndex,
			leftSidebar,
			rightSidebar,
			sourceScreen
		};
	}

	private captureWindowState(rootSplit: any, win: Window): WindowStateV2 {
		const physical = {
			x: win.screenX,
			y: win.screenY,
			width: win.outerWidth,
			height: win.outerHeight
		};

		// Convert physical coordinates to virtual coordinate system
		const virtual = physicalToVirtual(physical);

		console.log(`[Perspecta] captureWindowState:`, { physical, virtual });

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

			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] capturePopoutStates container:`, {
					containerType: container?.constructor?.name,
					containerDirection: container?.direction,
					containerChildren: container?.children?.length,
					firstChildType: container?.children?.[0]?.constructor?.name,
					firstChildDirection: container?.children?.[0]?.direction
				});
			}

			// The container itself may be a split (when popout has multiple panes)
			// or it may contain a single tab group. We capture from the container level.
			if (container?.children?.length > 0) {
				// Convert physical coordinates to virtual coordinate system
				const virtual = physicalToVirtual({
					x: win.screenX,
					y: win.screenY,
					width: win.outerWidth,
					height: win.outerHeight
				});

				// Capture from the container - it handles both splits and single tab groups
				states.push({
					root: this.captureSplitOrTabs(container),
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

			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] captureSplitOrTabs: direction=${node.direction}, children=${children.length}`);
			}

			return { type: 'split', direction: node.direction, children };
		}
		return this.captureTabGroup(node);
	}

	private captureTabGroup(tabContainer: any): TabGroupState {
		const tabs: TabState[] = [];
		const children = tabContainer?.children || [];

		// Get the active leaf within THIS tab container (not the global active leaf)
		// tabContainer.currentTab is the index of the active tab in this group
		const currentTabIndex = tabContainer?.currentTab ?? 0;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] captureTabGroup: ${children.length} children, currentTab=${tabContainer?.currentTab}, using index=${currentTabIndex}`);
		}

		for (let i = 0; i < children.length; i++) {
			const leaf = children[i];
			const file = (leaf?.view as any)?.file as TFile | undefined;
			if (file) {
				// Get UID from frontmatter cache (if exists)
				const uid = getUidFromCache(this.app, file);
				// Get filename without extension for fallback search
				const name = file.basename;

				const isActive = i === currentTabIndex;
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   tab[${i}]: ${file.basename}, active=${isActive}`);
				}

				tabs.push({
					path: file.path,
					active: isActive,
					uid,
					name
				});
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

		// Check for supported file types
		const isMarkdown = targetFile.extension === 'md';
		const isCanvas = targetFile.extension === 'canvas';
		const isBase = targetFile.extension === 'base';

		if (!isMarkdown && !isCanvas && !isBase) {
			new Notice(`Cannot save context to ${targetFile.extension} files. Please use a markdown, canvas, or base file.`);
			PerfTimer.end('saveContext');
			return;
		}

		let context = this.captureWindowArrangement();
		PerfTimer.mark('captureWindowArrangement');

		// Auto-generate UIDs for files that don't have them (always needed for external storage)
		if (this.settings.autoGenerateUids || this.settings.storageMode === 'external') {
			context = await this.ensureUidsForContext(context);
			PerfTimer.mark('ensureUidsForContext');
		}

		// Save based on file type and storage mode
		if (isCanvas) {
			// Canvas files always store context in the JSON
			await saveContextToCanvas(this.app, targetFile, context);
			this.filesWithContext.add(targetFile.path);
			this.debouncedRefreshIndicators();
			PerfTimer.mark('saveContextToCanvas');
		} else if (isBase) {
			// Base files always store context in the YAML
			await saveContextToBase(this.app, targetFile, context);
			this.filesWithContext.add(targetFile.path);
			this.debouncedRefreshIndicators();
			PerfTimer.mark('saveContextToBase');
		} else if (this.settings.storageMode === 'external') {
			await this.saveContextExternal(targetFile, context);
			PerfTimer.mark('saveContextExternal');
		} else {
			await this.saveArrangementToNote(targetFile, context);
			PerfTimer.mark('saveArrangementToNote');
		}

		if (this.settings.showDebugModal) {
			this.showContextDebugModal(context, targetFile.name);
			PerfTimer.mark('showContextDebugModal');
		} else {
			new Notice(`Context saved to ${targetFile.name}`);
		}

		PerfTimer.end('saveContext');
	}

	// Save context to external store (using file's UID as key)
	private async saveContextExternal(file: TFile, context: WindowArrangementV2): Promise<void> {
		// Get the file's UID (must exist since we ensured UIDs above)
		let uid = getUidFromCache(this.app, file);
		if (!uid) {
			// Fallback: add UID now if somehow missing
			uid = generateUid();
			await addUidToFile(this.app, file, uid);
			// Wait for cache update
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		// Initialize external store if not already
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		this.externalStore.set(uid, context);

		// Remove perspecta-arrangement from frontmatter (if present) to avoid duplication
		await this.removeArrangementFromFrontmatter(file);

		this.filesWithContext.add(file.path);
		this.debouncedRefreshIndicators();
	}

	// Remove perspecta-arrangement property from a file's frontmatter
	private async removeArrangementFromFrontmatter(file: TFile): Promise<boolean> {
		const content = await this.app.vault.read(file);
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);

		if (!match) return false;

		const fm = match[1];
		// Check if arrangement exists in frontmatter
		if (!fm.includes(`${FRONTMATTER_KEY}:`)) return false;

		// Remove arrangement (both old multi-line YAML and new single-line format)
		let newFm = fm
			.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')  // Old multi-line
			.replace(/perspecta-arrangement: ".*"\n?/g, '')  // New single-line
			.trim();

		// If frontmatter is empty now (except whitespace), we could remove it entirely
		// but better to keep it if there's other content
		const newContent = content.replace(frontmatterRegex, `---\n${newFm}\n---`);

		if (newContent !== content) {
			await this.app.vault.modify(file, newContent);
			return true;
		}
		return false;
	}

	// ============================================================================
	// Storage Migration & Cleanup
	// ============================================================================

	// Clean up old 'uid' properties from all files that have perspecta-uid
	async cleanupOldUidProperties(): Promise<number> {
		const files = this.app.vault.getMarkdownFiles();
		let cleaned = 0;

		for (const file of files) {
			try {
				if (await cleanupOldUid(this.app, file)) {
					cleaned++;
				}
			} catch (e) {
				console.warn(`[Perspecta] Failed to cleanup ${file.path}:`, e);
			}
		}

		return cleaned;
	}

	// Migrate all contexts from frontmatter to external storage
	async migrateToExternalStorage(): Promise<{ migrated: number; errors: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let migrated = 0;
		let errors = 0;

		// Initialize external store
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		for (const file of files) {
			try {
				// Check if file has context in frontmatter
				const context = this.getContextFromNote(file);
				if (!context) continue;

				// Ensure file has a UID
				let uid = getUidFromCache(this.app, file);
				if (!uid) {
					uid = generateUid();
					await addUidToFile(this.app, file, uid);
					await new Promise(resolve => setTimeout(resolve, 50)); // Brief pause for cache
				}

				// Save to external store
				const v2 = this.normalizeToV2(context);
				this.externalStore.set(uid, v2);

				// Remove from frontmatter
				await this.removeArrangementFromFrontmatter(file);

				migrated++;
			} catch (e) {
				console.error(`[Perspecta] Failed to migrate ${file.path}:`, e);
				errors++;
			}
		}

		// Flush to disk
		await this.externalStore.flushDirty();

		// Update settings
		this.settings.storageMode = 'external';
		await this.saveSettings();

		// Refresh indicators
		this.filesWithContext.clear();
		await this.setupFileExplorerIndicators();

		return { migrated, errors };
	}

	// Migrate all contexts from external storage to frontmatter
	async migrateToFrontmatter(): Promise<{ migrated: number; errors: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let migrated = 0;
		let errors = 0;

		// Initialize external store to load all contexts
		if (!this.externalStore['initialized']) {
			await this.externalStore.initialize();
		}

		for (const file of files) {
			try {
				// Check if file has a UID with stored context
				const uid = getUidFromCache(this.app, file);
				if (!uid) continue;

				const context = this.externalStore.get(uid);
				if (!context) continue;

				// Save to frontmatter
				await this.saveArrangementToNote(file, context);

				// Delete from external store
				await this.externalStore.delete(uid);

				migrated++;
			} catch (e) {
				console.error(`[Perspecta] Failed to migrate ${file.path}:`, e);
				errors++;
			}
		}

		// Update settings
		this.settings.storageMode = 'frontmatter';
		await this.saveSettings();

		// Refresh indicators
		this.filesWithContext.clear();
		await this.setupFileExplorerIndicators();

		return { migrated, errors };
	}

	// Generate UIDs for any files in the context that don't have them
	private async ensureUidsForContext(context: WindowArrangementV2): Promise<WindowArrangementV2> {
		const filesToUpdate: { file: TFile; uid: string }[] = [];

		// Collect files needing UIDs from main window
		this.collectFilesNeedingUids(context.main.root, filesToUpdate);

		// Collect files needing UIDs from popouts
		for (const popout of context.popouts) {
			this.collectFilesNeedingUids(popout.root, filesToUpdate);
		}

		// Write UIDs to files
		for (const { file, uid } of filesToUpdate) {
			try {
				await addUidToFile(this.app, file, uid);
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta] Added UID to ${file.path}: ${uid}`);
				}
			} catch (e) {
				console.warn(`[Perspecta] Failed to add UID to ${file.path}:`, e);
			}
		}

		// Wait for metadata cache to update (if we added any UIDs)
		if (filesToUpdate.length > 0) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		// Re-capture to get the new UIDs
		if (filesToUpdate.length > 0) {
			return this.captureWindowArrangement();
		}

		return context;
	}

	// Helper to collect files that need UIDs from a workspace node
	private collectFilesNeedingUids(node: WorkspaceNodeState, result: { file: TFile; uid: string }[]): void {
		if (node.type === 'tabs') {
			for (const tab of node.tabs) {
				if (!tab.uid) {
					const file = this.app.vault.getAbstractFileByPath(tab.path);
					if (file instanceof TFile && file.extension === 'md') {
						// Check cache again in case we already collected this file
						const existingUid = getUidFromCache(this.app, file);
						if (!existingUid) {
							result.push({ file, uid: generateUid() });
						}
					}
				}
			}
		} else if (node.type === 'split') {
			for (const child of node.children) {
				this.collectFilesNeedingUids(child, result);
			}
		}
	}

	private async saveArrangementToNote(file: TFile, arrangement: WindowArrangementV2) {
		const readStart = performance.now();
		const content = await this.app.vault.read(file);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ vault.read: ${(performance.now() - readStart).toFixed(1)}ms`);
		}

		const fmStart = performance.now();
		const newContent = this.updateFrontmatter(content, arrangement);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ updateFrontmatter: ${(performance.now() - fmStart).toFixed(1)}ms`);
		}

		const writeStart = performance.now();
		await this.app.vault.modify(file, newContent);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   ✓ vault.modify: ${(performance.now() - writeStart).toFixed(1)}ms`);
		}
	}

	private updateFrontmatter(content: string, arrangement: WindowArrangementV2): string {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		const encoded = this.encodeArrangement(arrangement);

		if (match) {
			// Remove old arrangement (both old multi-line YAML and new single-line format)
			let fm = match[1]
				.replace(/perspecta-arrangement:[\s\S]*?(?=\n[^\s]|\n$|$)/g, '')  // Old multi-line
				.replace(/perspecta-arrangement: ".*"/g, '')  // New single-line
				.trim();
			fm = fm ? fm + '\n' + encoded : encoded;
			return content.replace(frontmatterRegex, `---\n${fm}\n---`);
		}
		return `---\n${encoded}\n---\n${content}`;
	}

	// Encode arrangement as compact base64 JSON blob
	private encodeArrangement(arr: WindowArrangementV2): string {
		// Create minimal JSON structure - omit defaults and use short keys
		const compact = this.createCompactArrangement(arr);
		const json = JSON.stringify(compact);
		const base64 = btoa(unescape(encodeURIComponent(json)));
		return `${FRONTMATTER_KEY}: "${base64}"`;
	}

	// Create compact arrangement with minimal data
	private createCompactArrangement(arr: WindowArrangementV2): any {
		const compact: any = {
			v: arr.v,
			ts: arr.ts,
			f: arr.focusedWindow,  // short key: focusedWindow
			m: this.compactWindow(arr.main)  // short key: main
		};

		if (arr.popouts.length > 0) {
			compact.p = arr.popouts.map(p => this.compactWindow(p));  // short key: popouts
		}

		if (arr.leftSidebar) {
			compact.ls = { c: arr.leftSidebar.collapsed };  // short keys
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

		return compact;
	}

	private compactWindow(win: WindowStateV2): any {
		const compact: any = {
			r: this.compactNode(win.root)  // short key: root
		};

		// Store geometry as array [x, y, w, h] if present
		if (win.x !== undefined && win.y !== undefined && win.width !== undefined && win.height !== undefined) {
			compact.g = [win.x, win.y, win.width, win.height];  // short key: geometry
		}

		return compact;
	}

	private compactNode(node: WorkspaceNodeState): any {
		if (node.type === 'tabs') {
			// Compact tab format: array of [path, uid?, active?]
			// Only include uid if present, only include active marker for active tab
			return node.tabs.map(tab => {
				const arr: any[] = [tab.path];
				if (tab.uid) arr.push(tab.uid);
				else if (tab.active) arr.push(null);  // placeholder for uid
				if (tab.active) arr.push(1);  // 1 = active
				return arr.length === 1 ? tab.path : arr;  // Just path string if no extras
			});
		} else {
			// Split format: { d: direction, c: children }
			return {
				d: node.direction === 'horizontal' ? 'h' : 'v',
				c: node.children.map(child => this.compactNode(child))
			};
		}
	}

	// Decode base64 JSON blob back to WindowArrangementV2
	private decodeArrangement(encoded: string): WindowArrangementV2 | null {
		try {
			const json = decodeURIComponent(escape(atob(encoded)));
			const compact = JSON.parse(json);
			return this.expandCompactArrangement(compact);
		} catch (e) {
			console.error('[Perspecta] Failed to decode arrangement:', e);
			return null;
		}
	}

	private expandCompactArrangement(compact: any): WindowArrangementV2 {
		const arr: WindowArrangementV2 = {
			v: compact.v || 2,
			ts: compact.ts || Date.now(),
			focusedWindow: compact.f ?? -1,
			main: this.expandWindow(compact.m),
			popouts: (compact.p || []).map((p: any) => this.expandWindow(p))
		};

		if (compact.ls) {
			arr.leftSidebar = { collapsed: compact.ls.c, activeTab: compact.ls.t };
		}

		if (compact.rs) {
			arr.rightSidebar = { collapsed: compact.rs.c, activeTab: compact.rs.t };
		}

		if (compact.ar) {
			// Reconstruct screen info from aspect ratio (we don't need exact dimensions)
			arr.sourceScreen = {
				width: Math.round(1117 * compact.ar),  // Use reference height
				height: 1117,
				aspectRatio: compact.ar
			};
		}

		return arr;
	}

	private expandWindow(compact: any): WindowStateV2 {
		const win: WindowStateV2 = {
			root: this.expandNode(compact.r)
		};

		if (compact.g) {
			win.x = compact.g[0];
			win.y = compact.g[1];
			win.width = compact.g[2];
			win.height = compact.g[3];
		}

		return win;
	}

	private expandNode(compact: any): WorkspaceNodeState {
		// Array = tabs, Object with d/c = split
		if (Array.isArray(compact)) {
			const tabs: TabState[] = compact.map(item => {
				if (typeof item === 'string') {
					// Just path
					return { path: item, active: false, name: item.split('/').pop()?.replace(/\.md$/, '') };
				} else {
					// Array: [path, uid?, active?]
					const path = item[0];
					const uid = item[1] || undefined;
					const active = item[2] === 1;
					return { path, uid, active, name: path.split('/').pop()?.replace(/\.md$/, '') };
				}
			});
			return { type: 'tabs', tabs };
		} else {
			return {
				type: 'split',
				direction: compact.d === 'h' ? 'horizontal' : 'vertical',
				children: compact.c.map((child: any) => this.expandNode(child))
			};
		}
	}

	// ============================================================================
	// Context Restore (Optimized)
	// ============================================================================

	// Track path corrections during restore (populated by restoreTabGroup and helpers)
	private pathCorrections: Map<string, { newPath: string; newName: string }> = new Map();

	async restoreContext(file?: TFile) {
		const fullStart = performance.now();
		PerfTimer.begin('restoreContext');

		// Reset path corrections tracking
		this.pathCorrections.clear();

		const targetFile = file ?? this.app.workspace.getActiveFile();
		PerfTimer.mark('getActiveFile');

		if (!targetFile) { new Notice('No active file'); return; }

		const context = await this.getContextForFile(targetFile);
		PerfTimer.mark('getContextForFile');

		if (!context) { new Notice('No context found in this note'); return; }

		const focusedWin = await this.applyArrangement(context, targetFile.path);
		PerfTimer.mark('applyArrangement');

		// If any files were resolved via fallback, update the saved context with corrected paths
		if (this.pathCorrections.size > 0) {
			await this.updateContextWithCorrectedPaths(targetFile, context);
			PerfTimer.mark('updateContextWithCorrectedPaths');
			const count = this.pathCorrections.size;
			new Notice(`Context restored (${count} file path${count > 1 ? 's' : ''} updated)`);
		} else {
			this.showNoticeInWindow(focusedWin, 'Context restored');
		}
		PerfTimer.end('restoreContext');

		// Measure time until next idle - this captures rendering/painting time
		if (PerfTimer.isEnabled()) {
			requestIdleCallback(() => {
				const totalTime = performance.now() - fullStart;
				console.log(`[Perspecta] 🏁 Full restore (including render): ${totalTime.toFixed(0)}ms`);
			}, { timeout: 5000 });
		}
	}

	// Get context for file - handles markdown, canvas, base, and external storage
	private async getContextForFile(file: TFile): Promise<WindowArrangement | null> {
		// Canvas files store context directly in their JSON
		if (file.extension === 'canvas') {
			return getContextFromCanvas(this.app, file);
		}

		// Base files store context directly in their YAML
		if (file.extension === 'base') {
			return getContextFromBase(this.app, file);
		}

		// For markdown files, check external storage first (if enabled)
		if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, file);
			if (uid) {
				// Initialize store if needed
				if (!this.externalStore['initialized']) {
					await this.externalStore.initialize();
				}
				const context = this.externalStore.get(uid);
				if (context) return context;
			}
		}

		// Fall back to frontmatter (for backward compatibility or frontmatter mode)
		return this.getContextFromNote(file);
	}

	private getContextFromNote(file: TFile): WindowArrangement | null {
		const cache = this.app.metadataCache.getFileCache(file);
		const rawValue = cache?.frontmatter?.[FRONTMATTER_KEY];

		if (!rawValue) return null;

		// Check if it's the new base64 format (string) or old YAML format (object)
		if (typeof rawValue === 'string') {
			// New compact format - decode from base64
			return this.decodeArrangement(rawValue);
		} else {
			// Old YAML format - return as-is (backward compatibility)
			return rawValue as WindowArrangement;
		}
	}

	// Update saved context with corrected file paths after fallback resolution
	private async updateContextWithCorrectedPaths(contextFile: TFile, originalContext: WindowArrangement): Promise<void> {
		if (this.pathCorrections.size === 0) return;

		// Re-capture the current arrangement (which now has correct paths)
		const correctedContext = this.captureWindowArrangement();

		// Preserve original metadata
		correctedContext.ts = originalContext.ts;
		correctedContext.focusedWindow = originalContext.focusedWindow;

		// Preserve source screen info if it existed
		const v2Original = this.normalizeToV2(originalContext);
		if (v2Original.sourceScreen) {
			correctedContext.sourceScreen = v2Original.sourceScreen;
		}

		// Save the corrected context based on file type and storage mode
		if (contextFile.extension === 'canvas') {
			// Canvas files store context in their JSON
			await saveContextToCanvas(this.app, contextFile, correctedContext);
		} else if (contextFile.extension === 'base') {
			// Base files store context in their YAML
			await saveContextToBase(this.app, contextFile, correctedContext);
		} else if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, contextFile);
			if (uid) {
				this.externalStore.set(uid, correctedContext);
			}
		} else {
			await this.saveArrangementToNote(contextFile, correctedContext);
		}

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Updated context with ${this.pathCorrections.size} corrected paths:`);
			this.pathCorrections.forEach((correction, oldPath) => {
				console.log(`  ${oldPath} → ${correction.newPath}`);
			});
		}
	}

	private async applyArrangement(arrangement: WindowArrangement, contextNotePath?: string): Promise<Window | null> {
		try {
			PerfTimer.mark('applyArrangement:start');

			const v2 = this.normalizeToV2(arrangement);
			PerfTimer.mark('normalizeToV2');

			// Check if we need to tile windows due to aspect ratio mismatch
			const useTiling = needsTiling(v2.sourceScreen);
			let tiledPositions: { x: number; y: number; width: number; height: number }[] = [];

			if (useTiling) {
				const windowCount = 1 + v2.popouts.length;
				tiledPositions = calculateTiledLayout(windowCount, v2.main);
				if (COORDINATE_DEBUG) {
					console.log(`[Perspecta] Using tiled layout due to aspect ratio mismatch:`, {
						sourceAspect: v2.sourceScreen?.aspectRatio?.toFixed(2),
						targetAspect: (getPhysicalScreen().width / getPhysicalScreen().height).toFixed(2),
						windowCount,
						tiledPositions
					});
				}
				new Notice(`Screen shape changed - tiling ${windowCount} windows`);
			}
			PerfTimer.mark('checkTilingNeeded');

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

			// Restore geometry - use tiled position if aspect ratios differ
			if (useTiling && tiledPositions.length > 0) {
				this.restoreWindowGeometryDirect(window, tiledPositions[0]);
			} else {
				this.restoreWindowGeometry(window, v2.main, v2.sourceScreen);
			}
			PerfTimer.mark('restoreWindowGeometry');

			// Restore main workspace
			const workspace = this.app.workspace as any;
			await this.restoreWorkspaceNode(workspace.rootSplit, v2.main.root, mainLeaves[0]);
			PerfTimer.mark('restoreMainWorkspace');

			// Restore popouts
			for (let i = 0; i < v2.popouts.length; i++) {
				const tiledPosition = useTiling && tiledPositions.length > i + 1 ? tiledPositions[i + 1] : undefined;
				await this.restorePopoutWindow(v2.popouts[i], v2.sourceScreen, tiledPosition);
				PerfTimer.mark(`restorePopout[${i}]`);
			}

			// Process pending tab activations after a delay to ensure windows are fully ready
			// Use requestAnimationFrame + setTimeout to wait for both rendering and event loop
			if (this.pendingTabActivations.length > 0) {
				requestAnimationFrame(() => {
					setTimeout(() => {
						this.processPendingTabActivations();
					}, 100);
				});
			}

			// Restore sidebars
			if (v2.leftSidebar) this.restoreSidebarState('left', v2.leftSidebar);
			if (v2.rightSidebar) this.restoreSidebarState('right', v2.rightSidebar);
			PerfTimer.mark('restoreSidebars');

			// Find and focus the window containing the context note (the note used to restore)
			// This ensures the context note is active and its window is in foreground
			let contextNoteWin: Window | null = null;
			if (contextNotePath) {
				contextNoteWin = this.findWindowContainingFile(contextNotePath);
			}

			// Fall back to the originally focused window if context note window not found
			const focusedWin = contextNoteWin ?? this.getFocusedWindow(v2);

			if (focusedWin) {
				// Activate the leaf containing the context note (or the originally active leaf)
				if (contextNotePath && contextNoteWin) {
					this.activateLeafByPath(contextNoteWin, contextNotePath);
				} else {
					this.activateWindowLeaf(focusedWin, v2);
				}
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

		// Find the active tab index
		let activeTabIdx = state.tabs.findIndex(t => t.active);
		if (activeTabIdx < 0) activeTabIdx = 0;

		// Reorder tabs: open inactive tabs first, active tab LAST
		// This makes Obsidian naturally select the last-opened tab as active
		const reorderedTabs: { tab: TabState; originalIndex: number }[] = [];
		for (let i = 0; i < state.tabs.length; i++) {
			reorderedTabs.push({ tab: state.tabs[i], originalIndex: i });
		}
		// Sort: inactive first, active last
		reorderedTabs.sort((a, b) => {
			if (a.tab.active && !b.tab.active) return 1;
			if (!a.tab.active && b.tab.active) return -1;
			return a.originalIndex - b.originalIndex;
		});

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restoreTabGroup: ${state.tabs.length} tabs, active at index ${activeTabIdx}`);
			console.log(`[Perspecta]   Opening order: ${reorderedTabs.map(r => r.tab.name || r.tab.path).join(' → ')}`);
		}

		let firstLeaf: WorkspaceLeaf | undefined;
		let container: any = null;
		let isFirstTabOpened = false;

		for (let i = 0; i < reorderedTabs.length; i++) {
			const { tab, originalIndex } = reorderedTabs[i];
			const tabStart = performance.now();

			// Use fallback resolution: path → UID → filename
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ✗ File not found: ${tab.path} (tried path, uid: ${tab.uid || 'none'}, name: ${tab.name || 'none'})`);
				}
				continue;
			}

			// Track if we found a file via fallback (for path correction)
			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ↪ Resolved ${tab.path} → ${file.path} (via ${method})`);
				}
			}

			let leaf: WorkspaceLeaf;
			if (!isFirstTabOpened && existingLeaf) {
				// Use existing leaf for the first tab we open
				await existingLeaf.openFile(file);
				leaf = existingLeaf;
				container = existingLeaf.parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else if (!isFirstTabOpened) {
				// No existing leaf, create new one
				leaf = this.app.workspace.createLeafInParent(parent, 0);
				await leaf.openFile(file);
				container = leaf.parent;
				firstLeaf = leaf;
				isFirstTabOpened = true;
			} else {
				// Subsequent tabs go into the same container
				if (!container) continue;
				leaf = this.app.workspace.createLeafInParent(container, (container as any).children?.length ?? 0);
				await leaf.openFile(file);
			}

			const elapsed = performance.now() - tabStart;
			if (PerfTimer.isEnabled()) {
				const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
				const methodSuffix = method !== 'path' ? ` [${method}]` : '';
				console.log(`[Perspecta]   ${flag} openFile[${originalIndex}]: ${file.basename} - ${elapsed.toFixed(1)}ms${methodSuffix}${tab.active ? ' [ACTIVE]' : ''}`);
			}
		}

		return firstLeaf;
	}

	/**
	 * Restore a split structure.
	 *
	 * The challenge: Obsidian's getLeaf('split') creates splits at the LEAF level,
	 * not at the container level. So if we have a horizontal container [A, B] and
	 * split vertically from B, we get [A, vertical[B, C]] instead of vertical[[A,B], C].
	 *
	 * Solution: Use createLeafBySplit with the FIRST leaf of a nested structure.
	 * When we split from the first leaf in a different direction, Obsidian properly
	 * wraps the entire sibling group.
	 *
	 * For:
	 *   vertical split
	 *   ├── horizontal split (A | B)
	 *   └── C
	 *
	 * Order:
	 * 1. Start with leaf (A)
	 * 2. Build horizontal: split from A → B (now [A, B] in horizontal)
	 * 3. Split vertically from A (FIRST leaf) → C
	 *    This should wrap [A, B] as a unit
	 */
	private async restoreSplit(parent: any, state: SplitState, existingLeaf?: WorkspaceLeaf): Promise<WorkspaceLeaf | undefined> {
		if (!state.children.length) return existingLeaf;

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplit START: direction=${state.direction}, children=${state.children.length}, parent:`, {
				type: parent?.constructor?.name,
				direction: parent?.direction
			});
		}

		// Set the parent container's direction
		if (parent && parent.direction !== state.direction) {
			parent.direction = state.direction;
			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] restoreSplit: changed parent direction to ${state.direction}`);
			}
		}

		let firstLeaf = existingLeaf;

		// Process first child - this may create nested structure
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs') {
			// Simple tabs
			const firstTab = firstChild.tabs[0];
			if (firstTab && existingLeaf) {
				const { file: f, method } = resolveFile(this.app, firstTab);
				if (f) {
					if (method !== 'path') {
						this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
					}
					await existingLeaf.openFile(f);
				}
			}
			if (firstChild.tabs.length > 1 && existingLeaf) {
				await this.restoreRemainingTabs(existingLeaf, firstChild.tabs, 1);
			}
			firstLeaf = existingLeaf;
		} else {
			// First child is a nested split - build it first
			firstLeaf = await this.buildNestedSplit(existingLeaf, firstChild);
		}

		// Now add siblings at THIS level
		// KEY: Split from the FIRST leaf to properly wrap nested structures
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			// Small delay to ensure previous split operations are fully established
			await new Promise(resolve => setTimeout(resolve, 50));

			// Use createLeafBySplit from the FIRST leaf
			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);

			// Wait for the split to be established
			await new Promise(resolve => setTimeout(resolve, 50));

			if (child.type === 'tabs') {
				const firstTab = child.tabs[0];
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
				}
			} else {
				// Nested split
				const firstTab = this.getFirstTabFromNode(child);
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				await this.buildNestedSplit(newLeaf, child);
			}
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplit END: direction=${state.direction}`);
		}

		return firstLeaf;
	}

	/**
	 * Build a nested split structure starting from a leaf.
	 * Returns the first leaf in the created structure.
	 */
	private async buildNestedSplit(startLeaf: WorkspaceLeaf | undefined, state: SplitState): Promise<WorkspaceLeaf | undefined> {
		if (!state.children.length || !startLeaf) {
			return startLeaf;
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] buildNestedSplit: direction=${state.direction}, children=${state.children.length}`);
		}

		let firstLeaf: WorkspaceLeaf = startLeaf;

		// Process first child into startLeaf
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs') {
			const firstTab = firstChild.tabs[0];
			if (firstTab) {
				const { file: f, method } = resolveFile(this.app, firstTab);
				if (f) {
					if (method !== 'path') {
						this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
					}
					await startLeaf.openFile(f);
				}
			}
			if (firstChild.tabs.length > 1) {
				await this.restoreRemainingTabs(startLeaf, firstChild.tabs, 1);
			}
			firstLeaf = startLeaf;
		} else {
			// Recursively build nested split
			const result = await this.buildNestedSplit(startLeaf, firstChild);
			if (result) firstLeaf = result;
		}

		// Add siblings - split from FIRST leaf to keep them at same level
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			// Small delay to ensure previous operations are fully established
			await new Promise(resolve => setTimeout(resolve, 50));

			// Split from firstLeaf
			const newLeaf = this.app.workspace.createLeafBySplit(firstLeaf!, state.direction);

			// Wait for the split to be established
			await new Promise(resolve => setTimeout(resolve, 50));

			if (child.type === 'tabs') {
				const firstTab = child.tabs[0];
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
				}
			} else {
				// Nested split
				const firstTab = this.getFirstTabFromNode(child);
				if (firstTab) {
					const { file: f, method } = resolveFile(this.app, firstTab);
					if (f) {
						if (method !== 'path') {
							this.pathCorrections.set(firstTab.path, { newPath: f.path, newName: f.basename });
						}
						await newLeaf.openFile(f);
					}
				}
				await this.buildNestedSplit(newLeaf, child);
			}
		}

		return firstLeaf;
	}

	private async restorePopoutWindow(
		state: WindowStateV2,
		sourceScreen?: ScreenInfo,
		tiledPosition?: { x: number; y: number; width: number; height: number }
	) {
		const popoutStart = performance.now();

		// For simple tabs root, find any tab to start with (we'll reorder later)
		// For splits, use the first tab as before
		const firstTab = this.getFirstTab(state.root);
		if (!firstTab) return;

		// Use fallback resolution: path → UID → filename
		const { file, method } = resolveFile(this.app, firstTab);
		if (!file) return;

		// Track path corrections for fallback resolutions
		if (method !== 'path') {
			this.pathCorrections.set(firstTab.path, {
				newPath: file.path,
				newName: file.basename
			});
		}

		// Create the popout with a placeholder file first
		const openPopoutStart = performance.now();
		const popoutLeaf = this.app.workspace.openPopoutLeaf();
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]     ✓ openPopoutLeaf: ${(performance.now() - openPopoutStart).toFixed(1)}ms`);
		}

		const openFileStart = performance.now();
		await popoutLeaf.openFile(file);
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]     ✓ openFile (popout first): ${(performance.now() - openFileStart).toFixed(1)}ms`);
		}

		const win = popoutLeaf.view?.containerEl?.win;
		if (win) {
			if (tiledPosition) {
				// Use pre-calculated tiled position
				this.restoreWindowGeometryDirect(win, tiledPosition);
			} else {
				// Use normal virtual-to-physical conversion
				this.restoreWindowGeometry(win, state, sourceScreen);
			}
		}

		if (state.root.type === 'tabs') {
			// Simple tabs - restore all tabs with active tab opened LAST
			await this.restorePopoutTabs(popoutLeaf, state.root.tabs);
		} else if (state.root.type === 'split') {
			// For complex splits, use outer-first approach:
			// First create all outer splits, then fill in nested structures
			await this.restoreSplitOuterFirst(popoutLeaf, state.root);
		}
	}

	// Restore split using "outer-first" approach:
	// 1. First create all siblings at the current level
	// 2. Then recursively fill in any nested splits
	private async restoreSplitOuterFirst(existingLeaf: WorkspaceLeaf, state: SplitState): Promise<void> {
		if (!state.children.length) return;

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplitOuterFirst: direction=${state.direction}, children=${state.children.length}`);
		}

		// Step 1: Create all leaf placeholders at THIS level first
		// This ensures the outer split structure is correct before we subdivide
		const leafSlots: WorkspaceLeaf[] = [];

		// existingLeaf will be slot 0 (first child)
		leafSlots.push(existingLeaf);

		// getLeaf('split') creates a new pane AFTER the active leaf
		// So we iterate forward: each new split goes after the previous one
		// This gives us the correct order: [existingLeaf, new1, new2, ...]

		let lastLeaf = existingLeaf;
		for (let i = 1; i < state.children.length; i++) {
			this.app.workspace.setActiveLeaf(lastLeaf, { focus: false });
			const newLeaf = this.app.workspace.getLeaf('split', state.direction);

			// Open the first file of this child (use fallback resolution)
			const childFirstTab = this.getFirstTabFromNode(state.children[i]);
			if (childFirstTab) {
				const { file: f, method } = resolveFile(this.app, childFirstTab);
				if (f) {
					// Track path corrections for fallback resolutions
					if (method !== 'path') {
						this.pathCorrections.set(childFirstTab.path, {
							newPath: f.path,
							newName: f.basename
						});
					}
					await newLeaf.openFile(f);
				}
			}

			leafSlots.push(newLeaf);
			lastLeaf = newLeaf; // Next split will be after this one
		}

		// Now open the first file in the existing leaf (which is slot 0, use fallback resolution)
		const firstTab = this.getFirstTabFromNode(state.children[0]);
		if (firstTab) {
			const { file: f, method } = resolveFile(this.app, firstTab);
			if (f) {
				// Track path corrections for fallback resolutions
				if (method !== 'path') {
					this.pathCorrections.set(firstTab.path, {
						newPath: f.path,
						newName: f.basename
					});
				}
				await existingLeaf.openFile(f);
			}
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreSplitOuterFirst: created ${leafSlots.length} leaf slots`);
			leafSlots.forEach((leaf, idx) => {
				const path = (leaf?.view as any)?.file?.path || 'unknown';
				console.log(`  slot[${idx}]: ${path}`);
			});
		}

		// Step 2: Now fill in nested structures for each child
		for (let i = 0; i < state.children.length; i++) {
			const child = state.children[i];
			const leafSlot = leafSlots[i];

			if (child.type === 'tabs') {
				// Add remaining tabs to this slot
				if (child.tabs.length > 1) {
					await this.restoreRemainingTabs(leafSlot, child.tabs, 1);
				}
			} else if (child.type === 'split') {
				// This child is a nested split - recursively restore it
				// The leafSlot already has the first file, now we need to add the nested structure
				await this.restoreNestedSplitInPlace(leafSlot, child);
			}
		}
	}

	// Restore a nested split within an existing leaf's position
	private async restoreNestedSplitInPlace(leafSlot: WorkspaceLeaf, state: SplitState): Promise<void> {
		if (state.children.length <= 1) {
			// Only one child, just fill in its content
			if (state.children[0]?.type === 'tabs' && state.children[0].tabs.length > 1) {
				await this.restoreRemainingTabs(leafSlot, state.children[0].tabs, 1);
			}
			return;
		}

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreNestedSplitInPlace: direction=${state.direction}, children=${state.children.length}`);
		}

		// The leafSlot already has the first child's first file
		// We need to create splits for remaining children in the NESTED direction

		// First, handle remaining tabs in first child if any
		const firstChild = state.children[0];
		if (firstChild.type === 'tabs' && firstChild.tabs.length > 1) {
			await this.restoreRemainingTabs(leafSlot, firstChild.tabs, 1);
		} else if (firstChild.type === 'split') {
			// First child is also a split - need deeper recursion
			await this.restoreNestedSplitInPlace(leafSlot, firstChild);
		}

		// Now create splits for remaining children
		// Track last leaf so splits are created in order (each after the previous)
		let lastLeaf = leafSlot;
		for (let i = 1; i < state.children.length; i++) {
			const child = state.children[i];

			this.app.workspace.setActiveLeaf(lastLeaf, { focus: false });
			const newLeaf = this.app.workspace.getLeaf('split', state.direction);
			lastLeaf = newLeaf;

			// Open first file (use fallback resolution)
			const childFirstTab = this.getFirstTabFromNode(child);
			if (childFirstTab) {
				const { file: f, method } = resolveFile(this.app, childFirstTab);
				if (f) {
					// Track path corrections for fallback resolutions
					if (method !== 'path') {
						this.pathCorrections.set(childFirstTab.path, {
							newPath: f.path,
							newName: f.basename
						});
					}
					await newLeaf.openFile(f);
				}
			}

			// Handle child's structure
			if (child.type === 'tabs' && child.tabs.length > 1) {
				await this.restoreRemainingTabs(newLeaf, child.tabs, 1);
			} else if (child.type === 'split') {
				await this.restoreNestedSplitInPlace(newLeaf, child);
			}
		}
	}

	// Get the first tab from any node (tabs or split) - returns full TabState for fallback resolution
	private getFirstTabFromNode(node: WorkspaceNodeState): TabState | null {
		if (node.type === 'tabs') {
			return node.tabs[0] || null;
		} else if (node.type === 'split' && node.children.length > 0) {
			return this.getFirstTabFromNode(node.children[0]);
		}
		return null;
	}

	/**
	 * Restore tabs in a popout window, preserving both tab ORDER and active state.
	 *
	 * Strategy:
	 * 1. Open all tabs in the correct order (preserving visual tab order)
	 * 2. Track which leaf corresponds to the active tab
	 * 3. Schedule the active tab to be selected after the window is fully ready
	 */
	private async restorePopoutTabs(existingLeaf: WorkspaceLeaf, tabs: TabState[]) {
		if (tabs.length <= 1) return; // Only one tab, nothing to do

		// Find which tab should be active
		let activeTabIndex = tabs.findIndex(t => t.active);
		if (activeTabIndex < 0) activeTabIndex = 0;

		const container = existingLeaf.parent as any;
		if (!container) return;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restorePopoutTabs: ${tabs.length} tabs, active at index ${activeTabIndex}`);
		}

		// Track leaves as we open them (in correct order)
		const openedLeaves: WorkspaceLeaf[] = [];

		// existingLeaf already has tabs[0] open
		openedLeaves.push(existingLeaf);

		// Open remaining tabs in order (tabs[1], tabs[2], etc.)
		for (let i = 1; i < tabs.length; i++) {
			const tab = tabs[i];
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   ✗ File not found: ${tab.path}`);
				}
				continue;
			}

			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
			}

			const leaf = this.app.workspace.createLeafInParent(container, container.children?.length ?? 0);
			await leaf.openFile(file);
			openedLeaves.push(leaf);

			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   ✓ Opened[${i}]: ${file.basename}`);
			}
		}

		// Now all tabs are open in correct order
		// The last-opened tab is currently "active" in Obsidian's view
		// We need to make the correct tab active

		const activeLeaf = openedLeaves[activeTabIndex];
		if (!activeLeaf) return;

		// Schedule tab activation for after restore completes
		// Store in a queue that will be processed after all popouts are restored
		this.pendingTabActivations.push({
			container,
			activeTabIndex,
			activeLeaf
		});

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta]   Queued tab activation for index ${activeTabIndex}`);
		}
	}

	// Queue of pending tab activations to process after restore
	private pendingTabActivations: Array<{
		container: any;
		activeTabIndex: number;
		activeLeaf: WorkspaceLeaf;
	}> = [];

	/**
	 * Process all pending tab activations after windows are fully initialized
	 */
	private processPendingTabActivations() {
		if (this.pendingTabActivations.length === 0) return;

		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] Processing ${this.pendingTabActivations.length} pending tab activations`);
		}

		for (const { container, activeTabIndex, activeLeaf } of this.pendingTabActivations) {
			// Try multiple methods to activate the tab

			// Method 1: Set currentTab and call updateTabDisplay if available
			if (typeof container.currentTab !== 'undefined') {
				container.currentTab = activeTabIndex;
				if (typeof container.updateTabDisplay === 'function') {
					container.updateTabDisplay();
				}
				if (typeof container.onResize === 'function') {
					container.onResize();
				}
			}

			// Method 2: Use selectTab
			if (typeof container.selectTab === 'function') {
				container.selectTab(activeLeaf);
			}

			// Method 3: Focus the active leaf's view
			if (activeLeaf.view?.containerEl) {
				activeLeaf.view.containerEl.focus();
			}

			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   Activated tab at index ${activeTabIndex}`);
			}
		}

		// Clear the queue
		this.pendingTabActivations = [];
	}

	private async restoreRemainingTabs(existingLeaf: WorkspaceLeaf, tabs: TabState[], startIndex: number) {
		if (PerfTimer.isEnabled()) {
			console.log(`[Perspecta] restoreRemainingTabs: ${tabs.length} total tabs, starting from index ${startIndex}`);
		}

		// Find which tab should be active
		let activeTabIndex = 0;
		for (let i = 0; i < tabs.length; i++) {
			if (tabs[i].active) {
				activeTabIndex = i;
				break;
			}
		}

		// Strategy: Open inactive tabs first, then open the active tab last
		// This way Obsidian naturally makes the last-opened tab active
		const parent = existingLeaf.parent;
		if (!parent) return;

		// Collect all tabs to open (excluding the first one which is already open via existingLeaf)
		const tabsToOpen: { tab: TabState; index: number }[] = [];
		for (let i = startIndex; i < tabs.length; i++) {
			tabsToOpen.push({ tab: tabs[i], index: i });
		}

		// Reorder: put inactive tabs first, active tab last
		tabsToOpen.sort((a, b) => {
			if (a.tab.active && !b.tab.active) return 1;  // active goes last
			if (!a.tab.active && b.tab.active) return -1; // inactive goes first
			return a.index - b.index; // maintain original order otherwise
		});

		// If the active tab is the first tab (index 0, already in existingLeaf),
		// we need to reopen it last to make it active
		const activeIsFirstTab = activeTabIndex === 0;

		// Open tabs in the reordered sequence
		for (const { tab, index } of tabsToOpen) {
			const { file, method } = resolveFile(this.app, tab);
			if (!file) {
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   tab[${index}]: file not found for ${tab.path}`);
				}
				continue;
			}

			if (method !== 'path') {
				this.pathCorrections.set(tab.path, {
					newPath: file.path,
					newName: file.basename
				});
			}

			const leaf = this.app.workspace.createLeafInParent(parent, (parent as any).children?.length ?? 0);
			await leaf.openFile(file);
			if (PerfTimer.isEnabled()) {
				console.log(`[Perspecta]   tab[${index}]: opened ${file.basename}, active=${tab.active}`);
			}
		}

		// If active tab was the first tab (in existingLeaf), we need to switch to it
		if (activeIsFirstTab) {
			// Re-activate the first leaf by opening its file again or using setActiveLeaf
			setTimeout(() => {
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: false });
				if (PerfTimer.isEnabled()) {
					console.log(`[Perspecta]   Activated first tab (existingLeaf)`);
				}
			}, 100);
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

	private findWindowContainingFile(filePath: string): Window | null {
		let foundWin: Window | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!foundWin && (leaf.view as any)?.file?.path === filePath) {
				foundWin = leaf.view?.containerEl?.win ?? window;
			}
		});
		return foundWin;
	}

	private activateLeafByPath(win: Window, filePath: string) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view?.containerEl?.win === win && (leaf.view as any)?.file?.path === filePath) {
				this.app.workspace.setActiveLeaf(leaf, { focus: false });
			}
		});
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

	private restoreWindowGeometry(win: Window, state: WindowStateV2, sourceScreen?: ScreenInfo) {
		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometry called`, {
				hasCoords: state.x !== undefined && state.y !== undefined,
				hasSize: state.width !== undefined && state.height !== undefined,
				state: { x: state.x, y: state.y, width: state.width, height: state.height },
				sourceScreen
			});
		}

		if (state.width === undefined || state.height === undefined ||
			state.x === undefined || state.y === undefined) {
			if (COORDINATE_DEBUG) {
				console.log(`[Perspecta] restoreWindowGeometry: missing coordinates, skipping`);
			}
			return;
		}

		// Convert virtual coordinates to physical screen coordinates
		const physical = virtualToPhysical({
			x: state.x,
			y: state.y,
			width: state.width,
			height: state.height
		}, sourceScreen);

		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometry: applying`, physical);
		}

		try { win.resizeTo(physical.width, physical.height); } catch { /* ignore */ }
		try { win.moveTo(physical.x, physical.y); } catch { /* ignore */ }
	}

	// Apply geometry directly without virtual-to-physical conversion (used for tiled layouts)
	private restoreWindowGeometryDirect(win: Window, geometry: { x: number; y: number; width: number; height: number }) {
		if (COORDINATE_DEBUG) {
			console.log(`[Perspecta] restoreWindowGeometryDirect: applying`, geometry);
		}

		try { win.resizeTo(geometry.width, geometry.height); } catch { /* ignore */ }
		try { win.moveTo(geometry.x, geometry.y); } catch { /* ignore */ }
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
	// Context Details View
	// ============================================================================

	private async showContextDetails() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file');
			return;
		}

		const context = await this.getContextForFile(file);
		if (!context) {
			new Notice('No context found in this note');
			return;
		}

		// Get the window containing the active file
		const activeLeaf = this.app.workspace.activeLeaf;
		const targetWindow = activeLeaf?.view?.containerEl?.win ?? window;

		const v2 = this.normalizeToV2(context);
		this.showContextDetailsModal(v2, file.name, targetWindow);
	}

	private showContextDetailsModal(context: WindowArrangementV2, fileName: string, targetWindow: Window) {
		const doc = targetWindow.document;

		const overlay = doc.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = doc.createElement('div');
		modal.className = 'perspecta-debug-modal perspecta-details-modal';

		const date = new Date(context.ts);
		const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

		let html = `<h3>Context Details</h3>
			<div class="perspecta-details-header">
				<span class="perspecta-details-file">${fileName}</span>
				<span class="perspecta-details-date">${dateStr}</span>
			</div>
			<div class="perspecta-details-content">`;

		// Main window
		html += `<div class="perspecta-window-section">
			<div class="perspecta-window-title">Main Window</div>
			${this.formatNodeDetails(context.main.root, context.focusedWindow === -1)}
		</div>`;

		// Popouts
		if (context.popouts.length > 0) {
			context.popouts.forEach((p, i) => {
				html += `<div class="perspecta-window-section">
					<div class="perspecta-window-title">Popout ${i + 1}</div>
					${this.formatNodeDetails(p.root, context.focusedWindow === i)}
				</div>`;
			});
		}

		// Screen info
		if (context.sourceScreen) {
			const ar = context.sourceScreen.aspectRatio;
			const screenType = ar > 2 ? 'ultrawide' : ar > 1.7 ? 'wide' : 'standard';
			html += `<div class="perspecta-screen-info">Screen: ${screenType} (${ar.toFixed(2)})</div>`;
		}

		html += `</div><button class="perspecta-details-close">Close</button>`;
		modal.innerHTML = html;

		overlay.onclick = () => { modal.remove(); overlay.remove(); };
		modal.querySelector('.perspecta-details-close')?.addEventListener('click', () => { modal.remove(); overlay.remove(); });

		doc.body.appendChild(overlay);
		doc.body.appendChild(modal);
	}

	private formatNodeDetails(node: WorkspaceNodeState, isFocusedWindow: boolean): string {
		if (node.type === 'tabs') {
			return `<div class="perspecta-tab-list">${node.tabs.map(t => {
				const name = t.path.split('/').pop()?.replace(/\.md$/, '') || t.path;
				const folder = t.path.includes('/') ? t.path.split('/').slice(0, -1).join('/') : '';
				const activeClass = t.active ? ' perspecta-tab-active' : '';
				const focusedClass = t.active && isFocusedWindow ? ' perspecta-tab-focused' : '';
				const uidBadge = t.uid ? '<span class="perspecta-uid-badge" title="Has UID for move/rename resilience">uid</span>' : '';
				return `<div class="perspecta-tab-item${activeClass}${focusedClass}">
					<span class="perspecta-tab-name">${name}</span>${uidBadge}
					${folder ? `<span class="perspecta-tab-folder">${folder}</span>` : ''}
				</div>`;
			}).join('')}</div>`;
		} else {
			const icon = node.direction === 'horizontal' ? '↔' : '↕';
			return `<div class="perspecta-split">
				<div class="perspecta-split-header">${icon} Split (${node.direction})</div>
				<div class="perspecta-split-children">
					${node.children.map(child => this.formatNodeDetails(child, isFocusedWindow)).join('')}
				</div>
			</div>`;
		}
	}

	// ============================================================================
	// Debug Modal (Save Confirmation)
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

		// Check frontmatter
		const hasContextFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;

		// Check external storage
		let hasContextExternal = false;
		if (this.settings.storageMode === 'external') {
			const uid = getUidFromCache(this.app, file);
			if (uid && this.externalStore.has(uid)) {
				hasContextExternal = true;
			}
		}

		const hasContext = hasContextFrontmatter || hasContextExternal;
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

	private async setupFileExplorerIndicators() {
		PerfTimer.begin('setupFileExplorerIndicators');
		const mdFiles = this.app.vault.getMarkdownFiles();
		PerfTimer.mark(`getMarkdownFiles (${mdFiles.length} files)`);

		// Scan for markdown files with context in frontmatter
		for (const file of mdFiles) {
			if (this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY]) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark('scanForContextFiles (frontmatter)');

		// Scan for canvas files with context
		const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
		for (const file of canvasFiles) {
			if (await canvasHasContext(this.app, file)) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark(`scanForContextFiles (canvas: ${canvasFiles.length} files)`);

		// Scan for base files with context
		const baseFiles = this.app.vault.getFiles().filter(f => f.extension === 'base');
		for (const file of baseFiles) {
			if (await baseHasContext(this.app, file)) {
				this.filesWithContext.add(file.path);
			}
		}
		PerfTimer.mark(`scanForContextFiles (base: ${baseFiles.length} files)`);

		// If using external storage, also check for files whose UIDs have saved contexts
		if (this.settings.storageMode === 'external') {
			if (!this.externalStore['initialized']) {
				await this.externalStore.initialize();
			}
			const uidsWithContext = this.externalStore.getAllUids();
			for (const file of mdFiles) {
				const uid = getUidFromCache(this.app, file);
				if (uid && uidsWithContext.includes(uid)) {
					this.filesWithContext.add(file.path);
				}
			}
			PerfTimer.mark('scanForContextFiles (external)');
		}

		this.registerEvent(this.app.workspace.on('layout-change', () => this.debouncedRefreshIndicators()));
		setTimeout(() => this.refreshFileExplorerIndicators(), 500);
		PerfTimer.end('setupFileExplorerIndicators');
	}

	private async updateFileExplorerIndicator(file: TFile) {
		let hasContext = false;

		if (file.extension === 'canvas') {
			// Canvas files store context in their JSON
			hasContext = await canvasHasContext(this.app, file);
		} else if (file.extension === 'base') {
			// Base files store context in their YAML
			hasContext = await baseHasContext(this.app, file);
		} else {
			// Markdown files: check frontmatter
			hasContext = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY] != null;

			// Also check external storage if enabled
			if (!hasContext && this.settings.storageMode === 'external') {
				const uid = getUidFromCache(this.app, file);
				if (uid && this.externalStore.has(uid)) {
					hasContext = true;
				}
			}
		}

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
		COORDINATE_DEBUG = this.settings.enableDebugLogging;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		PerfTimer.setEnabled(this.settings.enableDebugLogging);
		COORDINATE_DEBUG = this.settings.enableDebugLogging;
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

		new Setting(containerEl).setName('Focus tint duration').setDesc('Seconds (0 = disabled)')
			.addText(t => t.setValue(String(this.plugin.settings.focusTintDuration)).onChange(async v => {
				const n = parseFloat(v);
				if (!isNaN(n) && n >= 0) { this.plugin.settings.focusTintDuration = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl).setName('Auto-generate file UIDs')
			.setDesc('Automatically add unique IDs to files in saved contexts. This allows files to be found even after moving or renaming.')
			.addToggle(t => t.setValue(this.plugin.settings.autoGenerateUids).onChange(async v => {
				this.plugin.settings.autoGenerateUids = v; await this.plugin.saveSettings();
			}));

		containerEl.createEl('h3', { text: 'Storage' });

		new Setting(containerEl).setName('Store window arrangements in frontmatter')
			.setDesc('When enabled, context data is stored in note frontmatter (syncs with note). When disabled, context is stored externally in the plugin folder (keeps notes cleaner, requires perspecta-uid in frontmatter).')
			.addToggle(t => t.setValue(this.plugin.settings.storageMode === 'frontmatter').onChange(async v => {
				this.plugin.settings.storageMode = v ? 'frontmatter' : 'external';
				await this.plugin.saveSettings();
				// Initialize external store if switching to external mode
				if (!v) {
					await this.plugin.externalStore.initialize();
				}
				// Refresh display to update button visibility
				this.display();
			}));

		// Migration buttons - show based on current storage mode
		if (this.plugin.settings.storageMode === 'frontmatter') {
			new Setting(containerEl)
				.setName('Migrate to external storage')
				.setDesc('Move all context data from note frontmatter to the plugin folder. This cleans up your notes by removing perspecta-arrangement properties.')
				.addButton(btn => btn
					.setButtonText('Migrate to external')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Migrating...');
						try {
							const result = await this.plugin.migrateToExternalStorage();
							new Notice(`Migration complete: ${result.migrated} contexts moved${result.errors > 0 ? `, ${result.errors} errors` : ''}`);
							this.display(); // Refresh to show updated state
						} catch (e) {
							new Notice('Migration failed: ' + (e as Error).message);
							btn.setDisabled(false);
							btn.setButtonText('Migrate to external');
						}
					}));
		} else {
			new Setting(containerEl)
				.setName('Migrate to frontmatter')
				.setDesc('Move all context data from the plugin folder into note frontmatter. This makes contexts portable with your notes.')
				.addButton(btn => btn
					.setButtonText('Migrate to frontmatter')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Migrating...');
						try {
							const result = await this.plugin.migrateToFrontmatter();
							new Notice(`Migration complete: ${result.migrated} contexts moved${result.errors > 0 ? `, ${result.errors} errors` : ''}`);
							this.display(); // Refresh to show updated state
						} catch (e) {
							new Notice('Migration failed: ' + (e as Error).message);
							btn.setDisabled(false);
							btn.setButtonText('Migrate to frontmatter');
						}
					}));
		}

		new Setting(containerEl)
			.setName('Clean up old uid properties')
			.setDesc('Remove obsolete "uid" properties from notes that already have "perspecta-uid". This cleans up leftover data from earlier versions.')
			.addButton(btn => btn
				.setButtonText('Clean up')
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('Cleaning...');
					try {
						const count = await this.plugin.cleanupOldUidProperties();
						new Notice(count > 0 ? `Cleaned up ${count} file${count > 1 ? 's' : ''}` : 'No old uid properties found');
					} catch (e) {
						new Notice('Cleanup failed: ' + (e as Error).message);
					}
					btn.setDisabled(false);
					btn.setButtonText('Clean up');
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
}
