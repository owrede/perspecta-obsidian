# Perspecta

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

- **Save & Restore Window Arrangements**: Capture tabs, splits, and popout windows
- **Multiple File Type Support**: Works with markdown (.md), canvas (.canvas), and base (.base) files
- **Smart File Tracking**: UIDs ensure files are found even after renaming or moving
- **Multi-Display Support**: Virtual coordinate system handles different screen configurations
- **Storage Options**:
  - Frontmatter mode: Store context directly in your notes
  - External mode: Keep your frontmatter clean with separate storage
- **File Explorer Indicators**: Visual markers show which files have saved contexts

## Installation

### Via BRAT (Recommended for beta testing)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Open BRAT settings
3. Click "Add Beta Plugin"
4. Enter: `owrede/perspecta-obsidian`
5. Click "Add Plugin"
6. Enable Perspecta in Community Plugins

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/owrede/perspecta-obsidian/releases)
2. Create a folder called `perspecta-obsidian` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into this folder
4. Reload Obsidian
5. Enable Perspecta in Community Plugins

## Usage

### Default Hotkeys

| Action | Hotkey |
|--------|--------|
| Save Context | `Shift+Cmd+S` (Mac) / `Shift+Ctrl+S` (Windows) |
| Restore Context | `Shift+Cmd+R` (Mac) / `Shift+Ctrl+R` (Windows) |

### Saving a Context

1. Arrange your windows, tabs, and splits as desired
2. Navigate to the note you want to associate with this arrangement
3. Press `Shift+Cmd+S` to save the context

### Restoring a Context

1. Open the note that has a saved context
2. Press `Shift+Cmd+R` to restore the window arrangement

### Settings

- **Storage Mode**: Choose between frontmatter (in-note) or external storage
- **Auto-generate UIDs**: Automatically add tracking IDs to files for reliable restoration
- **Debug Modal**: Show detailed information when saving contexts

## License

MIT
