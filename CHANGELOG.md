# Changelog

All notable changes to Perspecta will be documented in this file.

## [0.1.10] - 2025-12-06

- Hide perspecta-uid property from Properties view (still visible in source mode)

## [0.1.9] - 2025-12-06

- Removed excess padding from proxy window preview content
- Fixed bottom margin in proxy windows

## [0.1.8] - 2025-12-06

- Unified changelog system - single source of truth for all changelogs
- Added CHANGELOG.md file auto-generated from changelog data
- Reorganized README features to match settings pane structure
- Added Convert to proxy window command documentation
- Added backup reminder to external storage warning

## [0.1.7] - 2025-12-06

- Proxy windows now show scaled markdown preview of note content
- Draggable title bar - drag header to move proxy window
- Scrollable content - use mouse wheel or arrow keys to scroll preview
- Keyboard navigation: ↑/↓, j/k, Page Up/Down, Home/End, Enter/Space
- Configurable preview scale factor in Experimental settings (default 35%)
- Canvas viewport and zoom level now saved and restored
- Context indicator (target icon) now appears correctly in popout windows
- Fixed duplicate proxy windows when restoring contexts
- Fixed concurrent restore guard to prevent window duplication

## [0.1.6] - 2025-12-05

- Experimental: Proxy windows - minimalist window showing only note title
- Click proxy to restore latest arrangement, Shift+click for selector
- Click proxy without arrangement to expand to full window
- Proxy window positions and sizes saved/restored with arrangements
- Added Experimental settings tab to enable/disable proxy windows
- Fixed notifications not auto-dismissing (4 second timeout)
- Notifications and focus tints no longer appear in proxy windows

## [0.1.3] - 2025-12-04

- Multi-arrangement storage: store up to 5 arrangements per note
- Arrangement selector modal with visual SVG previews
- Delete button to remove specific arrangements from history
- Confirmation dialog when overwriting single arrangement
- Backup & restore functionality to perspecta folder
- SVG previews show windows, splits, sidebars, and focus highlight
- Instant tooltips on SVG areas showing note names
- Renamed "Focus tint duration" setting for clarity
- Fixed notification toast not disappearing

## [0.1.2]

- Improved plugin compliance with Obsidian guidelines

## [0.1.1]

- Save and restore scroll position for all tabs
- Save and restore split sizes (pane proportions)

## [0.1.0]

- Initial release
- Save and restore window arrangements (tabs, splits, popouts)
- External storage mode for cleaner notes
- Frontmatter storage mode for portability
- Auto-generate UIDs for file tracking
- Context indicators in file explorer
- Focus tint animation on restore
