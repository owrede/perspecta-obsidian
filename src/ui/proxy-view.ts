import { ItemView, WorkspaceLeaf, TFile, setIcon, Platform } from 'obsidian';

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
 * Shows only the note title with:
 * - Clickable title to restore arrangement (if one exists)
 * - Expand button to open as normal window
 */
export class ProxyNoteView extends ItemView {
	private state: ProxyViewState = { filePath: '' };
	private file: TFile | null = null;
	private originalTitleBarStyle: string | null = null;

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

		try {
			const allWindows = remote.BrowserWindow.getAllWindows();
			// Find our window - it should be the one with our view type in title or most recently created
			for (const bw of allWindows) {
				const title = bw.getTitle?.() || '';
				if (title.includes('Proxy') || title.includes(this.file?.basename || '')) {
					// Set minimum size constraint (don't override current size)
					bw.setMinimumSize(150, 40);

					// On macOS, hide the traffic light buttons
					if (Platform.isMacOS && typeof bw.setWindowButtonVisibility === 'function') {
						bw.setWindowButtonVisibility(false);
					}
					break;
				}
			}
		} catch (e) {
			console.log('[Perspecta] Could not configure window:', e);
		}
	}

	private renderContent(container: HTMLElement): void {
		// Make the whole container clickable to restore arrangement
		if (this.state.arrangementUid) {
			container.addEventListener('click', (e) => {
				// Don't trigger if clicking the expand button
				if ((e.target as HTMLElement).closest('.perspecta-proxy-expand')) return;
				// Hold Shift to show arrangement selector, otherwise use latest
				const forceLatest = !e.shiftKey;
				this.restoreArrangement(forceLatest);
			});
		}

		// Add hover effect via JavaScript (more reliable than CSS in popout windows)
		container.addEventListener('mouseenter', () => {
			container.style.backgroundColor = 'var(--background-secondary)';
		});
		container.addEventListener('mouseleave', () => {
			container.style.backgroundColor = 'var(--background-primary)';
		});

		// Title row
		const titleRow = container.createDiv({ cls: 'perspecta-proxy-title-row' });

		// Note title (top left)
		titleRow.createDiv({
			cls: 'perspecta-proxy-title',
			text: this.file?.basename || 'No file'
		});

		// Expand button (top right)
		const expandBtn = titleRow.createDiv({ cls: 'perspecta-proxy-expand' });
		setIcon(expandBtn, 'maximize-2');
		expandBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.expandToFullWindow();
		});
	}

	async onClose(): Promise<void> {
		// Cleanup
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

		// Get the plugin instance to call restoreContext
		const plugin = (this.app as any).plugins.plugins['perspecta-obsidian'];
		if (plugin && typeof plugin.restoreContext === 'function') {
			// Pass forceLatest to skip arrangement selector and use most recent
			await plugin.restoreContext(this.file, forceLatest);
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
