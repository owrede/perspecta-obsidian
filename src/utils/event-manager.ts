/**
 * Utility functions for managing DOM event listeners with automatic cleanup
 */

export interface EventListenerCleanup {
	(): void;
}

export class EventManager {
	private static cleanupFunctions: EventListenerCleanup[] = [];

	/**
	 * Add an event listener with automatic cleanup tracking
	 */
	static addTrackedListener<K extends keyof HTMLElementEventMap>(
		element: HTMLElement,
		event: K,
		handler: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): EventListenerCleanup {
		element.addEventListener(event, handler, options);
		
		const cleanup = () => {
			element.removeEventListener(event, handler, options);
		};
		
		this.cleanupFunctions.push(cleanup);
		return cleanup;
	}

	/**
	 * Add an event listener to a window with automatic cleanup tracking
	 */
	static addTrackedWindowListener<K extends keyof WindowEventMap>(
		window: Window,
		event: K,
		handler: (this: Window, ev: WindowEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): EventListenerCleanup {
		window.addEventListener(event, handler, options);
		
		const cleanup = () => {
			window.removeEventListener(event, handler, options);
		};
		
		this.cleanupFunctions.push(cleanup);
		return cleanup;
	}

	/**
	 * Add an event listener to a document with automatic cleanup tracking
	 */
	static addTrackedDocumentListener<K extends keyof DocumentEventMap>(
		document: Document,
		event: K,
		handler: (this: Document, ev: DocumentEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): EventListenerCleanup {
		document.addEventListener(event, handler, options);
		
		const cleanup = () => {
			document.removeEventListener(event, handler, options);
		};
		
		this.cleanupFunctions.push(cleanup);
		return cleanup;
	}

	/**
	 * Clean up all tracked event listeners
	 */
	static cleanupAll(): void {
		this.cleanupFunctions.forEach(cleanup => {
			try {
				cleanup();
			} catch (error) {
				console.warn('[Perspecta] Error during event cleanup:', error);
			}
		});
		this.cleanupFunctions = [];
	}

	/**
	 * Remove a specific cleanup function from tracking
	 */
	static removeCleanup(cleanup: EventListenerCleanup): void {
		const index = this.cleanupFunctions.indexOf(cleanup);
		if (index > -1) {
			this.cleanupFunctions.splice(index, 1);
		}
	}
}

/**
 * Helper class for managing event listeners for a specific component
 */
export class ComponentEventManager {
	private cleanupFunctions: EventListenerCleanup[] = [];

	/**
	 * Add an event listener to this component's cleanup list
	 */
	addListener<K extends keyof HTMLElementEventMap>(
		element: HTMLElement,
		event: K,
		handler: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): void {
		element.addEventListener(event, handler, options);
		
		const cleanup = () => {
			element.removeEventListener(event, handler, options);
		};
		
		this.cleanupFunctions.push(cleanup);
	}

	/**
	 * Add an event listener to a window for this component
	 */
	addWindowListener<K extends keyof WindowEventMap>(
		window: Window,
		event: K,
		handler: (this: Window, ev: WindowEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions
	): void {
		window.addEventListener(event, handler, options);
		
		const cleanup = () => {
			window.removeEventListener(event, handler, options);
		};
		
		this.cleanupFunctions.push(cleanup);
	}

	/**
	 * Clean up all event listeners for this component
	 */
	cleanup(): void {
		this.cleanupFunctions.forEach(cleanup => {
			try {
				cleanup();
			} catch (error) {
				console.warn('[Perspecta] Error during component event cleanup:', error);
			}
		});
		this.cleanupFunctions = [];
	}

	/**
	 * Get the number of tracked listeners
	 */
	get listenerCount(): number {
		return this.cleanupFunctions.length;
	}
}
