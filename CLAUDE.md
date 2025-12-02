# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Perspecta is an Obsidian plugin for knowledge management, research, and writing. Core goals:
- **Recontextualization**: Quickly reorganize and reframe information
- **Visual Mapping**: Graph and spatial visualization of knowledge
- **Script-based Automation**: Productivity features for large vaults

## Build Commands

```bash
npm install          # Install dependencies
npm run dev          # Development build with watch mode
npm run build        # Production build (includes type checking)
```

## Project Structure

```
├── src/
│   └── main.ts      # Plugin entry point (PerspectaPlugin class)
├── manifest.json    # Plugin metadata
├── styles.css       # Plugin styles
├── esbuild.config.mjs
├── tsconfig.json
└── versions.json
```

## Development Workflow

### Test Vault
Development vault: `/Users/wrede/Documents/Obsidian Vaults/Perspecta-Dev`

The plugin is symlinked to: `<vault>/.obsidian/plugins/perspecta-obsidian/`

After building, reload Obsidian or use the "Reload app without saving" command (Cmd+Option+R).

### Debugging
- Developer console: Cmd+Shift+I
- Hot reload: `npm run dev` watches for changes

## Architecture

### Plugin Entry (src/main.ts)
- `PerspectaPlugin` extends `Plugin`
- Settings stored via `loadData()`/`saveData()`
- Commands registered in `onload()`

### Planned Feature Modules
- **Visual Mapping**: Canvas-based knowledge visualization
- **Recontextualization**: Tools to reorganize and reframe notes
- **Automation**: Script runner for vault-wide operations

## Obsidian API Patterns

### File Operations
Always use Vault API, never direct filesystem:
```typescript
this.app.vault.create(path, content)
this.app.vault.modify(file, content)
this.app.vault.delete(file)
this.app.vault.getAbstractFileByPath(path)
```

### Views and Leaves
```typescript
this.app.workspace.getLeaf(false)
this.registerView(VIEW_TYPE, (leaf) => new CustomView(leaf))
```

### Link Resolution
```typescript
this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
```
