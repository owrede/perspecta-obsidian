/**
 * File Resolution Utilities
 *
 * Provides robust file resolution with multiple fallback strategies.
 * This module ensures files can be found even after moving or renaming.
 *
 * @module utils/file-resolver
 *
 * ## Resolution Strategies
 * Files are resolved in this order:
 * 1. **Path**: Direct path lookup (fastest)
 * 2. **UID**: Match by perspecta-uid frontmatter property
 * 3. **Name**: Match by filename (basename)
 *
 * ## Obsidian API Usage
 * - `App.vault.getAbstractFileByPath()` - Primary file lookup
 * - `App.vault.getMarkdownFiles()` - List files for UID/name search
 * - `App.vault.getFiles()` - List all files including non-markdown
 * - `App.metadataCache.getFileCache()` - Access frontmatter for UID lookup
 *
 * ## Security Notes
 * - Path validation prevents access outside vault
 * - File type validation ensures only supported files are resolved
 */

import { App, TFile } from 'obsidian';
import { TabState, UID_FRONTMATTER_KEY } from '../types';

/**
 * Resolution method used to find a file.
 * Used for tracking how files were resolved and updating stored paths.
 */
export type ResolutionMethod = 'path' | 'uid' | 'name' | 'not_found';

/**
 * Result of file resolution.
 */
export interface FileResolutionResult {
	/** The resolved file, or null if not found */
	file: TFile | null;
	/** The method used to resolve the file */
	method: ResolutionMethod;
	/** Error message if resolution failed */
	error?: string;
}

/**
 * Cache entry for UID-based file lookup.
 * Improves performance by caching UID to file mappings.
 */
interface UidCacheEntry {
	file: TFile;
	timestamp: number;
}

// Module-level cache for UID lookups
const uidCache = new Map<string, UidCacheEntry>();
const UID_CACHE_TTL = 60000; // 1 minute TTL

/**
 * Supported file extensions that can be resolved.
 */
const SUPPORTED_EXTENSIONS = new Set(['md', 'canvas', 'base']);

/**
 * Validates a file path for safety.
 *
 * @param path - Path to validate
 * @returns true if path is safe
 */
function isValidPath(path: string): boolean {
	if (!path || typeof path !== 'string') {
		return false;
	}

	// Check for empty or whitespace
	if (path.trim().length === 0) {
		return false;
	}

	// Check for directory traversal attempts
	if (path.includes('..')) {
		return false;
	}

	// Check for absolute paths (shouldn't happen in Obsidian)
	if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
		return false;
	}

	return true;
}

/**
 * Gets the UID from a file's frontmatter cache.
 *
 * @param app - Obsidian App instance
 * @param file - File to check
 * @returns UID string or undefined
 *
 * @see UID_FRONTMATTER_KEY for the property name used
 */
export function getUidFromCache(app: App, file: TFile): string | undefined {
	const cache = app.metadataCache.getFileCache(file);
	const uid = cache?.frontmatter?.[UID_FRONTMATTER_KEY];
	return typeof uid === 'string' ? uid : undefined;
}

/**
 * Builds or refreshes the UID cache for faster lookups.
 *
 * @param app - Obsidian App instance
 */
function refreshUidCache(app: App): void {
	const now = Date.now();

	// Clear expired entries
	for (const [uid, entry] of uidCache.entries()) {
		if (now - entry.timestamp > UID_CACHE_TTL) {
			uidCache.delete(uid);
		}
	}

	// Build cache from all markdown files
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		const uid = getUidFromCache(app, file);
		if (uid) {
			uidCache.set(uid, { file, timestamp: now });
		}
	}
}

/**
 * Resolves a file using the UID fallback strategy.
 *
 * @param app - Obsidian App instance
 * @param uid - UID to search for
 * @returns Resolved file or null
 */
function resolveByUid(app: App, uid: string): TFile | null {
	// Check cache first
	const cached = uidCache.get(uid);
	if (cached && Date.now() - cached.timestamp < UID_CACHE_TTL) {
		// Verify file still exists
		const exists = app.vault.getAbstractFileByPath(cached.file.path);
		if (exists instanceof TFile) {
			return cached.file;
		}
		// Cache entry is stale, remove it
		uidCache.delete(uid);
	}

	// Refresh cache and search
	refreshUidCache(app);
	const entry = uidCache.get(uid);
	return entry?.file ?? null;
}

/**
 * Resolves a file using the filename fallback strategy.
 * Only returns a match if exactly one file with that name exists.
 *
 * @param app - Obsidian App instance
 * @param name - Filename (without extension) to search for
 * @param extension - File extension to filter by
 * @returns Resolved file or null
 */
function resolveByName(app: App, name: string, extension: string): TFile | null {
	if (!name) {
		return null;
	}

	// Get all files with matching extension
	const allFiles = app.vault.getFiles();
	const matches = allFiles.filter(f =>
		f.basename === name && f.extension === extension
	);

	// Only return if exactly one match (ambiguous otherwise)
	if (matches.length === 1) {
		return matches[0];
	}

	return null;
}

/**
 * Resolves a file using multiple fallback strategies.
 * Tries path first, then UID, then filename.
 *
 * @param app - Obsidian App instance
 * @param tab - Tab state containing path, uid, and name
 * @returns Resolution result with file and method used
 *
 * @example
 * ```typescript
 * const result = resolveFile(app, { path: 'notes/file.md', uid: 'abc123', name: 'file' });
 * if (result.file) {
 *   console.log(`Found via ${result.method}: ${result.file.path}`);
 * } else {
 *   console.log('File not found');
 * }
 * ```
 */
export function resolveFile(app: App, tab: TabState): FileResolutionResult {
	// Validate path
	if (!isValidPath(tab.path)) {
		return { file: null, method: 'not_found', error: 'Invalid path' };
	}

	// Strategy 1: Direct path lookup
	const fileByPath = app.vault.getAbstractFileByPath(tab.path);
	if (fileByPath instanceof TFile) {
		return { file: fileByPath, method: 'path' };
	}

	// Strategy 2: UID lookup (for markdown files)
	if (tab.uid) {
		const fileByUid = resolveByUid(app, tab.uid);
		if (fileByUid) {
			return { file: fileByUid, method: 'uid' };
		}
	}

	// Strategy 3: Name lookup
	if (tab.name) {
		// Extract extension from original path
		const ext = tab.path.split('.').pop() || 'md';
		if (SUPPORTED_EXTENSIONS.has(ext)) {
			const fileByName = resolveByName(app, tab.name, ext);
			if (fileByName) {
				return { file: fileByName, method: 'name' };
			}
		}
	}

	return { file: null, method: 'not_found', error: `File not found: ${tab.path}` };
}

/**
 * Resolves multiple files in batch.
 * More efficient than resolving one at a time when dealing with many files.
 *
 * @param app - Obsidian App instance
 * @param tabs - Array of tab states to resolve
 * @returns Map of original paths to resolution results
 */
export function resolveFiles(app: App, tabs: TabState[]): Map<string, FileResolutionResult> {
	// Pre-populate UID cache for efficiency
	refreshUidCache(app);

	const results = new Map<string, FileResolutionResult>();

	for (const tab of tabs) {
		results.set(tab.path, resolveFile(app, tab));
	}

	return results;
}

/**
 * Clears the UID cache.
 * Useful when files have been modified externally.
 */
export function clearUidCache(): void {
	uidCache.clear();
}

/**
 * Gets stats about the UID cache.
 * Useful for debugging and monitoring.
 *
 * @returns Cache statistics
 */
export function getUidCacheStats(): { size: number; oldestEntry: number | null } {
	let oldest: number | null = null;
	const now = Date.now();

	for (const entry of uidCache.values()) {
		const age = now - entry.timestamp;
		if (oldest === null || age > oldest) {
			oldest = age;
		}
	}

	return {
		size: uidCache.size,
		oldestEntry: oldest
	};
}

/**
 * Validates that a file path points to a supported file type.
 *
 * @param path - Path to validate
 * @returns true if file type is supported
 */
export function isSupportedFileType(path: string): boolean {
	if (!path) return false;
	const ext = path.split('.').pop()?.toLowerCase();
	return ext ? SUPPORTED_EXTENSIONS.has(ext) : false;
}

/**
 * Extracts the filename without extension from a path.
 *
 * @param path - File path
 * @returns Filename without extension
 */
export function getBasename(path: string): string {
	const filename = path.split('/').pop() || path;
	const dotIndex = filename.lastIndexOf('.');
	return dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
}
