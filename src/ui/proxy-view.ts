import { ItemView, WorkspaceLeaf, TFile, setIcon, Platform, MarkdownRenderer, Component } from 'obsidian';

export const PROXY_VIEW_TYPE = 'perspecta-proxy-view';

export interface ProxyViewState extends Record<string, unknown> {
	filePath: string;
	arrangementUid?: string;
}

// Try to get Electron's remote module for window manipulation
function getElectronRemote(): any {
	try {
		// Try @electron/remote first (newer Electron versions)
		return require('@electron/remote');
	} catch {
		try {
			// Fall back to electron.remote (older versions)
			return require('electron').remote;
		} catch {
			return null;
		}
	}
}

/**
 * ProxyNoteView - A minimalist window that represents a note
 *
 * Shows a scaled-down preview of the note content with:
 * - Clickable area to restore arrangement (if one exists)
 * - Expand button to open as normal window
 */
export class ProxyNoteView extends ItemView {
	private state: ProxyViewState = { filePath: '' };
	private file: TFile | null = null;
	private renderComponent: Component | null = null;

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
		this.renderContent(container);

		// Configure Electron window for minimal titlebar
		// Use multiple delays to catch the chrome at different stages of creation
		this.configureElectronWindow();
		setTimeout(() => this.configureElectronWindow(), 50);
		setTimeout(() => this.configureElectronWindow(), 150);
		setTimeout(() => this.configureElectronWindow(), 300);
	}

	private applyProxyWindowClass(): void {
		// Try multiple ways to get the window and add the class
		const win = this.containerEl.win || (this.leaf.view?.containerEl as any)?.win;
		if (win && win !== window && win.document?.body) {
			win.document.body.classList.add('perspecta-proxy-window');
		}

		// Also add to the workspace container for this leaf
		const workspaceEl = this.containerEl.closest('.workspace');
		if (workspaceEl) {
			workspaceEl.classList.add('perspecta-proxy-workspace');
		}
	}

	private configureElectronWindow(): void {
		// Get the window document for this popout
		const win = this.containerEl.win || (this.leaf.view?.containerEl as any)?.win;
		if (!win || win === window) return;

		const doc = win.document;
		if (!doc) return;

		// Remove the workspace tab header container (contains tabs, add button, menu)
		const headerEl = doc.querySelector('.workspace-tab-header-container');
		if (headerEl) {
			headerEl.remove();
		}

		// Remove/empty the titlebar (contains title and navigation)
		const titlebarEl = doc.querySelector('.titlebar');
		if (titlebarEl) {
			// Empty it instead of removing to preserve window dragging on some systems
			titlebarEl.innerHTML = '';
			(titlebarEl as HTMLElement).style.height = '0';
			(titlebarEl as HTMLElement).style.minHeight = '0';
		}

		// Also hide the view header within our leaf
		const viewHeader = doc.querySelector('.view-header');
		if (viewHeader) {
			(viewHeader as HTMLElement).style.display = 'none';
		}

		// Configure Electron window (minimum size, hide traffic lights on macOS)
		this.configureElectronBrowserWindow();
	}

	private configureElectronBrowserWindow(): void {
		const remote = getElectronRemote();
		if (!remote) return;

		// Get our window reference
		const win = this.containerEl.win || (this.leaf.view?.containerEl as any)?.win;
		if (!win || win === window) return;

		try {
			const allWindows = remote.BrowserWindow.getAllWindows();
			// Find our window by matching the native window handle
			for (const bw of allWindows) {
				// Try to match by comparing the web contents' window reference
				const webContents = bw.webContents;
				if (webContents) {
					try {
						// Check if this BrowserWindow's document matches our document
						const bwDoc = webContents.mainFrame?.window?.document;
						if (bwDoc === win.document) {
							this.applyBrowserWindowConfig(bw);
							return;
						}
					} catch {
						// Ignore errors from accessing window properties
					}
				}

				// Fallback: match by title containing the file basename
				const title = bw.getTitle?.() || '';
				if (this.file?.basename && title.includes(this.file.basename)) {
					this.applyBrowserWindowConfig(bw);
					return;
				}
			}

			// Last resort: configure all non-main windows that haven't been configured
			// This helps catch windows that might have timing issues
			for (const bw of allWindows) {
				if (!bw.isMainWindow?.() && bw.getMinimumSize?.()?.[0] !== 150) {
					const title = bw.getTitle?.() || '';
					// Only configure if it looks like a proxy (small title or contains file name)
					if (title.includes('Proxy') || (this.file?.basename && title.includes(this.file.basename))) {
						this.applyBrowserWindowConfig(bw);
					}
				}
			}
		} catch (e) {
			console.log('[Perspecta] Could not configure window:', e);
		}
	}

	private applyBrowserWindowConfig(bw: any): void {
		// Set minimum size constraint (don't override current size)
		bw.setMinimumSize(150, 40);

		// On macOS, hide the traffic light buttons
		if (Platform.isMacOS && typeof bw.setWindowButtonVisibility === 'function') {
			bw.setWindowButtonVisibility(false);
		}
	}

	private async renderContent(container: HTMLElement): Promise<void> {
		// Header row with title and expand button - this is the drag handle
		const headerRow = container.createDiv({ cls: 'perspecta-proxy-header' });

		// Make header draggable (for window movement)
		headerRow.style.cssText += '-webkit-app-region: drag; cursor: move;';

		// Note title (top left)
		headerRow.createDiv({
			cls: 'perspecta-proxy-title',
			text: this.file?.basename || 'No file'
		});

		// Expand button (top right) - must be no-drag to be clickable
		const expandBtn = headerRow.createDiv({ cls: 'perspecta-proxy-expand' });
		expandBtn.style.cssText += '-webkit-app-region: no-drag; cursor: pointer;';
		setIcon(expandBtn, 'maximize-2');
		expandBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.expandToFullWindow();
		});

		// Preview container with scaled content - this is scrollable and clickable
		const previewWrapper = container.createDiv({ cls: 'perspecta-proxy-preview-wrapper' });
		const previewContent = previewWrapper.createDiv({ cls: 'perspecta-proxy-preview-content' });

		// Apply scale from settings
		const plugin = (this.app as any).plugins.plugins['perspecta-obsidian'];
		const scale = plugin?.settings?.proxyPreviewScale ?? 0.35;
		const inverseScale = 100 / (scale * 100);
		previewContent.style.width = `${inverseScale * 100}%`;
		previewContent.style.height = `${inverseScale * 100}%`;
		previewContent.style.transform = `scale(${scale})`;

		// Render markdown content
		await this.renderMarkdownPreview(previewContent);

		// Make the preview wrapper scrollable and clickable for restore
		previewWrapper.style.overflow = 'auto';
		previewWrapper.style.cursor = 'pointer';

		// Enable pointer events on the preview content for scrolling
		previewContent.style.pointerEvents = 'auto';

		// Click on preview area triggers restore
		previewWrapper.addEventListener('click', (e) => {
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
		container.addEventListener('keydown', (e) => {
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
		container.addEventListener('mousedown', () => {
			container.focus();
		});

		// Add hover effect via JavaScript (more reliable than CSS in popout windows)
		previewWrapper.addEventListener('mouseenter', () => {
			previewWrapper.style.backgroundColor = 'var(--background-secondary)';
		});
		previewWrapper.addEventListener('mouseleave', () => {
			previewWrapper.style.backgroundColor = '';
		});
	}

	private async renderMarkdownPreview(container: HTMLElement): Promise<void> {
		if (!this.file) return;

		try {
			// Read the file content
			const content = await this.app.vault.cachedRead(this.file);

			// Clean up previous render component
			if (this.renderComponent) {
				this.renderComponent.unload();
			}

			// Create a new component for this render
			this.renderComponent = new Component();
			this.renderComponent.load();

			// Render markdown into the container
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

	async onClose(): Promise<void> {
		// Clean up render component
		if (this.renderComponent) {
			this.renderComponent.unload();
			this.renderComponent = null;
		}
	}

	async setState(state: ProxyViewState, result: any): Promise<void> {
		this.state = state;

		if (state.filePath) {
			this.file = this.app.vault.getAbstractFileByPath(state.filePath) as TFile;
		}

		// Re-render if already open
		const container = this.containerEl.children[1] as HTMLElement;
		if (container) {
			container.empty();
			this.renderContent(container);
		}

		return super.setState(state, result);
	}

	getState(): ProxyViewState {
		return this.state;
	}

	private async restoreArrangement(forceLatest: boolean = true): Promise<void> {
		if (!this.state.arrangementUid || !this.file) return;

		// Store references before closing
		const file = this.file;
		const plugin = (this.app as any).plugins.plugins['perspecta-obsidian'];

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
		const win = this.leaf.view.containerEl.win;
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
			} catch (e) {
				// Silently fail - window positioning may not be allowed
			}
		}
	}
}
