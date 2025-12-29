# Changelog

All notable changes to Perspecta will be documented in this file.

## [0.1.26] - 2025-12-29

- New: Optional parallel popout window creation for 30-50% faster context restoration
- New: Performance section in Experimental settings tab
- Settings: Added toggle for parallel popout creation (disabled by default)
- Note: Enable in Settings → Experimental → Performance to try the new parallel mode

## [0.1.25] - 2025-12-29

- Updated CHANGELOG.md with comprehensive v0.1.24 release notes
- Documented Settings Tab refactoring details
- Clarified code organization improvements
- Note: This is a documentation-only release, no code changes

## [0.1.24] - 2025-12-29

- Refactor: Extracted Settings Tab to separate module (ui/settings-tab.ts)
- Refactor: Reduced main.ts from 4,320 to 3,873 lines (10.3% reduction)
- Improved: Better code organization and separation of concerns
- Improved: Settings UI now independently testable and maintainable
- Fixed: Build errors from incomplete refactoring attempts
- Internal: No user-facing changes, all functionality maintained

## [0.1.21] - 2025-12-29

- Performance: Comprehensive event listener management with automatic cleanup prevents memory leaks
- Performance: Replaced all hardcoded setTimeout calls with centralized timing constants
- Performance: Added debounced operations for file saving and UI updates
- Performance: Implemented retry logic with exponential backoff for unreliable operations
- Performance: Added timeout protection against hanging operations
- Reliability: Component-level event management with proper cleanup on component destruction
- Reliability: Safe timeout utilities prevent orphaned timeout callbacks
- Reliability: Better error handling and recovery in async operations
- Reliability: Improved window chrome configuration with retry logic
- Refactor: Created utility modules for constants, event management, and async operations
- Refactor: Eliminated magic numbers throughout codebase with centralized constants
- Refactor: Consistent async patterns across all services

## [0.1.20] - 2025-12-29

- Changed: Cmd+Shift+Click now auto-restores most recent arrangement (skips selector modal)

## [0.1.19] - 2025-12-28

- New: Cmd+Shift+Click (macOS) or Ctrl+Shift+Click (Windows/Linux) on links restores target note context
- Fixed: File context scanning now waits for Obsidian layout to be ready
- Fixed: Modifier key tracking works in both main window and popout windows

## [0.1.18] - 2025-12-28

- New: Non-linear center-preserving window scaling across different screen aspect ratios
- Improved: Windows in the center of the screen maintain proportions when switching displays
- Improved: Left/right edge windows absorb aspect ratio differences (stretching/compression)
- Fixed: Windows no longer get excessively stretched on ultrawide or compressed on narrow displays

## [0.1.17] - 2025-12-27

- New: Backup restore modal with Merge or Overwrite options
- New: Merge mode combines backup with existing, keeping newest arrangements on conflict
- New: Info box in Storage settings about Obsidian Sync configuration
- Improved: Documentation for syncing arrangements across devices

## [0.1.16] - 2025-12-27

- Fixed: Add defensive geometry validation to prevent freezes on Windows
- Fixed: Validate all geometry before window.moveTo/resizeTo operations
- Fixed: Guard against NaN, negative, zero, and extremely large coordinate values
- Fixed: Limit maximum popouts to 20 to prevent runaway window creation
- Fixed: Add try/catch around openPopoutLeaf and openFile calls
- Improved: Log warnings for invalid data to aid debugging

## [0.1.15] - 2025-12-26

- Performance: Incremental file explorer indicator updates via metadata events
- Refactor: New base64 utility replacing deprecated escape/unescape functions
- Refactor: Added ensureInitialized() API to external context store
- Refactor: Extracted IndicatorsService for better code organization
- Fixed: All 19 lint errors resolved, reduced warnings from 91 to 77
- Fixed: Backup restore now handles malformed files gracefully
- Fixed: File context menu now works for canvas and base files
- Improved: Better type safety with unknown instead of any in event handlers
- Improved: Consistent use of helper functions for internal API access

## [0.1.14] - 2025-12-20

- Internal improvements and bug fixes

## [0.1.13] - 2025-12-06

- Experimental: Save and restore desktop wallpaper with context
- Wallpaper support for macOS (AppleScript), Windows (PowerShell), Linux (GNOME)
- New settings to enable wallpaper capture and restore independently

## [0.1.12] - 2025-12-06

- Save and restore active sidebar panel (File Explorer, Search, Bookmarks, etc.)
- Improved sidebar state capture with multiple fallback methods

## [0.1.11] - 2025-12-06

- Proxy windows now show image thumbnails for image files
- Proxy windows show file type icon for PDFs and other binary files
- Fixed broken display when converting image/PDF windows to proxy

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
