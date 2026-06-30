# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`.vsix`) that acts as a local Obsidian-like markdown editor. It operates entirely offline — no marketplace, no external servers. The extension is installed locally from a `.vsix` package into the VS Code profile named **"Obsidian like"**.

The core feature is a `CustomTextEditorProvider` that opens `.md` files in a rich webview: markdown is rendered live (like a WYSIWYG editor) using `marked` v9 server-side, with inline editing directly on the rendered HTML via `contenteditable`.

## Deploy workflow (mandatory after every code change)

```bash
npm run package
code --profile "Obsidian like" --uninstall-extension angel-local.vault-tool
code --profile "Obsidian like" --install-extension vault-tool-0.0.1.vsix
```

Then reload the VS Code window (Ctrl+Shift+P → "Developer: Reload Window").

`npm run package` runs `npm run compile && vsce package --allow-missing-repository`.

## Key files

- `src/extension.ts` — **the entire extension** (~1500 lines). Everything is in one file: the TypeScript extension host code AND the webview HTML/JS/CSS as a template literal string.
- `out/extension.js` — compiled output (committed to repo, required for packaging).
- `package.json` — publisher must be `angel-local` (identifier, not human name — vsce 3.x validates this).

## Architecture: extension host side

- Registers a `CustomTextEditorProvider` for `*.md` files (priority: default).
- `resolveCustomTextEditor` creates the webview, renders initial HTML, and wires up message passing.
- `render(text)` calls `marked.parse()` with a `preprocessBody` hook that handles Obsidian-style syntax before marked sees it:
  - `![[image.png]]` → `<img>` tags (looks up attachment paths via config)
  - `[[Note Name]]` → `<span class="wiki-link" data-target="Name">Name</span>`
- `noteIndex: string[]` — module-level array of all `.md` filenames in the vault (no extension). Built at activation via `vscode.workspace.findFiles`. Updated on file create/delete via `FileSystemWatcher`.
- `activePanels: vscode.WebviewPanel[]` — tracks open panels to push `note-index` updates.

## Architecture: webview side (inside the template literal in extension.ts)

The webview is a `contenteditable` div (`#editor`) where the user edits rendered markdown directly.

### Key state variables

```javascript
var currentBlock = null;       // top-level block element cursor is currently in
var currentRawBlock = null;    // block currently shown in raw markdown mode (headings, images)
var currentRawInline = null;   // inline element in raw mode (STRONG, EM, etc.)
var rawModeChanging = false;   // guards against selectionchange re-entry during DOM mutations
var inlineCheckTimer = null;   // debounce timer for checkInlineMode
```

### Live-preview mechanism

**Block-level raw mode** (headings, Obsidian images):
- When cursor enters a heading or image block, `enterRawMode(el)` converts it to its markdown source (e.g. `<h2>Title</h2>` → `<h2 class="raw-mode">## Title</h2>`).
- When cursor leaves that block, `exitRawMode(el)` restores the rendered form.
- Detected in `selectionchange` when `block !== currentBlock`.

**Inline raw mode** (bold/italic):
- When cursor enters a `<strong>`/`<em>`/`<b>`/`<i>`, `enterInlineRaw(el)` adds `raw-mode` class and shows delimiters (`**word**`).
- When cursor leaves, `exitInlineRaw(el)` restores rendered form.
- Detected via `checkInlineMode()`, which is called from:
  - `selectionchange` (deferred via `scheduleInlineCheck()` → `setTimeout(checkInlineMode, 0)`)
  - `editor click` (also deferred via `scheduleInlineCheck()`)
  - `document keyup` for navigation keys (Arrow*, Home, End, PageUp, PageDown)
- **Critical**: inline check must be deferred (`setTimeout 0`) so DOM is stable after mutations. Direct `selectionchange` handling caused infinite re-entry loops due to `el.textContent` destroying old text nodes.

### `findInlineEl(node)`

Only returns a STRONG/B/EM/I ancestor if `node.nodeType === 3` (text node). Returns null for element nodes — this handles Chromium placing cursor at element boundaries.

### Enter key in headings

Intercepted in `keydown`: when Enter is pressed with cursor in a heading (raw or rendered), default Chromium behavior (which creates another `<hN>`) is prevented. Instead, `exitRawMode` is called if needed, then a new `<p>` is inserted below and cursor moved there.

### Note picker (`[[` wiki links)

- Triggered in the `input` handler when text before cursor contains `[[` without a closing `]]`.
- `<div id="note-picker">` floating dropdown shows matching note names.
- `picker.style.display` is initialized to `'none'` explicitly; visibility checked with `=== 'block'` (not `!== 'none'`).
- Selecting a note inserts `[[Note Name]]` and closes picker.
- `[[Note Name]]` renders as `<span class="wiki-link" data-target="Name">Name</span>`.
- `domToMarkdown` serializes wiki-link spans back to `[[Name]]` or `[[target|display]]`.

### Sync and render flow

- **Sync timer** (400ms debounce): sends `domToMarkdown(editor)` to extension via `{ type: 'sync' }`. This keeps the VS Code document model up to date for auto-save.
- **Render timer** (200ms debounce): triggered only when `input` matches a block-level markdown pattern AND not in raw mode. Sends `{ type: 'render-request' }` to extension → extension re-renders and responds with `{ type: 'render-response', html }`.
- On `render-response`: `saveCursor` → `editor.innerHTML = html` → `restoreCursor`. Cursor restoration uses character offset counting via `Range.toString()` and `TreeWalker(SHOW_TEXT)`.
- **Raw mode blocks the render timer** (`if (currentRawBlock || currentRawInline) { return; }`), preventing full re-renders while user is in raw editing mode.

### `domToMarkdown(root)`

Serializes the contenteditable DOM back to markdown. Key cases:
- `STRONG`/`B` with `raw-mode` class → returns `el.textContent` (the raw `**...**` string as-is)
- `STRONG`/`B` without raw-mode → `'**' + kids() + '**'`
- `SPAN.wiki-link` → `'[[' + data-target + ']]'` or `'[[target|display]]'`
- Headings with `raw-mode` → `el.textContent.trimEnd() + '\n\n'`

### Fold buttons

`addFoldBtn(headingEl)` inserts `<span class="fold-btn" contenteditable="false">` before heading's first child. Fold buttons are added by `initFoldBtns()` after every `editor.innerHTML` replacement. They are destroyed when `enterRawMode` calls `el.textContent = md` (which removes all children) — that's intentional, `exitRawMode` re-adds them via `addFoldBtn`.

## Known remaining issues (as of last session)

The following bugs were reported by the user but not yet fixed in this session:
1. **Image paste** — something broken (user mentioned it, not yet investigated).
2. **`[[` wiki link picker** — something broken (user mentioned it, not yet investigated).

The **heading Enter** bug (cursor jumping to line 1) was fixed in this session.
The **inline live-preview** (bold/italic) is partially working but may still have edge cases.

## Git branch

Working branch: `dev`. Main branch: `main`. All recent work is on `dev`.

Recent commits:
- `495a455` Fix heading Enter key: insert paragraph instead of new heading
- `d6c6d4c` Fix inline live-preview exit by adding selectionchange-based deferred check
- `d9fdc2f` Refactor inline live-preview to use click/keyup instead of selectionchange
- `8702b27` Fix inline raw mode: bold/italic permanently stuck after cursor passes through
- `983ec25` Add [[wiki link]] autocomplete picker and wiki-link rendering
