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

- **Save & Restore Window Arrangements**: Capture tabs, splits, and popout windows
- **Split Size Preservation**: Restore exact split proportions (e.g., 30%/70% layouts)
- **Scroll Position Restoration**: Each tab's scroll position is saved and restored
- **Multiple File Type Support**: Works with markdown (.md), canvas (.canvas), and base (.base) files
- **Smart File Tracking**: UIDs ensure files are found even after renaming or moving
- **Multi-Display Support**: Virtual coordinate system handles different screen configurations
- **Storage Options**:
  - Frontmatter mode: Store context directly in your notes
  - External mode: Keep your frontmatter clean with separate storage
- **File Explorer Indicators**: Visual markers show which files have saved contexts
- **Context Details View**: Inspect saved contexts with split percentages and tab information

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

### Commands

All commands are available via the Command Palette (`Cmd+P` / `Ctrl+P`):

| Command | Description |
|---------|-------------|
| **Save context** | Save the current window arrangement to the active file |
| **Restore context** | Restore the window arrangement saved in the active file |
| **Show context details** | Display detailed information about the saved context (tabs, windows, positions) |

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

## Important Concepts

### Storage Modes

Perspecta offers two storage modes for saving window arrangements:

#### Frontmatter Mode (Default)
- Context data is stored directly in your note's frontmatter as a compact base64-encoded string
- **Advantage**: Data stays with your notes and survives plugin removal
- **Disadvantage**: Adds a `perspecta-arrangement` property to your frontmatter

#### External Mode
- Context data is stored in the plugin's folder (`.obsidian/plugins/perspecta-obsidian/contexts/`)
- **Advantage**: Keeps your frontmatter clean
- **Disadvantage**: **All saved contexts will be lost if the plugin is removed or reinstalled**

> **Note**: If you value data persistence, use Frontmatter Mode. If you prefer clean frontmatter and understand the risk, use External Mode.

### Unique IDs (UIDs)

Perspecta adds a `perspecta-uid` property to the frontmatter of notes that are part of a saved context. This unique identifier serves an important purpose:

- **File tracking across renames**: When you rename or move a note, Obsidian changes its path. Without UIDs, Perspecta would lose track of these files and fail to restore them in your saved contexts.
- **Reliable restoration**: UIDs ensure that even if you reorganize your vault, your window arrangements will still restore correctly.

The UID is a small, unobtrusive property that looks like this:
```yaml
---
perspecta-uid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
---
```

## Tip

As this plugin mostly provides two simple functions (saving a window arrangement and restoring it) it uses two hotkeys only. If you have a mouse like Logitech MX Master that offers extra configurable keys, using the store/restore with mouse keys makes navigating with Perspecta very convenient!


## License

MIT
