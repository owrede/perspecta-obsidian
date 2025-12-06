# Perspecta

**Save and restore window arrangements in Obsidian**

> **WARNING: Alpha Software**
>
> This plugin is currently in early development (alpha). Use at your own risk!
>
> **Please backup your vault before using this plugin.** While we take care to avoid data loss, unexpected behavior may occur.

## Description

Perspecta is an Obsidian plugin for saving and restoring window arrangements. It allows you to capture the complete visual state of your workspace—including tabs, splits, and popout windows—and restore it later. This is particularly useful for:

- **Project-based workflows**: Save different window layouts for different projects or tasks
- **Research contexts**: Quickly switch between different research setups
- **Multi-display setups**: Restore complex window arrangements across multiple monitors

## Features

### Context: Save and restore windows/tabs in the context of one note

Core functionality for saving and restoring window arrangements. You can save several window arrangements per note.

- **Save & Restore Window Arrangements**: Capture tabs, splits, and popout windows
- **Split Size Preservation**: Restore exact split proportions (e.g., 30%/70% layouts)
- **Scroll Position Restoration**: Each tab's scroll position is saved and restored
- **Canvas Viewport Restoration**: Canvas pan position and zoom level are preserved
- **Multiple File Type Support**: Works with markdown (.md), canvas (.canvas), and base (.base) files
- **Smart File Tracking**: Auto-generated UIDs ensure files are found even after renaming or moving
- **Multi-Display Support**: Virtual coordinate system handles different screen configurations
- **Focus Highlight**: Brief visual highlight on restored notes (configurable duration)
- **File Explorer Indicators**: Visual markers show which files have saved contexts

### Storage: Decide how the data is stored (within the note or in the plugin folder)

Options for where and how context data is stored.

- **Frontmatter Mode** (Default): Store context directly in your notes
  - Data stays with your notes and survives plugin removal
  - Adds a `perspecta-arrangement` property to your frontmatter
- **External Mode**: Keep your frontmatter clean with separate storage
  - Context stored in `.obsidian/plugins/perspecta-obsidian/contexts/`
  - Supports multiple arrangements per note (up to 5)
  - Arrangement selector with visual SVG previews
  - Auto-confirm option for single-arrangement overwrites

### Backup and restore the plugin data

Protect your saved arrangements.

- **Create Backups**: Save all arrangements to the perspecta folder
- **Restore from Backup**: Recover arrangements from previous backups
- **Timestamped Backups**: Multiple backup versions with dates

### Experimental features

Features still in development.

- **Proxy Windows**: Minimalist windows showing scaled note previews
  - Drag the title bar to move the window
  - Scroll content with mouse wheel or keyboard (↑/↓, j/k, Page Up/Down)
  - Click preview to restore the full arrangement
  - Configurable preview scale (default 35%)

### Debug options

Tools for troubleshooting.

- **Debug Modal**: Show context details when saving
- **Performance Logging**: Log timing to developer console

## Installation

### Via BRAT (Recommended for beta testing)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Open BRAT settings
3. Click "Add Beta Plugin"
4. Enter: `owrede/perspecta-obsidian`
5. Click "Add Plugin"
6. Enable Perspecta in Community Plugins


## Usage

### Commands

All commands are available via the Command Palette (`Cmd+P` / `Ctrl+P`):

| Command | Description |
|---------|-------------|
| **Save context** | Save the current window arrangement (tabs, splits, popouts) to the active note. |
| **Restore context** | Restore the window arrangement saved in the active note. |
| **Show context details** | Display a visualization of the saved context (tabs, windows, positions). |
| **Convert to proxy window** ⚗️ | Convert the current popout window to a minimalist proxy window. *(Experimental: Enable in Settings → Experimental)* |

## Important Notes

### Storage Mode Warning

> **WARNING**: External storage mode stores data in the plugin folder. **All saved contexts will be lost if the plugin is removed or reinstalled.** Use Frontmatter mode if you value data persistence, or create regular backups via Settings → Backup.

### Unique IDs (UIDs)

Perspecta adds a `perspecta-uid` property to notes in saved contexts:

```yaml
---
perspecta-uid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
---
```

This allows files to be found even after renaming or moving them.

## Tip

As this plugin mostly provides two simple functions (saving a window arrangement and restoring it) it uses two hotkeys only. If you have a mouse like Logitech MX Master that offers extra configurable keys, using the store/restore with mouse keys makes navigating with Perspecta very convenient!


## License

MIT
