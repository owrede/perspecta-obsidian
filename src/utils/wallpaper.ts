/**
 * Desktop Wallpaper Utilities
 *
 * EXPERIMENTAL: Read and set desktop wallpaper across platforms.
 * Currently supports macOS, with Windows/Linux planned.
 */

import { Platform } from 'obsidian';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface WallpaperResult {
	success: boolean;
	path?: string;
	error?: string;
}

/**
 * Get the current desktop wallpaper path
 */
export async function getWallpaper(): Promise<WallpaperResult> {
	if (Platform.isMacOS) {
		return getWallpaperMacOS();
	} else if (Platform.isWin) {
		return getWallpaperWindows();
	} else if (Platform.isLinux) {
		return getWallpaperLinux();
	}
	return { success: false, error: 'Unsupported platform' };
}

/**
 * Set the desktop wallpaper
 */
export async function setWallpaper(path: string): Promise<WallpaperResult> {
	if (!path) {
		return { success: false, error: 'No path provided' };
	}

	if (Platform.isMacOS) {
		return setWallpaperMacOS(path);
	} else if (Platform.isWin) {
		return setWallpaperWindows(path);
	} else if (Platform.isLinux) {
		return setWallpaperLinux(path);
	}
	return { success: false, error: 'Unsupported platform' };
}

// ============================================================================
// macOS Implementation
// ============================================================================

async function getWallpaperMacOS(): Promise<WallpaperResult> {
	try {
		// Use AppleScript to get the current wallpaper
		const script = `
			tell application "System Events"
				tell current desktop
					get picture
				end tell
			end tell
		`;
		const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
		const path = stdout.trim();

		if (path && path !== 'missing value') {
			return { success: true, path };
		}
		return { success: false, error: 'Could not get wallpaper path' };
	} catch (e) {
		// Try alternative method for newer macOS versions
		try {
			const { stdout } = await execAsync(
				`osascript -e 'tell application "System Events" to get picture of desktop 1'`
			);
			const path = stdout.trim();
			if (path && path !== 'missing value') {
				return { success: true, path };
			}
		} catch {
			// Ignore secondary error
		}
		return { success: false, error: (e as Error).message };
	}
}

async function setWallpaperMacOS(path: string): Promise<WallpaperResult> {
	try {
		// Escape the path for AppleScript
		const escapedPath = path.replace(/"/g, '\\"');

		// Use AppleScript to set the wallpaper
		const script = `
			tell application "System Events"
				tell current desktop
					set picture to "${escapedPath}"
				end tell
			end tell
		`;
		await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
		return { success: true, path };
	} catch (e) {
		// Try alternative method
		try {
			const escapedPath = path.replace(/"/g, '\\"');
			await execAsync(
				`osascript -e 'tell application "System Events" to set picture of desktop 1 to "${escapedPath}"'`
			);
			return { success: true, path };
		} catch {
			// Ignore secondary error
		}
		return { success: false, error: (e as Error).message };
	}
}

// ============================================================================
// Windows Implementation (Basic)
// ============================================================================

async function getWallpaperWindows(): Promise<WallpaperResult> {
	try {
		// Use PowerShell to read from registry
		const { stdout } = await execAsync(
			`powershell -command "(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper).Wallpaper"`
		);
		const path = stdout.trim();
		if (path) {
			return { success: true, path };
		}
		return { success: false, error: 'Could not get wallpaper path' };
	} catch (e) {
		return { success: false, error: (e as Error).message };
	}
}

async function setWallpaperWindows(path: string): Promise<WallpaperResult> {
	try {
		// Use PowerShell to set wallpaper via SystemParametersInfo
		const escapedPath = path.replace(/'/g, "''");
		const script = `
			Add-Type -TypeDefinition @"
			using System;
			using System.Runtime.InteropServices;
			public class Wallpaper {
				[DllImport("user32.dll", CharSet = CharSet.Auto)]
				public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
			}
"@
			[Wallpaper]::SystemParametersInfo(0x0014, 0, '${escapedPath}', 0x0001 -bor 0x0002)
		`;
		await execAsync(`powershell -command "${script.replace(/"/g, '\\"')}"`);
		return { success: true, path };
	} catch (e) {
		return { success: false, error: (e as Error).message };
	}
}

// ============================================================================
// Linux Implementation (GNOME-based)
// ============================================================================

async function getWallpaperLinux(): Promise<WallpaperResult> {
	try {
		// Try GNOME gsettings first
		const { stdout } = await execAsync(
			`gsettings get org.gnome.desktop.background picture-uri`
		);
		let path = stdout.trim().replace(/^'|'$/g, '');

		// Remove file:// prefix if present
		if (path.startsWith('file://')) {
			path = decodeURIComponent(path.substring(7));
		}

		if (path) {
			return { success: true, path };
		}
		return { success: false, error: 'Could not get wallpaper path' };
	} catch (e) {
		return { success: false, error: (e as Error).message + ' (only GNOME is currently supported)' };
	}
}

async function setWallpaperLinux(path: string): Promise<WallpaperResult> {
	try {
		// Use GNOME gsettings
		const fileUri = path.startsWith('file://') ? path : `file://${path}`;
		await execAsync(
			`gsettings set org.gnome.desktop.background picture-uri '${fileUri}'`
		);
		// Also set for dark mode
		try {
			await execAsync(
				`gsettings set org.gnome.desktop.background picture-uri-dark '${fileUri}'`
			);
		} catch {
			// Ignore - older GNOME versions don't have this
		}
		return { success: true, path };
	} catch (e) {
		return { success: false, error: (e as Error).message + ' (only GNOME is currently supported)' };
	}
}

/**
 * Check if wallpaper operations are supported on this platform
 */
export function isWallpaperSupported(): boolean {
	return Platform.isMacOS || Platform.isWin || Platform.isLinux;
}

/**
 * Get platform-specific notes about wallpaper support
 */
export function getWallpaperPlatformNotes(): string {
	if (Platform.isMacOS) {
		return 'macOS: Full support via AppleScript';
	} else if (Platform.isWin) {
		return 'Windows: Support via PowerShell (may require permissions)';
	} else if (Platform.isLinux) {
		return 'Linux: GNOME desktop only (gsettings)';
	}
	return 'Platform not supported';
}
