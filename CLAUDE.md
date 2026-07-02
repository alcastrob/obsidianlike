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
| `src/extension.ts` | Extension host: ~800 lines. Provider, message handling, file I/O. |
| `webview-src/editor.js` | Webview CM6 editor: ~1800 lines. All editor logic. |
| `out/extension.js` | Compiled host (committed, required for packaging). |
| `out/editor.bundle.js` | esbuild bundle of webview (committed, required for packaging). |
| `package.json` | Publisher is `angelCastro` — the installed extension ID is `angelCastro.vault-tool`. |

## Architecture: extension host (`src/extension.ts`)

### Helpers

- `getAttachmentRoots(docUri)` — returns `vscode.Uri[]` for `localResourceRoots` (vault root, doc dir, configured subfolder). Vault root is always included, so any nested path under it is webview-accessible.
- `findImageFiles(dir)` — recursive image-file walker (extensions: png/jpg/jpeg/gif/svg/webp/bmp), skipping dotfiles and `node_modules`. Falls back to `fs.statSync` when `Dirent.isDirectory()/isFile()` are both false, because cloud-sync placeholder folders (Dropbox Smart Sync, OneDrive Files On-Demand) use NTFS reparse points that Node's `readdirSync` dirent type can misreport on Windows.
- `getImageMap(webview, docUri)` — returns `{ filename → webviewUri }` map. Resolution order: (1) the configured attachments dir (`getSaveDir`) — priority location; (2) a recursive `findImageFiles` scan of the whole vault root for any filename not already found. First match wins per basename. If a `![[file]]` reference isn't in the map at all, `imgPlugin` leaves the raw markdown text untouched instead of rendering a broken image.
- `getThemeCss()` — reads `.obsidian/themes/{name}/theme.css` from vault root (config: `vaultTool.obsidianTheme`). Tries the exact-case path first, then falls back to a case-insensitive scan of `.obsidian/themes/`, matched by **name only** — deliberately not gated on `Dirent.isDirectory()`. A first version of this fallback did gate on it and still failed on a real macOS vault where the theme folder was visibly present: `readdirSync`'s `Dirent` type can misreport for reparse points / cloud-sync placeholders (iCloud Drive, Dropbox, OneDrive) / network or FUSE mounts — the same class of bug `findImageFiles` already works around elsewhere in this file, and not actually Windows-exclusive, just more commonly hit there. Since all that matters is whether `theme.css` is readable at the expected path, the fallback just tries reading it for every name-matching candidate instead of trusting the dirent type at all. If the theme still isn't found after both attempts, `showWarningMessage` includes the exact resolved `.obsidian/themes` path plus whatever folder names *were* found there (or a note that the directory itself couldn't be read) — richer than a bare "not found," since that's the only diagnostic signal available without a live debugging session on the machine where it fails.
- `computeBreadcrumb(docUri)` — returns `[{ name, fsPath }]` array for the clickable path bar
- `splitTarget(raw)` — splits a wiki-link/transclusion target into `{ notePart, section }` on the first `#`. `section` is a heading's raw text and may be from **any** level (`#`–`######`) — `note#section` does not imply the target heading is `# section`; it's matched against whatever level it's actually written at in the target file (see `parseHeadings`).
- `splitDirHint(notePart)` — splits `notePart` into `{ noteName, dirHint }` on `/`; only the immediate parent segment is kept as the disambiguation hint (mirrors the wiki-link directory-hint rule below).
- `resolveNoteUri(notePart, currentDir)` — the shared note-lookup used by `open-note`, `open-transclusion`, `get-transclusion` and `get-headings`. See "`open-note` resolution rules" below — this function *is* those rules, factored out so all four callers agree on where a bare/disambiguated note name resolves to.
- `parseHeadings(text)` — regex ATX-heading scanner (`# `.. `###### `), returns `[{ level, text, line }]` in document order (`line` is 0-based). Skips lines inside ``` ``` ```/`~~~` fences so a `#` in a code sample isn't mistaken for a heading. Setext headings (`===`/`---` underlines) are **not** recognized — only ATX, matching what `livePreviewPlugin`'s `ATXHeading[1-6]` handling already assumes webview-side.
- `navigateToTarget(raw, currentDocUri, sourcePanel, createIfMissing)` — resolves `raw` (via `splitTarget` + `resolveNoteUri`), optionally creates the note when missing (`open-note` passes `true`; `open-transclusion` passes `false` — a transclusion pointing nowhere should surface "not found", not silently create a blank note), opens it with `vscode.openWith` in `sourcePanel`'s column, and — if `raw` carried a `#section` that resolves to a real heading in the target — looks up that target's panel in `panelsByPath` and posts `scroll-to-line` to it ~350ms later (giving the freshly-opened webview time to mount). Disposes `sourcePanel` afterward, same as the original `open-note`-only behavior.

### Module-level state

- `noteIndex: string[]` — all `.md` filenames in vault (no extension). Built at activation, updated by `FileSystemWatcher` on create/delete, broadcast to all open panels.
- `activePanels: vscode.WebviewPanel[]` — tracks open panels to push `note-index` updates.
- `panelsByPath: Map<string, vscode.WebviewPanel>` — the panel currently showing each document path (set/cleared alongside `activePanels`, keyed by `document.uri.fsPath`). Exists solely so `navigateToTarget` can find the just-opened (or already-open) target panel to send `scroll-to-line` to — `vscode.openWith` doesn't hand back a panel reference, and `supportsMultipleEditorsPerDocument: false` means there's at most one panel per path to track.

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
| `rename` | Validates new name, calls `WorkspaceEdit.renameFile()` — link fixup happens via the `onDidRenameFiles` listener that fires from this, see below, not from this handler directly |
| `open-note` | `navigateToTarget(name, ..., createIfMissing: true)` — resolves the wiki-link target (optionally `note#section`) and opens it with `vscode.openWith` in the same column, scrolling to the heading if a section was given (see below for resolution/creation rules) |
| `open-transclusion` | Same as `open-note` but `createIfMissing: false` — clicking a transclusion's "open source" button navigates to it like a link, but a missing target just shows a warning instead of creating an empty note |
| `get-transclusion` | Resolves `msg.target` (`note`, `dir/note`, or `...#section`), reads the target's text via `vscode.workspace.openTextDocument` (so unsaved edits in another open tab are reflected), slices out the section if one was given, and replies `transclusion-result` — see "Transclusions" below |
| `get-headings` | Resolves `msg.note`, returns `parseHeadings(text)` (level/text only, no line) as `headings-result` — powers the `#`-section step of `wikiComplete`'s autocomplete |
| `open-url` | `vscode.env.openExternal(vscode.Uri.parse(url))` |
| `reveal-path` | `vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath))` |
| `paste-image` | Saves base64 buffer as `Pasted image YYYYMMDDHHMMSS.png` to configured attachments dir, sends back `image-pasted` with webview URI |
| `drop-files` | `{ files: [{ name, data }] }` — one or more OS files dropped onto the webview. Saves each into the configured attachments dir *keeping the original filename* (unlike `paste-image`'s timestamp naming, since a real filename is available here), disambiguating only on an actual collision (`"name N.ext"`), and replies `files-dropped` |
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

### `open-note` / transclusion target resolution rules (`resolveNoteUri`)

A wiki-link or transclusion target may optionally carry one directory segment to disambiguate same-named notes, e.g. `[[folder/Note]]` or `![[folder/Note]]`. Only the immediate parent directory name is used as a hint — the rest of any longer path is ignored. It may also optionally carry a `#section` suffix (stripped by `splitTarget` before this resolution runs) pointing at an ATX heading of **any** level in the target file.

- **No directory hint** (`[[Note]]`): prefer a `Note.md` in the same directory as the note containing the link; if absent, fall back to a vault-wide `findFiles` search (first match wins).
- **Directory hint** (`[[folder/Note]]`): vault-wide search for `Note.md`, filtered to results whose immediate parent directory is named `folder` (case-insensitive).
- **Not found anywhere**: `open-note` creates it — target directory is the hinted subfolder inside the *current* note's directory (created if missing), or the current note's directory itself if no hint was given; the new file is written empty. `open-transclusion`/`get-transclusion`/`get-headings` do **not** create anything — they report "not found" instead, since silently creating a blank note just to embed it makes no sense.
- **Section resolution**: once the target file is found, `parseHeadings(text)` is scanned for a heading whose `text` matches `section` case-insensitively (exact match, not substring). No match → `open-note`/`open-transclusion` just skip the scroll (link still opens the note); `get-transclusion` replies with `error: 'section-not-found'`.

### Fixing up wiki-links after a note is renamed or moved (`onDidRenameFiles`)

Registered once in `activate()`: `vscode.workspace.onDidRenameFiles(e => { void handleWorkspaceRename(e.files); })`. This single listener covers **both** rename sources — the in-app title-edit (`rename` message handler calls `WorkspaceEdit.renameFile()`) and anything done in VS Code's own file explorer (drag, cut/paste, F2, moving an entire folder) — because both ultimately go through the same real filesystem rename that this event fires for. The webview's `rename` handler no longer fixes up links itself; there's a comment there pointing here instead.

- `handleWorkspaceRename(files)` — `onDidRenameFiles` gives one `{oldUri, newUri}` pair per renamed/moved *item*, which for a folder move is the folder itself, not each file inside it. If `newUri` is now a directory, `findMarkdownFiles(newUri.fsPath)` walks it and each found file's pre-move path is reconstructed by rebasing it onto `oldUri` (`path.relative(newUri.fsPath, newFilePath)` re-joined onto `oldUri.fsPath` — the subtree's internal structure doesn't change in a move, only the path prefix does). Non-`.md` files/folders containing none are skipped entirely — image links resolve by basename only (`getImageMap`), so moving an image never breaks a `![[file.png]]` reference and doesn't need this.
- `fixUpLinksForMovedNote(oldUri, newUri)` — unlike a blind name replace, a move can also change which directory a link needs to disambiguate against, so this must actually *resolve* each candidate link (against the vault as it was just before the move) rather than pattern-match on the old name alone:
  - Builds `oldFileList`: the current (post-move) vault-wide `.md` list with `newUri`'s path swapped back to `oldUri`'s — i.e. a snapshot of "the vault one moment before this specific move", since every other file's location is unaffected by it.
  - For every `[[...]]`/`![[...]]` in every *other* vault note (`WIKI_TARGET_RE = /(!?)\[\[([^\]]+)\]\]/g`), splits out any `|alias`/`#section` suffix (left untouched) and calls `resolvesToOldTarget(notePart, linkingDir, oldFileList, oldUri.fsPath)`, which replays `resolveNoteUri`'s exact same-directory-first / directory-hint rules against `oldFileList` to check whether *this specific* link — not just any link sharing the old name — actually pointed at the file that moved. (Two different notes can share a basename in different folders; only a link that genuinely resolved to the moved file should be touched.)
  - A confirmed match is rewritten using the *new* location: no directory hint if the linking note and the moved note now share a directory, otherwise `path.basename(newDir)` — consistent with `splitDirHint`'s "only the immediate parent segment is ever used as a hint" rule, so the rewritten link resolves the exact same way any other hinted link would.
  - Only *incoming* links (from other notes) are fixed up — the moved note's own outgoing links aren't touched, even though its own "prefer a file in the same directory" resolution basis has also shifted. Out of scope for now; not requested.
- **Known limitation, shared with `open-note`'s existing "first match wins" ambiguity**: when a moved note has no directory hint pointing at it and multiple same-named notes exist elsewhere in the vault, `resolvesToOldTarget`'s "which one does this link actually mean" tie-break (a sorted list, for determinism) isn't guaranteed to match whatever order VS Code's real `findFiles` would have picked at `open-note` resolution time — this only matters when such a naming collision exists at all.

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
  previewCompartment.of([livePreviewPlugin, mdLinkPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin]),
  foldPlugin,
  linkClickHandler,
  autocompletion({ override: [wikiComplete], closeOnBlur: true }),
  keymap.of([Mod-b (bold), Mod-i (italic), ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
  vsTheme,
  EditorView.updateListener (400ms sync debounce),
]
```

### `vsTheme` / `mdHighlight`

- `vsTheme`: `EditorView.theme({})` with CSS vars from VS Code (`--vscode-editor-*`) for all CM6 UI elements. Also defines `.cm-wiki-link`, `.cm-md-link`, `.cm-fold-indicator`, `.cm-fold-hidden`, `.cm-table-row-hidden`, table styles, **`.cm-header-1` through `.cm-header-6`** heading styles, and **`.cm-inline-code`/`.cm-code-block*`** code styles (see below).
- `mdHighlight`: `HighlightStyle` for bold, italic, strikethrough, links, code. Heading levels and `tags.monospace` (inline code + fenced code content) use **`class` only** (e.g. `{ tag: tags.heading1, class: 'cm-header cm-header-1' }`, `{ tag: tags.monospace, class: 'cm-inline-code' }`) — **critical**: when `class` is set in a HighlightStyle spec, CM6 ignores all CSS properties in that spec and uses the class name as-is. Their actual visual styles (fontSize, background, etc., via CSS vars) must therefore live in `vsTheme`, not in `mdHighlight`.

### Heading styling architecture (important)

Heading spans receive stable class names (`cm-header cm-header-1`…`cm-header-6`) via `mdHighlight`'s `class` property. The CSS for those classes lives in `vsTheme` and references Obsidian theme vars (`--h1-size`, `--h1-weight`, `--h1-color`, etc.) with fallback defaults. The `#editor` div has `class="is-live-preview markdown-source-view mod-cm6"` so Obsidian theme selectors like `.is-live-preview .HyperMD-header-1::before` work. The `cm-line` div for each heading gets `HyperMD-header HyperMD-header-N` via `Decoration.line()` in `livePreviewPlugin` (added before the active-line check, so it applies to all heading lines).

### Inline code vs. fenced code block styling (important)

`@lezer/markdown`'s default `styleTags` maps **both** `InlineCode` and a fenced code block's `CodeText` to the exact same `tags.monospace` tag (confirmed by inspecting `node_modules/@lezer/markdown/dist/index.js`: `"InlineCode CodeText": tags.monospace`) — there's no way to give them different treatment via `mdHighlight`'s tag-based matching alone, since CM6 can't distinguish which node produced a given tag once matched.

This mattered because the two need genuinely different visual treatment: standalone inline code (`` `text` ``) should look like a small chip (background + padding + border-radius), but applying that *same* per-character styling to a fenced block's `CodeText` — which, for a multi-line block, is one syntax node spanning several lines — rendered as a stack of visually disconnected chips instead of one block. (`Decoration.mark` ranges can't span a block boundary as a single DOM element; CM6 necessarily fragments a multi-line highlighted range into one `<span>` per visual line, and each fragment independently got the full chip styling.)

The fix, in two parts:
- `mdHighlight` gives `tags.monospace` a stable class (`cm-inline-code`) instead of inline CSS properties (same `class`-only pattern as headings). `vsTheme`'s `.cm-inline-code` rule has the chip styling, with `fontFamily: var(--code-font, var(--font-monospace, var(--vscode-editor-font-family, monospace)))` — `--code-font` is the user-configurable `vaultTool.codeFont` setting (see "Configuration" below), empty by default so it falls through to the Obsidian theme/editor font.
- `livePreviewPlugin`'s `FencedCode` handling (the "not a `tasks` block" fall-through path) treats the fence-open/-close lines and the content lines differently, mirroring Obsidian's own live preview rather than just hiding marker text in place:
  - **Gated on the fence actually being closed** — see "Deriving the closing fence line" below for why this matters and isn't optional.
  - The two fence lines (the ` ``` ` lines themselves) get the *exact* same dual treatment as `Table`'s collapsed rows / `foldPlugin`'s folded content elsewhere in this file: a full-line `Decoration.replace({})` plus a `Decoration.line({ class: 'cm-code-fence-hidden' })` (height:0, same technique as `.cm-table-row-hidden`/`.cm-fold-hidden`) — but only when that specific fence line **isn't** the active line. An earlier version only relied on the generic non-active-line `CodeMark` hiding further down (which just blanks the ` ``` ` glyphs' *text*), leaving the line itself at full height — Obsidian collapses that vertical space entirely rather than showing an empty, oddly-padded line, which is what this now matches.
  - Every line **between** the two fence lines (the actual code) gets `cm-code-block` (`cm-code-block-first`/`-last` for the outer rounded corners/border on the first/last content line, or `cm-code-block-solo` when there's exactly one content line) — unconditionally, active or not, same as heading line classes, so the box stays visible while editing inside it.
  - `vsTheme` has a plain descendant-selector override, `.cm-code-block .cm-inline-code { background: none; padding: 0; borderRadius: 0; }`, which cancels the chip look specifically for `CodeText` found inside a code-block line — ordinary CSS specificity (two classes beat one), no fighting over decoration nesting order needed.

#### Deriving the closing fence line — gate on a real second `CodeMark`, never on `node.to`/`doc.length`

A first version of the fence-line-collapsing logic above (and, it turns out, the *pre-existing* ` ```tasks ` query-block handling right next to it, which has always computed things the same way) derived "the closing fence's line" as `state.doc.lineAt(Math.max(node.from, Math.min(node.to, state.doc.length) - 1))`. This is wrong specifically **while the fence is still open** (being actively typed, not yet closed): lezer-markdown extends an unclosed `FencedCode` node all the way to end-of-document, so the instant the user presses Enter after typing content and lands on a fresh, still-empty line, `node.to` sits exactly at `doc.length` — pulling back by 1 to "stay inside the node" walks *past* that empty (but real, cursor-occupied) line and back onto the actual content line typed just before it. That content line then gets misidentified as "the closing fence" and — because it isn't the active line (the cursor is one line further down, on the line this computation skipped past) — gets collapsed to zero height by the logic above. That alone is a visible bug (typed text vanishing), but the real damage: collapsing a line the cursor's neighboring navigation depends on while CM6 is mid-layout is severe enough to corrupt its own cursor/selection tracking outright — reported symptom was total input lockup (arrow keys, clicks, even Enter doing nothing) that persisted until the document was closed and reopened.

The fix: never derive the closing line from `node.to`/`doc.length` math. Check `node.node.getChildren('CodeMark')` instead — lezer-markdown only emits a *second* `CodeMark` once a real closing ` ``` ` has been parsed (confirmed empirically: 1 mark while open, 2 once closed, regardless of how much content sits in between). If there's no second mark yet, skip the fence-collapse/box-styling logic entirely for that render pass (the block still renders fine via the generic, always-on per-node marker hiding — just without the box until it's actually closed). Once closed, `state.doc.lineAt(closeMark.from)` gives the real closing line unambiguously, no `doc.length` arithmetic involved. Applied to both the `tasks`-query-block widget path and the regular code-block path, since both had the identical latent bug (the `tasks` one just hadn't been hit in practice, likely because a `` ```tasks `` block is typically pasted or completed in one go rather than typed line-by-line with the cursor lingering on a fresh trailing empty line mid-edit).

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

For non-active lines with known filename in `imageMap`, replaces with `ImageWidget`. If the bracketed name's extension isn't one of `IMG_EXT`, `imgPlugin` leaves it alone — that's the signal `transclusionPlugin` (below) uses to claim it instead, since both plugins run their own regex pass over the exact same `!\[\[...\]\]` syntax.

`ImageWidget(src, alt, width, caption)` — renders `<img>` optionally wrapped in `<figure>` + `<figcaption>`.

### `transclusionPlugin` — note transclusions (`![[note]]`, `![[dir/note]]`, `![[note#section]]`)

Same `!\[\[([^\]]+)\]\]/g` regex pass as `imgPlugin`, but claims the match when the bracketed name (before any `#section` or `|param`) does **not** look like an image filename (`IMG_EXT.test(...)` false) — the two plugins' viewport passes are independent and each only emit decorations for the subset they own, same pattern `mdLinkPlugin`/`wikiLinkPlugin`/`imgPlugin` already use for their respective syntaxes.

A transclusion needs the *target* note's (possibly section-scoped) text, which the webview can't read itself — same async round-trip as `` ```tasks ``` `` query blocks: webview posts `get-transclusion` (host resolves + reads + slices), host replies `transclusion-result`, webview caches and rebuilds.

- `transclusionCache: Map<string, { content, title, line, error }>` keyed by the *raw* bracketed target string (e.g. `"projects/Foo#Status"`), `transclusionPending: Set<string>` dedupes in-flight requests, `transclusionRebuildEffect: StateEffect` forces a rebuild once a reply lands — all three mirror `tasksQueryCache`/`tasksQueryPending`/`tasksRebuildEffect` exactly.
- Since the source line is always a single line already (unlike a multi-line table), rendering needs no `Table`-style "collapse the remaining lines" trick: the whole `![[target]]` match is one `Decoration.replace` (not `block: true`) whose widget happens to render multi-line content — the same technique `ImageWidget`/`TableWidget`/`TasksQueryWidget` already rely on.
- `TransclusionWidget(target, data)` — `data` is whatever `transclusionCache.get(target)` held at `_build()` time: `undefined` while in flight (renders a loading placeholder), `{ error }` for `'not-found'` / `'section-not-found'` / `'error'` (renders a one-line message instead of a body), or `{ content, title, line }` on success. Rendered DOM: an outer `div.cm-transclusion` (the bordered rectangle) containing a `button.cm-transclusion-open` (absolutely positioned top-right, `↗` glyph, `data-target` = the raw target string) plus a `div.cm-transclusion-body` (an optional `div.cm-transclusion-title` showing the target's filename, then `renderMarkdownBlock(content)`).
- `renderMarkdownBlock(text)` — a small line-based block renderer (headings → `div.cm-header-N`, fenced code → `<pre><code>`, `>` blockquotes, `-`/`*`/`+` lists → `<ul>`, blank-line-separated paragraphs) used only for transcluded content; each block/paragraph's inline text goes through the existing `renderCell()` (bold/italic/strikethrough/code/wiki-links), which HTML-escapes first, so transcluded text can't inject markup. Nested `![[...]]` inside transcluded content is **not** re-resolved — it renders as inert escaped text, i.e. transclusions do not recurse.
- Clicking `.cm-transclusion-open` is wired into `linkClickHandler` exactly like `.cm-md-link`/task checkboxes: sends `{ type: 'open-transclusion', target: btn.dataset.target }`. The host's `navigateToTarget` (`createIfMissing: false`) resolves it, opens the target note in the same column, scrolls to the `#section` heading if one was given, and disposes the current panel — same UX as clicking any other wiki-link in this app's single-pane navigation model.
- `scroll-to-line` (host → webview): moves the selection to `doc.line(msg.line + 1).from` and dispatches `EditorView.scrollIntoView(pos, { y: 'center' })`. Sent by the host ~350ms after `vscode.openWith` resolves, targeting whichever panel `panelsByPath` says now owns that document path (works whether the target editor was freshly created or was already open).

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
- `ensureSubscribedToTasksChanges()` (module scope, single-flight via `subscribedToTasksChanges`, called from the top of `resolveCustomTextEditor` every time a panel opens) subscribes to the Tasks extension's `onDidChangeTasks` event and, on every fire, broadcasts `{ type: 'tasks-changed' }` to every panel in `activePanels`. If the lookup fails, it retries up to 5 times, 1.5s apart, instead of giving up for the rest of the session — a single long-lived panel opened during the cold-start race described above would otherwise never get another chance to subscribe (there's no new panel-open event to retry from if the user doesn't close and reopen it).
- The webview's handler for `tasks-changed` re-requests (`requestTasksQuery`) every query currently in `tasksQueryCache`, but **does not clear the cache first** and does not dispatch a rebuild itself — the stale result stays on screen exactly as-is until the fresh one actually arrives via `tasks-query-result` (which is what triggers the rebuild). An earlier version cleared the cache immediately, which forced every visible ```tasks``` block to flash to its "loading" placeholder and back on every single edit; showing stale-but-correct data for the fraction of a second it takes to refetch reads as instant, not as a flicker.
- **This whole feature was broken for a while by a subtle bug on the Tasks extension's side, not here**: its `onDidChangeTasks` was a `get onDidChangeTasks()` getter, and its `activate()` built the returned API via `{ ...createTasksApi(...) }` — spreading an object evaluates getters immediately, once, baking in whatever they returned *at that exact moment* as a plain value. Since the spread happened before that extension's own task index existed, the getter always saw `undefined` and returned a throwaway, never-fired `EventEmitter`. `ensureSubscribedToTasksChanges()` here "subscribed successfully" every time, just to the wrong emitter — nothing was ever wrong on this side. See `d:\git\vscode-tasks\CLAUDE.md`'s gotchas for the fix. Diagnosed with a real `vscode.OutputChannel` on both sides (not `console.log`, which isn't visible for a normally-installed, non-debug extension).

### Font/theme metrics and `requestMeasure()`

CM6 measures line-height/character metrics once during its own layout passes, using whatever font is actually resolved by the browser at that moment. Two things in this codebase change those metrics *after* CM6 has already measured and cached them, without going through CM6's own transaction system: the `theme-css` message (an Obsidian theme can define its own heading fonts/line-heights, and — per "Why theme CSS is sent via postMessage" above — it lands ~300ms after the webview's initial paint, well after CM6's first layout) and `font-update` (changes `--md-font`/`--md-font-size`, which `.cm-content` reads directly). If CM6's cached geometry goes stale relative to what's actually painted, anything computed from it — most visibly `drawSelection()`'s custom-drawn selection boxes — ends up positioned against the old metrics instead of the current ones, i.e. offset from the text it's supposed to cover. A one-time `document.fonts.ready.then(() => view.requestMeasure())` right after editor creation, plus the calls from those two message handlers, fix it.

**Confirmed fixed on real macOS hardware** — but the actual chain was more specific than "a timing race" originally suggested: `resolveCustomTextEditor` only sends `theme-css` at all when `getThemeCss()` returns non-empty (`if (themeCss) { webviewPanel.webview.postMessage(...) }`). While `getThemeCss()`'s macOS path-lookup bug (see its entry above) was making it return `''`, the `theme-css` message — and therefore the `requestMeasure()` call inside its handler — never fired *at all* on that machine, not just late. Fixing the theme lookup made both problems disappear together: the theme's own CSS started applying, and the `requestMeasure()` call attached to that same message finally got a chance to run and correct CM6's stale initial layout (which, until then, had been permanently based on `vsTheme`'s fallback font/sizing rather than the theme's actual ones — not a race that later resolved itself, but a fix that was never reached).

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

CM6 async autocompletion source (returns a `Promise` — CM6's `autocompletion({ override: [...] })` supports async sources natively). Triggered by `\[\[[^\]]*$` before cursor — matches whether preceded by `!` or not, so it fires for both `[[note]]` links and `![[note]]` transclusions; the `!` is left untouched and only the `[[...]]` span is replaced by `apply`.

- **No `#` typed yet**: filters `noteIndex` by substring match, `apply: '[[Name]]'`. `validFor: /^\[\[[^\]#]*$/` deliberately excludes `#` — typing one invalidates the result and forces CM6 to re-run the source rather than just re-filtering the existing (note-name) options against a query that now contains `#`.
- **`#` typed** (`![[Note#` or `[[Note#`): switches to heading search for the note part before the `#`. `requestHeadings(notePart)` posts `{ type: 'get-headings', id, note: notePart }` and returns a `Promise` resolved by the `headings-result` handler (correlated via a locally-generated `id`, tracked in `pendingHeadingRequests: Map<id, resolve>` — parallel in spirit to how `tasksQueryPending`/`transclusionPending` dedupe host round-trips, but here every request gets its own id since results aren't cached/reused across different queries). Options are the host's `parseHeadings()` order (i.e. **document order**, not alphabetical — satisfies "same hierarchical order as written"), filtered by substring on `text`, labeled `'#'.repeat(level) + ' ' + text` so the `#`/`##`/`###` prefix visually conveys nesting, `apply: '[[notePart#Heading]]'`.

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
| `files-dropped` | `{ files: [{ filename, uri }] }` — reply to `drop-files`. Updates `imageMap` for each (harmless no-op for non-images, since `imgPlugin` only ever looks up extensions in `IMG_EXT`) and inserts one `![[filename]]` per file, newline-separated, at `pendingDropPos` (the position under the cursor at drop time — see "Drag & drop files" below) |
| `font-update` | Updates `--md-font` and `--md-font-size` CSS vars on `<html>` |
| `theme-css` | Sets `element.textContent = css` on `<style id="__obsidian-theme">`, then calls `view.requestMeasure()` (see "Font/theme metrics and `requestMeasure()`" below) |
| `toggle-source-mode` | Reconfigures `previewCompartment` to `[]` or back |
| `transclusion-result` | Caches `{ content, title, line, error }` in `transclusionCache` keyed by `msg.id` (the raw target string), dispatches `transclusionRebuildEffect` |
| `headings-result` | Resolves the matching `pendingHeadingRequests` entry (by `msg.id`) with `msg.headings` — feeds `wikiComplete`'s section-search branch |
| `scroll-to-line` | Moves the selection to `doc.line(msg.line + 1)` and scrolls it to the vertical center — sent after navigating to a `#section` target |

### Drag & drop files onto the editor — status: fix attempted, not yet confirmed working

First attempt (raw `document.addEventListener('dragover'/'drop', ...)`) was manually tested and failed: VS Code's own "open the dropped file as a new editor tab" behavior still won. This looked at first like a VS Code-level architectural block (a drag-tracking overlay rendered outside the webview's iframe) — **but that theory doesn't hold up**: `microsoft/vscode#182449` confirms OS-file-drop onto a `CustomTextEditorProvider` webview does reach the webview's DOM (fixed in the June 2024 milestone; only Explorer-tree-internal drags were ever broken, and that's since been fixed too). So on a current VS Code (this repo tests against 1.126.0), the drop should reach our iframe's content just fine.

The real, confirmed-in-source culprit: **`@codemirror/view`'s `EditorView` has its own built-in `drop` handler** (`handlers.drop` in `node_modules/@codemirror/view/dist/index.cjs`) that, on seeing `event.dataTransfer.files.length > 0`, reads each file as *text* (`FileReader.readAsText`) and inserts the result into the document — garbage for a binary file like `.docx`. This built-in handler is bound directly to `view.contentDOM`, which sits *inside* `#editor` — closer to the actual drop target than a `document`-level listener, so it's reached first as the event bubbles, regardless of what a listener bound higher up the tree tries to do. Whether that alone fully explains "opens as a new tab" (as opposed to inserting garbled text) is unconfirmed; either way it's a real bug worth fixing on its own.

CM6 combines event handlers per type as `[...extension-registered domEventHandlers, ...its own built-in handlers.X]` (`computeHandlers` in `@codemirror/view`) and — per `runHandlers` — stops at the first one that returns truthy for that event, calling `preventDefault()` for it. So `dragenter`/`dragover`/`drop` are now registered as part of `linkClickHandler`'s existing `EditorView.domEventHandlers({...})` extension (same mechanism as its `mousedown`/`click` handling, not a raw DOM listener), which places them *before* CM6's own built-in `handlers.drop` in that per-type list — returning `true` there pre-empts CM6's default file-as-text behavior entirely, rather than racing against it.

- `dragenter`/`dragover` (on `linkClickHandler`) — return `true` whenever `e.dataTransfer.types.includes('Files')`; `dragover` also sets `dropEffect = 'copy'`. CM6 calls `preventDefault()` automatically for a truthy return, so the target becomes (and stays) valid for the duration of the drag.
- `drop` (on `linkClickHandler`) — computes the insertion position via `view.posAtCoords({x, y})` (falling back to the current selection head), stashes it in module-level `pendingDropPos`, reads every `File` via `readFileAsDataUrl` (`FileReader.readAsDataURL` wrapped in a `Promise`), and posts one batched `{ type: 'drop-files', files: [{ name, data }] }` once all have resolved. Returns `true`.
- A `document`-level fallback (`dragenter`/`dragover`/`drop`, sharing the same `pendingDropPos`/`readFileAsDataUrl`) still exists for drops landing outside CM6's `contentDOM` (the title/breadcrumb area above the editor, which `eventBelongsToEditor()` in `@codemirror/view` excludes from CM6's own handler scope entirely) — guarded with an `if (e.defaultPrevented) return;` at the top of each so it doesn't double-process a drop `linkClickHandler` already claimed.
- Temporary diagnostics: capture-phase `document` listeners on `dragenter`/`dragover`/`drop` log `[vault-tool] document <type>: hasFiles=... defaultPrevented=... target=...` unconditionally (capture phase means they log even if something else stops propagation first) — check via Command Palette → "Developer: Open Webview Developer Tools" (with the note panel focused) while performing the drag, to see whether the event reaches the webview's DOM at all. Remove once this is confirmed working end-to-end.

Host-side `drop-files` handling mirrors `paste-image` (writes into `getSaveDir()`, same base64-decode-and-`fs.writeFileSync` shape, via the shared `uniqueAttachmentName(saveDir, filename)` helper) but — unlike pasted clipboard image data, which has no real filename and gets a `Pasted image YYYYMMDDHHMMSS.png` name — a dropped file's original name is already known and kept as-is, only disambiguated (`"name N.ext"`) on an actual collision. The reply (`files-dropped`) inserts one `![[filename]]` per file at `pendingDropPos`, same embed convention already used for pasted images and note transclusions.

**Not yet re-tested on real hardware after this fix.** If it still doesn't work, the next things to check (in order): (1) the diagnostic logs above — do they fire at all, and with what `hasFiles`/`defaultPrevented`; (2) whether `event.dataTransfer.files` is actually populated at `drop` time (some remote/network-share paths on macOS can behave oddly with native DnD); (3) whether VS Code really does have some outer-layer interception after all, in which case `vaultTool.insertAttachment` below remains the fallback.

### `vaultTool.insertAttachment` — the actual working way to attach a file to a note

Explorer-context-menu command (`contributes.menus.explorer/context` in `package.json`) that sidesteps the drag-and-drop problem above entirely by never depending on a drop event reaching the webview. Right-click one or more files in VS Code's Explorer → "Vault Tool: Insertar como adjunto en la nota activa":

1. Resolves the target Vault Tool panel: `activePanels.find(p => p.active) ?? activePanels.find(p => p.visible) ?? (exactly one panel open ? that one : none)` — `.active` will almost always be `false` here since invoking from the Explorer context menu means focus was on the Explorer, not the editor, so the `.visible` fallback (and the single-panel fallback, covering the common case of just one note open in a background tab) both matter, unlike `toggleSourceMode`'s otherwise-identical panel lookup.
2. Resolves that panel's document path via a reverse lookup through `panelsByPath` (`[...panelsByPath.entries()].find(([, p]) => p === panel)`).
3. Copies each selected file into `getSaveDir(docPath)` via `fs.copyFileSync`, name-deduplicated by the same `uniqueAttachmentName` helper `drop-files` uses.
4. Posts the exact same `files-dropped` message the `drop-files` handler sends — no webview-side changes needed at all. `pendingDropPos` is `null` in this path (no drop occurred), so the webview's existing fallback inserts at the current cursor position instead — which is exactly the right behavior: place the cursor where you want the embed, then run the command.

## Configuration (`package.json` → `contributes.configuration`)

| Key | Default | Purpose |
|---|---|---|
| `vaultTool.markdownFont` | `""` | Font family for the editor |
| `vaultTool.codeFont` | `""` | Monospace font for inline code and fenced code blocks (`--code-font`) |
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
