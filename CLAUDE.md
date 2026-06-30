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
| `webview-src/editor.js` | Webview CM6 editor: ~1000 lines. All editor logic. |
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
- After 300ms: sends `{ type: 'note-index', notes }` and `{ type: 'theme-css', css }` (theme CSS is **not** inlined in HTML — see below).
- Handles `onWillSaveTextDocument`: sends `get-content` to webview, awaits `content-for-save` response (5s timeout).
- Handles `onDidChangeTextDocument`: sends `external-update` to webview when the file changes outside the webview.

### Why theme CSS is sent via postMessage, not inlined in HTML

Obsidian themes (e.g. Border) embed SVG data URLs in CSS properties like `-webkit-mask-image`. Those SVGs contain `<style>...</style>` tags, which prematurely close the `<style id="__obsidian-theme">` HTML element. The fix: leave the style element empty in HTML, send CSS via `postMessage({ type: 'theme-css', css })`, apply with `element.textContent = css` (bypasses the HTML parser entirely).

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

### `buildHtml(content, font, fontSize, noteIndex, cspSource, scriptUri, title, imageMap, breadcrumb)`

Generates the full webview HTML. Key points:
- CSP: `script-src ${cspSource} 'unsafe-inline'` (inline scripts are needed).
- `<style id="__obsidian-theme"></style>` — **empty** in HTML; filled via `theme-css` postMessage.
- `window.__vaultInitial = { content, font, fontSize, noteIndex, title, imageMap, breadcrumb }` — all initial data.
- The theme class sync script (`theme-dark`/`theme-light` on body) runs **after** `<body>` (at end of body, not in head) so `document.body` is never null.
- `#doc-breadcrumb` — clickable path segments above the title. Always visible (even for root-level files). Last segment (filename) is non-clickable. Directory segments send `reveal-path`.
- `#doc-title` — editable H1 that triggers rename on blur (800ms debounce).
- `#editor` — the CM6 mount point. Has `class="is-live-preview markdown-source-view mod-cm6"` so Obsidian theme selectors activate.

## Architecture: webview (`webview-src/editor.js`)

### CM6 extensions in use

```javascript
[
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(mdHighlight),
  previewCompartment.of([livePreviewPlugin, mdLinkPlugin, wikiLinkPlugin, imgPlugin]),
  foldPlugin,
  linkClickHandler,
  autocompletion({ override: [wikiComplete], closeOnBlur: true }),
  keymap.of([Mod-b (bold), Mod-i (italic), ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
  vsTheme,
  EditorView.updateListener (400ms sync debounce),
]
```

### `vsTheme` / `mdHighlight`

- `vsTheme`: `EditorView.theme({})` with CSS vars from VS Code (`--vscode-editor-*`) for all CM6 UI elements. Also defines `.cm-wiki-link`, `.cm-md-link`, `.cm-fold-indicator`, `.cm-fold-hidden`, `.cm-table-row-hidden`, table styles, and **`.cm-header-1` through `.cm-header-6`** heading styles.
- `mdHighlight`: `HighlightStyle` for bold, italic, strikethrough, links, code. Heading levels use **`class` only** (`{ tag: tags.heading1, class: 'cm-header cm-header-1' }` etc.) — **critical**: when `class` is set in a HighlightStyle spec, CM6 ignores all CSS properties in that spec and uses the class name as-is. Heading styles (fontSize, fontWeight, color via CSS vars) must therefore live in `vsTheme` under `.cm-header-N`, not in `mdHighlight`.

### Heading styling architecture (important)

Heading spans receive stable class names (`cm-header cm-header-1`…`cm-header-6`) via `mdHighlight`'s `class` property. The CSS for those classes lives in `vsTheme` and references Obsidian theme vars (`--h1-size`, `--h1-weight`, `--h1-color`, etc.) with fallback defaults. The `#editor` div has `class="is-live-preview markdown-source-view mod-cm6"` so Obsidian theme selectors like `.is-live-preview .HyperMD-header-1::before` work. The `cm-line` div for each heading gets `HyperMD-header HyperMD-header-N` via `Decoration.line()` in `livePreviewPlugin` (added before the active-line check, so it applies to all heading lines).

### `livePreviewPlugin`

`ViewPlugin` that hides markdown syntax markers on non-active lines via syntax tree iteration. Active lines = lines containing any cursor selection anchor or head.

`_build(view)` iterates the syntax tree over the current viewport:
- **ATXHeading[1-6]** — `Decoration.line({ class: 'HyperMD-header HyperMD-header-N' })` on every heading line (active or not), enabling Obsidian theme CSS selectors. Does not `return false` so children are still visited.
- **Tables** — first line replaced by `Decoration.replace({ widget: TableWidget })` (single-line, no `block:true`). Remaining table lines replaced with `Decoration.replace({})` + `Decoration.line({ class: 'cm-table-row-hidden' })` to collapse height.
- **HeaderMark** — `Decoration.replace({})` hides `## ` prefix (and trailing space) on non-active lines.
- **EmphasisMark, CodeMark, StrikethroughMark** — `Decoration.replace({})` hides the markers on non-active lines.
- **LinkMark, URL** — returns `false` only (no hiding); handled by `mdLinkPlugin` instead.

**`block: true` decorations are permanently banned** — they crash CM6's `measureVisibleLineHeights` / `coordsAt`. All multi-line hiding uses `Decoration.line({ class: '...' })` with `height: 0` CSS.

### `TableWidget` / `renderCell(raw)`

`TableWidget` is a `WidgetType` rendered as a single-line `Decoration.replace` on the first table line. Renders a full `<table>` with `<th>` / `<td>` cells.

`renderCell(raw)` — inline markdown renderer for table cell content: HTML-escapes, then applies sequential regex for bold, italic, strikethrough, wiki-links (`data-wiki` attribute), inline code. Uses `innerHTML` so formatting renders.

### `mdLinkPlugin`

Regex-based `ViewPlugin` for standard markdown links `[text](url)`. More reliable than syntax-tree approach because lezer-markdown's `Link` node structure varies depending on URL format in href.

- Regex: `/(?<!!)\[([^\[\]\n]*)\]\(([^)\n]*)\)/g` — matches `[text](url)` but NOT `![alt](url)`.
- For non-active lines: replaces entire `[text](url)` with `MdLinkWidget` — a `<span class="cm-md-link" data-url="url">text</span>`.
- Styled identically to wiki-links (underlined, `--link-color`).
- `linkClickHandler` detects `.cm-md-link` clicks and sends `open-url` with `dataset.url`.

### `wikiLinkPlugin`

Regex `/(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g` over viewport text. For non-active lines, hides `[[`, `]]`, and (when alias) the `target|` part, leaving only the display text with class `cm-wiki-link`.

### `imgPlugin`

Regex `/!\[\[([^\]]+)\]\]/g` over viewport. Parses optional `|` parameter:
- `![[file.png|400]]` or `![[file.png|400px]]` → image at 400px wide
- `![[file.png|Caption text]]` → image with `<figcaption>` below

For non-active lines with known filename in `imageMap`, replaces with `ImageWidget`.

`ImageWidget(src, alt, width, caption)` — renders `<img>` optionally wrapped in `<figure>` + `<figcaption>`.

### `foldPlugin`

`ViewPlugin` outside `previewCompartment` (works in both live-preview and source mode) that implements collapsible headings.

- `foldedSet: Set<number>` — module-level set of `line.from` positions of folded headings.
- `foldEffect: StateEffect` — dispatched on toggle to trigger plugin rebuild.
- `collectHeadings(state)` — scans the full syntax tree for `ATXHeading[1-6]` nodes.
- For each heading in viewport: adds `FoldToggle` widget at `line.from` with `side: -1`.
- `FoldToggle.toDOM()` renders the exact Obsidian DOM structure: `div.cm-fold-indicator[contenteditable=false] > div.collapse-indicator.collapse-icon > svg.svg-icon.right-triangle`. When folded, `div.cm-fold-indicator` also gets `is-collapsed` class, which triggers the Border theme's accent-color CSS for the indicator icon.
- For each folded heading: collapses lines from heading+1 to start of next heading at same/higher level (or end of doc) using `Decoration.replace({})` + `Decoration.line({ class: 'cm-fold-hidden' })`.
- Fold positions are remapped through document changes via `u.changes.mapPos()`.
- `currentView` module-level ref is set after editor creation so `FoldToggle.toDOM()` can dispatch effects.
- **Note**: `HyperMD-header-N` line classes are added in `livePreviewPlugin`, NOT here. Adding both a widget and a line decoration at the same position (`h.lineFrom`) in one plugin causes CM6 `RangeSetBuilder` ordering issues where the line decoration is silently dropped.

### `linkClickHandler`

`EditorView.domEventHandlers`:
- **`mousedown`**: preventDefault + return true for `.cm-wiki-link`, `[data-wiki]` (table cells), `.cm-md-link`, or any position where `findUrlAtPos` finds a URL. No active-line restriction — URLs are always navigable.
- **`click`**: same detection order; dispatches `open-note` (wiki-links) or `open-url` (URLs and `cm-md-link`).

`findUrlAtPos(view, pos)`: walks the syntax tree up from `pos` looking for `URL` or `Link/URL` nodes; falls back to regex `/https?:\/\/[^\s)"'\]>]+/g` on the line text.

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
| `theme-css` | Sets `element.textContent = css` on `<style id="__obsidian-theme">` |
| `toggle-source-mode` | Reconfigures `previewCompartment` to `[]` or back |

## Configuration (`package.json` → `contributes.configuration`)

| Key | Default | Purpose |
|---|---|---|
| `vaultTool.markdownFont` | `""` | Font family for the editor |
| `vaultTool.attachmentsLocation` | `"vault"` | Where to look for `![[images]]` |
| `vaultTool.attachmentsFolder` | `"attachments"` | Subfolder name or specific path |
| `vaultTool.obsidianTheme` | `""` | Theme name (loads `.obsidian/themes/{name}/theme.css`) |

## Known issues / future work

1. **Image paste** — reported broken, not investigated.
2. **`[[` wiki link picker** — autocomplete picker may have issues, not investigated.
3. **Standard markdown images** `![alt](url)` — not handled by imgPlugin (which only handles `![[file]]`). Shows as raw markdown.

## Git branch

Working branch: `render`. Main branch: `main`.

## npm / SSL note

If running on a corporate network that intercepts TLS:
```bash
npm install --strict-ssl=false
```
