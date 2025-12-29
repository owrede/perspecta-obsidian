# Perspecta Feature Ideas & Roadmap

## 1. Obsidian Workspace Integration

**Concept**: Leverage Obsidian's native Workspaces plugin to provide workspace-specific arrangements.

**Value**: A user in "Research" workspace could have different window arrangements for the same note than when in "Writing" workspace. Allows role-based context switching.

**Implementation**:
- [ ] Listen to workspace change events (`workspace:load` event)
- [ ] Extend storage structure: `{ workspaceName: string, arrangement: WindowArrangement }`
- [ ] Fallback hierarchy: workspace-specific → default arrangement
- [ ] Add setting: "Enable workspace-specific arrangements"
- [ ] Migrate existing arrangements as "default" arrangements
- [ ] UI: Show current workspace name in arrangement selector modal

---

## 2. Quick Context Preview (Hover)

**Concept**: Show a thumbnail/SVG preview of the saved arrangement when hovering over a file in the file explorer.

**Value**: Users can preview what arrangement they'll restore before clicking, reducing cognitive load.

**Implementation**:
- [ ] Generate lightweight SVG previews (already exists in modals.ts)
- [ ] Register `file-hover` event handler
- [ ] Cache SVG previews on context save to avoid recomputation
- [ ] Add tooltip-style popup with arrangement preview
- [ ] Show timestamp of when arrangement was saved
- [ ] Add setting: "Show context preview on hover"

---

## 3. Context Templates / Presets

**Concept**: Save arrangement layouts as reusable templates (e.g., "Reading Mode", "Research Grid", "Presentation").

**Value**: Users can quickly apply a consistent layout structure across different notes without saving per-note contexts.

**Implementation**:
- [ ] New command: "Save current layout as template"
- [ ] Store templates in `perspecta/templates/` folder
- [ ] Templates store layout structure but use current note(s)
- [ ] New command: "Apply template to current note"
- [ ] Template manager in settings (list, rename, delete)
- [ ] Option to set a default template for new notes

---

## 4. Context History / Undo

**Concept**: Track context save history per note with ability to restore previous versions.

**Value**: Accidental overwrites become non-destructive; users can explore arrangement evolution.

**Implementation**:
- [ ] Store last N arrangements per note (extend current multi-arrangement feature)
- [ ] Add command: "Restore previous context version"
- [ ] Show history list with timestamps and SVG previews
- [ ] Auto-prune old versions based on age or count setting
- [ ] Add "Undo last context save" command

---

## 5. Smart Context Suggestions

**Concept**: AI/heuristic-based suggestions for when to save or restore context.

**Value**: Reduces friction of manual context management.

**Implementation**:
- [ ] Detect significant layout changes (new splits, popouts)
- [ ] Prompt: "You've made significant layout changes. Save context?"
- [ ] Learn from user behavior (if they always restore after opening certain files)
- [ ] Suggest restoring context when opening a note with saved context
- [ ] Add setting: "Show context suggestions" (off by default)

---

## 6. Context Links / Transclusion

**Concept**: Reference one note's context from another, or chain contexts together.

**Value**: For research workflows where opening one "hub" note should set up the environment including related notes.

**Implementation**:
- [ ] New frontmatter field: `perspecta-context-ref: [[Other Note]]`
- [ ] When restoring, follow the reference chain
- [ ] Prevent circular references
- [ ] Allow "append" vs "replace" modes
- [ ] Use case: Project index notes that set up all related documents

---

## 7. Research Mode / Linked Context

**Concept**: Automatically save/restore contexts for note clusters (MOC - Map of Content pattern).

**Value**: Research projects often involve multiple related notes; switching to a project should restore the entire research environment.

**Implementation**:
- [ ] Detect links between notes in an arrangement
- [ ] Store "cluster ID" for related arrangements
- [ ] Command: "Restore cluster context" - restores all linked notes
- [ ] Integration with Dataview/MOC patterns
- [ ] Tag-based clustering option

---

## 8. Context Sharing / Export

**Concept**: Export/import arrangements for sharing setups with collaborators.

**Value**: Team workflows, publishing templates, educational content.

**Implementation**:
- [ ] Export arrangement as standalone JSON file
- [ ] Include file structure requirements (list of needed files)
- [ ] Import command that validates file paths exist
- [ ] Optional: URL-based sharing (base64 encoded)
- [ ] Consider privacy (file paths may reveal vault structure)

---

## 9. Performance Optimizations

### 9a. Lazy Restoration
- [ ] Restore visible tabs first, background tabs on-demand
- [ ] Priority: focused tab → visible tabs → background tabs
- [ ] Add progress indicator for large arrangements

### 9b. Incremental Capture
- [ ] Only capture changed state, not full arrangement
- [ ] Delta-based storage for history feature
- [ ] Faster save operations

### 9c. Index Optimization
- [ ] Build UID → file path index at startup
- [ ] Update index on file rename/move events
- [ ] Eliminate per-file frontmatter scans during restore

---

## 10. Arrangement Diffs / Comparison

**Concept**: Compare two saved arrangements visually.

**Value**: Understanding how a workspace evolved, debugging restore issues.

**Implementation**:
- [ ] Side-by-side SVG preview of two arrangements
- [ ] Highlight differences (added/removed tabs, position changes)
- [ ] Command: "Compare arrangements"
- [ ] Useful for workspace-specific comparison

---

## 11. Keyboard-Driven Workflow Enhancements

**Concept**: Power-user keyboard shortcuts for rapid context switching.

**Implementation**:
- [ ] Quick switcher integration: `Cmd+Shift+O` to search notes by context
- [ ] Number-based hotkeys: `Ctrl+1-5` to restore arrangement slots
- [ ] Fuzzy search in arrangement selector modal
- [ ] "Recent contexts" command with keyboard navigation

---

## 12. Multi-Vault Context Awareness

**Concept**: Track context across linked vaults or vault switching.

**Value**: Users with multiple vaults (personal/work) can maintain context per vault.

**Implementation**:
- [ ] Store vault identifier in arrangement metadata
- [ ] Cross-vault reference warnings
- [ ] Vault-specific backup/restore

---

## 13. Visual Arrangement Editor

**Concept**: Drag-and-drop editor to design arrangements without manually creating splits.

**Value**: Lower barrier to creating complex layouts; preview before applying.

**Implementation**:
- [ ] Canvas-style visual editor
- [ ] Drag to create splits, resize proportions
- [ ] Assign notes to layout slots
- [ ] Save as template or apply immediately

---

## 14. Integration Enhancements

### 14a. Dataview Integration
- [ ] Custom inline query: `=perspecta-context()` to show arrangement info
- [ ] Filter notes by "has context" status

### 14b. Templater Integration
- [ ] Templater command to restore context
- [ ] Trigger context save after template insertion

### 14c. Daily Notes Integration
- [ ] Auto-restore context for daily notes based on template
- [ ] Different contexts for different days/times

---

## 15. Mobile Considerations

**Concept**: Graceful handling on mobile where popouts don't exist.

**Implementation**:
- [ ] Detect mobile platform
- [ ] Restore only main window tabs (ignore popouts)
- [ ] Save mobile-specific arrangements
- [ ] Sync indicator for mobile/desktop arrangements

---

## Priority Tiers

### Tier 1 - High Impact, Moderate Effort
1. **Workspace Integration** (#1) - Your specific request
2. **Quick Context Preview** (#2) - UX improvement
3. **Performance Optimizations** (#9) - Core experience

### Tier 2 - High Value for Research Users
4. **Context History** (#4) - Safety net
5. **Research Mode / Linked Context** (#7) - Power feature
6. **Context Templates** (#3) - Reusability

### Tier 3 - Nice to Have
7. **Keyboard Workflow** (#11)
8. **Context Sharing** (#8)
9. **Visual Editor** (#13)

---

## Technical Notes

### Workspace Integration Deep Dive

Obsidian's Workspaces plugin uses `app.internalPlugins.getPluginById('workspaces')`. Key APIs:

```typescript
// Get current workspace name
const workspacePlugin = app.internalPlugins.getPluginById('workspaces');
const activeWorkspace = workspacePlugin?.instance?.activeWorkspace;

// Listen for workspace changes
app.workspace.on('workspace-change', (name: string) => {
  // Handle workspace switch
});
```

Storage structure extension:
```typescript
interface WorkspaceAwareArrangement {
  workspace?: string;  // undefined = default for all workspaces
  arrangement: WindowArrangementV2;
  savedAt: number;
}

interface ArrangementCollection {
  arrangements: WorkspaceAwareArrangement[];
}
```

Fallback logic:
1. Look for arrangement matching current workspace
2. Fall back to arrangement with `workspace: undefined` (default)
3. Show "no arrangement" if neither exists
