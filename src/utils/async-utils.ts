/**
 * Utility functions for reliable async operations and timing
 */

import { TIMING } from './constants';

/**
 * Creates a promise that resolves after a specified delay
 */
export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a promise that resolves after a short delay (50ms)
 */
export function briefPause(): Promise<void> {
	return delay(TIMING.BRIEF_PAUSE_DELAY);
}

/**
 * Creates a promise that resolves after a medium delay (100ms)
 */
export function shortPause(): Promise<void> {
	return delay(TIMING.WINDOW_SPLIT_DELAY);
}

/**
 * Creates a promise that resolves after a long delay (200ms)
 */
export function longPause(): Promise<void> {
	return delay(TIMING.SCROLL_RESTORATION_DELAY);
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryAsync<T>(
	operation: () => Promise<T>,
	maxAttempts = 3,
	baseDelay = 100
): Promise<T> {
	let lastError: Error = new Error('retryAsync: no attempts made');

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt === maxAttempts) {
				break;
			}

			const delayMs = baseDelay * Math.pow(2, attempt - 1);
			await delay(delayMs);
		}
	}

	throw lastError;
}

/**
 * Execute a function with a timeout
 */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
		})
	]);
}

/**
 * Debounce function for async operations
 */
export function debounceAsync<T extends unknown[], R>(
	fn: (...args: T) => Promise<R>,
	delay: number
): (...args: T) => Promise<R> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let pendingPromise: Promise<R> | null = null;

	return (...args: T): Promise<R> => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		pendingPromise = new Promise<R>((resolve, reject) => {
			timeoutId = setTimeout(async () => {
				try {
					const result = await fn(...args);
					resolve(result);
				} catch (error) {
					reject(error);
				} finally {
					timeoutId = null;
					pendingPromise = null;
				}
			}, delay);
		});

		return pendingPromise;
	};
}

/**
 * Wait for a condition to become true with timeout
 */
export async function waitForCondition(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	intervalMs = 50
): Promise<void> {
	const startTime = Date.now();
	
	while (Date.now() - startTime < timeoutMs) {
		if (await condition()) {
			return;
		}
		await delay(intervalMs);
	}
	
	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Safe setTimeout that returns a cleanup function
 */
export function safeTimeout(
	callback: () => void,
	delay: number
): () => void {
	const timeoutId = setTimeout(callback, delay);
	return () => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	};
}
