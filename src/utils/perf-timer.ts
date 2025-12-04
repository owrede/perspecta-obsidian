// ============================================================================
// Performance Timer
// ============================================================================

export class PerfTimer {
	private static enabled = false;
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
		const flag = elapsed > 50 ? '⚠ SLOW' : '✓';
		console.log(`[Perspecta]   ${flag} ${label}: ${elapsed.toFixed(1)}ms (total: ${fromStart.toFixed(1)}ms)`);
	}

	static end(operation: string) {
		if (!this.enabled) return;
		const total = performance.now() - this.start;
		console.log(`[Perspecta] ◼ ${operation} completed in ${total.toFixed(1)}ms`);
		if (this.times.length > 0) {
			console.log('[Perspecta] Full breakdown:');
			for (const t of this.times) {
				const flag = t.elapsed > 50 ? '⚠' : '✓';
				console.log(`  ${flag} ${t.label}: ${t.elapsed.toFixed(1)}ms (at ${t.fromStart.toFixed(1)}ms)`);
			}
		}
	}

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
