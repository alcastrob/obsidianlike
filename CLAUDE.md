# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`.vsix`) that acts as a local Obsidian-like markdown editor. It operates entirely offline — no marketplace, no external servers. Installed locally into the VS Code profile named **"Obsidian like"**.

The core feature is a `CustomTextEditorProvider` that opens `.md` files in a webview powered by **CodeMirror 6** (CM6). The editor provides live-preview (WYSIWYG-like): markdown syntax markers are hidden on non-active lines, and block elements like tables are rendered visually. The underlying document is always plain markdown text.

## Deploy workflow (mandatory after every code change)

```bash
npm run package
code --profile "Obsidian like" --uninstall-extension angelCastro.vault-tool
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
| `package.json` | Publisher is `angelCastro` — the installed extension ID is `angelCastro.vault-tool`. |

## Architecture: extension host (`src/extension.ts`)

### Helpers

- `getAttachmentRoots(docUri)` — returns `vscode.Uri[]` for `localResourceRoots` (vault root, doc dir, configured subfolder). Vault root is always included, so any nested path under it is webview-accessible.
- `findImageFiles(dir)` — recursive image-file walker (extensions: png/jpg/jpeg/gif/svg/webp/bmp), skipping dotfiles and `node_modules`. Falls back to `fs.statSync` when `Dirent.isDirectory()/isFile()` are both false, because cloud-sync placeholder folders (Dropbox Smart Sync, OneDrive Files On-Demand) use NTFS reparse points that Node's `readdirSync` dirent type can misreport on Windows.
- `getImageMap(webview, docUri)` — returns `{ filename → webviewUri }` map. Resolution order: (1) the configured attachments dir (`getSaveDir`) — priority location; (2) a recursive `findImageFiles` scan of the whole vault root for any filename not already found. First match wins per basename. If a `![[file]]` reference isn't in the map at all, `imgPlugin` leaves the raw markdown text untouched instead of rendering a broken image.
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
| `open-note` | Resolves the wiki-link target and opens it with `vscode.openWith` in the same column (see below for resolution/creation rules) |
| `open-url` | `vscode.env.openExternal(vscode.Uri.parse(url))` |
| `reveal-path` | `vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath))` |
| `paste-image` | Saves base64 buffer as `Pasted image YYYYMMDDHHMMSS.png` to configured attachments dir, sends back `image-pasted` with webview URI |
| `toggle-task` | Toggles the task checkbox line at `msg.line` (0-based). See "Task checkboxes" below. |

### Task checkboxes — soft dependency on `angelCastro.obsidian-like-tasks`

Clicking a `.cm-task-checkbox` widget in the CM6 editor (see `TaskCheckboxWidget` below) posts `{ type: 'toggle-task', line }` (0-based doc line number). The handler in `resolveCustomTextEditor`'s `onDidReceiveMessage`:

1. Reads the current line text with `document.lineAt(line).text`.
2. Calls `getTasksApi()`, which lazily does `vscode.extensions.getExtension('angelCastro.obsidian-like-tasks')?.activate()` and caches the resulting promise in the module-level `tasksApiPromise` — but **only caches success**: if `getExtension()` returns `undefined` or `activate()` throws, `tasksApiPromise` is reset to `undefined` so the *next* call retries from scratch, rather than being stuck with a permanently-failed lookup for the rest of the session (a real, if narrow, cold-start race: this extension's own activation can occasionally be requested before `angelCastro.obsidian-like-tasks` is registered in VS Code's extension list). Extension id note: the "Obsidian-Like Tasks" extension's `package.json` `name` is `obsidian-like-tasks` (not the repo folder name `vscode-tasks`) — if that ever changes again, update this id here too.
3. If the Tasks extension is installed and its API exposes `toggleTaskLine`, calls `tasksApi.toggleTaskLine(lineText)` — this is the "Obsidian-Like Tasks" extension's own recurrence-aware state machine (`src/api/TasksApi.ts` in that repo), returning either `[toggledLine]` or, for a just-completed recurring task, `[nextOccurrenceLine, toggledLine]`.
4. Otherwise falls back to `naiveToggleTaskLine(lineText)` — a local helper that does a plain `[ ]` ↔ `[x]`/`[X]` regex flip with no recurrence handling.
5. Applies the result via a `WorkspaceEdit` that replaces only `document.lineAt(line).range` (not the whole document — unlike `applySync`), joining multiple returned lines with the document's actual EOL (`document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'`).

This is a **soft dependency**: `package.json` has no `extensionDependencies` entry, so Vault Tool works standalone without the Tasks extension installed — `getTasksApi()` resolves to `undefined` (via `getExtension()` returning `undefined`, or a rejected `activate()` caught internally) and the naive fallback runs instead. Two extensions' webviews cannot call into each other directly, which is why this call happens host-to-host (Vault Tool's `extension.ts` calling into the Tasks extension's exported API), not webview-to-webview.

The `TasksExtensionApi` shape Vault Tool expects (declared locally in `src/extension.ts`, not imported from the other repo):
```ts
interface TasksExtensionApi {
  isTaskLine(lineText: string): boolean;      // not currently called from Vault Tool
  toggleTaskLine(lineText: string): string[]; // returns replacement line(s), no trailing newline
}
```

### `open-note` resolution rules

A wiki-link target may optionally carry one directory segment to disambiguate same-named notes, e.g. `[[folder/Note]]`. Only the immediate parent directory name is used as a hint — the rest of any longer path is ignored.

- **No directory hint** (`[[Note]]`): prefer a `Note.md` in the same directory as the note containing the link; if absent, fall back to a vault-wide `findFiles` search (first match wins).
- **Directory hint** (`[[folder/Note]]`): vault-wide search for `Note.md`, filtered to results whose immediate parent directory is named `folder` (case-insensitive).
- **Not found anywhere**: create it. Target directory is the hinted subfolder inside the *current* note's directory (created if missing), or the current note's directory itself if no hint was given. The new file is written empty.

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

The `cm-wiki-link` mark always carries `attributes: { 'data-target': name }` with the raw target (including any disambiguation path), even when an alias is displayed — the visible text alone isn't enough to resolve the link once an alias hides the real target. `linkClickHandler` reads `dataset.target` (falling back to `textContent` for safety) and sends that as `open-note`'s `name`, so the host receives the full target string to resolve.

### `imgPlugin`

Regex `/!\[\[([^\]]+)\]\]/g` over viewport. Parses optional `|` parameter:
- `![[file.png|400]]` or `![[file.png|400px]]` → image at 400px wide
- `![[file.png|Caption text]]` → image with `<figcaption>` below

For non-active lines with known filename in `imageMap`, replaces with `ImageWidget`.

`ImageWidget(src, alt, width, caption)` — renders `<img>` optionally wrapped in `<figure>` + `<figcaption>`.

### Task checkbox lines (in `livePreviewPlugin`, `ListItem` handling)

Handled entirely by plain-text regex against `state.doc.lineAt(node.from).text` inside the existing `ListItem` branch of `livePreviewPlugin`'s tree walk — **not** via a Lezer AST node, even though `markdown({ base: markdownLanguage })`'s default config was empirically verified (via a throwaway script iterating the syntax tree over `"- [ ] test"`) to already produce GFM `Task`/`TaskMarker` nodes. Regex was used anyway because it's simpler to keep in one place alongside the due-date/priority/recurrence text-scanning, which has no AST representation regardless.

- `TASK_LINE_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/` — detects the line and captures the status char (group 3). Matches `TaskRegularExpressions.taskRegex` in the sibling `angelCastro.obsidian-like-tasks` extension.
- `TASK_CHECKBOX_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +(\[.\])/` — narrower match used only to locate the exact `<indent><marker> [<char>]` span for the widget replacement (consumes the marker + checkbox, then at most one extra trailing space is swallowed — mirrors the existing `ListMark` → `BulletWidget` replacement).
- Status char one of `xX-` (done/cancelled) → line gets `cm-task-line cm-task-done` (line-level, via `Decoration.line`); any other char → just `cm-task-line`. Line numbers recognised as tasks are tracked in a per-build `taskLines: Set<number>` so the plain `ListMark` handler (further down in the same tree walk) can skip adding its `BulletWidget` for that line — otherwise the two replacement decorations would overlap.
- The `<marker> [<char>] ` span is replaced with `TaskCheckboxWidget(checked, line0based)` — a `WidgetType` rendering a real `<input type="checkbox">` with class `cm-task-checkbox` and `data-line` set to the 0-based doc line number. **Unlike `BulletWidget`, this is rendered on the active/cursor line too** (the task-line branch runs before the `active.has(ln)` gate that hides other inline markers on the cursor's line), so the checkbox stays clickable while editing that line's text.
- For non-done tasks, the remaining text after the checkbox is scanned (still plain regex, not AST) for `TASK_DUE_RE` (`📅`/`📆`/`🗓` + `YYYY-MM-DD`), `TASK_PRIORITY_RE` (`🔺⏫🔼🔽⏬`), and `TASK_RECURRENCE_RE` (`🔁` + rule text). Only the due date gets a visual treatment: if it parses to a calendar date strictly before today, that substring gets `Decoration.mark({ class: 'cm-task-overdue' })` (red/bold, mirrors `TaskDecorations.ts`'s `overdueDecoration` in the sibling Tasks extension). Priority/recurrence are parsed for parity with that extension's signifiers but currently have no dedicated styling.
- Clicking `.cm-task-checkbox` is wired into the existing `linkClickHandler` (`mousedown` prevents default / `click` fires the action, same pattern as wiki-links and `cm-md-link`): sends `vscode.postMessage({ type: 'toggle-task', line: Number(el.dataset.line) })`. The extension host applies the actual toggle (see "Task checkboxes" under extension-host message handlers above) and the resulting document change flows back through the normal `external-update` path, so the widget re-renders with the new checked state once applied — there is no local optimistic DOM update.

### ```tasks``` query blocks (also in `livePreviewPlugin`)

Unlike single-checkbox lines, a ```tasks``` query needs data from the *entire vault* (the sibling extension's in-memory task index), which the webview cannot compute from the current document's AST alone. Rendering is therefore an async round-trip: webview → this extension's host (`postMessage`) → `angelCastro.obsidian-like-tasks`'s exported API → back to the webview → render. Since `_build()` runs synchronously, results can't be awaited inline — see the cache/effect mechanism below.

- Detected via the `FencedCode` node in the same tree walk as `Table` (empirically verified: `markdown({ base: markdownLanguage })`'s default GFM setup produces `FencedCode` → `CodeMark`, `CodeInfo` (the info string), `CodeText` (the full query text as one node, even when multi-line), `CodeMark`). Only blocks whose `CodeInfo` is exactly `tasks` are touched; everything else falls through to the unmodified default `FencedCode`/`CodeMark`/`CodeText` handling.
- Rendering follows the exact same non-block strategy as `Table` (`block: true` decorations are banned — see the comment above `livePreviewPlugin`): the opening ` ```tasks ` fence line becomes a single-line `Decoration.replace({ widget: TasksQueryWidget })`; every remaining line (query text + closing fence) is collapsed via an empty `Decoration.replace({})` + `Decoration.line({ class: 'cm-table-row-hidden' })`, reusing that class rather than adding a redundant one. Also mirrors `Table`'s active-line fallback: if the cursor is on any line inside the block, the raw ` ```tasks `/query text/`` ` `` is left untouched and editable.
- `tasksQueryCache: Map<string, TasksQueryResultDTO>` (keyed by trimmed query text) and `tasksQueryPending: Set<string>` (dedupes in-flight requests) are module-level. `requestTasksQuery(query)` posts `{ type: 'run-tasks-query', query }` if that text isn't already pending. `tasksRebuildEffect: StateEffect` is a no-op effect dispatched purely to force a `livePreviewPlugin` rebuild once data arrives or is invalidated — the same trick `foldEffect` uses for fold toggles; `livePreviewPlugin.update()` checks for it alongside `docChanged`/`selectionSet`/`viewportChanged`.
- `TasksQueryWidget(query, result)` — `result` is whatever `tasksQueryCache.get(query)` held at `_build()` time: `undefined` while in flight (renders a "Cargando…" placeholder) or the resolved `TasksQueryResultDTO` once available. Passing `result` into the constructor (rather than reading the cache from inside `toDOM()`) makes `eq()` correctly report "not equal" once data arrives, so CM6 actually replaces the placeholder DOM instead of reusing it.
- `renderTasksQueryResult(container, result)` builds real DOM (`textContent`, not `innerHTML` — task descriptions are never interpreted as HTML) via `renderTaskRow`/`renderTaskList`: one `<div class="cm-tasks-query-item">` per task, containing a checkbox (class `cm-task-checkbox cm-task-query-checkbox` — **both** classes, so it still picks up `vsTheme`'s checkbox styling) plus priority/due-date/recurrence badges (`cm-tasks-query-badge`, overdue ones also get `cm-task-overdue`). `result.groups` (when the query has `group by`) renders a `cm-tasks-query-group-title` heading per non-empty group instead of one flat list. `result.unrecognizedLines` (query lines the engine didn't understand) are surfaced as a visible `cm-tasks-query-warning`, never silently dropped.
- A tasks-query checkbox carries `data-path` **and** `data-line` (a result can come from any file in the vault, not just the open one), so `linkClickHandler` checks `.cm-task-query-checkbox` *before* the plain `.cm-task-checkbox` branch (the query checkbox matches both selectors) and sends `{ type: 'toggle-task-at-location', path, line }` instead of the single-file `{ type: 'toggle-task', line }`.
- Host side (`onDidReceiveMessage`): `run-tasks-query` calls `(await getTasksApi())?.renderTasksQuery(query)` (empty `{ items: [], groups: null, unrecognizedLines: [] }` if the API/extension is unavailable, so the webview's placeholder doesn't hang forever) and replies with `{ type: 'tasks-query-result', query, result }`. `toggle-task-at-location` calls `toggleTaskAtLocation(path, line)`, which — unlike `toggleTaskLine` — may open and edit a document that isn't the one currently shown in this panel.
- `ensureSubscribedToTasksChanges()` (module scope, single-flight via `subscribedToTasksChanges`, called from the top of `resolveCustomTextEditor` every time a panel opens) subscribes to the Tasks extension's `onDidChangeTasks` event and, on every fire, broadcasts `{ type: 'tasks-changed' }` to every panel in `activePanels`. If the lookup fails, it retries up to 5 times, 1.5s apart, instead of giving up for the rest of the session — a single long-lived panel opened during the cold-start race described above would otherwise never get another chance to subscribe (there's no new panel-open event to retry from if the user doesn't close and reopen it). The webview's handler for `tasks-changed` clears `tasksQueryCache`/`tasksQueryPending` entirely and dispatches `tasksRebuildEffect`, so every visible ```tasks``` block re-requests fresh data — this is what makes toggling a task in one file (or from another query block entirely) refresh every other open query view.

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
