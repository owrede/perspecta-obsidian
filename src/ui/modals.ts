// ============================================================================
// Modal Components for Perspecta
// ============================================================================

import { TimestampedArrangement, WindowStateV2, WorkspaceNodeState } from '../types';

// SVG namespace
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Generate an SVG preview showing windows on a virtual screen (miniature view)
 */
function generateArrangementPreview(arrangement: TimestampedArrangement, width: number, height: number): SVGElement {
	const arr = arrangement.arrangement;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.classList.add('perspecta-arrangement-preview');

	const padding = 2;
	const cornerRadius = 2;

	// Get actual screen dimensions from the saved context
	const screenWidth = arr.sourceScreen?.width ?? 1920;
	const screenHeight = arr.sourceScreen?.height ?? 1080;

	// Calculate scale to fit screen in preview area
	const availableWidth = width - padding * 2;
	const availableHeight = height - padding * 2;
	const scale = Math.min(availableWidth / screenWidth, availableHeight / screenHeight);

	// Calculate actual screen size in preview and center it
	const scaledScreenWidth = screenWidth * scale;
	const scaledScreenHeight = screenHeight * scale;
	const screenX = padding + (availableWidth - scaledScreenWidth) / 2;
	const screenY = padding + (availableHeight - scaledScreenHeight) / 2;

	// Draw screen background
	const screenRect = createRect({
		x: screenX,
		y: screenY,
		width: scaledScreenWidth,
		height: scaledScreenHeight
	}, 'var(--background-modifier-border)', 'none', cornerRadius);
	svg.appendChild(screenRect);

	// Collect all windows
	const windows: { state: WindowStateV2; isMain: boolean }[] = [];
	if (arr.main) {
		windows.push({ state: arr.main, isMain: true });
	}
	if (arr.popouts) {
		arr.popouts.forEach(p => windows.push({ state: p, isMain: false }));
	}

	// Draw each window at its actual position (scaled)
	windows.forEach(({ state, isMain }) => {
		const x = state.x ?? 0;
		const y = state.y ?? 0;
		const w = state.width ?? 800;
		const h = state.height ?? 600;

		// Transform to preview coordinates
		const winRect: Rect = {
			x: screenX + x * scale,
			y: screenY + y * scale,
			width: w * scale,
			height: h * scale
		};

		// Draw window background (almost white border for all windows)
		const windowEl = createRect(
			winRect,
			'var(--background-primary)',
			'var(--background-primary-alt)',
			cornerRadius
		);
		windowEl.setAttribute('stroke-width', '1');
		svg.appendChild(windowEl);

		// Draw sidebars for main window
		if (isMain) {
			const sidebarWidth = Math.max(5, winRect.width * 0.18);
			const sidebarPadding = 2;

			// Left sidebar
			if (arr.leftSidebar && !arr.leftSidebar.collapsed) {
				const leftSidebar = createRect({
					x: winRect.x + sidebarPadding,
					y: winRect.y + sidebarPadding,
					width: sidebarWidth,
					height: winRect.height - sidebarPadding * 2
				}, 'var(--background-modifier-border)', 'none', 1);
				svg.appendChild(leftSidebar);
			}

			// Right sidebar
			if (arr.rightSidebar && !arr.rightSidebar.collapsed) {
				const rightSidebar = createRect({
					x: winRect.x + winRect.width - sidebarWidth - sidebarPadding,
					y: winRect.y + sidebarPadding,
					width: sidebarWidth,
					height: winRect.height - sidebarPadding * 2
				}, 'var(--background-modifier-border)', 'none', 1);
				svg.appendChild(rightSidebar);
			}
		}

		// Draw splits inside the window as dotted lines and tab areas with tooltips
		if (state.root) {
			drawSplitLines(svg, state.root, winRect);
			drawTabAreas(svg, state.root, winRect);
		}
	});

	// Draw focus highlight around the active tab group in the focused window
	const focusedWindowIndex = arr.focusedWindow ?? -1;
	let focusedState: WindowStateV2 | null = null;
	if (focusedWindowIndex === -1 && arr.main) {
		focusedState = arr.main;
	} else if (focusedWindowIndex >= 0 && arr.popouts && arr.popouts[focusedWindowIndex]) {
		focusedState = arr.popouts[focusedWindowIndex];
	}

	if (focusedState?.root) {
		const x = focusedState.x ?? 0;
		const y = focusedState.y ?? 0;
		const w = focusedState.width ?? 800;
		const h = focusedState.height ?? 600;
		const winRect: Rect = {
			x: screenX + x * scale,
			y: screenY + y * scale,
			width: w * scale,
			height: h * scale
		};
		drawFocusHighlight(svg, focusedState.root, winRect, cornerRadius);
	}

	return svg;
}

/**
 * Recursively draw dotted split lines inside a window
 */
function drawSplitLines(svg: SVGElement, node: WorkspaceNodeState, bounds: Rect): void {
	if (!node || node.type !== 'split') return;

	const children = node.children || [];
	if (children.length < 2) return;

	const sizes = node.sizes || children.map(() => 1 / children.length);
	const direction = node.direction;

	// Normalize sizes
	const totalSize = sizes.reduce((a, b) => a + b, 0);
	const normalizedSizes = sizes.map(s => s / totalSize);

	let offset = 0;
	children.forEach((child, i) => {
		const size = normalizedSizes[i] || (1 / children.length);

		// Draw split line before this child (except for first child)
		if (i > 0) {
			const line = document.createElementNS(SVG_NS, 'line');

			// In Obsidian: "vertical" direction = vertical divider line (panes side-by-side)
			//              "horizontal" direction = horizontal divider line (panes stacked)
			if (direction === 'vertical') {
				// Vertical split line (panes arranged left-to-right)
				const lineX = bounds.x + offset * bounds.width;
				line.setAttribute('x1', String(lineX));
				line.setAttribute('y1', String(bounds.y + 2));
				line.setAttribute('x2', String(lineX));
				line.setAttribute('y2', String(bounds.y + bounds.height - 2));
			} else {
				// Horizontal split line (panes arranged top-to-bottom)
				const lineY = bounds.y + offset * bounds.height;
				line.setAttribute('x1', String(bounds.x + 2));
				line.setAttribute('y1', String(lineY));
				line.setAttribute('x2', String(bounds.x + bounds.width - 2));
				line.setAttribute('y2', String(lineY));
			}

			line.setAttribute('stroke', 'var(--text-muted)');
			line.setAttribute('stroke-width', '1');
			line.setAttribute('stroke-dasharray', '2,2');
			line.setAttribute('opacity', '0.6');
			svg.appendChild(line);
		}

		// Calculate child bounds and recurse
		let childBounds: Rect;
		if (direction === 'vertical') {
			// Vertical direction: panes arranged left-to-right
			childBounds = {
				x: bounds.x + offset * bounds.width,
				y: bounds.y,
				width: size * bounds.width,
				height: bounds.height
			};
		} else {
			// Horizontal direction: panes arranged top-to-bottom
			childBounds = {
				x: bounds.x,
				y: bounds.y + offset * bounds.height,
				width: bounds.width,
				height: size * bounds.height
			};
		}

		drawSplitLines(svg, child, childBounds);
		offset += size;
	});
}

/**
 * Find and draw a colored border around the focused (active) tab group
 */
function drawFocusHighlight(svg: SVGElement, node: WorkspaceNodeState, bounds: Rect, cornerRadius: number): boolean {
	if (!node) return false;

	if (node.type === 'tabs') {
		// Check if this tab group has the active tab
		const hasActive = node.tabs?.some(t => t.active);
		if (hasActive) {
			// Draw colored border around this tab group
			const highlight = createRect(bounds, 'none', 'var(--interactive-accent)', cornerRadius);
			highlight.setAttribute('stroke-width', '1.5');
			svg.appendChild(highlight);
			return true;
		}
		return false;
	}

	if (node.type === 'split') {
		const children = node.children || [];
		if (children.length === 0) return false;

		const sizes = node.sizes || children.map(() => 1 / children.length);
		const direction = node.direction;

		const totalSize = sizes.reduce((a, b) => a + b, 0);
		const normalizedSizes = sizes.map(s => s / totalSize);

		let offset = 0;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			const size = normalizedSizes[i] || (1 / children.length);

			let childBounds: Rect;
			if (direction === 'vertical') {
				childBounds = {
					x: bounds.x + offset * bounds.width,
					y: bounds.y,
					width: size * bounds.width,
					height: bounds.height
				};
			} else {
				childBounds = {
					x: bounds.x,
					y: bounds.y + offset * bounds.height,
					width: bounds.width,
					height: size * bounds.height
				};
			}

			// Stop searching once we find and highlight the active tab group
			if (drawFocusHighlight(svg, child, childBounds, cornerRadius)) {
				return true;
			}
			offset += size;
		}
	}

	return false;
}

/**
 * Recursively draw transparent interactive areas for tab groups with tooltips
 */
function drawTabAreas(svg: SVGElement, node: WorkspaceNodeState, bounds: Rect): void {
	if (!node) return;

	if (node.type === 'tabs') {
		// This is a tab group - draw an interactive area with tooltip
		const tabs = node.tabs || [];
		if (tabs.length === 0) return;

		// Get note names for tooltip
		const noteNames = tabs.map(tab => {
			// Use name if available, otherwise extract from path
			if (tab.name) return tab.name;
			const path = tab.path || '';
			const fileName = path.split('/').pop() || path;
			return fileName.replace(/\.md$/, '');
		});

		// Build tooltip text
		const activeIndex = tabs.findIndex(t => t.active);
		let tooltipText: string;
		if (tabs.length === 1) {
			tooltipText = noteNames[0];
		} else {
			// Show all tabs, mark active one
			tooltipText = noteNames.map((name, i) =>
				i === activeIndex ? `▸ ${name}` : `  ${name}`
			).join('\n');
		}

		// Create transparent interactive rectangle
		const area = document.createElementNS(SVG_NS, 'rect');
		area.setAttribute('x', String(bounds.x));
		area.setAttribute('y', String(bounds.y));
		area.setAttribute('width', String(Math.max(0, bounds.width)));
		area.setAttribute('height', String(Math.max(0, bounds.height)));
		area.setAttribute('fill', 'transparent');
		area.setAttribute('class', 'perspecta-preview-tab-area');
		area.setAttribute('data-tooltip', tooltipText);

		svg.appendChild(area);
		return;
	}

	if (node.type === 'split') {
		// Recurse into children with calculated bounds
		const children = node.children || [];
		if (children.length === 0) return;

		const sizes = node.sizes || children.map(() => 1 / children.length);
		const direction = node.direction;

		// Normalize sizes
		const totalSize = sizes.reduce((a, b) => a + b, 0);
		const normalizedSizes = sizes.map(s => s / totalSize);

		let offset = 0;
		children.forEach((child, i) => {
			const size = normalizedSizes[i] || (1 / children.length);

			let childBounds: Rect;
			if (direction === 'vertical') {
				childBounds = {
					x: bounds.x + offset * bounds.width,
					y: bounds.y,
					width: size * bounds.width,
					height: bounds.height
				};
			} else {
				childBounds = {
					x: bounds.x,
					y: bounds.y + offset * bounds.height,
					width: bounds.width,
					height: size * bounds.height
				};
			}

			drawTabAreas(svg, child, childBounds);
			offset += size;
		});
	}
}

/**
 * Setup tooltip event handlers for preview tab areas
 */
function setupPreviewTooltips(container: HTMLElement, doc: Document): void {
	let tooltip: HTMLElement | null = null;

	const showTooltip = (e: MouseEvent) => {
		const target = e.target as SVGElement;
		const text = target.getAttribute('data-tooltip');
		if (!text) return;

		// Remove existing tooltip
		if (tooltip) tooltip.remove();

		tooltip = doc.createElement('div');
		tooltip.className = 'perspecta-preview-tooltip';
		tooltip.textContent = text;
		doc.body.appendChild(tooltip);

		// Position tooltip near cursor
		const rect = target.getBoundingClientRect();
		tooltip.style.left = `${rect.right + 8}px`;
		tooltip.style.top = `${rect.top}px`;

		// Adjust if tooltip goes off screen
		const tooltipRect = tooltip.getBoundingClientRect();
		if (tooltipRect.right > doc.documentElement.clientWidth) {
			tooltip.style.left = `${rect.left - tooltipRect.width - 8}px`;
		}
		if (tooltipRect.bottom > doc.documentElement.clientHeight) {
			tooltip.style.top = `${doc.documentElement.clientHeight - tooltipRect.height - 8}px`;
		}
	};

	const hideTooltip = () => {
		if (tooltip) {
			tooltip.remove();
			tooltip = null;
		}
	};

	container.addEventListener('mouseover', (e) => {
		if ((e.target as Element).classList.contains('perspecta-preview-tab-area')) {
			showTooltip(e as MouseEvent);
		}
	});

	container.addEventListener('mouseout', (e) => {
		if ((e.target as Element).classList.contains('perspecta-preview-tab-area')) {
			hideTooltip();
		}
	});

	// Clean up tooltip when container is removed
	const observer = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			mutation.removedNodes.forEach((node) => {
				if (node === container || (node as Element).contains?.(container)) {
					hideTooltip();
					observer.disconnect();
				}
			});
		});
	});
	observer.observe(doc.body, { childList: true, subtree: true });
}

/**
 * Create an SVG rect element
 */
function createRect(rect: Rect, fill: string, stroke: string, rx: number): SVGRectElement {
	const rectEl = document.createElementNS(SVG_NS, 'rect');
	rectEl.setAttribute('x', String(rect.x));
	rectEl.setAttribute('y', String(rect.y));
	rectEl.setAttribute('width', String(Math.max(0, rect.width)));
	rectEl.setAttribute('height', String(Math.max(0, rect.height)));
	rectEl.setAttribute('fill', fill);
	rectEl.setAttribute('stroke', stroke);
	rectEl.setAttribute('rx', String(rx));
	return rectEl;
}

// Format timestamp for display
function formatTimestamp(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday = date.toDateString() === yesterday.toDateString();

	const timeStr = date.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	});

	if (isToday) {
		return `Today at ${timeStr}`;
	} else if (isYesterday) {
		return `Yesterday at ${timeStr}`;
	} else {
		const dateStr = date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
		});
		return `${dateStr} at ${timeStr}`;
	}
}

// Get arrangement summary (number of windows and tabs)
function getArrangementSummary(arrangement: TimestampedArrangement): string {
	const arr = arrangement.arrangement;
	const windowCount = 1 + (arr.popouts?.length ?? 0);

	// Count tabs in main window
	let tabCount = 0;
	const countTabs = (node: unknown): void => {
		if (!node || typeof node !== 'object') return;
		const n = node as { type?: string; tabs?: unknown[]; children?: unknown[] };
		if (n.type === 'tabs' && Array.isArray(n.tabs)) {
			tabCount += n.tabs.length;
		} else if (n.type === 'split' && Array.isArray(n.children)) {
			n.children.forEach(countTabs);
		}
	};
	countTabs(arr.main?.root);
	arr.popouts?.forEach(p => countTabs(p.root));

	const windowText = windowCount === 1 ? '1 window' : `${windowCount} windows`;
	const tabText = tabCount === 1 ? '1 tab' : `${tabCount} tabs`;
	return `${windowText}, ${tabText}`;
}

export interface ArrangementSelectorResult {
	arrangement: TimestampedArrangement;
	cancelled: boolean;
	deleted?: number; // savedAt timestamp of deleted arrangement, if any
}

/**
 * Show a modal to select which arrangement to restore
 */
export function showArrangementSelector(
	arrangements: TimestampedArrangement[],
	fileName: string,
	onDelete?: (savedAt: number) => void,
	targetWindow: Window = window
): Promise<ArrangementSelectorResult> {
	return new Promise((resolve) => {
		const doc = targetWindow.document;

		const overlay = doc.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = doc.createElement('div');
		modal.className = 'perspecta-arrangement-selector';

		const title = modal.createDiv({ cls: 'perspecta-modal-title' });
		title.setText(`Select Arrangement - ${fileName}`);

		const subtitle = modal.createDiv({ cls: 'perspecta-modal-subtitle' });

		const updateSubtitle = (count: number) => {
			subtitle.setText(`${count} saved arrangement${count > 1 ? 's' : ''}`);
		};
		updateSubtitle(arrangements.length);

		const list = modal.createDiv({ cls: 'perspecta-arrangement-list' });

		// Sort by newest first
		const sorted = [...arrangements].sort((a, b) => b.savedAt - a.savedAt);

		const cleanup = () => {
			modal.remove();
			overlay.remove();
		};

		const renderList = () => {
			list.empty();

			// Filter out deleted items
			const remaining = sorted.filter(a => !deletedTimestamps.has(a.savedAt));
			updateSubtitle(remaining.length);

			// If no arrangements left, close the modal
			if (remaining.length === 0) {
				cleanup();
				resolve({ arrangement: sorted[0], cancelled: true });
				return;
			}

			remaining.forEach((arr, index) => {
				const item = list.createDiv({ cls: 'perspecta-arrangement-item' });

				// Add SVG preview
				const previewContainer = item.createDiv({ cls: 'perspecta-arrangement-preview-container' });
				const preview = generateArrangementPreview(arr, 80, 50);
				previewContainer.appendChild(preview);

				// Add tooltip handlers for tab areas
				setupPreviewTooltips(previewContainer, doc);

				const info = item.createDiv({ cls: 'perspecta-arrangement-info' });
				const timeLabel = info.createDiv({ cls: 'perspecta-arrangement-time' });
				timeLabel.setText(formatTimestamp(arr.savedAt));

				if (index === 0) {
					const badge = timeLabel.createSpan({ cls: 'perspecta-arrangement-badge' });
					badge.setText('Latest');
				}

				const summary = info.createDiv({ cls: 'perspecta-arrangement-summary' });
				summary.setText(getArrangementSummary(arr));

				// Delete button
				const deleteBtn = item.createDiv({ cls: 'perspecta-arrangement-delete' });
				deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10"/>
					<line x1="15" y1="9" x2="9" y2="15"/>
					<line x1="9" y1="9" x2="15" y2="15"/>
				</svg>`;
				deleteBtn.setAttribute('aria-label', 'Delete arrangement');

				deleteBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					deletedTimestamps.add(arr.savedAt);
					if (onDelete) {
						onDelete(arr.savedAt);
					}
					renderList();
				});

				item.addEventListener('click', () => {
					cleanup();
					resolve({ arrangement: arr, cancelled: false });
				});
			});
		};

		const deletedTimestamps = new Set<number>();
		renderList();

		const buttonRow = modal.createDiv({ cls: 'perspecta-modal-buttons' });
		const cancelBtn = buttonRow.createEl('button', {
			cls: 'perspecta-modal-button perspecta-modal-button-secondary',
			text: 'Cancel'
		});

		overlay.onclick = () => {
			cleanup();
			resolve({ arrangement: sorted[0], cancelled: true });
		};

		cancelBtn.addEventListener('click', () => {
			cleanup();
			resolve({ arrangement: sorted[0], cancelled: true });
		});

		doc.body.appendChild(overlay);
		doc.body.appendChild(modal);
	});
}

export interface ConfirmOverwriteResult {
	confirmed: boolean;
}

/**
 * Show a confirmation modal before overwriting an existing arrangement
 */
export function showConfirmOverwrite(
	existingArrangement: TimestampedArrangement,
	fileName: string,
	targetWindow: Window = window
): Promise<ConfirmOverwriteResult> {
	return new Promise((resolve) => {
		const doc = targetWindow.document;

		const overlay = doc.createElement('div');
		overlay.className = 'perspecta-debug-overlay';

		const modal = doc.createElement('div');
		modal.className = 'perspecta-confirm-modal';

		const title = modal.createDiv({ cls: 'perspecta-modal-title' });
		title.setText('Overwrite Arrangement?');

		const content = modal.createDiv({ cls: 'perspecta-confirm-content' });
		content.createDiv({ text: `"${fileName}" already has a saved arrangement:` });

		const existingInfo = content.createDiv({ cls: 'perspecta-existing-info' });

		// Add SVG preview
		const previewContainer = existingInfo.createDiv({ cls: 'perspecta-arrangement-preview-container' });
		const preview = generateArrangementPreview(existingArrangement, 80, 50);
		previewContainer.appendChild(preview);

		// Add tooltip handlers for tab areas
		setupPreviewTooltips(previewContainer, doc);

		const infoText = existingInfo.createDiv({ cls: 'perspecta-existing-info-text' });
		infoText.createDiv({
			cls: 'perspecta-arrangement-time',
			text: formatTimestamp(existingArrangement.savedAt)
		});
		infoText.createDiv({
			cls: 'perspecta-arrangement-summary',
			text: getArrangementSummary(existingArrangement)
		});

		content.createDiv({
			cls: 'perspecta-confirm-warning',
			text: 'This will replace the existing arrangement.'
		});

		const buttonRow = modal.createDiv({ cls: 'perspecta-modal-buttons' });

		const cancelBtn = buttonRow.createEl('button', {
			cls: 'perspecta-modal-button perspecta-modal-button-secondary',
			text: 'Cancel'
		});

		const confirmBtn = buttonRow.createEl('button', {
			cls: 'perspecta-modal-button perspecta-modal-button-primary',
			text: 'Overwrite'
		});

		const cleanup = () => {
			modal.remove();
			overlay.remove();
		};

		overlay.onclick = () => {
			cleanup();
			resolve({ confirmed: false });
		};

		cancelBtn.addEventListener('click', () => {
			cleanup();
			resolve({ confirmed: false });
		});

		confirmBtn.addEventListener('click', () => {
			cleanup();
			resolve({ confirmed: true });
		});

		doc.body.appendChild(overlay);
		doc.body.appendChild(modal);

		// Focus the confirm button for keyboard accessibility
		confirmBtn.focus();
	});
}
