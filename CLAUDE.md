# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`.vsix`) that acts as a local Obsidian-like markdown editor. It operates entirely offline — no marketplace, no external servers. Installed locally into the VS Code profile named **"Obsidian like"**.

The core feature is a `CustomTextEditorProvider` that opens `.md` files in a webview powered by **CodeMirror 6** (CM6). The editor provides live-preview (WYSIWYG-like): markdown syntax markers are hidden on non-active lines, and block elements like tables are rendered visually. The underlying document is always plain markdown text.

## Deploy workflow (mandatory after every code change)

```bash
npm run package
code --profile "Obsidian like" --uninstall-extension angel-local.vault-tool
code --profile "Obsidian like" --install-extension vault-tool-0.0.1.vsix
```

Then reload the VS Code window (Ctrl+Shift+P → "Developer: Reload Window").

`npm run package` = `npm run compile && npm run build-webview && vsce package --allow-missing-repository`

- `compile` → tsc compiles `src/extension.ts` → `out/extension.js`
- `build-webview` → esbuild bundles `webview-src/editor.js` → `out/editor.bundle.js`

## Key files

| File | Role |
|---|---|
| `src/extension.ts` | Extension host: ~430 lines. Provider, message handling, file I/O. |
| `webview-src/editor.js` | Webview CM6 editor: ~750 lines. All editor logic. |
| `out/extension.js` | Compiled host (committed, required for packaging). |
| `out/editor.bundle.js` | esbuild bundle of webview (committed, required for packaging). |
| `package.json` | Publisher must be `angel-local` (vsce 3.x validates this). |

## Architecture: extension host (`src/extension.ts`)

### Helpers

- `getAttachmentRoots(docUri)` — returns `vscode.Uri[]` for image lookup dirs (vault root, doc dir, configured subfolder)
- `getImageMap(webview, docUri)` — scans attachment roots, returns `{ filename → webviewUri }` map passed to webview
- `getThemeCss()` — reads `.obsidian/themes/{name}/theme.css` from vault root (config: `vaultTool.obsidianTheme`)
- `escapeRegex(s)` — escapes special regex chars
- `updateWikiLinks(oldName, newName)` — scans all vault `.md` files, replaces `[[OldName]]` and `[[OldName|alias]]` with new name via `WorkspaceEdit`
- `computeBreadcrumb(docUri)` — returns `[{ name, fsPath }]` array for the clickable path bar

### Module-level state

- `noteIndex: string[]` — all `.md` filenames in vault (no extension). Built at activation, updated by `FileSystemWatcher` on create/delete, broadcast to all open panels.
- `activePanels: vscode.WebviewPanel[]` — tracks open panels to push `note-index` updates.

### `resolveCustomTextEditor`

- Sets `webviewPanel.webview.options` with `localResourceRoots` covering `out/` and all attachment dirs.
- Calls `getThemeCss()`, `getImageMap()`, `computeBreadcrumb()` and passes all to `buildHtml()`.
- Sends `{ type: 'note-index', notes }` after 300ms (webview ready).
- Handles `onWillSaveTextDocument`: sends `get-content` to webview, awaits `content-for-save` response (5s timeout).
- Handles `onDidChangeTextDocument`: sends `external-update` to webview when the file changes outside the webview.

### Message handlers (webview → host)

| Message | Action |
|---|---|
| `sync` | Apply `content` to VS Code document via `applyEdit` (debounced autosave path) |
| `content-for-save` | Resolves the pending `onWillSave` promise |
| `rename` | Validates new name, calls `WorkspaceEdit.renameFile()`, then `updateWikiLinks(oldName, newName)` |
| `open-note` | Finds or creates the `.md` file, opens it with `vscode.openWith` in same column |
| `open-url` | `vscode.env.openExternal(vscode.Uri.parse(url))` |
| `reveal-path` | `vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath))` |
| `paste-image` | Saves base64 buffer as `Pasted image YYYYMMDDHHMMSS.png` to configured attachments dir, sends back `image-pasted` with webview URI |

### `buildHtml(content, font, fontSize, cspSource, scriptUri, title, imageMap, themeCss, breadcrumb)`

Generates the full webview HTML. Key points:
- CSP: `script-src ${cspSource} 'unsafe-inline'` (inline scripts are needed).
- `<style id="__obsidian-theme">` — injected theme CSS (pre-escaped `</style>`).
- `window.__vaultInitial = { content, font, fontSize, noteIndex, title, imageMap, breadcrumb }` — all initial data.
- The theme class sync script (`theme-dark`/`theme-light` on body) runs **after** `<body>` (at end of body, not in head) so `document.body` is never null.
- `#doc-breadcrumb` — clickable path segments above the title.
- `#doc-title` — editable H1 that triggers rename on blur (800ms debounce).
- `#editor` — the CM6 mount point.

## Architecture: webview (`webview-src/editor.js`)

### CM6 extensions in use

```javascript
[
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(mdHighlight),
  previewCompartment.of([livePreviewPlugin, tableOverlayPlugin, wikiLinkPlugin, imgPlugin]),
  linkClickHandler,
  autocompletion({ override: [wikiComplete] }),
  keymap.of([Mod-b (bold), Mod-i (italic), ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
  vsTheme,
  EditorView.updateListener (400ms sync debounce),
]
```

### `vsTheme` / `mdHighlight`

- `vsTheme`: `EditorView.theme({})` with CSS vars from VS Code (`--vscode-editor-*`) for all CM6 UI elements.
- `mdHighlight`: `HighlightStyle` using Obsidian CSS vars (`--bold-color`, `--h1-color`, `--h1-size`, `--italic-color`, `--code-normal`, `--blockquote-color`, etc.) with VS Code fallbacks. Obsidian's theme CSS uses `.theme-dark`/`.theme-light` class selectors — these are added to `<body>` and `<html>` by the inline script at the end of body.

### `livePreviewPlugin`

`ViewPlugin` that hides markdown syntax markers on non-active lines. Active lines = lines that contain any cursor selection anchor or head.

`_build(view)` iterates the syntax tree over the current viewport and:
- **Tables** — adds `Decoration.line({ class: 'cm-table-line-hidden' })` (CSS: `visibility: hidden`) for each table line when none of the table lines are active. Rendering is delegated to `tableOverlayPlugin`. **Does NOT use `block: true` decorations** — these crash CM6's measurement phase (`measureVisibleLineHeights`, `coordsAt`) for multi-line blocks.
- **HeaderMark** — `Decoration.replace({})` hides the `##` prefix (and trailing space).
- **EmphasisMark, CodeMark, StrikethroughMark, LinkMark, URL** — `Decoration.replace({})` hides the markers.

`_build` wraps everything in `try/catch` returning `Decoration.none` on any error.

### `tableOverlayPlugin`

`ViewPlugin` that renders tables visually without CM6 block decorations:
- `constructor(view)`: creates `<div class="cm-table-overlay-layer">` appended to `view.scrollDOM` (position: absolute). Sets `view.scrollDOM.style.position = 'relative'` if not already.
- `_render(view)`: on every docChanged/viewportChanged/selectionSet, clears the overlay and iterates the syntax tree. For each Table node where no line is active, calls `view.coordsAtPos(firstLine.from)` to get the screen Y position and places a `TableWidget` div at `top = coords.top - scrollRect.top + scrollDOM.scrollTop`. CSS: `pointer-events: none` on the layer, `pointer-events: auto` on each table element.
- When the cursor enters a table line → `isActive` = true → no `cm-table-line-hidden` class → raw markdown visible, overlay widget hidden.

**Critical**: `visibility: hidden` is used (not `display: none`) so CM6 can still measure line heights for scroll and viewport calculations.

### `wikiLinkPlugin`

Regex `/(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g` over viewport text. For non-active lines, hides `[[`, `]]`, and (when alias) the `target|` part, leaving only the display text with class `cm-wiki-link` (underlined, accent color).

### `imgPlugin`

Regex `/!\[\[([^\]]+)\]\]/g` over viewport. For non-active lines with known filenames in `imageMap`, replaces with `ImageWidget` (`<img max-width:100%>`).

### `linkClickHandler`

`EditorView.domEventHandlers`:
- **`mousedown`**: if target is `.cm-wiki-link` or `coordsAtPos` finds a URL on a non-active line → `e.preventDefault()` to block CM6 from moving the cursor to that position.
- **`click`**: `.cm-wiki-link` → `open-note`; URL found via syntax tree or regex → `open-url`.

`findUrlAtPos(view, pos)`: walks the syntax tree up from `pos` looking for `URL` or `Link/URL` nodes; falls back to regex on the line text.

### `wikiComplete`

CM6 autocompletion source. Triggered by `\[\[[^\]]*$` before cursor. Returns matching note names from `noteIndex` as `apply: '[[Name]]'` completions.

### Message handlers (host → webview)

| Message | Action |
|---|---|
| `note-index` | Updates `noteIndex` array |
| `image-map` | Updates `imageMap`, triggers view dispatch to redraw imgPlugin |
| `title-revert` | Restores title element to given name (rename failed) |
| `external-update` | Replaces full editor content if it differs |
| `get-content` | Responds with `content-for-save` containing full doc text |
| `trigger-sync` | Flushes pending sync immediately |
| `image-pasted` | Updates `imageMap` entry, inserts `![[filename]]` at cursor |
| `font-update` | Updates `--md-font` and `--md-font-size` CSS vars on `<html>` |
| `theme-css` | Replaces `<style id="__obsidian-theme">` content |
| `toggle-source-mode` | Reconfigures `previewCompartment` to `[]` or back |

## Configuration (`package.json` → `contributes.configuration`)

| Key | Default | Purpose |
|---|---|---|
| `vaultTool.markdownFont` | `""` | Font family for the editor |
| `vaultTool.attachmentsLocation` | `"vault"` | Where to look for `![[images]]` |
| `vaultTool.attachmentsFolder` | `"attachments"` | Subfolder name or specific path |
| `vaultTool.obsidianTheme` | `""` | Theme name (loads `.obsidian/themes/{name}/theme.css`) |

## Known issues / future work

The following have NOT been investigated or fixed:
1. **Image paste** — user mentioned it's broken but no investigation done yet.
2. **`[[` wiki link picker** — autocomplete picker may have issues; not investigated.
3. **Table overlay scroll sync** — the overlay positions are recalculated on `viewportChanged`, but rapid scroll may show momentary position lag.
4. **Table line height mismatch** — the overlay widget may be taller/shorter than the hidden raw lines, causing slight scrollbar inaccuracy for documents heavy with tables.

## Git branch

Working branch: `dev`. Main branch: `main`.

Recent significant commits on `dev`:
- Table rendering via overlay plugin (avoids CM6 block decoration crashes)
- Theme class sync fix (script moved to end of `<body>`)
- Clickable breadcrumb path at top of document
- Wiki-link update on file rename (`updateWikiLinks`)
- Link click: `mousedown` preventDefault + `click` action (prevents cursor-move-only behavior)
- `computeBreadcrumb` + `reveal-path` message for Explorer reveal
- Full migration from `contenteditable` + `marked` to CodeMirror 6

## npm / SSL note

If running on a corporate network that intercepts TLS:
```bash
npm install --strict-ssl=false
```
