/**
 * Desktop Wallpaper Utilities
 *
 * Provides safe, cross-platform wallpaper management using native OS commands.
 * This module uses child_process with strict input validation to prevent
 * command injection and other security vulnerabilities.
 *
 * @module utils/wallpaper
 *
 * ## Platform Support
 * - **macOS**: Full support using AppleScript
 * - **Windows**: Full support using PowerShell
 * - **Linux**: GNOME desktop environments using gsettings
 *
 * ## Security Notes
 * - Path validation prevents directory traversal attacks
 * - Shell metacharacter filtering prevents command injection
 * - Only image file extensions are accepted
 * - All paths are validated and escaped before shell execution
 *
 * ## Obsidian API Usage
 * - Uses `Platform` from 'obsidian' for platform detection
 *
 * ## Electron/Node.js API Usage
 * - Uses `child_process.execFile` for safe command execution (no shell)
 * - Available in Electron's main process context
 */

import { Platform } from 'obsidian';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { copyFile, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

/**
 * Result interface for wallpaper operations.
 * Provides consistent success/error handling across all functions.
 */
export interface WallpaperResult {
	/** Whether the operation succeeded */
	success: boolean;
	/** The wallpaper path (on success) */
	path?: string;
	/** Error message (on failure) */
	error?: string;
}

/**
 * Valid image file extensions that can be set as wallpapers.
 * These are validated before any wallpaper operation.
 */
const VALID_IMAGE_EXTENSIONS = new Set([
	'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif',
	'.webp', '.heic', '.heif', '.avif'
]);

/**
 * Maximum allowed path length to prevent buffer overflow attacks.
 * Most file systems have limits around 255-260 characters for filenames,
 * and 4096 for full paths.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * Characters that are dangerous in shell contexts.
 * Must be filtered/escaped before any shell command execution.
 */
const SHELL_METACHARACTERS = /[`$\\!"';&|<>(){}[\]*?~#]/;

/**
 * Patterns that indicate dangerous path manipulation.
 */
// eslint-disable-next-line no-control-regex -- Intentional for security: detecting control characters in paths
const DANGEROUS_PATH_PATTERNS = [
	/\0/,              // Null byte injection
	/\.\.[/\\]/,       // Directory traversal (../ or ..\)
	// eslint-disable-next-line no-control-regex
	/[\x00-\x1F]/,     // Control characters (except in file path segments)
];

/**
 * Validates a file path for safety before wallpaper operations.
 *
 * @param path - The path to validate
 * @returns Object with isValid boolean and optional error message
 *
 * @security
 * - Checks for null bytes that could truncate paths
 * - Checks for directory traversal attempts
 * - Checks for shell metacharacters that could enable injection
 * - Checks for control characters
 */
function validatePath(path: string): { isValid: boolean; error?: string } {
	// Check for empty or whitespace-only paths
	if (!path || typeof path !== 'string' || path.trim().length === 0) {
		return { isValid: false, error: 'Path is empty or invalid' };
	}

	// Check path length
	if (path.length > MAX_PATH_LENGTH) {
		return { isValid: false, error: `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters` };
	}

	// Check for dangerous path patterns
	for (const pattern of DANGEROUS_PATH_PATTERNS) {
		if (pattern.test(path)) {
			return { isValid: false, error: 'Path contains invalid characters or patterns' };
		}
	}

	// Check for shell metacharacters (critical for command injection prevention)
	if (SHELL_METACHARACTERS.test(path)) {
		return { isValid: false, error: 'Path contains characters not allowed in wallpaper paths' };
	}

	return { isValid: true };
}

/**
 * Validates that a path has a valid image extension for wallpapers.
 *
 * @param path - The path to validate
 * @returns Object with isValid boolean and optional error message
 */
function validateImageExtension(path: string): { isValid: boolean; error?: string } {
	const dotIndex = path.lastIndexOf('.');
	if (dotIndex === -1) {
		return { isValid: false, error: 'Path has no file extension' };
	}

	const ext = path.toLowerCase().substring(dotIndex);

	if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
		return {
			isValid: false,
			error: `Invalid image extension '${ext}'. Supported: ${Array.from(VALID_IMAGE_EXTENSIONS).join(', ')}`
		};
	}

	return { isValid: true };
}

/**
 * Escapes a path for safe use in AppleScript strings.
 * AppleScript uses backslash escaping for special characters.
 *
 * @param path - The path to escape
 * @returns Escaped path safe for AppleScript
 */
function escapeAppleScript(path: string): string {
	// In AppleScript, we need to escape backslashes and quotes
	return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Gets the current desktop wallpaper path on macOS.
 *
 * @returns Promise resolving to the wallpaper path or null
 */
async function getWallpaperMacOS(): Promise<string | null> {
	try {
		const script = 'tell application "System Events" to get picture of desktop 1';
		// Use execFile with array args to prevent shell injection
		const { stdout } = await execFileAsync('osascript', ['-e', script]);
		const path = stdout.trim();
		return path || null;
	} catch {
		return null;
	}
}

/**
 * Sets the desktop wallpaper on macOS using AppleScript.
 *
 * @param path - Validated path to the image file
 */
async function setWallpaperMacOS(path: string): Promise<void> {
	const escapedPath = escapeAppleScript(path);
	const script = `tell application "System Events" to set picture of desktop 1 to "${escapedPath}"`;
	// Use execFile with array args to prevent shell injection
	await execFileAsync('osascript', ['-e', script]);
}

/**
 * Gets the current desktop wallpaper path on Windows.
 *
 * @returns Promise resolving to the wallpaper path or null
 */
async function getWallpaperWindows(): Promise<string | null> {
	try {
		// Use PowerShell to read the registry value
		const psCommand = "(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper).Wallpaper";
		// Use execFile with array args to prevent shell injection
		const { stdout } = await execFileAsync('powershell', ['-Command', psCommand]);
		const path = stdout.trim();
		return path || null;
	} catch {
		return null;
	}
}

/**
 * Sets the desktop wallpaper on Windows using PowerShell.
 *
 * @param path - Validated path to the image file
 */
async function setWallpaperWindows(path: string): Promise<void> {
	// PowerShell command to set wallpaper via SystemParametersInfo
	// We use Add-Type to access Win32 API
	const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Wallpaper {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
"@
[Wallpaper]::SystemParametersInfo(0x0014, 0, '${path.replace(/'/g, "''")}', 0x0001 -bor 0x0002)
`;
	// Use execFile with array args to prevent shell injection
	await execFileAsync('powershell', ['-Command', psScript]);
}

/**
 * Gets the current desktop wallpaper path on Linux (GNOME).
 *
 * @returns Promise resolving to the wallpaper path or null
 */
async function getWallpaperLinux(): Promise<string | null> {
	try {
		// Use execFile with array args to prevent shell injection
		const { stdout } = await execFileAsync('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri']);
		let path = stdout.trim();

		// Remove quotes and file:// prefix
		path = path.replace(/^'|'$/g, '');
		if (path.startsWith('file://')) {
			path = decodeURIComponent(path.substring(7));
		}

		return path || null;
	} catch {
		return null;
	}
}

/**
 * Sets the desktop wallpaper on Linux (GNOME) using gsettings.
 *
 * @param path - Validated path to the image file
 */
async function setWallpaperLinux(path: string): Promise<void> {
	// GNOME expects a file:// URI
	const fileUri = `file://${encodeURIComponent(path).replace(/%2F/g, '/')}`;
	// Use execFile with array args to prevent shell injection
	await execFileAsync('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', fileUri]);

	// Also set for dark mode (GNOME 42+)
	try {
		await execFileAsync('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', fileUri]);
	} catch {
		// Ignore - older GNOME versions don't have this setting
	}
}

/**
 * Gets the current desktop wallpaper path.
 *
 * @returns Promise resolving to WallpaperResult with the current wallpaper path
 *
 * @example
 * ```typescript
 * const result = await getWallpaper();
 * if (result.success) {
 *   console.log('Current wallpaper:', result.path);
 * } else {
 *   console.error('Failed to get wallpaper:', result.error);
 * }
 * ```
 */
export async function getWallpaper(): Promise<WallpaperResult> {
	// Early return for mobile platforms (no wallpaper API)
	if (Platform.isMobile) {
		return { success: false, error: 'Wallpaper operations not supported on mobile' };
	}

	try {
		let path: string | null = null;

		if (Platform.isMacOS) {
			path = await getWallpaperMacOS();
		} else if (Platform.isWin) {
			path = await getWallpaperWindows();
		} else if (Platform.isLinux) {
			path = await getWallpaperLinux();
		} else {
			return { success: false, error: 'Platform not supported' };
		}

		if (!path) {
			return { success: false, error: 'Could not retrieve wallpaper path' };
		}

		return { success: true, path };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return { success: false, error: errorMessage };
	}
}

/**
 * Sets the desktop wallpaper to the specified image.
 *
 * @param path - Absolute path to the image file
 * @returns Promise resolving to WallpaperResult indicating success/failure
 *
 * @example
 * ```typescript
 * const result = await setWallpaper('/path/to/image.jpg');
 * if (result.success) {
 *   console.log('Wallpaper set successfully');
 * } else {
 *   console.error('Failed to set wallpaper:', result.error);
 * }
 * ```
 *
 * @security
 * - Validates path for dangerous characters and patterns
 * - Validates image file extension
 * - Shell metacharacters are blocked to prevent command injection
 */
export async function setWallpaper(path: string): Promise<WallpaperResult> {
	// Early return for mobile platforms (no wallpaper API)
	if (Platform.isMobile) {
		return { success: false, error: 'Wallpaper operations not supported on mobile' };
	}

	// Validate path safety
	const pathValidation = validatePath(path);
	if (!pathValidation.isValid) {
		return { success: false, error: pathValidation.error };
	}

	// Validate image extension
	const extValidation = validateImageExtension(path);
	if (!extValidation.isValid) {
		return { success: false, error: extValidation.error };
	}

	try {
		if (Platform.isMacOS) {
			await setWallpaperMacOS(path);
		} else if (Platform.isWin) {
			await setWallpaperWindows(path);
		} else if (Platform.isLinux) {
			await setWallpaperLinux(path);
		} else {
			return { success: false, error: 'Platform not supported' };
		}

		return { success: true, path };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return { success: false, error: errorMessage };
	}
}

/**
 * Checks if wallpaper operations are supported on the current platform.
 *
 * @returns true if wallpaper operations are supported
 *
 * @example
 * ```typescript
 * if (isWallpaperSupported()) {
 *   // Show wallpaper options in UI
 * }
 * ```
 */
export function isWallpaperSupported(): boolean {
	// Mobile platforms don't support wallpaper operations
	if (Platform.isMobile) return false;
	return Platform.isMacOS || Platform.isWin || Platform.isLinux;
}

/**
 * Gets platform-specific notes about wallpaper support.
 * Useful for displaying in settings UI to inform users of limitations.
 *
 * @returns Human-readable description of wallpaper support for current platform
 */
export function getWallpaperPlatformNotes(): string {
	if (Platform.isMacOS) {
		return 'macOS: Changes apply to active desktop space only.';
	} else if (Platform.isWin) {
		return 'Windows: Full support via SystemParametersInfo API.';
	} else if (Platform.isLinux) {
		return 'Linux: GNOME desktop environments only (uses gsettings).';
	}
	return 'Platform not supported for wallpaper operations.';
}

/**
 * Validates a wallpaper path without performing any operations.
 * Useful for checking paths before saving context.
 *
 * @param path - The path to validate
 * @returns Object with isValid boolean and optional error message
 */
export function validateWallpaperPath(path: string): { isValid: boolean; error?: string } {
	const pathValidation = validatePath(path);
	if (!pathValidation.isValid) {
		return pathValidation;
	}

	return validateImageExtension(path);
}

/**
 * Generates a short hash from a file path for unique naming.
 * Uses first 8 characters of SHA-256 hash.
 *
 * @param path - The path to hash
 * @returns 8-character hex hash string
 */
function hashPath(path: string): string {
	return createHash('sha256').update(path).digest('hex').substring(0, 8);
}

/**
 * Copies a wallpaper from its source location to a local directory.
 * Creates a unique filename based on the original filename and source path hash.
 *
 * @param sourcePath - Absolute path to the source wallpaper image
 * @param destDir - Absolute path to the destination directory
 * @returns Promise resolving to WallpaperResult with the new local path
 *
 * @example
 * ```typescript
 * const result = await copyWallpaperToLocal('/path/to/wallpaper.jpg', '/vault/perspecta/wallpapers');
 * if (result.success) {
 *   console.log('Copied to:', result.path);
 * }
 * ```
 *
 * @security
 * - Validates source path for dangerous patterns
 * - Validates image extension
 * - Creates destination directory if needed
 */
export async function copyWallpaperToLocal(
	sourcePath: string,
	destDir: string
): Promise<WallpaperResult> {
	// Validate source path
	const pathValidation = validatePath(sourcePath);
	if (!pathValidation.isValid) {
		return { success: false, error: `Invalid source path: ${pathValidation.error}` };
	}

	const extValidation = validateImageExtension(sourcePath);
	if (!extValidation.isValid) {
		return { success: false, error: extValidation.error };
	}

	try {
		// Check if source file exists
		const sourceStats = await stat(sourcePath);
		if (!sourceStats.isFile()) {
			return { success: false, error: 'Source path is not a file' };
		}

		// Create destination directory if it doesn't exist
		if (!existsSync(destDir)) {
			await mkdir(destDir, { recursive: true });
		}

		// Generate unique filename: originalname_hash.ext
		const originalName = basename(sourcePath, extname(sourcePath));
		const ext = extname(sourcePath);
		const pathHash = hashPath(sourcePath);
		const destFilename = `${originalName}_${pathHash}${ext}`;
		const destPath = join(destDir, destFilename);

		// Skip copy if file already exists (same content assumed)
		if (existsSync(destPath)) {
			return { success: true, path: destPath };
		}

		// Copy the file
		await copyFile(sourcePath, destPath);

		return { success: true, path: destPath };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return { success: false, error: `Failed to copy wallpaper: ${errorMessage}` };
	}
}

/**
 * Gets the wallpapers directory path within a vault's Perspecta folder.
 *
 * @param vaultPath - Absolute path to the vault
 * @param perspectaFolder - Name of the Perspecta folder (default: 'perspecta')
 * @returns Absolute path to the wallpapers directory
 */
export function getWallpapersDir(vaultPath: string, perspectaFolder = 'perspecta'): string {
	return join(vaultPath, perspectaFolder, 'wallpapers');
}
