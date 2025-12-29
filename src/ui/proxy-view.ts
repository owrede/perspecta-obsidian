/**
 * Proxy View - Minimalist Window for Note Representation
 *
 * Shows a scaled-down preview of note content in a compact window.
 * Designed for quick context switching without full window overhead.
 *
 * @module ui/proxy-view
 *
 * ## Security Notes
 * - Does NOT use Electron remote module (deprecated, security risk)
 * - Uses CSS-only solutions for window styling
 * - Uses safe DOM manipulation methods (no innerHTML with user data)
 *
 * ## Obsidian API Usage
 * - ItemView for custom view implementation
 * - MarkdownRenderer for safe content rendering
 * - Platform for OS detection
 */

import { ItemView, WorkspaceLeaf, TFile, setIcon, MarkdownRenderer, Component, ViewStateResult } from 'obsidian';
import { TIMING, CSS_CLASSES, EVENTS } from '../utils/constants';
import { ComponentEventManager } from '../utils/event-manager';
import { delay, retryAsync, safeTimeout } from '../utils/async-utils';

export const PROXY_VIEW_TYPE = 'perspecta-proxy-view';

export interface ProxyViewState extends Record<string, unknown> {
	filePath: string;
	arrangementUid?: string;
}

/**
 * ProxyNoteView - A minimalist window that represents a note
 *
 * Shows a scaled-down preview of the note content with:
 * - Clickable area to restore arrangement (if one exists)
 * - Expand button to open as normal window
 *
 * Note: Window chrome hiding is achieved via CSS classes applied to the
 * popout window body. This avoids the deprecated Electron remote module.
 */
export class ProxyNoteView extends ItemView {
	private state: ProxyViewState = { filePath: '' };
	private file: TFile | null = null;
	private renderComponent: Component | null = null;
	private eventManager = new ComponentEventManager();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return PROXY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename || 'Proxy';
	}

	getIcon(): string {
		return 'minimize-2';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('perspecta-proxy-container');

		// Add class to the popout window for CSS targeting
		this.applyProxyWindowClass();

		// Render content first
		await this.renderContent(container);

		// Configure window chrome via CSS with improved retry logic
		await this.configureWindowChromeWithRetry();
	}

	/**
	 * Configure window chrome with retry logic for reliability
	 */
	private async configureWindowChromeWithRetry(): Promise<void> {
		// Try immediately and at different intervals to catch chrome at various stages
		const attempts = [
			0,
			TIMING.CHROME_RETRY_DELAY_1,
			TIMING.CHROME_RETRY_DELAY_2,
			TIMING.CHROME_RETRY_DELAY_3
		];

		for (const delay of attempts) {
			if (delay > 0) {
				await new Promise(resolve => setTimeout(resolve, delay));
			}
			this.configureWindowChrome();
		}
	}

	/**
	 * Applies CSS classes to the popout window for styling.
	 * This enables CSS-only window chrome hiding.
	 */
	private applyProxyWindowClass(): void {
		// Try multiple ways to get the window and add the class
		const win = this.getPopoutWindow();
		if (win?.document?.body) {
			win.document.body.classList.add(CSS_CLASSES.PROXY_WINDOW);
		}

		// Also add to the workspace container for this leaf
		const workspaceEl = this.containerEl.closest('.workspace');
		if (workspaceEl) {
			workspaceEl.classList.add(CSS_CLASSES.PROXY_WORKSPACE);
		}
	}

	/**
	 * Gets the popout window for this view, if any.
	 * Returns null if this is the main window.
	 */
	private getPopoutWindow(): Window | null {
		const win = this.containerEl.win || (this.leaf.view?.containerEl as { win?: Window })?.win;
		if (win && win !== window) {
			return win;
		}
		return null;
	}

	/**
	 * Configures window chrome (tabs, titlebar, etc.) via CSS and DOM.
	 * Does NOT use Electron remote module - uses CSS-only approach.
	 */
	private configureWindowChrome(): void {
		const win = this.getPopoutWindow();
		if (!win) return;

		const doc = win.document;
		if (!doc) return;

		// Remove the workspace tab header container (contains tabs, add button, menu)
		const headerEl = doc.querySelector('.workspace-tab-header-container');
		if (headerEl) {
			headerEl.remove();
		}

		// Hide the titlebar via CSS (safe - no innerHTML)
		const titlebarEl = doc.querySelector('.titlebar') as HTMLElement | null;
		if (titlebarEl) {
			// Remove children safely instead of innerHTML
			while (titlebarEl.firstChild) {
				titlebarEl.removeChild(titlebarEl.firstChild);
			}
			titlebarEl.style.height = '0';
			titlebarEl.style.minHeight = '0';
		}

		// Also hide the view header within our leaf
		const viewHeader = doc.querySelector('.view-header') as HTMLElement | null;
		if (viewHeader) {
			viewHeader.style.display = 'none';
		}

		// Note: Window minimum size and traffic light hiding previously used
		// Electron's remote module. This has been removed for security.
		// CSS handles most styling, and users can resize windows as needed.
	}

	private async renderContent(container: HTMLElement): Promise<void> {
		// Header row with title and expand button - this is the drag handle
		const headerRow = container.createDiv({ cls: CSS_CLASSES.PROXY_HEADER });

		// Make header draggable (for window movement)
		headerRow.style.cssText += '-webkit-app-region: drag; cursor: move;';

		// Note title (top left)
		headerRow.createDiv({
			cls: CSS_CLASSES.PROXY_TITLE,
			text: this.file?.basename || 'No file'
		});

		// Expand button (top right) - must be no-drag to be clickable
		const expandBtn = headerRow.createDiv({ cls: CSS_CLASSES.PROXY_EXPAND });
		expandBtn.style.cssText += '-webkit-app-region: no-drag; cursor: pointer;';
		setIcon(expandBtn, 'maximize-2');
		
		this.eventManager.addListener(expandBtn, EVENTS.CLICK, (e) => {
			e.stopPropagation();
			this.expandToFullWindow();
		});

		// Preview container with scaled content - this is scrollable and clickable
		const previewWrapper = container.createDiv({ cls: 'perspecta-proxy-preview-wrapper' });
		const previewContent = previewWrapper.createDiv({ cls: 'perspecta-proxy-preview-content' });

		// Check if this file needs scaled markdown preview or special handling
		const ext = this.file?.extension.toLowerCase() || '';
		const needsScaling = !this.isImageFile(ext) && !this.isPdfFile(ext) && !this.isNonRenderableFile(ext);

		if (needsScaling) {
			// Apply scale from settings for markdown/text content
			const plugin = this.getPlugin();
			const scale = plugin?.settings?.proxyPreviewScale ?? 0.35;
			const inverseScale = 100 / (scale * 100);
			previewContent.style.width = `${inverseScale * 100}%`;
			previewContent.style.height = `${inverseScale * 100}%`;
			previewContent.style.transform = `scale(${scale})`;
		} else {
			// For images/PDFs/binary files, use normal sizing
			previewContent.style.width = '100%';
			previewContent.style.height = '100%';
			previewContent.style.position = 'relative';
		}

		// Render content (handles different file types)
		await this.renderMarkdownPreview(previewContent);

		// Make the preview wrapper scrollable and clickable for restore
		previewWrapper.style.overflow = 'auto';
		previewWrapper.style.cursor = 'pointer';

		// Enable pointer events on the preview content for scrolling
		previewContent.style.pointerEvents = 'auto';

		// Click on preview area triggers restore
		this.eventManager.addListener(previewWrapper, EVENTS.CLICK, (e) => {
			if (this.state.arrangementUid) {
				// Has arrangement - restore it (hold Shift for selector)
				const forceLatest = !e.shiftKey;
				this.restoreArrangement(forceLatest);
			} else {
				// No arrangement - just expand to full window
				this.expandToFullWindow();
			}
		});

		// Enable keyboard scrolling when focused
		container.tabIndex = 0;  // Make focusable
		this.eventManager.addListener(container, EVENTS.KEY_DOWN, (e) => {
			const scrollAmount = 50;
			if (e.key === 'ArrowDown' || e.key === 'j') {
				previewWrapper.scrollTop += scrollAmount;
				e.preventDefault();
			} else if (e.key === 'ArrowUp' || e.key === 'k') {
				previewWrapper.scrollTop -= scrollAmount;
				e.preventDefault();
			} else if (e.key === 'PageDown') {
				previewWrapper.scrollTop += previewWrapper.clientHeight;
				e.preventDefault();
			} else if (e.key === 'PageUp') {
				previewWrapper.scrollTop -= previewWrapper.clientHeight;
				e.preventDefault();
			} else if (e.key === 'Home') {
				previewWrapper.scrollTop = 0;
				e.preventDefault();
			} else if (e.key === 'End') {
				previewWrapper.scrollTop = previewWrapper.scrollHeight;
				e.preventDefault();
			} else if (e.key === 'Enter' || e.key === ' ') {
				// Enter/Space triggers restore
				if (this.state.arrangementUid) {
					this.restoreArrangement(true);
				} else {
					this.expandToFullWindow();
				}
				e.preventDefault();
			}
		});

		// Focus the container when clicking on it (for keyboard navigation)
		this.eventManager.addListener(container, EVENTS.MOUSE_DOWN, () => {
			container.focus();
		});

		// Add hover effect via JavaScript (more reliable than CSS in popout windows)
		this.eventManager.addListener(previewWrapper, EVENTS.MOUSE_ENTER, () => {
			previewWrapper.style.backgroundColor = 'var(--background-secondary)';
		});
		this.eventManager.addListener(previewWrapper, EVENTS.MOUSE_LEAVE, () => {
			previewWrapper.style.backgroundColor = '';
		});
	}

	private async renderMarkdownPreview(container: HTMLElement): Promise<void> {
		if (!this.file) return;

		const ext = this.file.extension.toLowerCase();

		// Check if this is a binary/non-markdown file
		if (this.isImageFile(ext)) {
			this.renderImagePreview(container);
			return;
		}

		if (this.isPdfFile(ext)) {
			this.renderFileTypeIcon(container, 'file-text', 'PDF');
			return;
		}

		if (this.isNonRenderableFile(ext)) {
			this.renderFileTypeIcon(container, 'file', ext.toUpperCase());
			return;
		}

		try {
			// Read the file content (only for text-based files)
			const content = await this.app.vault.cachedRead(this.file);

			// Clean up previous render component
			if (this.renderComponent) {
				this.renderComponent.unload();
			}

			// Create a new component for this render
			this.renderComponent = new Component();
			this.renderComponent.load();

			// Render markdown into the container (safe - uses Obsidian's renderer)
			await MarkdownRenderer.render(
				this.app,
				content,
				container,
				this.file.path,
				this.renderComponent
			);
		} catch (e) {
			console.log('[Perspecta] Could not render preview:', e);
			container.setText('Preview unavailable');
		}
	}

	private isImageFile(ext: string): boolean {
		return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'avif'].includes(ext);
	}

	private isPdfFile(ext: string): boolean {
		return ext === 'pdf';
	}

	private isNonRenderableFile(ext: string): boolean {
		// Files that can't be rendered as markdown or displayed as images
		return [
			'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
			'zip', 'rar', '7z', 'tar', 'gz',
			'mp3', 'wav', 'ogg', 'flac', 'm4a',
			'mp4', 'mov', 'avi', 'mkv', 'webm',
			'exe', 'dmg', 'app', 'bin'
		].includes(ext);
	}

	private renderImagePreview(container: HTMLElement): void {
		if (!this.file) return;

		const imgContainer = container.createDiv({ cls: 'perspecta-proxy-image-preview' });

		// Get the resource path for the image
		const resourcePath = this.app.vault.getResourcePath(this.file);

		const img = imgContainer.createEl('img', {
			attr: {
				src: resourcePath,
				alt: this.file.basename
			}
		});

		// Style the image to fit within the preview area
		img.style.maxWidth = '100%';
		img.style.maxHeight = '100%';
		img.style.objectFit = 'contain';
		imgContainer.style.display = 'flex';
		imgContainer.style.alignItems = 'center';
		imgContainer.style.justifyContent = 'center';
		imgContainer.style.height = '100%';
		imgContainer.style.padding = '8px';
		imgContainer.style.boxSizing = 'border-box';
	}

	private renderFileTypeIcon(container: HTMLElement, iconName: string, fileType: string): void {
		const iconContainer = container.createDiv({ cls: 'perspecta-proxy-file-icon' });

		// Create icon (safe - uses Obsidian's setIcon)
		const iconEl = iconContainer.createDiv({ cls: 'perspecta-proxy-file-icon-svg' });
		setIcon(iconEl, iconName);

		// Create file type label (safe - uses createDiv with text property)
		iconContainer.createDiv({
			cls: 'perspecta-proxy-file-type-label',
			text: fileType
		});

		// Style the container
		iconContainer.style.display = 'flex';
		iconContainer.style.flexDirection = 'column';
		iconContainer.style.alignItems = 'center';
		iconContainer.style.justifyContent = 'center';
		iconContainer.style.height = '100%';
		iconContainer.style.gap = '8px';
		iconContainer.style.color = 'var(--text-muted)';

		// Style the icon
		iconEl.style.width = '48px';
		iconEl.style.height = '48px';
		const svg = iconEl.querySelector('svg');
		if (svg) {
			(svg as SVGElement).style.width = '100%';
			(svg as SVGElement).style.height = '100%';
		}
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		// Type guard for our state format
		const proxyState = state as ProxyViewState;
		if (proxyState && typeof proxyState === 'object' && 'filePath' in proxyState) {
			this.state = proxyState;

			if (proxyState.filePath) {
				this.file = this.app.vault.getAbstractFileByPath(proxyState.filePath) as TFile;
			}

			// Re-render if already open
			const container = this.containerEl.children[1] as HTMLElement;
			if (container) {
				container.empty();
				await this.renderContent(container);
			}
		}

		return super.setState(state, result);
	}

	async onClose(): Promise<void> {
		// Clean up all event listeners
		this.eventManager.cleanup();
		
		// Clean up render component
		if (this.renderComponent) {
			this.renderComponent.unload();
			this.renderComponent = null;
		}
	}

	getState(): ProxyViewState {
		return this.state;
	}

	/**
	 * Gets the Perspecta plugin instance.
	 * Uses typed accessor instead of (this.app as any).
	 */
	private getPlugin(): { settings?: { proxyPreviewScale?: number } } | null {
		const app = this.app as { plugins?: { plugins?: Record<string, unknown> } };
		return app.plugins?.plugins?.['perspecta-obsidian'] as { settings?: { proxyPreviewScale?: number } } ?? null;
	}

	private async restoreArrangement(forceLatest = true): Promise<void> {
		if (!this.state.arrangementUid || !this.file) return;

		// Store references before closing
		const file = this.file;
		const plugin = this.getPlugin() as { restoreContext?: (file: TFile, forceLatest: boolean) => Promise<void> } | null;

		// Close this proxy window FIRST to prevent duplicates
		// The restoreContext will create new windows as needed
		this.leaf.detach();

		// Now restore the context for the file
		if (plugin && typeof plugin.restoreContext === 'function') {
			// Pass forceLatest to skip arrangement selector and use most recent
			await plugin.restoreContext(file, forceLatest);
		}
	}

	private async expandToFullWindow(): Promise<void> {
		if (!this.file) return;

		// Get the current window position/size
		const win = this.getPopoutWindow();
		const x = win?.screenX || 100;
		const y = win?.screenY || 100;

		// Close this proxy view
		this.leaf.detach();

		// Open the file in a new popout window at similar position
		const newLeaf = this.app.workspace.openPopoutLeaf({
			size: { width: 800, height: 600 }
		});

		await newLeaf.openFile(this.file);

		// Try to position the new window (may not work on all platforms)
		const newWin = newLeaf.view.containerEl.win;
		if (newWin && newWin !== window) {
			try {
				newWin.moveTo(x, y);
			} catch {
				// Silently fail - window positioning may not be allowed
			}
		}
	}
}
