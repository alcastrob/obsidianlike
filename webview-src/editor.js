// webview-src/editor.js — CodeMirror 6 editor for the VS Code vault extension.
// Bundled by esbuild into out/editor.bundle.js.

import { EditorState, EditorSelection, RangeSetBuilder, Compartment, StateEffect, Prec } from "@codemirror/state";
import {
  EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// ── Bootstrap data ───────────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const init   = window.__vaultInitial || {};
// Array of { name, dir } — `dir` is the vault-relative parent directory ('' for
// root-level notes), used as subtext in the [[ ]] suggester (WikiSuggestView).
let noteIndex = init.noteIndex || [];
// Same shape, most-recently-opened first — powers the suggester's empty-query
// "recent files" list. Kept up to date by the 'note-history' message.
let noteHistory = init.recentNotes || [];
let imageMap  = init.imageMap  || {};
let syncTimer = null;

// ── Theme (CSS variables from VS Code) ────────────────────────────────────────
const vsTheme = EditorView.theme({
  '&': { height: '100%', background: 'transparent' },
  '.cm-scroller': { overflow: 'auto', height: '100%' },
  '.cm-content': {
    maxWidth: '780px',
    margin: '0 auto',
    padding: '16px 28px 120px',
    lineHeight: '1.75',
    fontFamily: 'var(--md-font, var(--vscode-editor-font-family, inherit))',
    fontSize: 'var(--md-font-size, 14px)',
    caretColor: 'var(--vscode-editorCursor-foreground, #aeafad)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, #aeafad)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': {
    background: 'var(--vscode-editor-selectionBackground, rgba(173,214,255,0.3)) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    background: 'var(--vscode-editor-selectionBackground, rgba(173,214,255,0.3)) !important',
  },
  '.cm-activeLine':  { background: 'rgba(255,255,255,0.03)' },
  '.cm-line': { padding: '0' },
  '.cm-wiki-link, .cm-md-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4a9eff)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // A [[wiki-link]] whose target note doesn't exist anywhere in the vault —
  // same color/underline as a resolved link, just faded, so it still reads as
  // a link (unlike Obsidian's --link-unresolved-color, which stays close to
  // plain text color; this codebase has no such separate var to lean on).
  '.cm-wiki-link-missing': {
    opacity: 'var(--link-unresolved-opacity, 0.55)',
  },
  // Cancels lezer-markdown's coincidental Link/LinkMark tagging of a
  // [[wiki-link]]'s inner "[Foo]" (see the comment above where this class is
  // applied, in livePreviewPlugin) — !important since it must win over
  // mdHighlight's plain (non-!important) generated classes regardless of
  // which stylesheet CM6 happens to insert first. Also applied to `*`
  // (every descendant): CM6 renders overlapping mark decorations from
  // different extensions as *nested* spans, so mdHighlight's own tags.link/
  // tags.processingInstruction classes end up on inner spans (the bracket
  // characters and the link text each get their own nested span with their
  // own explicit `color`/`font-size`). A child element's own explicit CSS
  // property always wins over an ancestor's value for that property, no
  // matter how the ancestor's rule is weighted — `!important` on the outer
  // `.cm-wiki-link-raw` span alone does nothing for those inner spans, since
  // "inherit" only kicks in when nothing else matches the element itself.
  // Verified empirically with a real EditorView in jsdom (throwaway script,
  // not checked in): the DOM comes out as
  // `<span class="cm-wiki-link-raw"><span class="tok-link tok-processingInstruction">[</span>...`
  // i.e. genuinely nested, not a single flat span with combined classes.
  // Also used by .cm-plain-brackets — a bare `[text]` with no `(url)` after it
  // (and not a [[wiki-link]]'s own inner brackets, handled separately by
  // .cm-wiki-link-raw above) gets the exact same reset, for the exact same
  // reason: lezer-markdown parses *any* `[...]` shape as a shortcut-reference
  // Link node regardless of whether a matching reference definition exists
  // anywhere in the document, so mdHighlight's unconditional tags.link/
  // tags.processingInstruction styling colors it and makes it look clickable
  // even though it links nowhere. See the .cm-plain-brackets detection in
  // livePreviewPlugin below for how "not a real link, not a wiki-link" is told
  // apart from an actual `[text](url)` (left untouched, still blue/clickable).
  // font-size deliberately isn't reset here — it's set per-instance as an
  // inline style instead (plainBracketFontSizeStyle, in livePreviewPlugin),
  // since the "just inherit" this rule used to apply here also flattened a
  // heading's font-size back down to the paragraph default whenever the
  // bracket happened to sit inside one. See that function's comment.
  '.cm-wiki-link-raw, .cm-wiki-link-raw *, .cm-plain-brackets, .cm-plain-brackets *': {
    color: 'inherit !important',
    textDecoration: 'none !important',
    cursor: 'text !important',
  },
  '.cm-md-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // Collapsed table rows (lines 2..N replaced by empty + height:0) — full
  // zeroing rule lives at the end of this stylesheet, see the comment there.
  // List item lines — indentation per nesting depth + spacing before the first item.
  '.cm-list-line': { paddingLeft: '0' },
  '.cm-list-depth-1': { paddingLeft: '1.5em' },
  '.cm-list-depth-2': { paddingLeft: '3em' },
  '.cm-list-depth-3': { paddingLeft: '4.5em' },
  '.cm-list-depth-4': { paddingLeft: '6em' },
  '.cm-list-first': { marginTop: '0.5em' },
  '.cm-list-bullet': {
    display: 'inline-block', width: '1.2em',
    color: 'var(--text-muted, inherit)',
  },
  // YAML frontmatter "Properties" panel (PropertiesWidget).
  '.cm-properties': {
    display: 'block',
    margin: '4px 0 18px',
    paddingBottom: '4px',
    borderBottom: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.25)))',
    fontSize: '0.88em',
  },
  '.cm-properties-title': {
    fontWeight: '700', fontSize: '1.05em', marginBottom: '6px',
  },
  '.cm-properties-row': {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '4px 0', borderTop: '1px solid var(--table-border-color, rgba(128,128,128,0.12))',
  },
  '.cm-properties-icon': {
    width: '1.4em', textAlign: 'center', opacity: '0.6', flexShrink: '0',
  },
  '.cm-properties-key': {
    minWidth: '110px', color: 'var(--text-muted, inherit)', flexShrink: '0',
  },
  '.cm-properties-value': { flex: '1', minWidth: '0' },
  '.cm-properties-list': {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px',
  },
  '.cm-properties-pill': {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    background: 'var(--tag-background, rgba(120,180,120,0.15))',
    color: 'var(--tag-color, var(--text-accent, #7fb37f))',
    borderRadius: '12px', padding: '2px 6px 2px 10px', fontSize: '0.95em',
  },
  '.cm-properties-pill-remove': {
    cursor: 'pointer', opacity: '0.6', padding: '0 4px', fontSize: '0.9em',
  },
  '.cm-properties-pill-remove:hover': { opacity: '1' },
  '.cm-properties-add-input, .cm-properties-text-input, .cm-properties-new-key-input': {
    background: 'transparent', border: 'none', borderBottom: '1px solid transparent',
    color: 'inherit', font: 'inherit', padding: '2px 0', minWidth: '40px',
    outline: 'none',
  },
  '.cm-properties-add-input:focus, .cm-properties-text-input:focus, .cm-properties-new-key-input:focus': {
    borderBottomColor: 'var(--vscode-focusBorder, rgba(128,128,128,0.5))',
  },
  '.cm-properties-text-input': { width: '100%' },
  '.cm-properties-add-row': {
    padding: '6px 0 2px', cursor: 'text', opacity: '0.6', display: 'flex',
  },
  '.cm-properties-add-row:hover': { opacity: '0.9' },
  '.cm-properties-add-label': { cursor: 'pointer' },
  // Task checkbox lines (- [ ] / - [x] ...), rendered by TaskCheckboxWidget.
  '.cm-task-line': { paddingLeft: '0' },
  '.cm-task-done': {
    color: 'var(--text-muted, inherit)',
    textDecoration: 'line-through',
  },
  // Wraps the checkbox + edit button rendered by TaskCheckboxWidget so both sit
  // inline together where the "- [ ] " markdown source used to be.
  '.cm-task-widget': {
    display: 'inline-flex',
    alignItems: 'center',
  },
  '.cm-task-checkbox': {
    display: 'inline-block',
    width: '1em', height: '1em',
    margin: '0 0.4em 0 0',
    verticalAlign: 'middle',
    cursor: 'pointer',
    position: 'relative', top: '-1px',
  },
  // Status icon rendered in place of the native checkbox for any status other
  // than the plain unchecked `[ ]` (done/cancelled/in-progress/custom letters
  // like "w"/"d") — a checkbox can only ever show two visual states, so these
  // are a separate clickable <span> instead (see TaskCheckboxWidget/STATUS_ICON
  // below). Carries `.cm-task-checkbox` too, so it inherits cursor/margin/
  // alignment from the rule above. A color-emoji glyph renders noticeably
  // larger than the checkbox's own 1em box at the same font-size, so this
  // shrinks the font-size and centers/clips the glyph into that same fixed
  // box instead of letting it size itself (`width/height: auto`, tried first,
  // let each glyph's own oversized metrics dictate the box, which is exactly
  // what made icons of different sizes/paddings misalign against the checkbox
  // and against each other in a list of mixed-status tasks).
  '.cm-task-status-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    width: '1em', height: '1em',
    fontSize: '0.7em',
    lineHeight: '1',
  },
  '.cm-task-overdue': {
    color: 'var(--text-error, #e06c75)',
    fontWeight: 'bold',
  },
  // ```tasks``` query block rendering (see TasksQueryWidget). Deliberately *not* broken out of
  // `.cm-content`'s own 780px reading-width column/28px padding (see its `maxWidth`/`padding`
  // above) — an earlier version tried a "full-bleed, capped" break-out via `100vw`-relative
  // `calc()` to give a many-column task row (tags, id, priority, dates, backlink, edit button)
  // more room than plain prose, on the theory that `.cm-content`'s own centred-column math
  // (`margin-left: calc(50% - min(50vw, 600px))`, mirroring `margin: 0 auto` + a max-width) would
  // carry over cleanly to a child of it. In practice it didn't: reported as this listing's side
  // margins vanishing entirely (flush against the pane's edges) while every other element on the
  // page kept its normal margin — i.e. exactly the "page's own margins disappeared" outcome that
  // break-out was supposed to avoid, just via a different bug than the first (uncapped) attempt.
  // Simplest correct fix, and what was actually asked for: don't fight the layout at all. A
  // normal-flow block with no explicit width naturally fills its parent `.cm-line`'s content box,
  // which *is* `.cm-content`'s own (780px-capped, 28px-padded, auto-centred) box — the same one
  // every paragraph on the page already renders in — so this reads with *exactly* the same left/
  // right margin as normal text, at any pane width, with no special-casing to get wrong. Long
  // descriptions/titles still wrap correctly at this width — that's `.cm-tasks-query-item` being
  // plain inline flow rather than flexbox (see its own comment below), unrelated to how wide this
  // container is.
  '.cm-tasks-query': {
    display: 'block',
    margin: '4px 0 10px',
    padding: '2px 0',
  },
  '.cm-tasks-query-loading, .cm-tasks-query-empty': {
    opacity: '0.55',
    fontStyle: 'italic',
    fontSize: '0.9em',
    padding: '2px 0',
  },
  '.cm-tasks-query-warning': {
    color: 'var(--text-error, #e06c75)',
    fontSize: '0.85em',
    marginTop: '4px',
    opacity: '0.85',
  },
  '.cm-tasks-query-group-title': {
    fontWeight: '600',
    opacity: '0.75',
    fontSize: '0.95em',
    margin: '10px 0 4px',
  },
  '.cm-tasks-query-filter': {
    margin: '0 0 8px',
  },
  '.cm-tasks-query-filter input': {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    fontSize: '0.9em',
    padding: '4px 8px',
    background: 'var(--background-modifier-form-field, var(--background-secondary))',
    color: 'inherit',
    border: '1px solid var(--background-modifier-border, transparent)',
    borderRadius: '4px',
  },
  '.cm-tasks-query-count': {
    marginTop: '8px',
    fontSize: '0.85em',
    opacity: '0.6',
  },
  // Compound selectors (not just `.cm-tasks-query-hidden` alone) so this reliably wins over
  // `.cm-tasks-query-item`/`.cm-tasks-query-group-title`'s own `display` regardless of which
  // rule happens to be declared later in this object — equal-specificity single-class
  // selectors would otherwise have the *later* declaration silently win the cascade.
  '.cm-tasks-query-item.cm-tasks-query-hidden, .cm-tasks-query-group-title.cm-tasks-query-hidden': {
    display: 'none',
  },
  '.cm-tasks-query-list': {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  // Deliberately normal inline flow, not flexbox — a `display:flex; flex-wrap:wrap` row wraps
  // whole *items* onto a new flex line instead of wrapping a long item's own text at the word
  // level (confirmed empirically: a flex item's hypothetical main size for the "does it fit on
  // this line" check is its own full max-content width, not its wrapped/shrunk width), so a task
  // with a long description ended up with the checkbox alone on one line and the entire
  // description dropped to the next, even though the description text itself has plenty of
  // spaces to wrap on normally. Plain inline flow — the checkbox as an inline-block, the
  // description as ordinary inline text, tags/badges/dates/backlink/edit-button as inline-blocks —
  // wraps exactly the way a checkbox next to a paragraph of text should: the checkbox stays
  // glued to the first line, the description wraps word-by-word, and trailing badges flow right
  // after the last word instead of being pushed to the container's far edge.
  '.cm-tasks-query-item': {
    lineHeight: '1.5',
  },
  '.cm-tasks-query-item.cm-task-done .cm-tasks-query-desc': {
    color: 'var(--text-muted, inherit)',
    textDecoration: 'line-through',
  },
  '.cm-tasks-query-badge': {
    display: 'inline-block',
    opacity: '0.75',
    fontSize: '0.9em',
    whiteSpace: 'nowrap',
    marginLeft: '0.3em',
  },
  '.cm-tasks-query-due, .cm-tasks-query-depends': {
    display: 'inline-block',
    fontSize: '0.9em',
    whiteSpace: 'nowrap',
    marginLeft: '0.3em',
  },
  '.cm-tasks-query-tag, .cm-tasks-query-id': {
    display: 'inline-block',
    padding: '0 0.5em',
    borderRadius: '999px',
    fontSize: '0.85em',
    lineHeight: '1.6em',
    whiteSpace: 'nowrap',
    marginLeft: '0.3em',
    background: 'var(--tag-background, var(--background-modifier-hover))',
    color: 'var(--tag-color, var(--text-normal, inherit))',
  },
  '.cm-tasks-query-backlink': {
    display: 'inline-block',
    fontSize: '0.85em',
    opacity: '0.75',
    whiteSpace: 'nowrap',
    marginLeft: '0.3em',
  },
  '.cm-task-query-edit-btn': {
    display: 'inline-block',
    cursor: 'pointer',
    opacity: '0.35',
    fontSize: '0.85em',
    verticalAlign: 'middle',
    marginLeft: '0.3em',
  },
  '.cm-task-query-edit-btn:hover': {
    opacity: '1',
  },
  // ```dataview```/```dql```/```dataviewjs``` query block rendering (see DataviewQueryWidget).
  // The inner markup (`.dv-*` classes) comes verbatim from the sibling
  // "angelCastro.obsidianlike-dataview" extension's HTML renderer, so these rules style classes
  // this file doesn't itself generate — kept in sync manually with that extension's render/html.ts.
  '.cm-dataview-query': {
    display: 'block',
    margin: '4px 0 10px',
    padding: '2px 0',
  },
  '.cm-dataview-query-loading': {
    opacity: '0.55',
    fontStyle: 'italic',
    fontSize: '0.9em',
    padding: '2px 0',
  },
  '.cm-dataview-query .dv-error': {
    color: 'var(--text-error, #e06c75)',
    fontSize: '0.9em',
    opacity: '0.9',
  },
  '.cm-dataview-query .dv-empty': {
    opacity: '0.55',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  '.cm-dataview-query .dv-list': {
    margin: '0',
    paddingLeft: '1.4em',
    lineHeight: '1.5',
  },
  '.cm-dataview-query .dv-list li': {
    margin: '2px 0',
  },
  '.cm-dataview-query .dv-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '0.95em',
  },
  '.cm-dataview-query .dv-table th, .cm-dataview-query .dv-table td': {
    border: '1px solid var(--background-modifier-border, rgba(128,128,128,0.3))',
    padding: '3px 8px',
    textAlign: 'left',
  },
  '.cm-dataview-query .dv-table th': {
    opacity: '0.75',
    fontWeight: '600',
  },
  '.cm-dataview-query .dv-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4a9eff)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-dataview-query .dv-task-group': {
    marginBottom: '6px',
  },
  // Flex column + small gap, not native list-item block flow — a plain `<li>` inherits
  // `.cm-content`'s prose `line-height: 1.75`, which read as a much bigger gap between rows
  // than Obsidian's own Dataview task list. Mirrors `.cm-tasks-query-list`/`-item` above.
  '.cm-dataview-query .dv-task-list': {
    margin: '2px 0 0',
    padding: '0',
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  '.cm-dataview-query .dv-task-list li': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4em',
    lineHeight: '1.5',
  },
  '.cm-dataview-query .dv-task-list input[type="checkbox"]': {
    verticalAlign: 'middle',
    margin: '0',
  },
  '.cm-dataview-query .dv-calendar-day': {
    margin: '2px 0',
  },
  // DataviewJsWidget (a ```dataviewjs``` block calling dv.view(...)) — unlike `.cm-dataview-
  // query` above, this wraps a *live* script's own DOM (e.g. tasks-timeline.js's own embedded
  // CSS/classes), so styling here stays minimal: just enough that the loading/error states
  // read consistently with the rest of the editor before the loaded script's own styles apply.
  '.cm-dataviewjs-app': {
    display: 'block',
    margin: '4px 0 10px',
  },
  '.cm-dataviewjs-loading': {
    opacity: '0.55',
    fontStyle: 'italic',
    fontSize: '0.9em',
    padding: '2px 0',
  },
  '.cm-dataviewjs-error': {
    color: 'var(--text-error, #e06c75)',
    fontSize: '0.9em',
    padding: '4px 0',
    whiteSpace: 'pre-wrap',
  },
  '.cm-dataviewjs-notice-container': {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '10000',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    pointerEvents: 'none',
  },
  '.cm-dataviewjs-notice': {
    background: 'var(--background-secondary, #2a2a2a)',
    color: 'var(--text-normal, inherit)',
    border: '1px solid var(--background-modifier-border, rgba(128,128,128,0.3))',
    borderRadius: '6px',
    padding: '8px 12px',
    fontSize: '0.9em',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    opacity: '0',
    transform: 'translateY(6px)',
    transition: 'opacity 0.15s ease, transform 0.15s ease',
  },
  '.cm-dataviewjs-notice-visible': {
    opacity: '1',
    transform: 'translateY(0)',
  },
  // Folded heading content — full zeroing rule lives at the end of this
  // stylesheet, see the comment there.
  // Heading fold indicator — mirrors Obsidian's .cm-fold-indicator structure.
  // Obsidian only reveals this (and the Border theme's H1/H2/H3 icon reskin
  // for it) while the pointer is over the heading line; otherwise it's fully
  // hidden, leaving just the colored ::before bar. Hidden by default here too.
  '.cm-fold-indicator': {
    display: 'inline-block', cursor: 'pointer', userSelect: 'none',
    opacity: '0', transition: 'opacity 0.15s', verticalAlign: 'middle',
  },
  '.cm-line:hover .cm-fold-indicator, .cm-fold-indicator:hover': { opacity: '0.85' },
  '.cm-fold-indicator .svg-icon.right-triangle': {
    width: '14px', height: '14px', verticalAlign: 'middle',
    transition: 'transform 0.15s',
  },
  '.cm-fold-indicator.is-collapsed .svg-icon.right-triangle': {
    transform: 'rotate(-90deg)',
  },
  // Needs a positioning context so the fold indicator (below) and the
  // full-height color bar (further below) can both be positioned absolutely
  // against this line — .cm-line has no offset of its own, so this doesn't
  // move or resize the line box itself. paddingLeft makes room for the bar,
  // which no longer occupies inline flow width once it's absolutely positioned.
  '.HyperMD-header': { position: 'relative', paddingLeft: '7px' },
  // The heading's ::before bar starts at the line's own left edge (x:0) in
  // normal flow, so to put the fold indicator to its *left* (matching real
  // Obsidian — see the H1/H2 badge in its hover screenshot) it has to leave
  // flow entirely and sit in the gutter carved out by .cm-content's own left
  // padding, rather than being reordered as a sibling after the bar.
  '.HyperMD-header .cm-fold-indicator': {
    position: 'absolute', left: '-18px', top: '50%', transform: 'translateY(-50%)',
  },
  // Cancel the Border theme's own translateX(-8px) on this icon (tuned for
  // Obsidian's own DOM/spacing, not ours) now that the outer .cm-fold-indicator
  // above is doing 100% of the positioning — otherwise the two offsets compound.
  '.HyperMD-header .collapse-indicator.collapse-icon': { transform: 'none !important' },
  // Obsidian's own heading color bar (Border theme's `.HyperMD-header-N::before`)
  // — color/radius/background stay theme-driven; everything about sizing and
  // placement is overridden here. The theme's own version sizes the bar off
  // `1.2em` (`calc(1.2em - 8px)` + a `translateY(4px)` nudge), which assumes
  // `::before`'s font-size context is the heading's own big rendered size —
  // true in Obsidian's DOM (the pseudo lives directly on the <h1>/etc.), but
  // not here: our line's actual font-size class (`.cm-header-N`, added by
  // mdHighlight) lives on a *child span* of the line, not the `.cm-line`
  // element the `::before` is attached to, so `1.2em` resolved against the
  // small base editor font-size instead and came out a few px short of the
  // heading text's actual height. Anchoring the bar with `top:0;bottom:0`
  // against `.HyperMD-header`'s own (already `position: relative`) box makes
  // it span the line's real rendered height regardless of font-size context.
  // Theme CSS also lands later via postMessage without `!important` (see "Why
  // theme CSS is sent via postMessage" in CLAUDE.md), so this needs
  // `!important` to win regardless of load order either way.
  '.HyperMD-header-1::before, .HyperMD-header-2::before, .HyperMD-header-3::before, .HyperMD-header-4::before, .HyperMD-header-5::before, .HyperMD-header-6::before': {
    position: 'absolute !important',
    top: '0 !important', bottom: '0 !important', left: '0 !important',
    height: 'auto !important',
    width: '4px !important',
    margin: '0 !important',
    transform: 'none !important',
  },
  // Heading styles — mirrors Obsidian core CSS so theme vars apply.
  // CM6 uses class-only in mdHighlight, so styles must live here.
  '.cm-header-1': {
    fontSize: 'var(--h1-size, 1.75em)', fontWeight: 'var(--h1-weight, 700)',
    lineHeight: 'var(--h1-line-height, 1.3)', color: 'var(--h1-color, inherit)',
    fontStyle: 'var(--h1-style, normal)', fontFamily: 'var(--h1-font, inherit)',
  },
  '.cm-header-2': {
    fontSize: 'var(--h2-size, 1.4em)', fontWeight: 'var(--h2-weight, 700)',
    lineHeight: 'var(--h2-line-height, 1.3)', color: 'var(--h2-color, inherit)',
    fontStyle: 'var(--h2-style, normal)', fontFamily: 'var(--h2-font, inherit)',
  },
  '.cm-header-3': {
    fontSize: 'var(--h3-size, 1.15em)', fontWeight: 'var(--h3-weight, 650)',
    lineHeight: 'var(--h3-line-height, 1.3)', color: 'var(--h3-color, inherit)',
    fontStyle: 'var(--h3-style, normal)', fontFamily: 'var(--h3-font, inherit)',
  },
  '.cm-header-4': {
    fontSize: 'var(--h4-size, 1.1em)', fontWeight: 'var(--h4-weight, 625)',
    lineHeight: 'var(--h4-line-height, 1.4)', color: 'var(--h4-color, inherit)',
    fontStyle: 'var(--h4-style, normal)', fontFamily: 'var(--h4-font, inherit)',
  },
  '.cm-header-5': {
    fontSize: 'var(--h5-size, 1em)', fontWeight: 'var(--h5-weight, 600)',
    lineHeight: 'var(--h5-line-height, 1.4)', color: 'var(--h5-color, inherit)',
    fontStyle: 'var(--h5-style, normal)', fontFamily: 'var(--h5-font, inherit)',
  },
  '.cm-header-6': {
    fontSize: 'var(--h6-size, 0.95em)', fontWeight: 'var(--h6-weight, 575)',
    lineHeight: 'var(--h6-line-height, 1.4)', color: 'var(--h6-color, inherit)',
    fontStyle: 'var(--h6-style, normal)', fontFamily: 'var(--h6-font, inherit)',
  },
  // Note transclusions (![[note]], ![[dir/note]], ![[note#section]]).
  '.cm-transclusion': {
    display: 'block',
    position: 'relative',
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)))',
    borderRadius: '6px',
    background: 'var(--table-row-alt-background, rgba(128,128,128,0.04))',
    margin: '6px 0 10px',
    padding: '10px 34px 10px 14px',
  },
  '.cm-transclusion-open': {
    position: 'absolute',
    top: '6px', right: '6px',
    width: '22px', height: '22px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', borderRadius: '4px',
    background: 'transparent',
    color: 'var(--text-muted, inherit)',
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: '1',
    opacity: '0.6',
    padding: '0',
  },
  '.cm-transclusion-open:hover': { opacity: '1', background: 'rgba(128,128,128,0.18)' },
  '.cm-transclusion-title': {
    fontWeight: '600',
    fontSize: '0.82em',
    opacity: '0.6',
    marginBottom: '4px',
  },
  '.cm-transclusion-body > :first-child': { marginTop: '0' },
  '.cm-transclusion-body > :last-child': { marginBottom: '0' },
  '.cm-transclusion-loading, .cm-transclusion-error': {
    opacity: '0.6',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  '.cm-transclusion-error': { color: 'var(--text-error, #e06c75)' },
  // [[ ]] wiki-link suggester (see WikiSuggestView) — a plain floating DOM
  // element appended as a child of `.cm-editor` (view.dom, which CM6 already
  // gives `position: relative`) and positioned with plain absolute offsets
  // computed from coordsAtPos, rather than CM6's built-in autocompletion
  // tooltip — see the comment above WikiSuggestView for why.
  '.cm-wikilink-suggest': {
    position: 'absolute',
    zIndex: '50',
    minWidth: '260px',
    maxWidth: '420px',
    background: 'var(--vscode-editorWidget-background, #252526)',
    color: 'var(--vscode-editorWidget-foreground, inherit)',
    border: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35))',
    borderRadius: '6px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
    fontSize: '0.92em',
    overflow: 'hidden',
  },
  '.cm-wls-list': { maxHeight: '220px', overflowY: 'auto' },
  '.cm-wls-item': { padding: '6px 12px', cursor: 'pointer' },
  '.cm-wls-item.is-selected': {
    background: 'var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.25))',
    color: 'var(--vscode-list-activeSelectionForeground, inherit)',
  },
  '.cm-wls-title': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-wls-title b': { fontWeight: '700' },
  '.cm-wls-dir': {
    fontSize: '0.85em',
    opacity: '0.6',
    marginTop: '1px',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  '.cm-wls-empty, .cm-wls-loading': {
    padding: '8px 12px',
    opacity: '0.65',
    fontStyle: 'italic',
  },
  '.cm-wls-footer': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 14px',
    justifyContent: 'center',
    padding: '6px 10px',
    borderTop: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25))',
    fontSize: '0.78em',
    opacity: '0.7',
  },
  '.cm-wls-footer b': { fontWeight: '700' },
  // Ctrl/Cmd+hover wiki-link preview popup (HoverPreviewView) — a plain floating
  // DOM element appended to `.cm-editor`, positioned like `.cm-wikilink-suggest`.
  '.cm-hover-preview': {
    position: 'absolute',
    zIndex: '60',
    minWidth: '260px',
    maxWidth: '420px',
    maxHeight: '320px',
    overflowY: 'auto',
    background: 'var(--vscode-editorWidget-background, #252526)',
    color: 'var(--vscode-editorWidget-foreground, inherit)',
    border: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35))',
    borderRadius: '6px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
    fontSize: '0.92em',
    padding: '10px 14px',
  },
  '.cm-hover-preview-title': {
    fontWeight: '600',
    fontSize: '0.82em',
    opacity: '0.6',
    marginBottom: '4px',
  },
  '.cm-hover-preview-body > :first-child': { marginTop: '0' },
  '.cm-hover-preview-body > :last-child': { marginBottom: '0' },
  '.cm-hover-preview-loading, .cm-hover-preview-error': {
    opacity: '0.6',
    fontStyle: 'italic',
  },
  '.cm-hover-preview-error': { color: 'var(--text-error, #e06c75)' },
  // Standalone inline code (`text`) — a small chip, same look as before this
  // was split out of mdHighlight's tags.monospace spec into a stable class name.
  '.cm-inline-code': {
    // --code-font is the user-configurable `obsidianLike.codeFont` setting (empty
    // by default, falling through to the Obsidian theme's --font-monospace var,
    // then VS Code's editor font, then a generic monospace).
    fontFamily: 'var(--code-font, var(--font-monospace, var(--vscode-editor-font-family, monospace)))',
    // --code-font-size is the user-configurable `obsidianLike.codeFontSize` setting
    // (default 14px) — an absolute size, unlike the surrounding text's em-relative sizing.
    fontSize: 'var(--code-font-size, 14px)',
    background: 'var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)))',
    color: 'var(--code-normal, inherit)',
    padding: '1px 4px', borderRadius: '3px',
  },
  // Fenced code blocks (```...```) — line classes added in livePreviewPlugin's
  // FencedCode handling, one per *content* line (fence-open/-close lines are
  // collapsed to zero height via .cm-code-fence-hidden instead — see there),
  // so the whole block renders as a single cohesive box instead of
  // tags.monospace's chip styling being applied per-visual-line (CM6 can't
  // render one Decoration.mark spanning multiple lines as a single element, so
  // a multi-line highlighted range always gets fragmented into one <span> per
  // line — with the chip's own background+padding+radius, that looked like a
  // stack of disconnected pills rather than one block).
  // !important on the box-defining properties here (background/border/padding/
  // radius/margin), same defensive pattern already used by .cm-code-fence-hidden
  // /.cm-table-row-hidden/.cm-fold-hidden below: an Obsidian theme's own CSS
  // loads *after* this (via the theme-css postMessage, into a separate later
  // <style> tag — see "Why theme CSS is sent via postMessage" elsewhere in the
  // docs), and many themes reset baseline background/border on generic editor
  // line selectors (`.cm-line { background: transparent; }` and similar) that
  // would otherwise silently win the cascade over this on source-order alone,
  // even though `.cm-code-block` itself is a more specific selector — normal
  // specificity doesn't help against a theme rule using its own !important.
  '.cm-code-block': {
    fontFamily: 'var(--code-font, var(--font-monospace, var(--vscode-editor-font-family, monospace)))',
    fontSize: 'var(--code-font-size, 14px)',
    background: 'var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15))) !important',
    color: 'var(--code-normal, inherit)',
    borderLeft: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))) !important',
    borderRight: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))) !important',
    padding: '0 14px !important',
  },
  // The ```/``` fence lines themselves: collapsed to zero height (not just
  // text-hidden) when not the active line, so — matching Obsidian — they don't
  // leave behind an empty, padded line above/below the block. Same technique as
  // .cm-table-row-hidden/.cm-fold-hidden — full zeroing rule lives at the end
  // of this stylesheet, see the comment there (also explains why: this class
  // and .cm-code-block-first/-last below, which sets non-zero margin/border/
  // padding with !important of its own, can end up on the very same line).
  '.cm-code-block-first': {
    borderTop: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))) !important',
    borderRadius: '6px 6px 0 0 !important',
    paddingTop: '8px !important', marginTop: '6px !important',
  },
  '.cm-code-block-last': {
    borderBottom: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))) !important',
    borderRadius: '0 0 6px 6px !important',
    paddingBottom: '8px !important', marginBottom: '10px !important',
  },
  '.cm-code-block-solo': {
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35))) !important',
    borderRadius: '6px !important',
    paddingTop: '8px !important', paddingBottom: '8px !important', marginTop: '6px !important', marginBottom: '10px !important',
  },
  // Cancels the standalone inline-code chip look for CodeText found inside a
  // fenced block's own box (see the comment on .cm-inline-code / mdHighlight above).
  '.cm-code-block .cm-inline-code': { background: 'none !important', padding: '0 !important', borderRadius: '0 !important' },
  '.cm-md-table-wrap': { overflowX: 'auto', margin: '4px 0 8px' },
  '.cm-md-table': { borderCollapse: 'collapse', width: '100%', fontSize: 'inherit', fontFamily: 'inherit' },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)))',
    padding: '6px 12px', lineHeight: '1.5', verticalAlign: 'top',
  },
  '.cm-md-table th': {
    fontWeight: '600',
    background: 'var(--table-header-background, rgba(128,128,128,0.1))',
    color: 'var(--table-header-color, inherit)',
  },
  '.cm-md-table tr:nth-child(even) td': {
    background: 'var(--table-row-alt-background, rgba(128,128,128,0.04))',
  },
  '.cm-tooltip': {
    background: 'var(--vscode-editorSuggestWidget-background, #252526)',
    border: '1px solid var(--vscode-editorSuggestWidget-border, #454545)',
    borderRadius: '4px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
  },
  '.cm-tooltip-autocomplete': { padding: '4px 0' },
  '.cm-tooltip-autocomplete ul': { listStyle: 'none', margin: 0, padding: 0 },
  '.cm-tooltip-autocomplete ul li': {
    color: 'var(--vscode-editorSuggestWidget-foreground, #d4d4d4)',
    padding: '3px 16px',
    fontFamily: 'var(--vscode-font-family, sans-serif)',
    fontSize: '13px',
    cursor: 'pointer',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected="true"]': {
    background: 'var(--vscode-editorSuggestWidget-selectedBackground, #094771)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, #fff)',
  },

  // ── Zero-height collapsed lines — deliberately declared LAST ─────────────────
  // .cm-table-row-hidden (collapsed table/```tasks```/frontmatter lines),
  // .cm-code-fence-hidden (collapsed ``` fence lines) and .cm-fold-hidden
  // (collapsed folded-heading content) all mean the same thing: this line must
  // occupy zero visual space. CM6 combines Decoration.line() classes from
  // *different* extensions onto the same line's class attribute, so a single
  // line can easily end up with one of these *and* some other box-styling
  // class at once — most commonly a folded heading section that contains a
  // fenced code block, where .cm-code-block-first/-last (above) sets non-zero
  // margin/border/padding of its own, also with !important. Same-specificity
  // !important ties go to whichever rule is declared *later* in the
  // stylesheet — these three used to live much earlier (grouped next to the
  // decoration logic they support), which let that margin/border/padding leak
  // through on an otherwise-collapsed line. A single leftover margin is a few
  // px; a folded section containing several such blocks in a long document
  // compounded into a very visible (reported: several hundred px) blank gap.
  // Fixed by moving the zeroing here (after every rule it might need to beat)
  // and covering every box-model property that could leak through this way,
  // not just the ones a specific bug report happened to trace — margin/
  // border/border-radius/box-shadow included, not just height/padding.
  '.cm-table-row-hidden, .cm-code-fence-hidden, .cm-fold-hidden': {
    height: '0 !important', lineHeight: '0 !important', minHeight: '0 !important',
    padding: '0 !important', margin: '0 !important', border: 'none !important',
    borderRadius: '0 !important', boxShadow: 'none !important',
    overflow: 'hidden', visibility: 'hidden',
  },
});

// ── Syntax highlight style ────────────────────────────────────────────────────
// Uses Obsidian CSS variables (--bold-color, --h1-color, etc.) with VS Code fallbacks.
// The theme-dark / theme-light class on body (synced by inline script in buildHtml)
// makes these variables resolve from the loaded theme.css.
const mdHighlight = HighlightStyle.define([
  // Heading levels — class ONLY (when class is set, CM6 ignores CSS props).
  // Styles live in vsTheme under .cm-header-N so the Obsidian theme can override them.
  { tag: tags.heading1, class: 'cm-header cm-header-1' },
  { tag: tags.heading2, class: 'cm-header cm-header-2' },
  { tag: tags.heading3, class: 'cm-header cm-header-3' },
  { tag: tags.heading4, class: 'cm-header cm-header-4' },
  { tag: tags.heading5, class: 'cm-header cm-header-5' },
  { tag: tags.heading6, class: 'cm-header cm-header-6' },
  { tag: tags.strong,
    fontWeight: 'var(--bold-weight, 700)',
    color: 'var(--bold-color, inherit)' },
  { tag: tags.emphasis,
    fontStyle: 'italic',
    color: 'var(--italic-color, inherit)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link,
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4a9eff)))',
    textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: tags.url,
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4a9eff)))',
    textDecoration: 'underline', textUnderlineOffset: '2px' },
  // class-only (see the heading entries above for why): tags.monospace matches
  // BOTH standalone inline code (`text`) and a fenced code block's own content
  // (lezer-markdown's default styleTags maps "InlineCode CodeText" to the same
  // tag) — the two need different visual treatment (a small chip vs. one
  // cohesive block), so the actual CSS lives in vsTheme under .cm-inline-code,
  // with a `.cm-code-block .cm-inline-code` override cancelling the chip look
  // specifically inside a fenced block (see the comment there).
  { tag: tags.monospace, class: 'cm-inline-code' },
  { tag: tags.quote,
    borderLeft: '3px solid var(--blockquote-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.4)))',
    paddingLeft: '12px',
    color: 'var(--blockquote-color, var(--text-muted, inherit))' },
  { tag: tags.processingInstruction,
    color: 'var(--text-faint, var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.5)))',
    fontSize: '0.82em' },
  { tag: tags.meta,
    color: 'var(--text-faint, var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.5)))' },
]);

// ── Task checkbox line detection (Obsidian "Tasks" plugin style signifiers) ──────
// Full-line match used to detect a task and pull out the status char, mirroring
// TaskRegularExpressions.taskRegex in the sibling "Tasks" extension
// (angelCastro.vscode-tasks, src/core/Task/TaskRegularExpressions.ts).
const TASK_LINE_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/;
// Narrower match used only to find the exact "<indent><marker> [<char>]" span so the
// checkbox widget replacement mirrors the ListMark→BulletWidget replacement below
// (consume the marker + checkbox, then at most one trailing space).
const TASK_CHECKBOX_RE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +(\[.\])/;
// Signifiers within the task text (after the checkbox) — same emoji as Obsidian Tasks.
const TASK_DUE_RE        = /(?:📅|📆|🗓)\uFE0F? *(\d{4}-\d{2}-\d{2})/u;
const TASK_PRIORITY_RE   = /(🔺|⏫|🔼|🔽|⏬)/u;
const TASK_RECURRENCE_RE = /🔁\uFE0F? *([a-zA-Z0-9, !]+)/u;


function todayDateOnly() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isOverdueDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const due = new Date(+m[1], +m[2] - 1, +m[3]);
  return due.getTime() < todayDateOnly().getTime();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getActiveLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

// ── Table widget ──────────────────────────────────────────────────────────────
// Renders inline markdown (bold, italic, code, wiki-links) inside table cells.
// `basePath` (optional, workspace-relative — e.g. a task's own `t.path`) is the file the *raw*
// text actually came from, when that's not the currently-open document. `[[wikilink]]` resolution
// on the host side (`resolveNoteUri` in extension.ts) has always assumed "the note containing the
// link" means the open document — true for a wikilink typed directly into it, but wrong for text
// rendered here on behalf of *another* file (a tasks-query row's description is the running
// example: the open document is the note holding the ```tasks``` block, not the task's own note,
// which can be anywhere else in the vault). Without `basePath`, a same-directory guess against the
// wrong directory can miss, and — worse — since "not found" means "create a new blank file", a
// perfectly valid link elsewhere in the vault would get shadowed by an empty file created next to
// the query instead of ever opening the real target. `data-wiki-base` carries that hint through to
// the click handler, which forwards it to the host as `open-note`'s `basePath` field.
function renderCell(raw, basePath) {
  // HTML-escape first to prevent injection
  let s = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Protect inline code from further processing
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\x00C${codes.length - 1}\x00`; });
  // #tags — same regex as the engine's own TaskRegularExpressions.hashTags (start-of-string or
  // preceded by whitespace, anything but the negated punctuation set), rendered as a pill *in
  // place* rather than stripped out. Run early (before links/wiki-links generate their own HTML)
  // so it only ever sees plain text, and its "preceded by whitespace" requirement already keeps
  // it from matching a `#fragment` inside a URL (preceded by a non-whitespace path character, not
  // whitespace or start-of-string). Reuses `.cm-tasks-query-tag`'s pill styling — originally
  // written for the tasks-query row's separate end-of-row tag list, now doing double duty since
  // that separate list is gone (see renderTaskRow below).
  s = s.replace(/(^|\s)#([^\s!@#$%^&*(),.?":{}|<>]+)/g, (_, prefix, tag) =>
    `${prefix}<span class="cm-tasks-query-tag">#${tag}</span>`
  );
  // Bold-italic → bold → italic (order matters: ** before *)
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Standard markdown links [text](url), *and* a bare `https://...` URL with no [text]() around
  // it at all (e.g. a task description someone just pasted a link into) — both render as the
  // same clickable span, showing only the link text (or, for a bare URL, the URL itself — there's
  // no separate "text" to prefer) rather than the text *and* the raw destination URL as separate
  // visible content. Reuses the `.cm-md-link` class (and `data-url` attribute) the CM6-native
  // `mdLinkPlugin` already renders links with elsewhere in the document — same CSS, and
  // `linkClickHandler`'s existing `.closest('.cm-md-link')` branches (mousedown guard + `open-url`
  // click handler) pick these up with no new wiring, since they just do generic DOM traversal
  // regardless of how the element was created. One combined regex (alternation) rather than two
  // separate passes: a bare-URL pass run *after* this one would otherwise re-match the URL sitting
  // inside an already-rendered `[text](url)` span's `data-url` attribute text; alternation avoids
  // that by construction, since only one branch can win at a given position and `[text](url)`'s
  // own `[` always starts before its `(url)` portion would. Must run *before* the wiki-link regex
  // below: `[[Note]]` has no parens after it so the `[text](url)` branch can't match it, but
  // running link detection first avoids any risk of matching inside wiki-links' own generated HTML
  // instead. The bare-URL branch mirrors `findUrlAtPos`'s own fallback regex (main editor), so
  // "renders as a link here" and "is clickable there" agree on the same URL span.
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)"'\]>]+)/g,
    (_, text, url, bareUrl) => bareUrl
      ? `<span class="cm-md-link" data-url="${bareUrl}">${bareUrl}</span>`
      : `<span class="cm-md-link" data-url="${url}">${text}</span>`
  );
  // Wiki-links [[target]] or [[target|alias]]
  const baseAttr = basePath ? ` data-wiki-base="${String(basePath).replace(/"/g, '&quot;')}"` : '';
  s = s.replace(/(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (_, tgt, alias) =>
    `<span data-wiki="${tgt}"${baseAttr} style="color:var(--link-color,var(--vscode-textLink-foreground,#4a9eff));` +
    `text-decoration:underline;cursor:pointer;">${alias || tgt}</span>`
  );
  // Restore inline code
  s = s.replace(/\x00C(\d+)\x00/g, (_, i) =>
    `<code style="font-family:monospace;background:rgba(128,128,128,0.18);padding:1px 4px;border-radius:3px;">${codes[+i]}</code>`
  );
  return s;
}

class TableWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(other) { return this.src === other.src; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;margin:4px 0 10px;width:100%;display:block;';

    const lines = (this.src || '').split('\n').filter(l => l.trim() && l.includes('|'));
    if (lines.length < 2) {
      wrap.style.cssText += 'white-space:pre;font-family:monospace;opacity:0.75;';
      wrap.textContent = this.src;
      return wrap;
    }

    const parseRow = line =>
      line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

    const aligns = parseRow(lines[1]).map(s => {
      const t = s.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      return 'left';
    });

    const BORDER   = '1px solid rgba(128,128,128,0.38)';
    const CELL     = `border:${BORDER};padding:5px 12px;line-height:1.5;vertical-align:top;color:inherit;`;
    const TH_EXTRA = 'font-weight:600;background:rgba(128,128,128,0.12);';

    const table = document.createElement('table');
    table.style.cssText =
      'border-collapse:collapse;width:100%;font-size:inherit;font-family:inherit;color:inherit;';

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    parseRow(lines[0]).forEach((h, i) => {
      const th = document.createElement('th');
      th.style.cssText = CELL + TH_EXTRA + `text-align:${aligns[i] || 'left'};`;
      th.innerHTML = renderCell(h);
      hRow.appendChild(th);
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    lines.slice(2).forEach((line, ri) => {
      const tr = document.createElement('tr');
      if (ri % 2 === 1) tr.style.background = 'rgba(128,128,128,0.05)';
      parseRow(line).forEach((cell, i) => {
        const td = document.createElement('td');
        td.style.cssText = CELL + `text-align:${aligns[i] || 'left'};`;
        td.innerHTML = renderCell(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent() { return false; }
}

// ── YAML frontmatter → "Properties" panel ──────────────────────────────────────
// Obsidian's Live Preview replaces a note's leading YAML frontmatter block with
// an interactive "Propiedades" panel (tags as removable pills, "+ Añadir
// propiedad", ...) rather than ever showing the raw "---\n...\n---" text —
// editing happens through that panel's own controls, not by revealing markdown
// syntax the way every other live-preview element in this file does.
//
// Hand-rolled, minimal parser rather than a real YAML library: this webview
// bundle has no other npm dependencies, and only needs to round-trip
// Obsidian's own handful of common property shapes (string, number, boolean,
// list) — not arbitrary YAML. Anything the parser doesn't confidently
// recognize (comments, nested maps, multi-line block scalars, anchors, ...)
// makes parseFrontmatter return null, which leaves the block as plain,
// uninterpreted text (livePreviewPlugin below just never enters this whole
// code path) rather than risking silently mangling something it doesn't
// understand on the first write-back.
function unquoteYamlScalar(s) {
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  return s;
}

function parseYamlScalar(raw) {
  const s = raw.trim();
  if (/^(true|false)$/i.test(s)) return { type: 'boolean', value: /^true$/i.test(s) };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { type: 'number', value: Number(s) };
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim();
    const value = inner === '' ? [] : inner.split(',').map(v => unquoteYamlScalar(v.trim()));
    return { type: 'list', value };
  }
  return { type: 'string', value: unquoteYamlScalar(s) };
}

// Returns { properties: [{key,type,value}], from, to } — `to` is the closing
// "---" line's own end (its trailing newline, like every other line's, is left
// untouched by callers) — or null if the document doesn't open with a
// recognizable frontmatter block at all.
function parseFrontmatter(state) {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== '---') return null;
  let closeLine = -1;
  for (let ln = 2; ln <= state.doc.lines; ln++) {
    if (state.doc.line(ln).text.trim() === '---') { closeLine = ln; break; }
  }
  if (closeLine === -1) return null;

  const properties = [];
  let ln = 2;
  while (ln < closeLine) {
    const text = state.doc.line(ln).text;
    if (!text.trim()) { ln++; continue; }
    // Anything not a plain "key:" / "key: value" line (comments, nested maps,
    // block scalars, ...) bails out to null rather than guessing.
    const m = /^([^:\n]+):(.*)$/.exec(text);
    if (!m) return null;
    const key = m[1].trim();
    const rest = m[2].trim();
    ln++;
    if (rest === '') {
      // Either an empty scalar, or the start of a "  - item" list block.
      const items = [];
      while (ln < closeLine) {
        const im = /^  - (.*)$/.exec(state.doc.line(ln).text);
        if (!im) break;
        items.push(unquoteYamlScalar(im[1].trim()));
        ln++;
      }
      properties.push(items.length > 0
        ? { key, type: 'list', value: items }
        : { key, type: 'string', value: '' });
    } else {
      properties.push({ key, ...parseYamlScalar(rest) });
    }
  }
  return { properties, from: 0, to: state.doc.line(closeLine).to };
}

// Quotes a scalar only when needed to round-trip correctly (would otherwise be
// mis-read back as a different type, or contains characters that break the
// plain "key: value" line shape).
function yamlScalarOut(value) {
  const s = String(value);
  if (s === '' || /^(true|false)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s) ||
      /[:#]/.test(s) || /^\s|\s$/.test(s) || /^[[\]{}]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function serializeFrontmatter(properties) {
  const lines = ['---'];
  for (const p of properties) {
    if (p.type === 'list') {
      if (p.value.length === 0) {
        lines.push(`${p.key}: []`);
      } else {
        lines.push(`${p.key}:`);
        for (const item of p.value) lines.push(`  - ${yamlScalarOut(item)}`);
      }
    } else if (p.type === 'boolean') {
      lines.push(`${p.key}: ${p.value ? 'true' : 'false'}`);
    } else if (p.type === 'number') {
      lines.push(`${p.key}: ${p.value}`);
    } else {
      lines.push(p.value === '' ? `${p.key}:` : `${p.key}: ${yamlScalarOut(p.value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

const PROPERTY_TYPE_ICON = { list: '\u{1F3F7}', boolean: '☑', number: '#', string: 'Aa' };

class PropertiesWidget extends WidgetType {
  constructor(view, from, to, properties) {
    super();
    this.view = view;
    this.from = from;
    this.to = to;
    this.properties = properties;
  }
  eq(other) {
    return this.from === other.from && this.to === other.to &&
      JSON.stringify(this.properties) === JSON.stringify(other.properties);
  }
  // Replaces the whole frontmatter block with newProps re-serialized. Tagged
  // with a userEvent that deliberately does *not* start with "input"/"delete"
  // so wikiLinkActivationTracker's isUserEvent('input') check (keyed off the
  // *cursor's* position, unrelated to this panel) never mistakes it for an
  // edit inside whatever wiki-link the document cursor happens to be sitting
  // on elsewhere.
  commit(newProps) {
    this.view.dispatch({
      changes: { from: this.from, to: this.to, insert: serializeFrontmatter(newProps) },
      userEvent: 'properties.change',
    });
  }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-properties';
    box.contentEditable = 'false';

    const title = document.createElement('div');
    title.className = 'cm-properties-title';
    title.textContent = 'Propiedades';
    box.appendChild(title);

    this.properties.forEach((prop, idx) => box.appendChild(this.renderRow(prop, idx)));
    box.appendChild(this.renderAddRow());
    return box;
  }
  renderRow(prop, idx) {
    const row = document.createElement('div');
    row.className = 'cm-properties-row';

    const icon = document.createElement('span');
    icon.className = 'cm-properties-icon';
    icon.textContent = PROPERTY_TYPE_ICON[prop.type] || PROPERTY_TYPE_ICON.string;
    row.appendChild(icon);

    const key = document.createElement('span');
    key.className = 'cm-properties-key';
    key.textContent = prop.key;
    row.appendChild(key);

    const valueEl = document.createElement('div');
    valueEl.className = 'cm-properties-value';

    if (prop.type === 'list') {
      valueEl.appendChild(this.renderListValue(prop, idx));
    } else if (prop.type === 'boolean') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'cm-properties-checkbox';
      cb.checked = prop.value;
      cb.addEventListener('mousedown', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        const next = this.properties.slice();
        next[idx] = { ...prop, value: cb.checked };
        this.commit(next);
      });
      valueEl.appendChild(cb);
    } else {
      const input = document.createElement('input');
      input.type = prop.type === 'number' ? 'number' : 'text';
      input.className = 'cm-properties-text-input';
      input.value = String(prop.value);
      input.addEventListener('mousedown', e => e.stopPropagation());
      const commitValue = () => {
        const raw = input.value;
        const value = prop.type === 'number' ? (Number(raw) || 0) : raw;
        if (value === prop.value) return;
        const next = this.properties.slice();
        next[idx] = { ...prop, value };
        this.commit(next);
      };
      input.addEventListener('blur', commitValue);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      valueEl.appendChild(input);
    }
    row.appendChild(valueEl);
    return row;
  }
  renderListValue(prop, idx) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-properties-list';
    prop.value.forEach((item, itemIdx) => {
      const pill = document.createElement('span');
      pill.className = 'cm-properties-pill';
      const text = document.createElement('span');
      text.textContent = item;
      pill.appendChild(text);
      const remove = document.createElement('span');
      remove.className = 'cm-properties-pill-remove';
      remove.textContent = '×';
      remove.title = 'Quitar';
      remove.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      remove.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const nextItems = prop.value.slice(0, itemIdx).concat(prop.value.slice(itemIdx + 1));
        const next = this.properties.slice();
        next[idx] = { ...prop, value: nextItems };
        this.commit(next);
      });
      pill.appendChild(remove);
      wrap.appendChild(pill);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-properties-add-input';
    input.placeholder = '+';
    input.addEventListener('mousedown', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const next = this.properties.slice();
      next[idx] = { ...prop, value: prop.value.concat([value]) };
      input.value = '';
      this.commit(next);
    });
    wrap.appendChild(input);
    return wrap;
  }
  renderAddRow() {
    const row = document.createElement('div');
    row.className = 'cm-properties-add-row';

    const label = document.createElement('span');
    label.className = 'cm-properties-add-label';
    label.textContent = '+ Añadir propiedad';
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-properties-new-key-input';
    input.placeholder = 'Nombre de la propiedad';
    input.style.display = 'none';
    input.addEventListener('mousedown', e => e.stopPropagation());
    row.appendChild(input);

    label.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    label.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      label.style.display = 'none';
      input.style.display = '';
      input.focus();
    });
    const cancel = () => { input.style.display = 'none'; label.style.display = ''; input.value = ''; };
    input.addEventListener('blur', cancel);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const key = input.value.trim();
      if (!key) { cancel(); return; }
      const next = this.properties.concat([{ key, type: 'string', value: '' }]);
      cancel();
      this.commit(next);
    });
    return row;
  }
  ignoreEvent() { return false; }
}

// ── Image widget ──────────────────────────────────────────────────────────────
class ImageWidget extends WidgetType {
  constructor(src, alt, width, caption) {
    super(); this.src = src; this.alt = alt; this.width = width; this.caption = caption;
  }
  eq(other) {
    return this.src === other.src && this.width === other.width && this.caption === other.caption;
  }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt || '';
    img.style.cssText = 'height:auto;display:block;border-radius:4px;';
    img.style.maxWidth = this.width || '100%';
    if (this.width) img.style.width = this.width;
    if (this.caption) {
      const fig = document.createElement('figure');
      fig.style.cssText = 'display:block;margin:4px 0 8px;';
      fig.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.style.cssText = 'text-align:center;font-size:0.85em;opacity:0.6;margin-top:4px;';
      cap.textContent = this.caption;
      fig.appendChild(cap);
      return fig;
    }
    img.style.margin = '4px 0';
    return img;
  }
  ignoreEvent() { return false; }
}

// ── List bullet widget ────────────────────────────────────────────────────────
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-list-bullet';
    span.textContent = '•';
    return span;
  }
  ignoreEvent() { return false; }
}

// Obsidian-Tasks-community-convention icons for statuses beyond the plain
// unchecked/checked binary a native checkbox can show. Mirrors
// `STATUS_ICON_EMOJI` in the sibling "angelCastro.obsidian-like-tasks"
// extension's `src/markdownTasksPlugin.ts` (same symbols, same icons), so a
// task looks the same whether viewed here or in VS Code's Markdown Preview.
// `x`/`X`/`-` are included here (unlike that Preview-only map, which leaves
// them to the native/VS-Code-rendered checkbox) because this editor's checkbox
// is a real interactive element the user clicks to toggle, not passive
// reading-view HTML — showing a done/cancelled icon on it is expected too.
// Any symbol not listed (e.g. a future custom status) falls back to a generic
// badge showing the raw character, same convention as that Preview map.
const STATUS_ICON = {
  'x': '✅', 'X': '✅',
  '-': '✖',
  '/': '🔄',
  'w': '⏳', // "Waiting" — matches this vault's own convention for custom statuses.
  'd': '👤', // "Delegated" — ditto.
};

// ── Task checkbox widget ──────────────────────────────────────────────────────
// Renders a real <input type="checkbox"> for the plain unchecked state (`[ ]`),
// or a clickable status-icon <span> for anything else (see STATUS_ICON above —
// a checkbox can only ever show two visual states, so done/cancelled/
// in-progress/custom statuses need a real glyph instead). Unlike BulletWidget,
// this is rendered on the active/cursor line too (not gated behind
// active.has(ln)) so it stays clickable while editing the task text. `line` is
// the 0-based doc line number, read back by the click handler and sent to the
// extension host as `toggle-task`.
class TaskCheckboxWidget extends WidgetType {
  constructor(statusChar, isDone, line) { super(); this.statusChar = statusChar; this.isDone = isDone; this.line = line; }
  eq(other) { return this.statusChar === other.statusChar && this.line === other.line; }
  toDOM() {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-task-widget';

    if (this.statusChar === ' ') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'cm-task-checkbox';
      input.checked = false;
      input.dataset.line = String(this.line);
      wrapper.appendChild(input);
    } else {
      const icon = document.createElement('span');
      icon.className = 'cm-task-checkbox cm-task-status-icon';
      icon.setAttribute('role', 'checkbox');
      icon.setAttribute('aria-checked', String(this.isDone));
      icon.title = this.statusChar;
      icon.dataset.line = String(this.line);
      icon.textContent = STATUS_ICON[this.statusChar] || this.statusChar;
      wrapper.appendChild(icon);
    }

    return wrapper;
  }
  ignoreEvent() { return false; }
}

// ── Tasks query (```tasks``` fenced code blocks) ──────────────────────────────
// Soft dependency on the sibling "angelCastro.obsidian-like-tasks" extension: a
// `tasks` query needs data from the *entire vault* (that extension's in-memory
// index), which the webview can't compute locally from the current document's
// AST. So rendering requires an async round-trip: webview → this extension's
// host (postMessage) → Tasks extension's API → back to the webview → render.
//
// `_build()` (in livePreviewPlugin, below) runs synchronously, so results can't
// be awaited inline. Instead:
//   - `tasksQueryCache`   caches results by exact (trimmed) query text.
//   - `tasksQueryPending` avoids firing duplicate requests for the same text
//     while a response is in flight.
//   - `tasksRebuildEffect` is a no-op StateEffect dispatched purely to force a
//     livePreviewPlugin rebuild once a response/invalidation arrives — the same
//     trick `foldEffect` uses further down in this file for fold toggles.
const tasksQueryCache   = new Map();   // trimmed query text -> TasksQueryResultDTO
const tasksQueryPending = new Set();   // trimmed query text currently awaiting a response
const tasksRebuildEffect = StateEffect.define();

function requestTasksQuery(query) {
  if (tasksQueryPending.has(query)) return;
  tasksQueryPending.add(query);
  vscode.postMessage({ type: 'run-tasks-query', query });
}

// ── Dataview query blocks (```dataview```/```dql```/```dataviewjs```) ─────────
// Same async round-trip as the Tasks query block above (webview → this
// extension's host → sibling "angelCastro.obsidianlike-dataview" extension's API
// → back to the webview), for the same reason: query results depend on the
// *entire vault*'s index, which only that sibling extension maintains. Unlike
// Tasks, the response is ready-to-embed HTML (DataviewQueryResultDTO = { ok,
// html }), not a DTO this file renders itself — see the comment above
// `renderDataviewBlock` in extension.ts for why.
const dataviewQueryCache   = new Map(); // "lang query" -> DataviewQueryResultDTO
const dataviewQueryPending = new Set(); // "lang query" currently awaiting a response
const dataviewRebuildEffect = StateEffect.define();

function dataviewCacheKey(lang, query) { return lang + ' ' + query; }

function requestDataviewQuery(lang, query) {
  const key = dataviewCacheKey(lang, query);
  if (dataviewQueryPending.has(key)) return;
  dataviewQueryPending.add(key);
  vscode.postMessage({ type: 'run-dataview-query', lang, query });
}

// ── DataviewJS interactive engine (real DOM, `app`, `dv.view`) ─────────────────
// A ```dataviewjs``` block whose code calls dv.view(...) needs a fundamentally different
// execution model than DataviewQueryWidget above: it loads and runs *another* script (e.g.
// tasks-timeline.js, straight from the vault, unmodified) against a real DOM container and
// live vault I/O — not a one-shot "push some output nodes, render to static HTML" call.
// obsidianlike-dataview's own dv sandbox (Node vm, no window) has no dv.container/dv.view/app
// at all, so it can't run this — see DataviewJsWidget below, which claims this specific case
// instead (detected via DV_VIEW_CALL_RE) while everything else still goes through
// DataviewQueryWidget/obsidianlike-dataview exactly as before.

// Obsidian injects these onto HTMLElement.prototype for every dataviewjs script; this webview
// has no such thing normally (editor.js itself just uses plain document.createElement
// throughout), so a faithful-to-Obsidian polyfill is installed once, globally, purely so
// tasks-timeline.js (and any other vault script loaded this way) runs completely unmodified.
(function installObsidianDomHelpers() {
  if (HTMLElement.prototype.createEl) return; // idempotent, in case this ever runs twice
  function applyDomElementInfo(el, info) {
    if (info == null) return el;
    if (typeof info === 'string') { if (info) el.className = info; return el; }
    if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    if (info.text !== undefined) {
      if (info.text instanceof Node) el.appendChild(info.text);
      else el.textContent = info.text;
    }
    if (info.attr) {
      for (const key in info.attr) {
        const v = info.attr[key];
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(key, v === true ? '' : String(v));
      }
    }
    if (info.title) el.setAttribute('title', info.title);
    if (info.value !== undefined) el.value = info.value;
    if (info.type !== undefined) el.type = info.type;
    if (info.href !== undefined) el.href = info.href;
    if (info.placeholder !== undefined) el.placeholder = info.placeholder;
    return el;
  }
  HTMLElement.prototype.createEl = function (tag, info, callback) {
    const el = document.createElement(tag);
    applyDomElementInfo(el, info);
    if (info && typeof info === 'object' && info.prepend) { this.insertBefore(el, this.firstChild); }
    else { this.appendChild(el); }
    if (typeof callback === 'function') callback(el);
    return el;
  };
  HTMLElement.prototype.createDiv = function (info, callback) { return this.createEl('div', info, callback); };
  HTMLElement.prototype.createSpan = function (info, callback) { return this.createEl('span', info, callback); };
  HTMLElement.prototype.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  HTMLElement.prototype.setText = function (text) { this.textContent = text; };
  HTMLElement.prototype.appendText = function (text) { this.appendChild(document.createTextNode(text)); };
  HTMLElement.prototype.addClass = function (cls) { this.classList.add(cls); };
  HTMLElement.prototype.removeClass = function (cls) { this.classList.remove(cls); };
  HTMLElement.prototype.toggleClass = function (cls, force) { this.classList.toggle(cls, force); };
  HTMLElement.prototype.hasClass = function (cls) { return this.classList.contains(cls); };
})();

const DV_VIEW_CALL_RE = /\bdv\s*\.\s*view\s*\(/;

const dataviewScriptCache = new Map();   // script name -> { content, error }
const dataviewScriptWaiters = new Map(); // script name -> Array<resolve>, while a request is in flight

// Resolves once with { content, error } — dedupes concurrent requests for the same name (a
// script calling dv.view() more than once, or several blocks loading the same script) onto a
// single host round trip, same spirit as requestTasksQuery/requestDataviewQuery's pending sets.
function requestDataviewScript(name) {
  return new Promise(resolve => {
    const cached = dataviewScriptCache.get(name);
    if (cached) { resolve(cached); return; }
    let waiters = dataviewScriptWaiters.get(name);
    if (!waiters) { waiters = []; dataviewScriptWaiters.set(name, waiters); }
    waiters.push(resolve);
    if (waiters.length === 1) {
      vscode.postMessage({ type: 'dataview-resolve-script', name });
    }
  });
}

const pendingDataviewFileRequests = new Map(); // id -> { resolve, reject }
let nextDataviewRequestId = 1;

function dvReadFile(path) {
  return new Promise((resolve, reject) => {
    const id = 'dvr' + (nextDataviewRequestId++);
    pendingDataviewFileRequests.set(id, { resolve, reject });
    vscode.postMessage({ type: 'dataview-read-file', id, path });
  });
}

function dvWriteFile(path, content) {
  return new Promise((resolve, reject) => {
    const id = 'dvw' + (nextDataviewRequestId++);
    pendingDataviewFileRequests.set(id, { resolve, reject });
    vscode.postMessage({ type: 'dataview-write-file', id, path, content });
  });
}

function dvBasename(path) {
  const last = path.split('/').pop();
  return last.endsWith('.md') ? last.slice(0, -3) : last;
}

// Stand-in for Obsidian's `app`, built from what this webview already has: `noteIndex` (kept
// live by the 'note-index' message, see noteIndexRebuildEffect below) covers the synchronous
// parts of the real API (getMarkdownFiles/getAbstractFileByPath/getFirstLinkpathDest); the
// async parts (reading/writing a file's content, opening a note) round-trip to the extension
// host. Deliberately does NOT cache file *content* anywhere — real Obsidian's app.vault.read()
// always returns current content, and tasks-timeline.js's own "🔄 Refrescar" button depends on
// that staying true without any extra cache-invalidation plumbing on this side.
function buildDataviewApp() {
  const noteStub = (entry) => {
    const path = entry.dir ? entry.dir + '/' + entry.name + '.md' : entry.name + '.md';
    return { path, basename: entry.name, extension: 'md' };
  };
  return {
    vault: {
      getMarkdownFiles() { return noteIndex.map(noteStub); },
      getAbstractFileByPath(path) {
        const entry = noteIndex.find(n => noteStub(n).path === path);
        return entry ? noteStub(entry) : undefined;
      },
      async read(file) {
        const result = await dvReadFile(file.path);
        if (result.error) { throw new Error(result.error); }
        return result.content;
      },
      async modify(file, content) {
        const result = await dvWriteFile(file.path, content);
        if (!result.ok) { throw new Error(result.error || 'No se pudo guardar el archivo'); }
      },
    },
    workspace: {
      getLeaf() {
        // `view` is deliberately left undefined: VS Code's custom editor doesn't expose a CM6
        // instance to the extension host the way Obsidian exposes `view.editor`, so a script's
        // `if (view && view.editor) view.editor.setCursor(...)`-style cursor positioning after
        // opening a file harmlessly no-ops instead of throwing.
        return { view: undefined, async openFile(file) { vscode.postMessage({ type: 'dataview-open-note', path: file.path }); } };
      },
    },
    metadataCache: {
      // Real Obsidian's getFirstLinkpathDest is itself a synchronous lookup against an
      // already-built vault index, so resolving against noteIndex directly (rather than a host
      // round trip) matches both the required sync signature and the actual semantics.
      getFirstLinkpathDest(linkpath) {
        const clean = String(linkpath).split('#')[0].trim();
        if (!clean) return null;
        const wanted = (clean.endsWith('.md') ? clean : clean + '.md').toLowerCase();
        for (const entry of noteIndex) {
          const stub = noteStub(entry);
          if (stub.path.toLowerCase() === wanted || stub.path.toLowerCase().endsWith('/' + wanted)) return stub;
        }
        const wantedBasename = dvBasename(wanted);
        const match = noteIndex.find(n => n.name.toLowerCase() === wantedBasename);
        return match ? noteStub(match) : null;
      },
    },
  };
}

let dataviewNoticeContainer = null;
function ensureDataviewNoticeContainer() {
  if (dataviewNoticeContainer && document.body.contains(dataviewNoticeContainer)) return dataviewNoticeContainer;
  dataviewNoticeContainer = document.body.createDiv('cm-dataviewjs-notice-container');
  return dataviewNoticeContainer;
}

// Stand-in for Obsidian's global `Notice` — a floating toast inside the webview itself (closer
// to Obsidian's actual look than a VS Code notification), and needs no host round trip.
class DataviewNotice {
  constructor(message, timeoutMs) {
    const container = ensureDataviewNoticeContainer();
    const el = container.createDiv({ cls: 'cm-dataviewjs-notice', text: String(message) });
    requestAnimationFrame(() => el.classList.add('cm-dataviewjs-notice-visible'));
    setTimeout(() => {
      el.classList.remove('cm-dataviewjs-notice-visible');
      setTimeout(() => el.remove(), 200);
    }, timeoutMs || 4000);
  }
}

// Runs one ```dataviewjs``` block's own top-level code (no `input` — matches Obsidian, where
// only a script *loaded via* dv.view() receives one) against a fresh `dv`/`app`/`Notice`
// environment. Fire-and-forget from DataviewJsWidget.toDOM()'s perspective: mutates `container`
// in place once done (or on error) rather than returning anything, since toDOM() already
// returned its wrapper element to CM6 before this settles.
async function runDataviewJsBlock(code, container) {
  const loading = container.createDiv({ cls: 'cm-dataviewjs-loading', text: 'Cargando…' });
  const appAdapter = buildDataviewApp();
  const dv = { container, view: (name, input) => dvView(name, input, container, appAdapter) };
  try {
    const run = new Function('dv', 'app', 'Notice', 'return (async () => {\n' + code + '\n})()');
    await run(dv, appAdapter, DataviewNotice);
    if (container.contains(loading)) { loading.remove(); }
  } catch (err) {
    container.empty();
    container.createDiv({ cls: 'cm-dataviewjs-error', text: 'Error en dataviewjs: ' + (err && err.message ? err.message : String(err)) });
  }
}

// dv.view(name, input): resolves and runs another script from the vault, exactly like
// Obsidian — a fresh child container per call (so the loaded script owns its own DOM subtree,
// never sharing one with a sibling dv.view() call), its own nested `dv` (a loaded script can
// itself call dv.view() again, recursively), and `input` bound this time — unlike the outer
// block, a *loaded* script does receive one.
async function dvView(name, input, parentContainer, appAdapter) {
  const childHost = parentContainer.createDiv();
  const loading = childHost.createDiv({ cls: 'cm-dataviewjs-loading', text: `Cargando "${name}"…` });

  const script = await requestDataviewScript(name);
  if (childHost.contains(loading)) { loading.remove(); }

  if (script.error) {
    childHost.createDiv({ cls: 'cm-dataviewjs-error', text: `No se pudo cargar "${name}": ${script.error}` });
    return;
  }

  const dv = { container: childHost, view: (n, i) => dvView(n, i, childHost, appAdapter) };
  try {
    const run = new Function('dv', 'app', 'input', 'Notice', 'return (async () => {\n' + script.content + '\n})()');
    await run(dv, appAdapter, input, DataviewNotice);
  } catch (err) {
    childHost.empty();
    childHost.createDiv({ cls: 'cm-dataviewjs-error', text: `Error ejecutando "${name}": ` + (err && err.message ? err.message : String(err)) });
  }
}

// Single-line replacement widget for the opening ```dataviewjs fence when its code calls
// dv.view(...). Unlike DataviewQueryWidget (stateless: rebuilds fresh HTML from a data blob
// every time), the whole point here is a *persistent* live script instance — tasks-timeline.js
// keeps its own zoom/filter/drag state across CM6 rebuilds — so eq() only ever compares the
// block's raw source text, never anything about whether the script has finished loading. As
// long as the text is unchanged, CM6 never calls toDOM() again and the running instance (and
// its DOM) survives completely untouched across cursor moves, scrolls, and edits elsewhere in
// the document.
class DataviewJsWidget extends WidgetType {
  constructor(code) { super(); this.code = code; }
  eq(other) { return this.code === other.code; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-dataviewjs-app';
    // `dv.container` is this inner host, never `wrap` itself: tasks-timeline.js builds its own
    // "persistent container" as a *sibling* of the container it's given (a leftover of how it
    // recycles Obsidian's dataviewjs blocks on reload), inserted via raw
    // `parentNode.insertBefore(...)`. If `dv.container` were `wrap` (the node CM6 actually
    // owns), that sibling would land *outside* CM6's managed subtree and become an orphan the
    // day this widget is torn down (cursor entering the block reverts it to raw source).
    // Nesting an inner host means that sibling still ends up inside `wrap` either way, so CM6's
    // own attach/detach lifecycle covers it too.
    const innerHost = document.createElement('div');
    wrap.appendChild(innerHost);
    runDataviewJsBlock(this.code, innerHost);
    return wrap;
  }
  // Everything in here handles its own interaction (drag&drop, dropdowns, search, checkboxes) —
  // unlike TasksQueryWidget (which only needs to protect one filter <input>), no click anywhere
  // in this widget should ever move the document selection: that would make the next rebuild
  // treat the block as "cursor inside" and revert it to raw source mid-interaction.
  ignoreEvent() { return true; }
}

const TASK_PRIORITY_ICON = {
  Highest: '🔺', High: '⏫', Medium: '🔼', Low: '🔽', Lowest: '⏬',
};

// Renders a single TaskDTO as a checklist row. Mirrors TaskCheckboxWidget's DOM
// shape — a native <input type="checkbox"> for the plain unchecked/checked
// states, or a status-icon <span> otherwise (see STATUS_ICON/TaskCheckboxWidget
// above) — but carries both `data-path` and `data-line` since results can come
// from any file in the vault, not just the currently open document — the click
// handler below reads both and sends `toggle-task-at-location` instead of
// `toggle-task`.
function renderTaskRow(t) {
  const row = document.createElement('div');
  row.className = 'cm-tasks-query-item' + (t.isDone ? ' cm-task-done' : '');

  // `statusSymbol` is only present from a rebuilt sibling "Tasks" extension —
  // treat a missing value the same as plain `[ ]` so this degrades gracefully
  // against an older build that only sends `isDone`.
  const statusSymbol = t.statusSymbol !== undefined ? t.statusSymbol : ' ';
  let cb;
  if (statusSymbol === ' ') {
    cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.isDone;
  } else {
    cb = document.createElement('span');
    cb.setAttribute('role', 'checkbox');
    cb.setAttribute('aria-checked', String(!!t.isDone));
    cb.title = statusSymbol;
    cb.textContent = STATUS_ICON[statusSymbol] || statusSymbol;
  }
  cb.className = statusSymbol === ' '
    ? 'cm-task-checkbox cm-task-query-checkbox'
    : 'cm-task-checkbox cm-task-status-icon cm-task-query-checkbox';
  cb.dataset.path = t.path;
  cb.dataset.line = String(t.line);
  row.appendChild(cb);

  const desc = document.createElement('span');
  // Note: no `cm-task-overdue` here even when `t.isOverdue` — that class is reserved for the due
  // date itself (below), matching every other surface in this codebase (the native VS Code
  // editor's TaskDecorations, the Markdown Preview's due-date badge): only the date signifier
  // turns red/bold, never the task's own description text.
  desc.className = 'cm-tasks-query-desc';
  // Reuses renderCell's inline-markdown handling (bold/italic/code/links/wiki-links/#tags) — the
  // same helper table cells already use — so e.g. a `[[wikilink]]` in a task's description shows
  // up as a real clickable link instead of literal brackets. renderCell HTML-escapes the raw text
  // before doing anything else, so this is safe against injection despite using innerHTML. `t.path`
  // is passed as the base path (see renderCell's own comment) — a query result can come from any
  // file in the vault, so a `[[wikilink]]` inside its description must resolve relative to *that*
  // file, not the document the ```tasks``` block itself lives in. `t.description` (not
  // `descriptionWithoutTags`) keeps any `#tags` exactly where they appear in the task's own text —
  // renderCell renders them as pills in place, rather than this function stripping them out and
  // re-appending them after the description like an earlier version did, which reordered a task
  // like "Hacer cosas #a y otras cosas #b" into "Hacer cosas y otras cosas #a #b".
  desc.innerHTML = renderCell(t.description || '', t.path);
  row.appendChild(desc);

  // ID and depends-on are only present from a rebuilt sibling "Tasks" extension — they degrade to
  // `undefined` against an older build, same pattern as `statusSymbol` above.
  if (t.id) {
    const idEl = document.createElement('span');
    idEl.className = 'cm-tasks-query-id';
    idEl.textContent = '🆔 ' + t.id;
    row.appendChild(idEl);
  }

  const icon = TASK_PRIORITY_ICON[t.priority];
  if (icon) {
    const p = document.createElement('span');
    p.className = 'cm-tasks-query-badge';
    p.textContent = icon;
    row.appendChild(p);
  }
  if (t.dependsOn && t.dependsOn.length > 0) {
    // Plain text like the dates below, not a `.cm-tasks-query-badge` pill — same reasoning as
    // the due-date fix: this should read as part of the task's own text.
    const dep = document.createElement('span');
    dep.className = 'cm-tasks-query-depends';
    dep.textContent = '⛔ ' + t.dependsOn.join(',');
    row.appendChild(dep);
  }
  if (t.dueDate) {
    // Unlike priority/recurrence, not wrapped in `.cm-tasks-query-badge` — a date should read as
    // part of the task's own text (same font/color/weight as the description), not as a pill.
    const d = document.createElement('span');
    d.className = 'cm-tasks-query-due' + (t.isOverdue ? ' cm-task-overdue' : '');
    d.textContent = '📅 ' + t.dueDate;
    row.appendChild(d);
  }
  if (t.startDate) {
    const s = document.createElement('span');
    s.className = 'cm-tasks-query-due';
    s.textContent = '🛫 ' + t.startDate;
    row.appendChild(s);
  }
  if (t.isRecurring && t.recurrenceRule) {
    const r = document.createElement('span');
    r.className = 'cm-tasks-query-badge';
    r.textContent = '🔁 ' + t.recurrenceRule;
    row.appendChild(r);
  }

  // Backlink to the file (and heading, if the task sits under one) the task was found in —
  // clickable like any other wikilink, reusing the `[data-wiki]` pattern the table-cell
  // wikilink handler already understands (see `linkClickHandler` below) rather than adding a
  // new message type. Deliberately does NOT carry the `.cm-wiki-link` class real in-document
  // wikilinks use for styling: `linkClickHandler`'s `isWikiLinkEl` intercepts *any* element with
  // that class (checked by class alone, walking up from the click target) before the `[data-wiki]`
  // branch below ever runs, and reads `dataset.target` — which this span never sets, only
  // `dataset.wiki` — falling back to the element's own *display* text ("File > Heading") as the
  // literal wikilink target. That's not a valid note name, so `resolveNoteUri` never finds it and
  // silently creates a blank file named e.g. "20260619 > Insights clave.md" instead of opening
  // "20260619.md" and scrolling to the heading. Styled with the exact same inline `style` string
  // `renderCell`'s own wiki-link rendering uses, instead of the class, so it still reads/behaves
  // like a link without ever matching `isWikiLinkEl`. `data-wiki-base` is set to the task's own
  // `t.path` (the file this backlink points at, and the file the heading search is scoped to) —
  // harmless since it trivially resolves to itself, but keeps this consistent with every other
  // task-related wikilink in this codebase, and correctly tie-breaks toward the right file if
  // another note elsewhere in the vault happens to share this one's name.
  const noteName = (t.path || '').replace(/\.md$/i, '').split('/').pop();
  if (noteName) {
    const back = document.createElement('span');
    back.className = 'cm-tasks-query-backlink';
    const link = document.createElement('span');
    link.dataset.wiki = t.heading ? `${noteName}#${t.heading}` : noteName;
    link.dataset.wikiBase = t.path;
    link.style.cssText = 'color:var(--link-color,var(--vscode-textLink-foreground,#4a9eff));text-decoration:underline;cursor:pointer;';
    link.textContent = t.heading ? `${noteName} > ${t.heading}` : noteName;
    back.append('(', link, ')');
    row.appendChild(back);
  }

  const editBtn = document.createElement('span');
  editBtn.className = 'cm-task-query-edit-btn';
  editBtn.title = 'Edit task';
  editBtn.dataset.path = t.path;
  editBtn.dataset.line = String(t.line);
  editBtn.textContent = '✏️';
  row.appendChild(editBtn);

  return row;
}

function renderTaskList(items) {
  const list = document.createElement('div');
  list.className = 'cm-tasks-query-list';
  items.forEach(t => list.appendChild(renderTaskRow(t)));
  return list;
}

function renderEmptyNotice(container) {
  const empty = document.createElement('div');
  empty.className = 'cm-tasks-query-empty';
  empty.textContent = 'No hay tareas que coincidan.';
  container.appendChild(empty);
}

// Renders a TasksQueryResultDTO into `container` (a freshly-created wrapper div). Adds a
// description filter box above the list and a "N tasks" count below it — both purely
// client-side (filtering only ever toggles visibility of already-rendered rows), matching
// Obsidian Tasks' own query results, which likewise just filter/count what's already rendered
// rather than re-running the query.
function renderTasksQueryResult(container, result) {
  const groups = result && result.groups;
  const items  = (result && result.items) || [];
  const totalCount = groups ? groups.reduce((n, g) => n + ((g.items && g.items.length) || 0), 0) : items.length;

  let filterInput = null;
  if (totalCount > 0) {
    const filterWrap = document.createElement('div');
    filterWrap.className = 'cm-tasks-query-filter';
    filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter by description...';
    filterWrap.appendChild(filterInput);
    container.appendChild(filterWrap);
  }

  const listWrap = document.createElement('div');
  if (groups) {
    const nonEmpty = groups.filter(g => g.items && g.items.length > 0);
    if (nonEmpty.length === 0) {
      renderEmptyNotice(listWrap);
    } else {
      nonEmpty.forEach(g => {
        const h = document.createElement('div');
        h.className = 'cm-tasks-query-group-title';
        h.textContent = g.name;
        listWrap.appendChild(h);
        listWrap.appendChild(renderTaskList(g.items));
      });
    }
  } else if (items.length > 0) {
    listWrap.appendChild(renderTaskList(items));
  } else {
    renderEmptyNotice(listWrap);
  }
  container.appendChild(listWrap);

  const unrecognized = (result && result.unrecognizedLines) || [];
  if (unrecognized.length > 0) {
    const warn = document.createElement('div');
    warn.className = 'cm-tasks-query-warning';
    warn.textContent = '⚠ Líneas no reconocidas: ' + unrecognized.join(' | ');
    container.appendChild(warn);
  }

  if (totalCount > 0) {
    const countEl = document.createElement('div');
    countEl.className = 'cm-tasks-query-count';
    container.appendChild(countEl);

    const updateCount = () => {
      const visible = listWrap.querySelectorAll('.cm-tasks-query-item:not(.cm-tasks-query-hidden)');
      countEl.textContent = visible.length + (visible.length === 1 ? ' task' : ' tasks');
    };

    filterInput.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase();
      listWrap.querySelectorAll('.cm-tasks-query-item').forEach(row => {
        // `t.description` (what `.cm-tasks-query-desc` shows) has its `#tags` already stripped
        // out by the engine — they're rendered separately as `.cm-tasks-query-tag` pills — so
        // filtering on the description text alone could never match a hashtag. Folding the
        // tag pills' own text in means both "#urgent" and "urgent" (with or without the "#")
        // match a task tagged `#urgent`, since the pill's textContent already includes the "#".
        const desc = row.querySelector('.cm-tasks-query-desc');
        const tagEls = row.querySelectorAll('.cm-tasks-query-tag');
        const text = (desc ? desc.textContent : '') + ' ' +
          Array.from(tagEls).map(el => el.textContent).join(' ');
        row.classList.toggle('cm-tasks-query-hidden', q !== '' && !text.toLowerCase().includes(q));
      });
      listWrap.querySelectorAll('.cm-tasks-query-group-title').forEach(h => {
        const list = h.nextElementSibling;
        const anyVisible = list && list.querySelector('.cm-tasks-query-item:not(.cm-tasks-query-hidden)');
        h.classList.toggle('cm-tasks-query-hidden', !anyVisible);
      });
      updateCount();
    });
    updateCount();
  }
}

// Single-line replacement widget for the opening ```tasks fence (mirrors
// TableWidget's "replace only the first line" pattern — block:true decorations
// are banned, see the comment above livePreviewPlugin). `result` is whatever was
// in `tasksQueryCache` for this query at the time `_build()` ran: `undefined`
// while the request is still in flight, or the resolved TasksQueryResultDTO once
// the host has responded. Passing it into the constructor (rather than reading
// the cache from inside toDOM) means `eq()` correctly reports "not equal" once
// data arrives, so CM6 knows to re-render instead of reusing the old "loading"
// DOM node.
class TasksQueryWidget extends WidgetType {
  constructor(query, result) { super(); this.query = query; this.result = result; }
  eq(other) { return this.query === other.query && this.result === other.result; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-tasks-query';
    if (this.result) {
      renderTasksQueryResult(wrap, this.result);
    } else {
      const loading = document.createElement('div');
      loading.className = 'cm-tasks-query-loading';
      loading.textContent = 'Cargando consulta de tareas…';
      wrap.appendChild(loading);
    }
    return wrap;
  }
  // Everything inside this widget handles its own clicks (checkbox, edit button, backlink) via
  // `linkClickHandler`'s preventDefault-on-mousedown guards — *except* the filter `<input>`,
  // which needs completely normal DOM focus/typing behaviour. Returning `true` (ignore) for
  // events targeting it tells CM6 not to also try to move the document selection there; without
  // this, clicking into the filter box moved the cursor into this block's document range, which
  // made the next rebuild treat the block as "cursor is inside" and swap the whole widget out for
  // raw source — destroying the input (and any typed filter text) before a single keystroke could
  // register.
  ignoreEvent(event) {
    return !!(event.target && event.target.closest && event.target.closest('.cm-tasks-query-filter'));
  }
}

// Single-line replacement widget for the opening ```dataview/```dql/```dataviewjs fence — same
// "replace only the first line, collapse the rest" strategy as TasksQueryWidget above. `cached`
// is whatever's in `dataviewQueryCache` for this (lang, query) pair when `_build()` ran:
// `undefined` while the request is in flight, or the resolved `{ ok, html }` once the host
// responds. The sibling extension's HTML already carries its own `dv-*` classes/`data-wiki`
// attributes — `[data-wiki]` clicks are picked up for free by the generic handler in
// `linkClickHandler` below, no extra wiring needed here.
class DataviewQueryWidget extends WidgetType {
  constructor(lang, query, cached) { super(); this.lang = lang; this.query = query; this.cached = cached; }
  eq(other) { return this.lang === other.lang && this.query === other.query && this.cached === other.cached; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-dataview-query';
    if (this.cached) {
      wrap.innerHTML = this.cached.html;
    } else {
      const loading = document.createElement('div');
      loading.className = 'cm-dataview-query-loading';
      loading.textContent = 'Cargando consulta dataview…';
      wrap.appendChild(loading);
    }
    return wrap;
  }
}

// Matches .cm-header-N's own font-size defaults exactly (see vsTheme) — used
// to give .cm-wiki-link-raw/.cm-plain-brackets the *correct* size when the
// bracket sits inside a heading, instead of just resetting to `inherit`
// (which collapsed it to the surrounding paragraph size — see the comment
// where this is used, below).
const HEADING_SIZE_DEFAULT = { 1: '1.75em', 2: '1.4em', 3: '1.15em', 4: '1.1em', 5: '1em', 6: '0.95em' };
function headingLevelOf(node) {
  let cur = node.node.parent;
  while (cur) {
    const m = /^ATXHeading([1-6])$/.exec(cur.name);
    if (m) return +m[1];
    cur = cur.parent;
  }
  return null;
}
// Inline `style` (not a class) so it reliably wins regardless of stylesheet
// order or !important ties, same reasoning as the list hanging-indent fix
// above headingLevelOf's own caller. Needed because .cm-wiki-link-raw/
// .cm-plain-brackets reset color/text-decoration/cursor with !important on
// `.selector, .selector *` (to beat mdHighlight's own generated classes on
// the *nested* span for those properties — see the comment on that rule) —
// but mdHighlight's own tags.heading1..6 rule also lands on that same nested
// span when the bracket sits inside a heading (confirmed: highlightTree
// combines multiple active tags' classes onto one span, e.g.
// "cm-header cm-header-1 tok-link tok-processingInstruction" together, not
// separate sibling spans), and its font-size *isn't* !important — so an
// earlier version of this that also reset font-size via that same
// `!important` class rule was silently flattening a heading's font size back
// down to the paragraph default, since `!important` unconditionally beats a
// non-!important rule regardless of which element actually carries it.
function plainBracketFontSizeStyle(node) {
  const level = headingLevelOf(node);
  return level
    ? `font-size: var(--h${level}-size, ${HEADING_SIZE_DEFAULT[level]}) !important`
    : 'font-size: inherit !important';
}

// Decoration.line() spec that makes a line take zero visual space — used
// everywhere a whole line needs to disappear: folded heading content,
// collapsed table rows/```tasks```/frontmatter lines, collapsed ``` fence
// lines. The matching CSS class (`.cm-table-row-hidden, .cm-code-fence-hidden,
// .cm-fold-hidden`, at the very end of vsTheme) already zeroes every relevant
// box-model property with `!important` — but that still isn't a *guaranteed*
// win: an Obsidian theme's own CSS loads *after* this whole stylesheet (via
// the theme-css postMessage, into its own later <style> tag — see "Why theme
// CSS is sent via postMessage"), so a theme rule using `!important` on the
// same property via a more general selector (e.g. a blanket `.cm-line` rule,
// or something targeting headers specifically) can still win purely on
// source order — same category of problem already called out for
// `.cm-code-block`'s own background/border, which just accepts the risk
// ("!important + hope the theme doesn't also reach for it here"). This is a
// stronger fix, for the specific properties that must reliably collapse to
// zero: an *inline* style beats any class-based rule regardless of
// `!important`, because specificity is compared before falling back to
// source order within the same importance tier, and no external stylesheet —
// loaded whenever, by whatever selector — can out-specificity a declaration
// on the element itself. Reported: a folded heading's blank-line gap
// persisting even after the CSS class fix, on a theme that apparently reaches
// for the same properties this needs zeroed.
function hiddenLineDeco(cls) {
  return Decoration.line({
    class: cls,
    attributes: {
      style: 'height:0 !important;line-height:0 !important;min-height:0 !important;' +
             'padding:0 !important;margin:0 !important;border:none !important;' +
             'border-radius:0 !important;box-shadow:none !important;overflow:hidden;visibility:hidden',
    },
  });
}

// ── Live-preview plugin ───────────────────────────────────────────────────────
const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some(t => t.effects.some(e => e.is(tasksRebuildEffect) || e.is(dataviewRebuildEffect)))) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    try {
      const { state } = view;
      const active = getActiveLines(state);
      // Two separate arrays: span/widget decorations and line-level class decorations.
      // Line decorations must be added to the builder as (line.from, line.from, dec).
      const decs     = [];  // { from, to, dec }
      const lineDecs = [];  // { from, dec }   — line.from only, to=from
      let listDepth = 0;
      let awaitingFirstItem = false;
      const listTypeStack = []; // 'BulletList' | 'OrderedList' per current nesting level
      // Line numbers recognised as task-checkbox lines, so the plain ListMark→BulletWidget
      // replacement below can skip them (the task checkbox widget already covers that span).
      const taskLines = new Set();

      // ── YAML frontmatter → "Propiedades" panel ─────────────────────────────
      // Computed unconditionally (not viewport-gated like the tree-walk below)
      // since it only ever concerns the very start of the document, however
      // far the user has since scrolled — matches how TableWidget/etc. handle
      // their own single always-relevant widget position.
      const fm = parseFrontmatter(state);
      const fmCloseLine = fm ? state.doc.lineAt(fm.to).number : 0;
      if (fm) {
        const firstLine = state.doc.line(1);
        decs.push({ from: firstLine.from, to: firstLine.to,
          dec: Decoration.replace({ widget: new PropertiesWidget(view, fm.from, fm.to, fm.properties) }) });
        for (let ln = 2; ln <= fmCloseLine; ln++) {
          const line = state.doc.line(ln);
          // Blank line guard: see the long comment on this same pattern at the
          // Table case below for why an empty line must never also get a
          // zero-length Decoration.replace at the same point as its line decoration.
          if (line.to > line.from) decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
          lineDecs.push({ from: line.from, dec: hiddenLineDeco('cm-table-row-hidden') });
        }
      }

      syntaxTree(state).iterate({
        from: view.viewport.from,
        to:   view.viewport.to,
        leave(node) {
          if (node.name === 'BulletList' || node.name === 'OrderedList') { listDepth--; listTypeStack.pop(); }
        },
        enter(node) {
          const n = node.name;

          // The frontmatter block (if any) is entirely handled above, as a
          // single unit — none of lezer's normal parsing of its content
          // (a "---" HorizontalRule, "tags:" as a Paragraph, "  - x" as a
          // BulletList/ListItem, ...) should also decorate it, which would
          // conflict with the full-line Decoration.replace above. Returning
          // false here (rather than e.g. only for BulletList) also means the
          // matching `leave` never fires for a skipped node, so listDepth
          // bookkeeping for lists later in the *real* document stays balanced.
          if (fmCloseLine > 0 && state.doc.lineAt(node.from).number <= fmCloseLine) { return false; }

          // ── Lists — indentation + spacing from the preceding block ────────
          if (n === 'BulletList' || n === 'OrderedList') {
            if (listDepth === 0) { awaitingFirstItem = true; }
            listDepth++;
            listTypeStack.push(n);
            return; // descend into ListItem children
          }
          if (n === 'ListItem') {
            const line = state.doc.lineAt(node.from);
            const lineStart = line.from;
            const depth = Math.min(listDepth, 4);
            const depthClass = `cm-list-depth-${depth}`;
            const firstClass = awaitingFirstItem ? ' cm-list-first' : '';

            // ── Hanging indent ────────────────────────────────────────────────
            // A list item's own marker (bullet or number) is inline content
            // that only ever appears on the item's *first* source line — a
            // second (or later) line, whether from the paragraph soft-wrapping
            // on screen (EditorView.lineWrapping) or an actual multi-line
            // source (2-space-indented or CommonMark "lazy" continuation, no
            // indent at all), has nothing rendered before its text and must
            // still align with where the *text* starts, not the marker.
            // Plain padding-left alone can't do that (it pushes every visual
            // row of a block by the same amount, so the wrapped/continuation
            // rows ended up flush with the marker's own position instead of
            // past it) — needs the CSS hanging-indent pair instead: push the
            // whole block in by (nesting indent + marker width), then pull
            // just the *first* line back out by the marker width alone via
            // text-indent (which, per CSS, only ever affects a block's own
            // first line, never how far in wrapped continuation rows start).
            // Set as an inline style (wins over any CSS class regardless of
            // stylesheet order) rather than baked into the cm-list-depth-N
            // classes below, since the marker width differs by list type:
            // BulletWidget always renders at a fixed 1.2em (.cm-list-bullet),
            // but an ordered marker is raw, variable-width text ("1." vs
            // "10." vs "100.") — never replaced by a widget at all (see the
            // ListMark handling below) — so exact alignment isn't achievable
            // for every digit count; 2em is just wide enough for the common
            // 1-2 digit case without visually crowding the text.
            const markerW = listTypeStack[listTypeStack.length - 1] === 'OrderedList' ? 2 : 1.2;
            const indentEm = depth * 1.5 + markerW;
            const firstLineStyle = `padding-left:${indentEm}em;text-indent:-${markerW}em`;
            const contLineStyle = `padding-left:${indentEm}em`;
            // Task checkbox lines read flush with the surrounding prose's left margin
            // instead of indented like a regular list item — a checklist isn't "a sublist
            // of the document", Obsidian's own Tasks plugin renders a top-level one the
            // same way. Shifts the whole indent formula left by exactly one nesting level
            // (`depth - 1` instead of `depth`) rather than hardcoding 0, so a *nested* task
            // (depth 2+ — a subtask under another task, or under a plain bullet) still
            // reads one level deeper than its parent; only the true top level (depth 1)
            // lands at 0.
            const taskIndentEm = (depth - 1) * 1.5 + markerW;
            const taskFirstLineStyle = `padding-left:${taskIndentEm}em;text-indent:-${markerW}em`;
            const taskContLineStyle = `padding-left:${taskIndentEm}em`;

            // ── Task checkbox lines ──────────────────────────────────────────
            // Detected via plain-text regex (not AST) per the line text, so this
            // works regardless of whether lezer-markdown's GFM Task/TaskMarker nodes
            // are present. Rendered on active AND inactive lines (unlike the plain
            // bullet below) so the checkbox stays clickable while editing.
            const taskM = TASK_LINE_RE.exec(line.text);
            if (taskM) {
              taskLines.add(line.number);
              const statusChar = taskM[3];
              const isDone = /[xX-]/.test(statusChar);
              lineDecs.push({ from: lineStart,
                dec: Decoration.line({
                  class: `HyperMD-list-line cm-list-line ${depthClass}${firstClass} cm-task-line${isDone ? ' cm-task-done' : ''}`,
                  attributes: { style: taskFirstLineStyle },
                }) });

              const cbM = TASK_CHECKBOX_RE.exec(line.text);
              if (cbM) {
                const markStart = lineStart + cbM[1].length;
                let end = lineStart + cbM[0].length;
                if (state.doc.sliceString(end, end + 1) === ' ') end++;
                decs.push({ from: markStart, to: end,
                  dec: Decoration.replace({ widget: new TaskCheckboxWidget(statusChar, isDone, line.number - 1) }) });

                if (!isDone) {
                  // Signifiers live in the remaining task text. Only the overdue due-date
                  // gets a visual treatment; priority/recurrence are parsed for parity with
                  // the sibling "Tasks" extension's signifiers but aren't styled here.
                  const rest = state.doc.sliceString(end, line.to);
                  const dueM = TASK_DUE_RE.exec(rest);
                  if (dueM && isOverdueDate(dueM[1])) {
                    const dueFrom = end + dueM.index;
                    decs.push({ from: dueFrom, to: dueFrom + dueM[0].length,
                      dec: Decoration.mark({ class: 'cm-task-overdue' }) });
                  }
                  TASK_PRIORITY_RE.exec(rest);
                  TASK_RECURRENCE_RE.exec(rest);
                }
              }
            } else {
              lineDecs.push({ from: lineStart,
                dec: Decoration.line({ class: `HyperMD-list-line cm-list-line ${depthClass}${firstClass}`,
                                        attributes: { style: firstLineStyle } }) });
            }

            // Continuation lines: the item's *own* paragraph (GFM Task items
            // wrap their content in a Task node instead — see the syntax tree
            // this was checked against) spanning more than one source line.
            // Deliberately reads this node's own direct child rather than
            // node.to, which would also reach into any *nested* sub-list that
            // follows — that content gets its own (deeper) indent when its
            // own ListItem is visited separately, not this depth's.
            const contentNode = node.node.getChild('Paragraph') || node.node.getChild('Task');
            if (contentNode) {
              const contentToLine = state.doc.lineAt(Math.min(contentNode.to, state.doc.length)).number;
              const activeContLineStyle = taskM ? taskContLineStyle : contLineStyle;
              for (let ln = line.number + 1; ln <= contentToLine; ln++) {
                const contLine = state.doc.line(ln);
                lineDecs.push({ from: contLine.from,
                  dec: Decoration.line({ class: `HyperMD-list-line cm-list-line cm-list-continuation ${depthClass}`,
                                          attributes: { style: activeContLineStyle } }) });
              }
            }

            awaitingFirstItem = false;
            // Don't return false — ListMark/Paragraph/nested lists still need processing
          }

          // ── Tables ────────────────────────────────────────────────────────
          // Strategy (no block:true → no CM6 measurement crash):
          //   Line 1 (header): Decoration.replace with TableWidget — single-line
          //   Lines 2..N:      Decoration.replace({}) to empty + Decoration.line
          //                    to collapse height to 0.
          // The widget uses inline styles so it renders without CM6 class scoping.
          if (n === 'Table') {
            try {
              const fromLine = state.doc.lineAt(node.from);
              const endPos   = Math.max(node.from,
                Math.min(node.to, state.doc.length) - 1);
              const toLine   = state.doc.lineAt(endPos);

              let isActive = false;
              for (let i = fromLine.number; i <= toLine.number; i++) {
                if (active.has(i)) { isActive = true; break; }
              }
              if (!isActive) {
                const src = state.doc.sliceString(fromLine.from, toLine.to);
                // First line replaced by the rendered widget (single-line, safe)
                decs.push({ from: fromLine.from, to: fromLine.to,
                  dec: Decoration.replace({ widget: new TableWidget(src) }) });
                // Remaining lines: replace content + collapse via line decoration.
                // A BLANK line must skip the Decoration.replace({}) push entirely —
                // pushing it anyway (as every one of these call sites originally did)
                // seeds the merge below with two zero-length decorations at the exact
                // same (from, to) point (the replace's span degenerates to zero width
                // on an empty line, landing on the same point as the line decoration's
                // own from===to point). RangeSetBuilder silently keeps only one of a
                // pair of decorations added at an identical point — confirmed with a
                // real EditorView in jsdom (throwaway script, not checked in): the
                // line decoration (and therefore its height:0 CSS) never reached the
                // DOM for blank lines, while non-blank lines in the very same block
                // collapsed correctly, since their replace span was non-zero-width and
                // sorted to a different point than the line decoration. This was the
                // actual root cause of "folding a heading leaves a blank-space gap"
                // (reported against foldPlugin, which has the identical fix, below) —
                // two earlier fix attempts aimed at the wrong layer (CSS specificity,
                // then inline styles) because the line decoration's CSS was correct,
                // it just never got attached to blank lines' DOM elements at all. Since
                // Decoration.replace({}) over a zero-length span replaces nothing
                // anyway, skipping the push for blank lines loses no behavior.
                for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                  const line = state.doc.line(ln);
                  if (line.to > line.from) {
                    decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
                  }
                  lineDecs.push({ from: line.from,
                    dec: hiddenLineDeco('cm-table-row-hidden') });
                }
              }
            } catch (_) {}
            return false;
          }

          // ── ```tasks``` query blocks ─────────────────────────────────────
          // Same non-block strategy as Table above: first line (the ```tasks
          // fence) becomes a single-line widget replacement; every remaining
          // line (query text + closing fence) is collapsed via an empty replace
          // + a height:0 line decoration. Verified empirically (throwaway script
          // iterating the syntax tree over a ```tasks fenced block) that
          // markdown({ base: markdownLanguage })'s default GFM setup produces
          // FencedCode > CodeMark, CodeInfo, CodeText, CodeMark — matching the
          // structure assumed here; CodeText spans the full (possibly
          // multi-line) query text as a single node.
          if (n === 'FencedCode') {
            const infoNode = node.node.getChild('CodeInfo');
            const info = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to).trim() : '';
            // The closing ``` doesn't exist as a second CodeMark until the fence is
            // actually closed — while still open (being typed), lezer-markdown
            // extends the node all the way to EOF/doc.length, which makes deriving
            // "the closing line" from that positional math unreliable (see git log
            // for the details of a real freeze this caused). So this whole node is
            // now treated exactly like Table/```tasks```: fully raw (no marker
            // hiding, no box styling at all — `return false` so nothing further
            // down this tree walk touches its children either) whenever either
            // (a) there's no second CodeMark yet, i.e. the fence isn't closed, or
            // (b) the cursor is on any line from the opening fence to the closing
            // one inclusive. Only a closed block with the cursor entirely outside
            // it gets the rendered treatment.
            const marks = node.node.getChildren('CodeMark');
            const closeMark = marks.length >= 2 ? marks[marks.length - 1] : null;
            if (!closeMark) { return false; }

            const fromLine = state.doc.lineAt(node.from);
            const toLine   = state.doc.lineAt(closeMark.from);
            let isActive = false;
            for (let i = fromLine.number; i <= toLine.number; i++) {
              if (active.has(i)) { isActive = true; break; }
            }
            if (isActive) { return false; }

            if (info === 'tasks') {
              try {
                const codeTextNode = node.node.getChild('CodeText');
                const queryText = codeTextNode
                  ? state.doc.sliceString(codeTextNode.from, codeTextNode.to).trim()
                  : '';

                const cached = tasksQueryCache.get(queryText);
                if (!cached) { requestTasksQuery(queryText); }

                decs.push({ from: fromLine.from, to: fromLine.to,
                  dec: Decoration.replace({ widget: new TasksQueryWidget(queryText, cached) }) });
                // Blank-line guard — see the comment on the Table case above.
                for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                  const line = state.doc.line(ln);
                  if (line.to > line.from) {
                    decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
                  }
                  lineDecs.push({ from: line.from,
                    dec: hiddenLineDeco('cm-table-row-hidden') });
                }
              } catch (_) {}
              return false;
            }

            if (info === 'dataviewjs') {
              const codeTextNode = node.node.getChild('CodeText');
              const scriptCode = codeTextNode ? state.doc.sliceString(codeTextNode.from, codeTextNode.to) : '';
              // Only a dv.view(...) call needs the real-DOM/app engine (DataviewJsWidget) —
              // everything else (dv.table/dv.list-only reporting scripts) still goes through
              // DataviewQueryWidget/obsidianlike-dataview below exactly as before, unmodified.
              if (DV_VIEW_CALL_RE.test(scriptCode)) {
                try {
                  decs.push({ from: fromLine.from, to: fromLine.to,
                    dec: Decoration.replace({ widget: new DataviewJsWidget(scriptCode) }) });
                  // Blank-line guard — see the comment on the Table case above.
                  for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                    const line = state.doc.line(ln);
                    if (line.to > line.from) {
                      decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
                    }
                    lineDecs.push({ from: line.from,
                      dec: hiddenLineDeco('cm-table-row-hidden') });
                  }
                } catch (_) {}
                return false;
              }
            }

            if (info === 'dataview' || info === 'dql' || info === 'dataviewjs') {
              try {
                const codeTextNode = node.node.getChild('CodeText');
                const queryText = codeTextNode
                  ? state.doc.sliceString(codeTextNode.from, codeTextNode.to).trim()
                  : '';

                const key = dataviewCacheKey(info, queryText);
                const cached = dataviewQueryCache.get(key);
                if (!cached) { requestDataviewQuery(info, queryText); }

                decs.push({ from: fromLine.from, to: fromLine.to,
                  dec: Decoration.replace({ widget: new DataviewQueryWidget(info, queryText, cached) }) });
                // Blank-line guard — see the comment on the Table case above.
                for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                  const line = state.doc.line(ln);
                  if (line.to > line.from) {
                    decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
                  }
                  lineDecs.push({ from: line.from,
                    dec: hiddenLineDeco('cm-table-row-hidden') });
                }
              } catch (_) {}
              return false;
            }

            // Regular (non-tasks) fenced code block, closed, cursor outside it
            // entirely: the ``` fence-open/-close lines collapse to zero height
            // (not just text-hidden), mirroring Obsidian — so they don't leave
            // behind an empty, padded-looking line above/below the block —
            // and every remaining *content* line gets a shared box-style line
            // class (.cm-code-block/-first/-last/-solo — see vsTheme) so the
            // block renders as one cohesive box.
            try {
              for (const fenceLine of [fromLine, toLine]) {
                // Explicit full-line replace + height-collapse, same dual
                // pattern as Table's collapsed rows and folded headings
                // (foldPlugin) elsewhere in this file — also clears any
                // CodeInfo language text (e.g. "js" from ```js).
                decs.push({ from: fenceLine.from, to: fenceLine.to, dec: Decoration.replace({}) });
                lineDecs.push({ from: fenceLine.from,
                  dec: hiddenLineDeco('cm-code-fence-hidden') });
              }

              const contentFromLn = fromLine.number + 1;
              const contentToLn   = toLine.number - 1;
              for (let ln = contentFromLn; ln <= contentToLn; ln++) {
                const line = state.doc.line(ln);
                let cls = 'cm-code-block';
                if (contentFromLn === contentToLn) cls += ' cm-code-block-solo';
                else if (ln === contentFromLn) cls += ' cm-code-block-first';
                else if (ln === contentToLn) cls += ' cm-code-block-last';
                lineDecs.push({ from: line.from, dec: Decoration.line({ class: cls }) });
              }
            } catch (_) {}
            return false;
          }

          // ── Headings — line class for Obsidian theme (active + inactive) ──
          const headingM = /^ATXHeading([1-6])$/.exec(n);
          if (headingM) {
            const lineStart = state.doc.lineAt(node.from).from;
            lineDecs.push({ from: lineStart,
              dec: Decoration.line({ class: `HyperMD-header HyperMD-header-${headingM[1]}` }) });
            // Don't return false — children (HeaderMark etc.) still need processing
          }

          const ln = state.doc.lineAt(node.from).number;

          // ── [[wiki-link]] inner brackets — cancel lezer-markdown's coincidental
          // Link/LinkMark tagging, only while the cursor is inside THIS link's
          // own brackets ──────────────────────────────────────────────────────
          // `[[Foo]]` isn't real CommonMark syntax, but the *inner* "[Foo]"
          // looks exactly like a shortcut reference link to lezer-markdown, so
          // it parses as a Link node with its own LinkMark children — while the
          // outer "[" and "]" fall completely outside any node and get no
          // syntax-highlighting classes at all. That leaves the inner brackets
          // styled (tags.link + tags.processingInstruction, i.e. colored and a
          // smaller font-size) while the outer ones stay plain text-colored —
          // visibly mismatched while editing. Gated to this link's own bracket
          // range, not the whole line: wikiLinkPlugin now also switches a link
          // to raw/rendered per-token (not per-line), so with several
          // [[wiki-links]] on one active line, only the one the cursor is
          // actually inside should stay raw — the others still get
          // wikiLinkPlugin's hidden-brackets + .cm-wiki-link styling, and this
          // decoration must not stack on top of that (same node, different
          // plugin) since its !important reset would cancel wikiLinkPlugin's
          // blue/underline styling too. `![[Foo]]` doesn't have this problem:
          // the leading "!" makes the *outer* Image node wrap everything, so
          // every character — brackets included — already gets the same
          // tags.link styling uniformly; skip nodes parented by Image so that
          // stays untouched.
          if (n === 'Link' && node.node.parent && node.node.parent.name !== 'Image' &&
              state.doc.sliceString(node.from - 1, node.from) === '[' &&
              state.doc.sliceString(node.to, node.to + 1) === ']' &&
              isLinkActivated(node.from - 1, node.to + 1)) {
            decs.push({ from: node.from, to: node.to, dec: Decoration.mark({
              class: 'cm-wiki-link-raw',
              attributes: { style: plainBracketFontSizeStyle(node) },
            }) });
          }

          // ── Bare `[text]` with no `(url)` after it — same false-positive
          // coloring as the wiki-link case above, for the same reason
          // (lezer-markdown parses *any* `[...]` shape as a shortcut-reference
          // Link node, whether or not a matching reference definition exists
          // anywhere in the document), but unconditional rather than gated to
          // the active/edited line — a bare bracket isn't raw syntax waiting to
          // be revealed, it's just plain text that happens to parse the same
          // way, so it should never look like a link. Two other Link shapes
          // are deliberately excluded: this link's own [[wiki-link]] inner
          // brackets (just above — mutually exclusive with the check below,
          // since that requires being preceded by "[" and followed by "]",
          // which this explicitly rules out), and a genuine `[text](url)`,
          // whose own Link node span extends through the closing ")" (see the
          // syntax tree dump this was verified against: `[text]` alone spans
          // just its own brackets, `[text](url)` swallows the parenthesized
          // URL into the *same* node instead of leaving it a sibling). The
          // last condition avoids a one-keystroke flicker while actively
          // typing a not-yet-closed "[[note" — its momentary single-bracket
          // parse would otherwise transiently match this too.
          if (n === 'Link' && node.node.parent && node.node.parent.name !== 'Image' &&
              !(state.doc.sliceString(node.from - 1, node.from) === '[' &&
                state.doc.sliceString(node.to, node.to + 1) === ']') &&
              state.doc.sliceString(node.to - 1, node.to) !== ')' &&
              !(!activeLinkClosed && activeLinkFrom === node.from - 1)) {
            decs.push({ from: node.from, to: node.to, dec: Decoration.mark({
              class: 'cm-plain-brackets',
              attributes: { style: plainBracketFontSizeStyle(node) },
            }) });
          }

          if (active.has(ln)) return;

          if (n === 'HeaderMark') {
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
            decs.push({ from: node.from, to: end, dec: Decoration.replace({}) });
            return false;
          }
          if (n === 'ListMark') {
            // Task-checkbox lines are already fully replaced by TaskCheckboxWidget
            // (added while processing the enclosing ListItem, above) — skip the plain
            // bullet replacement so the two decorations don't overlap.
            if (taskLines.has(state.doc.lineAt(node.from).number)) { return false; }
            const markText = state.doc.sliceString(node.from, node.to);
            if (/^[-*+]$/.test(markText)) {
              let end = node.to;
              if (state.doc.sliceString(end, end + 1) === ' ') end++;
              decs.push({ from: node.from, to: end, dec: Decoration.replace({ widget: new BulletWidget() }) });
            }
            return false;
          }
          if (n === 'EmphasisMark' || n === 'CodeMark' || n === 'StrikethroughMark') {
            decs.push({ from: node.from, to: node.to, dec: Decoration.replace({}) });
            return false;
          }
          // LinkMark and URL nodes are handled by mdLinkPlugin (regex-based).
          // Returning false here prevents double-processing if the tree-walker still visits them.
          if (n === 'LinkMark') { return false; }
          if (n === 'URL')      { return false; }
        }
      });

      // Merge span/widget decs + line decs, sort by position, add to builder.
      const all = [
        ...decs,
        ...lineDecs.map(d => ({ from: d.from, to: d.from, dec: d.dec })),
      ];
      all.sort((a, b) => a.from - b.from || a.to - b.to);

      const builder = new RangeSetBuilder();
      let lastTo = -1;
      for (const { from, to, dec } of all) {
        // Skip overlapping non-zero-length ranges.
        // Zero-length (from===to) decorations are always safe to add regardless
        // of lastTo because they don't occupy any span.
        if (from !== to && from < lastTo) continue;
        try { builder.add(from, to, dec); } catch (_) {}
        if (to > lastTo) lastTo = to;
      }
      return builder.finish();
    } catch (e) {
      console.error('[livePreview] _build error:', e);
      return Decoration.none;
    }
  }
}, { decorations: v => v.decorations });

// ── Standard markdown link plugin ([text](url) → styled clickable span) ───────
class MdLinkWidget extends WidgetType {
  constructor(text, url) { super(); this.text = text; this.url = url; }
  eq(o) { return this.text === o.text && this.url === o.url; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-md-link';
    el.textContent = this.text;
    el.dataset.url = this.url;
    return el;
  }
  ignoreEvent() { return false; }
}

const mdLinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    const { state } = view;
    const active = getActiveLines(state);
    const { from: vf, to: vt } = view.viewport;
    const str = state.doc.sliceString(vf, vt);
    // Match [text](url) but NOT ![ (image syntax)
    const re = /(?<!!)\[([^\[\]\n]*)\]\(([^)\n]*)\)/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const text = m[1];
      const url  = m[2].trim();
      all.push({ from: mFrom, to: mTo,
        dec: Decoration.replace({ widget: new MdLinkWidget(text, url) }) });
    }
    // Bare `https://...` URLs — e.g. dropped straight into a task's description with no
    // `[text](url)` around them — get the same clickable styling instead of sitting there as
    // plain, unstyled text. Same regex `findUrlAtPos` already uses as its syntax-tree fallback
    // for click detection, so "does this look like a link" and "does clicking here open a link"
    // agree on the same span. Unlike the widget above, this is a plain `Decoration.mark` (no
    // widget, nothing to hide) — there's no markdown syntax to reveal/collapse for a bare URL,
    // the URL text itself is exactly what should stay visible, so it doesn't need the
    // active-line exclusion `[text](url)` uses either. The final overlap-skip below already
    // keeps this from double-styling a URL that's actually a `[text](url)` destination: that
    // match's own `from` (`[`) always sorts before this one's `from` (`http`, further inside
    // the same construct), so it claims the range first.
    const urlRe = /https?:\/\/[^\s)"'\]>]+/g;
    while ((m = urlRe.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      all.push({ from: mFrom, to: mTo,
        dec: Decoration.mark({ class: 'cm-md-link', attributes: { 'data-url': m[0] } }) });
    }
    all.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of all) {
      if (from < lastTo) continue;
      try { builder.add(from, to, dec); lastTo = Math.max(lastTo, to); } catch (_) {}
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Wiki-link plugin ──────────────────────────────────────────────────────────
// Dispatched by the `note-index` message handler so wikiLinkPlugin re-checks
// which links resolve — unlike docChanged/selectionSet/viewportChanged, a
// noteIndex update carries no doc/viewport change of its own to key off of.
const noteIndexRebuildEffect = StateEffect.define();

// Mirrors resolveNoteUri's rules host-side (splitTarget + splitDirHint): a
// target may carry a "#section" suffix (irrelevant to existence) and a single
// directory-hint segment (`folder/Note`, only the immediate parent name).
// Existence only, not full resolution — doesn't need to know the *current*
// note's directory, since "no hint" existence is "some note has this name
// anywhere" (same-dir-first vs. vault-wide fallback both resolve if either
// matches) and "with hint" existence just needs a name+parent-dir match.
function noteTargetExists(rawTarget) {
  const notePart = rawTarget.split('#')[0];
  const segments = notePart.replace(/\\/g, '/').split('/').filter(Boolean);
  const noteName = segments.pop() || notePart;
  const dirHint = segments.length > 0 ? segments[segments.length - 1] : null;
  if (!dirHint) return noteIndex.some(n => n.name === noteName);
  const hint = dirHint.toLowerCase();
  return noteIndex.some(n => n.name === noteName &&
    (n.dir ? n.dir.split('/').pop() : '').toLowerCase() === hint);
}

// Also used by WikiSuggestView below — an unclosed "[[" ending exactly at the
// cursor (still being typed, no closing "]]" yet).
const WIKI_TRIGGER_RE = /\[\[([^\]\n]*)$/;

// ── [[wiki-link]] "activation" — when a link should reveal its raw markdown ───
// Obsidian-style live preview reveals a link's raw [[...]] the instant the
// cursor sits anywhere inside it, including just passing through on cursor
// navigation — which reads as flicker/noise rather than "I'm editing this
// link" (worse for Up/Down specifically, since moveVerticalByLine's
// column-preserving landing spot inside a link is essentially arbitrary, not
// something the user aimed for). Instead, a link only reveals its raw form
// once the user actually *edits* text (insert or delete) while the cursor is
// inside it — landing there via pure navigation alone leaves it rendered.
// Once activated by an edit, it *stays* raw — including through further pure
// navigation within the same link — until the cursor moves outside its outer
// brackets, at which point it reverts to normal rendering.
//
// `activeLinkFrom`/`activeLinkTo` is the currently-activated link's outer
// span: position of the first "[" through one past the last "]" for an
// existing [[note]], or through the cursor itself for a still-unclosed "[["
// being typed. `activeLinkClosed` tells the two cases apart: `true` for an
// existing, already-closed link being edited (only affects raw-vs-rendered
// display); `false` for a genuinely in-progress, unclosed "[[note" (also what
// gates WikiSuggestView's popup below — editing inside an already-closed link
// never reopens it, matching how the popup already only ever targeted
// *new*, unclosed links).
let activeLinkFrom = null;
let activeLinkTo = null;
let activeLinkClosed = false;

// Finds the [[...]] (closed) or "[[..." (unclosed, ending at the cursor) span
// containing `pos`, mirroring the exact shapes wikiLinkPlugin and
// WikiSuggestView's own trigger regex already recognize.
function findLinkContextAt(state, pos) {
  const sel = state.selection.main;
  if (!sel.empty || sel.head !== pos) return null;
  const line = state.doc.lineAt(pos);

  const closedRe = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;
  let m;
  while ((m = closedRe.exec(line.text)) !== null) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return { from, to, closed: true };
  }

  const before = line.text.slice(0, pos - line.from);
  const tm = WIKI_TRIGGER_RE.exec(before);
  if (tm) return { from: line.from + tm.index, to: pos, closed: false };
  return null;
}

// Plain side-effect ViewPlugin (no decorations) — must run *before*
// wikiLinkPlugin/livePreviewPlugin in the extensions list (see createEditor)
// so their own rebuild for this same transaction already sees the up-to-date
// activation state, instead of lagging a transaction behind.
const wikiLinkActivationTracker = ViewPlugin.fromClass(class {
  update(u) {
    // Keep a currently-activated span in sync with edits made elsewhere in the
    // document (e.g. an external-update from autosave), so it doesn't drift or
    // silently point at the wrong text.
    if (activeLinkFrom != null && u.docChanged) {
      activeLinkFrom = u.changes.mapPos(activeLinkFrom, -1);
      activeLinkTo = u.changes.mapPos(activeLinkTo, 1);
    }

    const userEdited = u.docChanged &&
      u.transactions.some(t => t.isUserEvent('input') || t.isUserEvent('delete'));
    if (userEdited) {
      const ctx = findLinkContextAt(u.state, u.state.selection.main.head);
      if (ctx) { activeLinkFrom = ctx.from; activeLinkTo = ctx.to; activeLinkClosed = ctx.closed; }
      else { activeLinkFrom = activeLinkTo = null; }
      return;
    }

    // Pure navigation (or a non-user-input doc change): never *newly*
    // activates — only clears an existing activation once the cursor leaves it.
    if (!u.docChanged && !u.selectionSet) return;
    if (activeLinkFrom != null) {
      const pos = u.state.selection.main.head;
      if (pos < activeLinkFrom || pos > activeLinkTo) { activeLinkFrom = activeLinkTo = null; }
    }
  }
});

function isLinkActivated(from, to) {
  return activeLinkFrom === from && activeLinkTo === to;
}

const wikiLinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some(tr => tr.effects.some(e => e.is(noteIndexRebuildEffect)))) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    const { state } = view;
    const { from: vf, to: vt } = view.viewport;
    const str = state.doc.sliceString(vf, vt);
    const re = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      if (isLinkActivated(mFrom, mTo)) continue;
      const name  = m[1];
      const alias = m[2];
      const linkClass = 'cm-wiki-link' + (noteTargetExists(name) ? '' : ' cm-wiki-link-missing');
      all.push({ from: mFrom,     to: mFrom + 2, dec: Decoration.replace({}) });
      // No alias: `name` may still carry a "#section" (e.g. "Note#Heading") —
      // show only the section text, same as an alias hides "target|" and
      // shows just the alias, rather than the raw "Note#Heading" as-is.
      const hashIdx = alias === undefined ? name.indexOf('#') : -1;
      if (alias !== undefined) {
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length + 1, dec: Decoration.replace({}) });
        const aFrom = mFrom + 2 + name.length + 1;
        all.push({ from: aFrom, to: aFrom + alias.length,
          dec: Decoration.mark({ class: linkClass, attributes: { 'data-target': name } }) });
      } else if (hashIdx !== -1) {
        const section = name.slice(hashIdx + 1);
        all.push({ from: mFrom + 2, to: mFrom + 2 + hashIdx + 1, dec: Decoration.replace({}) });
        const sFrom = mFrom + 2 + hashIdx + 1;
        all.push({ from: sFrom, to: sFrom + section.length,
          dec: Decoration.mark({ class: linkClass, attributes: { 'data-target': name } }) });
      } else {
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length,
          dec: Decoration.mark({ class: linkClass, attributes: { 'data-target': name } }) });
      }
      all.push({ from: mTo - 2, to: mTo, dec: Decoration.replace({}) });
    }
    all.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of all) {
      if (from < lastTo) continue;
      try { builder.add(from, to, dec); lastTo = Math.max(lastTo, to); } catch (_) {}
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Image plugin (![[filename.ext]] → <img>) ──────────────────────────────────
const IMG_EXT = /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i;
const imgPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    const { state } = view;
    const active = getActiveLines(state);
    const { from: vf, to: vt } = view.viewport;
    const str = state.doc.sliceString(vf, vt);
    const re = /!\[\[([^\]]+)\]\]/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const raw = m[1];
      const pipeIdx = raw.indexOf('|');
      const filename = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw).trim();
      if (!IMG_EXT.test(filename)) continue;
      let width = null, caption = null;
      if (pipeIdx >= 0) {
        const param = raw.slice(pipeIdx + 1).trim();
        if (/^\d+(?:px)?$/i.test(param)) width = parseInt(param, 10) + 'px';
        else if (param) caption = param;
      }
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const basename = filename.split('/').pop();
      const src = imageMap[filename] || imageMap[basename] || '';
      if (!src) continue;
      all.push({ from: mFrom, to: mTo,
        dec: Decoration.replace({ widget: new ImageWidget(src, filename, width, caption) }) });
    }
    all.sort((a, b) => a.from - b.from);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of all) {
      if (from < lastTo) continue;
      try { builder.add(from, to, dec); } catch (_) {}
      lastTo = to;
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Note transclusions (![[note]], ![[dir/note]], ![[note#section]]) ─────────
// A transclusion needs the target note's (possibly section-scoped) text, which
// the webview can't read itself — same async round-trip pattern as the ```tasks```
// query blocks above: webview → host (postMessage) → host reads/parses the file →
// back to the webview → render. `_build()` runs synchronously, so results are
// cached by the raw target string (`transclusionCache`) and re-requested only
// once per target (`transclusionPending`); `transclusionRebuildEffect` forces a
// plugin rebuild once a response arrives, mirroring `tasksRebuildEffect`.
const transclusionCache   = new Map(); // raw target string -> { content, title, line, error }
const transclusionPending = new Set();
const transclusionRebuildEffect = StateEffect.define();

function requestTransclusion(target) {
  if (transclusionPending.has(target)) return;
  transclusionPending.add(target);
  vscode.postMessage({ type: 'get-transclusion', id: target, target });
}

// Minimal block-level markdown renderer for transcluded content: headings, fenced
// code, blockquotes, bullet lists and paragraphs. Inline formatting (bold, italic,
// code, wiki-links) is delegated to `renderCell`, which already HTML-escapes its
// input, so this stays safe against transcluded content containing HTML-like text.
function renderMarkdownBlock(text) {
  const frag = document.createDocumentFragment();
  const lines = (text || '').split(/\r\n|\n/);
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    p.style.margin = '0.4em 0';
    p.innerHTML = renderCell(para.join(' '));
    frag.appendChild(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++; // skip closing fence (if any)
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:rgba(128,128,128,0.15);padding:8px 10px;border-radius:4px;overflow-x:auto;margin:0.4em 0;';
      const code = document.createElement('code');
      code.style.fontFamily = 'var(--font-monospace, monospace)';
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }
    const headingM = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (headingM) {
      flushPara();
      const level = headingM[1].length;
      const h = document.createElement('div');
      h.className = `cm-header cm-header-${level}`;
      h.style.margin = '0.3em 0';
      h.innerHTML = renderCell(headingM[2].trim());
      frag.appendChild(h);
      i++;
      continue;
    }
    const quoteM = /^\s*>\s?(.*)$/.exec(line);
    if (quoteM) {
      flushPara();
      const bq = document.createElement('blockquote');
      bq.style.cssText = 'border-left:3px solid rgba(128,128,128,0.4);margin:0.3em 0;padding-left:10px;opacity:0.85;';
      bq.innerHTML = renderCell(quoteM[1]);
      frag.appendChild(bq);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0.3em 0;padding-left:1.4em;';
      while (i < lines.length) {
        const lm = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!lm) break;
        const li = document.createElement('li');
        li.innerHTML = renderCell(lm[1]);
        ul.appendChild(li);
        i++;
      }
      frag.appendChild(ul);
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return frag;
}

class TransclusionWidget extends WidgetType {
  constructor(target, data) { super(); this.target = target; this.data = data; }
  eq(other) { return this.target === other.target && this.data === other.data; }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-transclusion';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-transclusion-open';
    btn.title = 'Abrir nota de origen';
    btn.dataset.target = this.target;
    btn.textContent = '↗';
    box.appendChild(btn);

    const body = document.createElement('div');
    body.className = 'cm-transclusion-body';
    if (!this.data) {
      body.classList.add('cm-transclusion-loading');
      body.textContent = 'Cargando transclusión…';
    } else if (this.data.error) {
      body.classList.add('cm-transclusion-error');
      body.textContent = this.data.error === 'section-not-found'
        ? `Sección no encontrada en "${this.data.title || this.target}"`
        : `No se encontró "${this.target}"`;
    } else {
      if (this.data.title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'cm-transclusion-title';
        titleEl.textContent = this.data.title;
        body.appendChild(titleEl);
      }
      body.appendChild(renderMarkdownBlock(this.data.content));
    }
    box.appendChild(body);
    return box;
  }
  ignoreEvent() { return false; }
}

const transclusionPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some(t => t.effects.some(e => e.is(transclusionRebuildEffect)))) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    const { state } = view;
    const active = getActiveLines(state);
    const { from: vf, to: vt } = view.viewport;
    const str = state.doc.sliceString(vf, vt);
    const re = /!\[\[([^\]]+)\]\]/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const raw = m[1].trim();
      // Images are rendered by imgPlugin — skip here regardless of any #section-
      // or |param-like suffix a filename might coincidentally contain.
      const filenameGuess = raw.split('#')[0].split('|')[0].trim();
      if (IMG_EXT.test(filenameGuess)) continue;
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const cached = transclusionCache.get(raw);
      if (cached === undefined) requestTransclusion(raw);
      all.push({ from: mFrom, to: mTo,
        dec: Decoration.replace({ widget: new TransclusionWidget(raw, cached) }) });
    }
    all.sort((a, b) => a.from - b.from);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of all) {
      if (from < lastTo) continue;
      try { builder.add(from, to, dec); } catch (_) {}
      lastTo = to;
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Ctrl+hover wiki-link preview popup ────────────────────────────────────────
// Holding Ctrl (Cmd on macOS) while the mouse rests over a [[wiki-link]] shows a
// small floating popup with the target note's content — Obsidian's own "page
// preview" hover behavior. Reuses the exact same host round-trip as note
// transclusions (`transclusionCache`/`requestTransclusion`/`transclusion-result`)
// since the data need — raw target string -> { content, title, line, error } —
// is identical; this also means a target already fetched for a `![[...]]`
// transclusion elsewhere in the doc previews instantly, and vice versa.
//
// Detection piggybacks on `linkClickHandler`'s own `mousemove` handler (added
// there, not here) rather than a second DOM walk: `e.ctrlKey`/`e.metaKey` is
// read straight off the mousemove event, since keydown/keyup only fire while
// some element in the page has focus and would miss "Ctrl already held, then
// move the mouse over a link" — a plain mousemove's modifier flags are always
// current regardless of focus.
const HOVER_PREVIEW_DELAY = 300; // ms — mirrors Obsidian's own hover-preview delay

class HoverPreviewView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-hover-preview';
    this.dom.style.display = 'none';
    view.dom.appendChild(this.dom);

    this.linkEl = null;   // the .cm-wiki-link/[data-wiki] element currently tracked
    this.target = null;   // its raw wiki-link target string
    this.showTimer = null;
    this.visible = false;
    this.overPopup = false; // pointer is over the popup itself — keep it open

    this.dom.addEventListener('mouseenter', () => { this.overPopup = true; });
    this.dom.addEventListener('mouseleave', () => {
      this.overPopup = false;
      if (!this.linkEl) this.hide();
    });
  }

  destroy() { this.dom.remove(); }

  onMouseMove(e, linkEl, rawTarget) {
    const ctrlHeld = e.ctrlKey || e.metaKey;
    if (!ctrlHeld || !linkEl) { this.leaveLink(); return; }
    if (linkEl === this.linkEl) return; // still hovering the same link
    this.leaveLink();
    this.linkEl = linkEl;
    this.target = rawTarget;
    this.showTimer = setTimeout(() => this.show(), HOVER_PREVIEW_DELAY);
  }

  // Called on Ctrl/Cmd release too (see the document-level keyup listener near
  // the bottom of this file) so the popup disappears immediately even if the
  // mouse doesn't move right after releasing the key.
  leaveLink() {
    clearTimeout(this.showTimer);
    this.showTimer = null;
    this.linkEl = null;
    this.target = null;
    if (!this.overPopup) this.hide();
  }

  show() {
    if (!this.target) return;
    this.visible = true;
    const cached = transclusionCache.get(this.target);
    if (cached === undefined) requestTransclusion(this.target);
    this.render(cached);
  }

  hide() {
    this.visible = false;
    this.dom.style.display = 'none';
  }

  // Re-paints with fresh data once a pending transclusion-result for this exact
  // target arrives — see the 'transclusion-result' message handler below.
  refresh() {
    if (!this.visible || !this.target) return;
    this.render(transclusionCache.get(this.target));
  }

  render(data) {
    if (!this.linkEl || !this.linkEl.isConnected) { this.hide(); return; }
    // Deferred via requestMeasure, not read synchronously here — same reason as
    // WikiSuggestView.render() above: this can run from inside a domEventHandlers
    // callback, and CM6 forbids reading layout synchronously at arbitrary times.
    this.view.requestMeasure({
      key: this,
      read: () => ({
        linkRect: this.linkEl.getBoundingClientRect(),
        editorRect: this.view.dom.getBoundingClientRect(),
      }),
      write: measured => this.paint(measured, data),
    });
  }

  paint({ linkRect, editorRect }, data) {
    if (!this.visible) return;
    const dom = this.dom;
    dom.textContent = '';
    dom.style.display = 'block';

    if (data === undefined) {
      const loading = document.createElement('div');
      loading.className = 'cm-hover-preview-loading';
      loading.textContent = 'Cargando…';
      dom.appendChild(loading);
    } else if (data.error) {
      const err = document.createElement('div');
      err.className = 'cm-hover-preview-error';
      err.textContent = data.error === 'section-not-found'
        ? `Sección no encontrada en "${data.title || this.target}"`
        : `No se encontró "${this.target}"`;
      dom.appendChild(err);
    } else {
      if (data.title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'cm-hover-preview-title';
        titleEl.textContent = data.title;
        dom.appendChild(titleEl);
      }
      const body = document.createElement('div');
      body.className = 'cm-hover-preview-body';
      body.appendChild(renderMarkdownBlock(data.content));
      dom.appendChild(body);
    }

    dom.style.left = Math.max(0, linkRect.left - editorRect.left) + 'px';
    dom.style.top = (linkRect.bottom - editorRect.top + 4) + 'px';
  }
}

const hoverPreviewPlugin = ViewPlugin.fromClass(HoverPreviewView);

// ── Wiki-link suggestion popup ────────────────────────────────────────────────
// Triggers on both `[[` (links) and `![[` (transclusions) since the trigger
// regex matches on `[[` alone — the leading `!`, if present, is left as-is and
// only the `[[...]]` span is ever replaced. Rendered as a plain floating DOM
// element (WikiSuggestView below) rather than CM6's built-in autocompletion
// tooltip: the desired look (a directory subtext under each note name, a
// persistent keybinding-hint footer, "no results" as its own row) needs full
// control over per-row markup that the Completion API doesn't expose — same
// reasoning as every other custom-rendered widget in this file (TableWidget,
// TransclusionWidget, TasksQueryWidget). Once the typed text contains a `#`,
// it switches to searching that note's headings (in document order) instead
// of the note index, via the same host round-trip the old CM6-based version
// used.
const pendingHeadingRequests = new Map(); // request id -> resolve
let headingsReqSeq = 0;

function requestHeadings(note) {
  return new Promise(resolve => {
    const id = 'h' + (++headingsReqSeq);
    pendingHeadingRequests.set(id, resolve);
    vscode.postMessage({ type: 'get-headings', id, note });
  });
}

const WIKI_SUGGEST_MAX = 5; // visible rows in the popup at once — see the sliding window in paint()
const WIKI_SUGGEST_SCAN_MAX = 50; // underlying matches kept before windowing, just a sanity cap

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// HTML-escapes `text`, wrapping the first case-insensitive occurrence of
// `query` in <b>. Empty query -> plain escaped text (used for the "recent
// files" list, which isn't matched against anything so nothing is bolded).
function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<b>' + escapeHtml(text.slice(idx, idx + query.length)) + '</b>' +
    escapeHtml(text.slice(idx + query.length));
}

// Notes whose name contains `query` (case-insensitive), closest/earliest match
// first — "empiecen o contengan" from the spec, i.e. a name starting with the
// query sorts before one merely containing it. Capped to WIKI_SUGGEST_SCAN_MAX
// (not the much smaller WIKI_SUGGEST_MAX, which is just the popup's visible
// window — see the sliding window in paint()), so a query matching many notes
// can still be reached by scrolling instead of being invisibly truncated.
function matchNotes(query) {
  const q = query.toLowerCase();
  const scored = [];
  for (const n of noteIndex) {
    const idx = n.name.toLowerCase().indexOf(q);
    if (idx !== -1) scored.push({ n, idx });
  }
  scored.sort((a, b) => a.idx - b.idx || a.n.name.localeCompare(b.n.name));
  return scored.slice(0, WIKI_SUGGEST_SCAN_MAX).map(s => ({ type: 'note', name: s.n.name, dir: s.n.dir }));
}

class WikiSuggestView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-wikilink-suggest';
    this.dom.style.display = 'none';
    view.dom.appendChild(this.dom);

    this.open = false;
    this.mode = null;             // 'notes' | 'headings'
    this.query = '';              // text after [[ (notes) or after # (headings)
    this.notePart = '';           // note name before # (headings mode only)
    this.pos = null;              // cursor position (= end of replacement range)
    this.openBracketFrom = null;  // doc position of the "[[" that opened this popup
    this.items = [];
    this.selected = 0;
    this.loading = false;
    // Set on Escape so the popup stays dismissed for this exact trigger context
    // (same "[[" + same typed text) — cleared as soon as either changes.
    this.dismissedKey = null;
    this.headingsToken = 0;

    // The popup is a plain DOM node outside CM6's contentDOM, so it can use
    // ordinary listeners instead of routing through linkClickHandler.
    this.dom.addEventListener('mousedown', e => e.preventDefault());
    this.dom.addEventListener('click', e => {
      const item = e.target.closest('.cm-wls-item');
      if (item) this.accept(Number(item.dataset.index));
    });

    this.recompute();
  }

  destroy() { this.dom.remove(); }

  update(u) {
    if (u.docChanged || u.selectionSet) this.recompute();
  }

  currentContext() {
    const state = this.view.state;
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const pos = sel.head;
    const line = state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const m = WIKI_TRIGGER_RE.exec(before);
    if (!m) return null;
    const openBracketFrom = line.from + m.index;
    // Only a genuinely unclosed "[[" the user is actively typing opens the
    // popup — the cursor merely navigating into one, or an edit made inside an
    // *already-closed* [[link]], must not (that only reveals the raw text, via
    // isLinkActivated — see the "wiki-link activation" comment above
    // wikiLinkPlugin). WIKI_TRIGGER_RE alone can't tell "still being typed"
    // apart from "cursor happens to sit before the ']]' of an existing link",
    // since it only looks at text *before* the cursor.
    if (activeLinkClosed || activeLinkFrom !== openBracketFrom) return null;
    return { pos, openBracketFrom, raw: m[1] };
  }

  recompute() {
    const ctx = this.currentContext();
    if (!ctx) { this.dismissedKey = null; this.close(); return; }

    const key = ctx.openBracketFrom + ':' + ctx.raw;
    if (this.dismissedKey === key) { this.hide(); return; }
    this.dismissedKey = null;

    this.pos = ctx.pos;
    this.openBracketFrom = ctx.openBracketFrom;

    const hashIdx = ctx.raw.indexOf('#');
    if (hashIdx === -1) {
      this.mode = 'notes';
      this.query = ctx.raw;
      this.notePart = '';
      this.loading = false;
      this.items = this.query ? matchNotes(this.query) : noteHistory.slice(0, WIKI_SUGGEST_SCAN_MAX).map(n => ({ type: 'note', name: n.name, dir: n.dir }));
      this.selected = 0;
      this.open = true;
      this.render();
      return;
    }

    const notePart = ctx.raw.slice(0, hashIdx);
    if (!notePart) { this.close(); return; }
    this.mode = 'headings';
    this.notePart = notePart;
    this.query = ctx.raw.slice(hashIdx + 1);
    this.open = true;
    this.loading = true;
    this.items = [];
    this.selected = 0;
    this.render();

    const token = ++this.headingsToken;
    const wantQuery = this.query;
    requestHeadings(notePart).then(headings => {
      if (token !== this.headingsToken) return; // superseded by a later keystroke
      const q = wantQuery.toLowerCase();
      this.items = headings
        .filter(h => h.text.toLowerCase().includes(q))
        .slice(0, WIKI_SUGGEST_SCAN_MAX)
        .map(h => ({ type: 'heading', level: h.level, text: h.text }));
      this.loading = false;
      this.selected = 0;
      this.render();
    });
  }

  close() {
    this.open = false;
    this.mode = null;
    this.hide();
  }

  hide() { this.dom.style.display = 'none'; }

  // Escape: hide without altering text, and don't reopen for this exact
  // context until the user types more or moves elsewhere.
  dismiss() {
    if (!this.open) return;
    this.dismissedKey = this.openBracketFrom + ':' + (this.mode === 'headings' ? this.notePart + '#' + this.query : this.query);
    this.open = false;
    this.hide();
  }

  moveSelection(delta) {
    if (!this.open || this.loading || this.items.length === 0) return false;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.render();
    return true;
  }

  accept(index) {
    const idx = Number.isInteger(index) ? index : this.selected;
    let insertText;
    if (this.items.length === 0) {
      // No matches — Enter creates the wikilink using the typed text as-is.
      const raw = this.mode === 'headings' ? `${this.notePart}#${this.query}` : this.query;
      insertText = `[[${raw}]]`;
    } else {
      const it = this.items[idx];
      insertText = it.type === 'heading' ? `[[${this.notePart}#${it.text}]]` : `[[${it.name}]]`;
    }
    const from = this.openBracketFrom;
    const view = this.view;
    let to = this.pos;
    // If the cursor sits inside an already-closed [[...]] — e.g. the user
    // clicked back between "enlaces" and "]]" to type "#cabecera" — that
    // trailing "]]" is still in the document past `to`. Swallow it into the
    // replaced range so insertText's own "]]" replaces it instead of leaving
    // both (which produced "[[enlaces#cabecera]]]]").
    if (view.state.doc.sliceString(to, to + 2) === ']]') to += 2;
    this.close();
    view.dispatch({
      changes: { from, to, insert: insertText },
      selection: { anchor: from + insertText.length },
      userEvent: 'input',
    });
    view.focus();
  }

  rowTitle(it) {
    if (it.type === 'heading') {
      return escapeHtml('#'.repeat(it.level) + ' ') + highlightMatch(it.text, this.query);
    }
    return highlightMatch(it.name, this.query);
  }

  // Schedules the actual paint via requestMeasure rather than reading
  // coordsAtPos/getBoundingClientRect synchronously here. render() can be
  // called from inside the ViewPlugin's own update() (via recompute(), on
  // every keystroke) — and CM6 throws "Reading the editor layout isn't
  // allowed during an update" if coordsAtPos is read synchronously in that
  // window, which crashes and permanently deactivates this plugin (CM6
  // destroys+deactivates a ViewPlugin the first time its update() throws).
  // `key: this` ties queued requests to this instance, so a later render()
  // call (e.g. arrow-key navigation) replaces an earlier still-pending one
  // instead of piling up.
  render() {
    if (!this.open) { this.hide(); return; }
    this.view.requestMeasure({
      key: this,
      read: view => ({ coords: view.coordsAtPos(this.pos), editorRect: view.dom.getBoundingClientRect() }),
      write: measured => this.paint(measured),
    });
  }

  paint(measured) {
    if (!this.open) { this.hide(); return; }
    const { coords, editorRect } = measured;
    if (!coords) { this.hide(); return; }

    const dom = this.dom;
    dom.textContent = '';
    dom.style.display = 'block';

    const list = document.createElement('div');
    list.className = 'cm-wls-list';
    if (this.loading) {
      const loading = document.createElement('div');
      loading.className = 'cm-wls-loading';
      loading.textContent = 'Cargando…';
      list.appendChild(loading);
    } else if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cm-wls-empty';
      empty.textContent = 'No se encontraron resultados';
      list.appendChild(empty);
    } else {
      // Sliding window: only WIKI_SUGGEST_MAX rows are ever rendered, but with
      // more matches than that, the window follows `selected` — windowStart =
      // selected - (WIKI_SUGGEST_MAX - 1), clamped to the list's bounds. That
      // alone reproduces "pin the selected row to the last visible slot once
      // scrolled past the first page, in either direction" with no extra
      // scroll-direction state: e.g. selected=6 (0-based, the 7th match) always
      // renders window [2,6] regardless of whether Up or Down just got you
      // there, matching the earlier item reappearing at the top the same way
      // pressing Up through a normal dropdown would.
      const windowStart = this.items.length <= WIKI_SUGGEST_MAX ? 0 :
        Math.max(0, Math.min(this.selected - (WIKI_SUGGEST_MAX - 1), this.items.length - WIKI_SUGGEST_MAX));
      this.items.slice(windowStart, windowStart + WIKI_SUGGEST_MAX).forEach((it, i) => {
        const absIndex = windowStart + i;
        const row = document.createElement('div');
        row.className = 'cm-wls-item' + (absIndex === this.selected ? ' is-selected' : '');
        row.dataset.index = String(absIndex);
        const title = document.createElement('div');
        title.className = 'cm-wls-title';
        title.innerHTML = this.rowTitle(it);
        row.appendChild(title);
        if (it.type === 'note' && it.dir) {
          const dirEl = document.createElement('div');
          dirEl.className = 'cm-wls-dir';
          dirEl.textContent = it.dir + '/';
          row.appendChild(dirEl);
        }
        list.appendChild(row);
      });
    }
    dom.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'cm-wls-footer';
    footer.innerHTML =
      '<span>Use <b>#</b> para enlazar el encabezado</span>' +
      '<span>Use <b>^</b> para enlazar bloques</span>' +
      '<span>Use <b>|</b> para cambiar el texto mostrado</span>';
    dom.appendChild(footer);

    dom.style.left = Math.max(0, coords.left - editorRect.left) + 'px';

    // Flip upward (draw from above the cursor's line, growing up) when there
    // isn't enough room to draw downward without spilling past the visible
    // editor pane — reported when the cursor sits near the tab's bottom edge,
    // where the popup could end up partially or entirely clipped/off-screen.
    // dom.offsetHeight forces a synchronous reflow to get the popup's real,
    // just-built height — safe to read here (unlike inside a ViewPlugin's own
    // update(), see WikiSuggestView's class comment) since this write()
    // callback is exactly the phase CM6's own requestMeasure cycle sets aside
    // for touching the DOM, and it's this popup's own detached subtree being
    // measured, not any layout CM6 itself owns.
    const GAP = 4;
    const popupHeight = dom.offsetHeight;
    const spaceBelow = editorRect.bottom - coords.bottom;
    const spaceAbove = coords.top - editorRect.top;
    if (popupHeight + GAP > spaceBelow && spaceAbove > spaceBelow) {
      dom.style.top = (coords.top - editorRect.top - popupHeight - GAP) + 'px';
    } else {
      dom.style.top = (coords.bottom - editorRect.top + GAP) + 'px';
    }
  }
}

const wikiSuggestPlugin = ViewPlugin.fromClass(WikiSuggestView);

const wikiSuggestKeymap = Prec.highest(keymap.of([
  { key: 'Escape', run: view => {
      const p = view.plugin(wikiSuggestPlugin);
      if (p && p.open) { p.dismiss(); return true; }
      return false;
    } },
  { key: 'ArrowDown', run: view => {
      const p = view.plugin(wikiSuggestPlugin);
      return p ? p.moveSelection(1) : false;
    } },
  { key: 'ArrowUp', run: view => {
      const p = view.plugin(wikiSuggestPlugin);
      return p ? p.moveSelection(-1) : false;
    } },
  { key: 'Enter', run: view => {
      const p = view.plugin(wikiSuggestPlugin);
      if (!p || !p.open) return false;
      if (!p.loading) p.accept();
      return true;
    } },
]));

// ── Line-based vertical cursor movement (replaces CM6's default Up/Down) ──────
// CM6's own cursorLineDown/cursorLineUp move by *visual pixel position*: on the
// first key of a vertical-move sequence it captures a "goal" x-coordinate from
// the line's current on-screen styling, then reuses that goal for every further
// press in the same sequence so the column lines up visually — that's normally
// how a short line doesn't derail navigation through a long one. But markdown
// marker hiding (livePreviewPlugin: `* ` shown raw only on the active line,
// replaced by BulletWidget everywhere else) changes each line's on-screen width
// depending on which line the cursor is currently on. Every arrow press changes
// the active line, which changes decorations *before* the next press reuses the
// stale goal x-coordinate — captured against styling that no longer matches
// what's rendered. Confirmed as a known CodeMirror behavior, not a bug specific
// to this codebase (discuss.codemirror.net/t/moving-of-cursor-with-different-
// size-mark-decoration-and-replace-decoration-issues/4198 — a maintainer reply
// there recommends exactly the fix below): a small bulleted list where each
// line's marker toggles raw/hidden as the cursor passes through reproduced
// visible skipping/backtracking on Down and Up, worse the further into the list
// the cursor moved.
//
// Fix (per that thread): bypass goal-column/pixel tracking entirely and move by
// plain document line number instead — line ± 1, same character *column*
// (clamped to the target line's length), independent of anything rendered.
// `vGoalCol` reimplements just enough of CM6's own goal-column persistence
// (preserving the column through a *sequence* of consecutive vertical moves,
// e.g. down through several short lines then back onto a long one) without
// involving pixel/DOM measurement anywhere — `dispatchingVerticalMove` marks a
// transaction as one of these moves so the reset below (in the main
// updateListener) can tell "still mid vertical-move sequence" apart from any
// other selection change, which should still clear the remembered column.
let vGoalCol = null;
let dispatchingVerticalMove = false;

function moveVerticalByLine(view, dir, extend) {
  const { state } = view;
  const range = state.selection.main;
  const curLine = state.doc.lineAt(range.head);

  // EditorView.lineWrapping means a single *document* line with no embedded
  // newline (a long paragraph) can still span several on-screen rows. Moving
  // by document-line-number alone (below) would skip straight over those
  // extra rows to the next real line — e.g. landing on the blank line after
  // a long paragraph instead of the paragraph's own second visual row.
  // CM6's own pixel-based view.moveVertically() *does* handle this correctly,
  // but only reusing it for a single, freshly-computed step that turns out to
  // stay on the *same* document line: calling it fresh (no persisted
  // goalColumn passed in, unlike CM6's own cursorLineDown/Up, which is what
  // this whole custom keymap replaced) means there's no stale cross-press
  // goal to go wrong, and moving between wrap-rows of one line never crosses
  // into a differently-decorated line either, so the corruption described
  // above this function's binding can't happen for this particular step.
  const pixelCandidate = view.moveVertically(EditorSelection.cursor(range.head), dir > 0);
  const staysOnSameLine = state.doc.lineAt(pixelCandidate.head).number === curLine.number;

  let newHead;
  if (staysOnSameLine) {
    // Still within the same wrapped document line — trust the pixel step,
    // and deliberately leave vGoalCol untouched (this isn't a line-to-line
    // jump, so it has no bearing on that column-preservation mechanism).
    newHead = pixelCandidate.head;
  } else {
    // Actually crossing into a different document line (the common case,
    // and also what a wrapped line's *last*/*first* visual row hits next) —
    // exactly where the pixel/goal-column approach breaks, per the comment
    // above; jump by line number + character column instead, immune to it.
    const col = vGoalCol != null ? vGoalCol : (range.head - curLine.from);
    let targetLineNum = curLine.number + dir;
    // Skip clean over a folded heading's content instead of landing inside
    // it. foldAtomicRanges (see its own comment) covers CM6's own built-in
    // navigation and mouse-click paths, but this function deliberately
    // bypasses CM6's built-in vertical motion for cross-line moves (that's
    // the whole reason it exists — see above), so it doesn't inherit that
    // protection for free and needs the same check done here directly,
    // against the same computeFoldedSpans single source of truth.
    for (const span of computeFoldedSpans(state)) {
      const spanFromLine = state.doc.lineAt(span.from).number;
      const spanToLine = state.doc.lineAt(span.to).number;
      if (targetLineNum >= spanFromLine && targetLineNum <= spanToLine) {
        targetLineNum = dir > 0 ? spanToLine + 1 : spanFromLine - 1;
      }
    }
    targetLineNum = Math.min(Math.max(targetLineNum, 1), state.doc.lines);
    const targetLine = state.doc.line(targetLineNum);
    newHead = targetLine.from + Math.min(col, targetLine.length);
    vGoalCol = col;
  }

  dispatchingVerticalMove = true;
  try {
    view.dispatch({
      selection: extend ? EditorSelection.range(range.anchor, newHead) : EditorSelection.cursor(newHead),
      userEvent: 'select',
    });
  } finally {
    dispatchingVerticalMove = false;
  }
  return true;
}

const verticalMoveKeymap = Prec.highest(keymap.of([
  { key: 'ArrowDown', run: view => moveVerticalByLine(view, 1, false) },
  { key: 'ArrowUp', run: view => moveVerticalByLine(view, -1, false) },
  { key: 'Shift-ArrowDown', run: view => moveVerticalByLine(view, 1, true) },
  { key: 'Shift-ArrowUp', run: view => moveVerticalByLine(view, -1, true) },
]));

// ── Markdown shortcuts ────────────────────────────────────────────────────────
function toggleWrap(view, marker) {
  const { state, dispatch } = view;
  const sel = state.selection.main;
  const ml  = marker.length;
  if (sel.empty) {
    dispatch(state.update({
      changes: { from: sel.from, insert: marker + marker },
      selection: { anchor: sel.from + ml },
      userEvent: 'input',
    }));
  } else {
    const text = state.doc.sliceString(sel.from, sel.to);
    if (text.startsWith(marker) && text.endsWith(marker) && text.length > ml * 2) {
      dispatch(state.update({
        changes: { from: sel.from, to: sel.to, insert: text.slice(ml, -ml) },
        userEvent: 'input',
      }));
    } else {
      dispatch(state.update({
        changes: [{ from: sel.from, insert: marker }, { from: sel.to, insert: marker }],
        selection: EditorSelection.range(sel.from, sel.to + ml * 2),
        userEvent: 'input',
      }));
    }
  }
  return true;
}

// ── Click / link handler ──────────────────────────────────────────────────────
// mousedown: prevent CM6 from moving cursor onto wiki-link or URL spans.
// click: fire the actual action (open note or URL).
function findUrlAtPos(view, pos) {
  const line = view.state.doc.lineAt(pos);
  let url = null;
  let cur = syntaxTree(view.state).resolve(pos, 1);
  while (cur) {
    if (cur.name === 'URL') {
      let raw = view.state.doc.sliceString(cur.from, cur.to);
      if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
      url = raw;
      break;
    }
    if (cur.name === 'Link') {
      let child = cur.firstChild;
      while (child) {
        if (child.name === 'URL') {
          let raw = view.state.doc.sliceString(child.from, child.to);
          if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
          url = raw;
          break;
        }
        child = child.nextSibling;
      }
      break;
    }
    cur = cur.parent;
  }
  if (!url) {
    const colOffset = pos - line.from;
    const re = /https?:\/\/[^\s)"'\]>]+/g;
    let m;
    while ((m = re.exec(line.text)) !== null) {
      if (m.index <= colOffset && colOffset <= m.index + m[0].length) {
        url = m[0]; break;
      }
    }
  }
  return url && /^https?:\/\//.test(url) ? url : null;
}

function isWikiLinkEl(target, editorDom) {
  let el = target;
  while (el && el !== editorDom) {
    if (el.classList && el.classList.contains('cm-wiki-link')) return el;
    el = el.parentElement;
  }
  return null;
}

const linkClickHandler = EditorView.domEventHandlers({
  // Registered here (via EditorView.domEventHandlers, same as mousedown/click
  // below) rather than as a raw document.addEventListener, because CM6's own
  // EditorView has a BUILT-IN 'drop' handler (@codemirror/view's internal
  // `handlers.drop`) that runs on the editor's contentDOM: when it sees
  // `event.dataTransfer.files.length > 0`, it reads each file as *text*
  // (FileReader.readAsText) and inserts the result into the document — garbage
  // for a binary file like a .docx. CM6 composes handlers per event type as
  // [...extension-registered handlers, ...its own built-in ones] and stops at
  // the first one that returns a truthy value (calling preventDefault() for
  // it), so registering our own drop handling as an extension here — exactly
  // like this file's other custom mousedown/click handling — runs *before*
  // and pre-empts CM6's default text-insert behavior, rather than racing
  // against it as a separately-bound, later-in-bubble-order raw listener would.
  dragenter(e) {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return false;
    return true;
  },
  dragover(e) {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return false;
    e.dataTransfer.dropEffect = 'copy';
    return true;
  },
  drop(e, view) {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return false;
    console.log('[obsidian-like] CM6 drop handler: files=', e.dataTransfer.files.length);
    const coordPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    pendingDropPos = coordPos != null ? coordPos : view.state.selection.main.head;
    const files = Array.from(e.dataTransfer.files);
    Promise.all(files.map(f => readFileAsDataUrl(f).then(data => ({ name: f.name, data }))))
      .then(payload => vscode.postMessage({ type: 'drop-files', files: payload }))
      .catch(() => { pendingDropPos = null; });
    return true;
  },
  // mousedown: prevent CM6 cursor placement when clicking navigable elements
  mousedown(e, view) {
    const wikiEl = isWikiLinkEl(e.target, view.dom);
    if (wikiEl) { e.preventDefault(); return true; }
    const tableWiki = e.target.closest('[data-wiki]');
    if (tableWiki) { e.preventDefault(); return true; }
    const mdLink = e.target.closest('.cm-md-link');
    if (mdLink) { e.preventDefault(); return true; }
    const transclOpen = e.target.closest('.cm-transclusion-open');
    if (transclOpen) { e.preventDefault(); return true; }
    const taskCb = e.target.closest('.cm-task-checkbox');
    if (taskCb) { e.preventDefault(); return true; }
    const taskQueryEditBtn = e.target.closest('.cm-task-query-edit-btn');
    if (taskQueryEditBtn) { e.preventDefault(); return true; }

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    if (findUrlAtPos(view, pos)) { e.preventDefault(); return true; }
    return false;
  },
  // click: fire the action
  click(e, view) {
    const wikiEl = isWikiLinkEl(e.target, view.dom);
    if (wikiEl) {
      e.preventDefault();
      const target = wikiEl.dataset.target || wikiEl.textContent.trim();
      vscode.postMessage({ type: 'open-note', name: target });
      return true;
    }
    const tableWiki = e.target.closest('[data-wiki]');
    if (tableWiki) {
      e.preventDefault();
      // `data-wiki-base` (see renderCell) is only set for wikilinks rendered on behalf of another
      // file (e.g. a tasks-query row's description) — forwarded so the host resolves/creates
      // relative to *that* file's directory instead of always defaulting to the open document's.
      vscode.postMessage({ type: 'open-note', name: tableWiki.dataset.wiki, basePath: tableWiki.dataset.wikiBase });
      return true;
    }
    const mdLink = e.target.closest('.cm-md-link');
    if (mdLink) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-url', url: mdLink.dataset.url });
      return true;
    }
    const transclOpen = e.target.closest('.cm-transclusion-open');
    if (transclOpen) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-transclusion', target: transclOpen.dataset.target });
      return true;
    }
    // Checked before the generic .cm-task-checkbox below: a tasks-query result
    // checkbox carries BOTH classes (so it still gets vsTheme's checkbox
    // styling), but it needs `data-path` + `data-line` (the task may live in
    // any file in the vault) rather than the plain `toggle-task` line-only message.
    const taskQueryCb = e.target.closest('.cm-task-query-checkbox');
    if (taskQueryCb) {
      e.preventDefault();
      vscode.postMessage({
        type: 'toggle-task-at-location',
        path: taskQueryCb.dataset.path,
        line: Number(taskQueryCb.dataset.line),
      });
      return true;
    }
    // A tasks-query row's edit button carries `data-path` + `data-line` too (the task may live
    // in any file in the vault), same reasoning as `.cm-task-query-checkbox` above — there's no
    // equivalent for the single inline checkbox widget, since editing that one is covered by the
    // `vaultTool.editTaskAtCursor` keybinding instead (the cursor is always in the right document
    // for that case, unlike an arbitrary row in a query result).
    const taskQueryEditBtn = e.target.closest('.cm-task-query-edit-btn');
    if (taskQueryEditBtn) {
      e.preventDefault();
      vscode.postMessage({
        type: 'edit-task-at-location',
        path: taskQueryEditBtn.dataset.path,
        line: Number(taskQueryEditBtn.dataset.line),
      });
      return true;
    }
    const taskCb = e.target.closest('.cm-task-checkbox');
    if (taskCb) {
      e.preventDefault();
      vscode.postMessage({ type: 'toggle-task', line: Number(taskCb.dataset.line) });
      return true;
    }

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const url = findUrlAtPos(view, pos);
    if (url) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-url', url });
      return true;
    }
    return false;
  },
  // Ctrl/Cmd+hover preview (HoverPreviewView) — never claims the event, only
  // observes it, so it can't interfere with normal cursor placement/selection.
  mousemove(e, view) {
    const hp = view.plugin(hoverPreviewPlugin);
    if (!hp) return false;
    const wikiEl = isWikiLinkEl(e.target, view.dom);
    const tableWiki = !wikiEl ? e.target.closest('[data-wiki]') : null;
    const linkEl = wikiEl || tableWiki;
    const rawTarget = wikiEl ? (wikiEl.dataset.target || wikiEl.textContent.trim())
                      : tableWiki ? tableWiki.dataset.wiki : null;
    hp.onMouseMove(e, linkEl, rawTarget);
    return false;
  },
  mouseleave(e, view) {
    view.plugin(hoverPreviewPlugin)?.leaveLink();
    return false;
  },
});

// ── Heading fold ──────────────────────────────────────────────────────────────
const foldEffect    = StateEffect.define();
const foldedSet     = new Set(); // set of heading line.from positions that are folded
let   currentView   = null;      // set after editor creation

class FoldToggle extends WidgetType {
  constructor(lineFrom, folded) { super(); this.lineFrom = lineFrom; this.folded = folded; }
  eq(o) { return this.lineFrom === o.lineFrom && this.folded === o.folded; }
  toDOM() {
    const outer = document.createElement('div');
    outer.className = 'cm-fold-indicator' + (this.folded ? ' is-collapsed' : '');
    outer.contentEditable = 'false';
    const inner = document.createElement('div');
    inner.className = 'collapse-indicator collapse-icon';
    // Empty on purpose: kept only so the Border theme's mask-image reskin
    // selectors (targeting .svg-icon.right-triangle) still have an element to
    // attach to, but 0x0/empty viewBox means nothing is ever actually drawn.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('viewBox', '0 0 0 0'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('svg-icon', 'right-triangle');
    inner.appendChild(svg); outer.appendChild(inner);
    const lf = this.lineFrom;
    outer.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    outer.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (foldedSet.has(lf)) foldedSet.delete(lf); else foldedSet.add(lf);
      if (currentView) currentView.dispatch({ effects: foldEffect.of(lf) });
    });
    return outer;
  }
  ignoreEvent() { return false; }
}

function collectHeadings(state) {
  const hs = [];
  syntaxTree(state).iterate({
    enter(node) {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (m) {
        const line = state.doc.lineAt(node.from);
        hs.push({ level: +m[1], lineFrom: line.from, lineTo: line.to });
        return false;
      }
    }
  });
  return hs;
}

// Character-position spans of every currently-folded heading's *content*
// (from just after the heading's own line through wherever that fold ends —
// the next heading at the same or a shallower level, or end of document).
// Factored out of foldPlugin's own _build() (which still uses it, unchanged,
// for the per-line hide decorations) so the exact same computation can also
// back an atomicRanges provider and moveVerticalByLine's own fold-aware line
// jump — see the comments on both, below, for why folded content needing
// real cursor-navigation protection (not just visual height:0 hiding) turned
// out to need three separate consumers of this one source of truth, not one.
function computeFoldedSpans(state, headings) {
  headings = headings || collectHeadings(state);
  const spans = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!foldedSet.has(h.lineFrom)) continue;
    let foldEnd = state.doc.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        foldEnd = headings[j].lineFrom > 0 ? headings[j].lineFrom - 1 : 0;
        break;
      }
    }
    if (foldEnd > h.lineTo) { spans.push({ from: h.lineTo + 1, to: foldEnd }); }
  }
  return spans;
}

const foldPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged) {
      // Remap folded positions through document edits
      const mapped = new Set();
      for (const p of foldedSet) {
        const mp = u.changes.mapPos(p, 1);
        if (mp != null) mapped.add(mp);
      }
      foldedSet.clear();
      mapped.forEach(p => foldedSet.add(p));
    }
    if (u.docChanged || u.viewportChanged || u.selectionSet ||
        u.transactions.some(t => t.effects.some(e => e.is(foldEffect)))) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    try {
      const { state } = view;
      const { from: vf, to: vt } = view.viewport;
      const headings = collectHeadings(state);
      const all = [], lineDecs = [];

      for (const h of headings) {
        // Fold toggle widget — only for heading lines in viewport
        if (h.lineTo >= vf && h.lineFrom <= vt) {
          all.push({ from: h.lineFrom, to: h.lineFrom,
            dec: Decoration.widget({ widget: new FoldToggle(h.lineFrom, foldedSet.has(h.lineFrom)), side: -1 }) });
        }
      }

      // Collapse every line within each currently-folded span.
      // Blank-line guard — this was the actual root cause of the reported
      // "folding a heading leaves a visible blank-space gap" bug (see the long
      // comment on the Table case in livePreviewPlugin's own _build, above,
      // for the full RangeSetBuilder diagnosis): a blank line's own
      // Decoration.replace({}) push degenerates to a zero-length span at the
      // exact same point as its Decoration.line hidden-line decoration, and
      // only one of two decorations added at an identical point survives —
      // silently dropping the line decoration (and its height:0 CSS) for
      // every blank line in the folded span, while non-blank lines collapsed
      // correctly. Confirmed with a real EditorView in jsdom (throwaway
      // script, not checked in). Skipping the push for blank lines loses no
      // behavior, since replacing a zero-length span is already a no-op.
      for (const { from, to } of computeFoldedSpans(state, headings)) {
        const startLn = state.doc.lineAt(from).number;
        const endLn   = state.doc.lineAt(to).number;
        for (let ln = startLn; ln <= endLn; ln++) {
          const line = state.doc.line(ln);
          if (line.to > line.from) {
            all.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
          }
          lineDecs.push({ from: line.from,
            dec: hiddenLineDeco('cm-fold-hidden') });
        }
      }

      const combined = [
        ...all,
        ...lineDecs.map(d => ({ from: d.from, to: d.from, dec: d.dec })),
      ];
      combined.sort((a, b) => a.from - b.from || a.to - b.to);
      const builder = new RangeSetBuilder();
      let lastTo = -1;
      for (const { from, to, dec } of combined) {
        if (from !== to && from < lastTo) continue;
        try { builder.add(from, to, dec); } catch (_) {}
        if (to > lastTo) lastTo = to;
      }
      return builder.finish();
    } catch (e) {
      console.error('[foldPlugin]', e);
      return Decoration.none;
    }
  }
}, { decorations: v => v.decorations });

// Makes folded content a real cursor-navigation barrier, not just visually
// height:0 — reported bug: the "collapsed" gap between a folded heading and
// the next one was still fully navigable (click into it, arrow through it,
// select and copy/delete it) purely because `.cm-fold-hidden`'s CSS zeroing
// only ever hid *rendering*; the document positions themselves, including
// every blank line separating paragraphs under the folded heading, were
// still perfectly ordinary, selectable positions as far as CM6's own cursor
// model was concerned. `EditorView.atomicRanges` is CM6's sanctioned fix for
// exactly this: ranges registered here get skipped over by moveByChar/
// moveVertically-based navigation (Home/End, arrow keys *routed through
// CM6's own commands*) and by mouse-click/drag-selection placement (verified
// by reading @codemirror/view's own source: pointer-driven selection changes
// are explicitly passed through skipAtomsForSelection). What this does *not*
// cover is moveVerticalByLine's own Up/Down handling below, which — for the
// exact same decoration-driven goal-column corruption reasons documented on
// that function — deliberately bypasses CM6's built-in vertical motion for
// cross-line moves instead of using it, so it can't inherit atomicRanges
// protection for free; it has its own fold-skipping logic instead, using
// this same computeFoldedSpans.
const foldAtomicRanges = EditorView.atomicRanges.of(view => {
  const builder = new RangeSetBuilder();
  for (const { from, to } of computeFoldedSpans(view.state)) {
    if (to > from) { try { builder.add(from, to, Decoration.replace({})); } catch (_) {} }
  }
  return builder.finish();
});

// ── Source mode (Compartment) ─────────────────────────────────────────────────
const previewCompartment = new Compartment();
let sourceMode = false;

// ── Editor creation ───────────────────────────────────────────────────────────
function createEditor(parent, content) {
  const state = EditorState.create({
    doc: content,
    extensions: [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      // Must run before livePreviewPlugin/wikiLinkPlugin (next) so their own
      // rebuild for this same transaction already sees the fresh activation
      // state — see the comment above wikiLinkActivationTracker's definition.
      wikiLinkActivationTracker,
      previewCompartment.of([livePreviewPlugin, mdLinkPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin]),
      foldPlugin,
      foldAtomicRanges,
      linkClickHandler,
      hoverPreviewPlugin,
      wikiSuggestPlugin,
      wikiSuggestKeymap,
      verticalMoveKeymap,
      // CM6 doesn't set these on its contentEditable contentDOM by default, and
      // leaving them unset is what silently disables the OS-level text features
      // that key off them: macOS's own Text Replacement (System Settings ->
      // Keyboard -> Text Replacement) only offers its substitution popup on an
      // editable element that opts in via `autocorrect`; `spellcheck`/
      // `autocapitalize` are the same category of native-input attribute
      // (Obsidian's own CM6-based editor sets the equivalent). Not verified on
      // real macOS hardware from here (development happens on Windows) — if
      // substitutions still don't trigger after this, the next thing to check
      // is whether CM6's own `beforeinput`/composition handling (which takes
      // over from the browser's native contentEditable insertion path for
      // every keystroke, by design, same as every other CM6-based editor) is
      // intercepting the substitution event before WebKit/Chromium's macOS
      // text-replacement subsystem gets a chance to act on it — that would be
      // a much deeper, framework-level limitation, not a one-line fix.
      EditorView.contentAttributes.of({ autocorrect: 'on', autocapitalize: 'sentences', spellcheck: 'true' }),
      keymap.of([
        { key: 'Mod-b', run: v => toggleWrap(v, '**') },
        { key: 'Mod-i', run: v => toggleWrap(v, '*')  },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      vsTheme,
      EditorView.updateListener.of(u => {
        // Reports the cursor's line to the extension host on every selection change (cheap — a
        // single int, no debounce needed unlike `sync`'s full document text). This is what lets
        // `vaultTool.editTaskAtCursor` (a *real* contributes.keybindings entry, reassignable in
        // VS Code's Keyboard Shortcuts UI, unlike the old CM6-only keymap this replaced) know
        // which line to hand off to the Tasks extension without VS Code ever exposing this
        // webview as a `TextEditor` — see the CLAUDE.md section on this command for why a plain
        // CM6 keybinding wasn't good enough on its own.
        if (u.selectionSet) {
          const line = u.state.doc.lineAt(u.state.selection.main.head).number - 1;
          vscode.postMessage({ type: 'cursor-position', line });
          // Any selection change that didn't come from moveVerticalByLine itself
          // ends that vertical-move sequence — same as CM6's own goal-column
          // reset on non-vertical motion (typing, click, Home/End, ...).
          if (!dispatchingVerticalMove) { vGoalCol = null; }
        }
        if (!u.docChanged) return;
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
          vscode.postMessage({ type: 'sync', content: u.state.doc.toString() });
        }, 400);
      }),
    ],
  });
  return new EditorView({ state, parent });
}

// ── Init ──────────────────────────────────────────────────────────────────────
const root = document.documentElement;
root.style.setProperty('--md-font', init.font || '');
root.style.setProperty('--code-font', init.codeFont || '');
root.style.setProperty('--code-font-size', (init.codeFontSize || 14) + 'px');
root.style.setProperty('--md-font-size', (init.fontSize || 14) + 'px');

// ── Breadcrumb ────────────────────────────────────────────────────────────────
const breadcrumbEl = document.getElementById('doc-breadcrumb');
if (init.breadcrumb && init.breadcrumb.length > 0) {
  init.breadcrumb.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep';
      sep.textContent = '/';
      breadcrumbEl.appendChild(sep);
    }
    const isLast = i === init.breadcrumb.length - 1;
    const span = document.createElement('span');
    span.className = 'bc-part' + (isLast ? ' bc-last' : '');
    span.textContent = part.name;
    if (!isLast) { span.dataset.fspath = part.fsPath; }
    breadcrumbEl.appendChild(span);
  });
  breadcrumbEl.addEventListener('click', e => {
    const part = e.target.closest('.bc-part');
    if (part && part.dataset.fspath) {
      vscode.postMessage({ type: 'reveal-path', fsPath: part.dataset.fspath });
    }
  });
}

// ── Document title ────────────────────────────────────────────────────────────
const titleEl = document.getElementById('doc-title');
let currentTitle = init.title || '';
titleEl.textContent = currentTitle;

let renameTimer = null;

titleEl.addEventListener('input', () => {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => {
    const newName = titleEl.textContent.trim();
    if (newName && newName !== currentTitle) {
      currentTitle = newName;
      vscode.postMessage({ type: 'sync', content: view.state.doc.toString() });
      vscode.postMessage({ type: 'rename', newName });
    }
  }, 800);
});

titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); view.focus(); }
  if (e.key === 'Escape') { titleEl.textContent = currentTitle; view.focus(); }
});

// ── Editor ────────────────────────────────────────────────────────────────────
const container = document.getElementById('editor');
const view = createEditor(container, init.content || '');
currentView = view;
view.focus();

// Reported to the extension host (throttled via rAF) so `vaultTool.editTaskAtCursor` and the
// tasks-query row edit button can restore it after the "Create or edit Task" dialog closes —
// opening that dialog steals focus from this panel for as long as it's open (`ViewColumn.Beside`,
// `preserveFocus: false`), and was observed to leave this view scrolled back to the top once it
// closed, on both Apply and Cancel. See the `panelScrollTop` comment in extension.ts.
let scrollReportScheduled = false;
view.scrollDOM.addEventListener('scroll', () => {
  if (scrollReportScheduled) return;
  scrollReportScheduled = true;
  requestAnimationFrame(() => {
    scrollReportScheduled = false;
    vscode.postMessage({ type: 'scroll-position', scrollTop: view.scrollDOM.scrollTop });
  });
});

// CM6 measures line-height/character metrics once, early, using whatever font is
// actually resolved at that moment. If the real font (custom `markdownFont`, or
// one pulled in by the Obsidian theme CSS) finishes loading afterward, that cached
// geometry goes stale and custom-drawn UI that depends on it — namely
// drawSelection()'s selection boxes — ends up positioned against the old metrics
// instead of the real ones. `requestMeasure()` forces CM6 to redo that pass once
// fonts have actually settled.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { try { view.requestMeasure(); } catch (_) {} });
}

// Releasing Ctrl/Cmd should close the hover-preview popup right away, even if
// the mouse doesn't move afterward — mousemove's own e.ctrlKey check (in
// linkClickHandler) only re-evaluates on the next pointer movement.
document.addEventListener('keyup', e => {
  if (e.key === 'Control' || e.key === 'Meta') {
    currentView && currentView.plugin(hoverPreviewPlugin)?.leaveLink();
  }
});

// ── Source mode toggle ────────────────────────────────────────────────────────
function toggleSourceMode() {
  sourceMode = !sourceMode;
  view.dispatch({
    effects: previewCompartment.reconfigure(
      sourceMode ? [] : [livePreviewPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin]
    ),
  });
  document.body.classList.toggle('source-mode', sourceMode);
}

// Smallest { from, to, insert } that turns `oldStr` into `newStr`, found by
// trimming the matching prefix and suffix around whatever actually differs.
// Used by 'external-update' below instead of always replacing the whole
// document: CM6 maps the cursor through a change automatically (leaving it
// untouched whenever it falls outside the changed span), but a from:0,
// to:doc.length replace gives it nothing to map — every position sat inside
// the fully-deleted range, so it collapses to line 1, column 1. This was very
// visible on every autosave, since VS Code's own save participants (e.g.
// files.insertFinalNewline/trimTrailingWhitespace, independent of anything
// this extension controls) commonly touch the saved text slightly, which
// triggers exactly one of these external-update round-trips per save.
function minimalReplaceRange(oldStr, newStr) {
  const maxStart = Math.min(oldStr.length, newStr.length);
  let start = 0;
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  let oldEnd = oldStr.length, newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  return { from: start, to: oldEnd, insert: newStr.slice(start, newEnd) };
}

// Absolute offset for (1-based lineNumber, 0-based col) within `text`, clamping
// both to whatever `text` actually contains. Used to re-anchor the cursor by
// line/column after an 'external-update' rather than trusting CM6's default
// selection-mapping through the change — that mapping only does the right
// thing when the cursor sits *outside* the changed span. A save participant
// like files.trimTrailingWhitespace can touch many scattered lines in one
// save (every line that had trailing spaces — common in markdown, which uses
// a trailing double-space for a line break), which widens minimalReplaceRange's
// span to cover most of the document and very likely swallows the cursor's
// position inside it. That kind of change essentially never adds or removes
// *lines* though, so "same line, same column, clamped" survives it correctly
// even when the raw character-offset diff doesn't.
function posFromLineCol(text, lineNumber, col) {
  const lines = text.split('\n');
  const li = Math.min(Math.max(lineNumber, 1), lines.length) - 1;
  const c = Math.min(Math.max(col, 0), lines[li].length);
  let pos = 0;
  for (let i = 0; i < li; i++) pos += lines[i].length + 1; // +1 for the '\n'
  return pos + c;
}

// ── Message handling ──────────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'note-index':
      noteIndex = msg.notes || [];
      view.dispatch({ effects: noteIndexRebuildEffect.of(null) });
      break;
    case 'note-history':
      noteHistory = msg.notes || [];
      break;
    case 'image-map':
      imageMap = msg.map || {};
      view.dispatch({});
      break;
    case 'title-revert':
      currentTitle = msg.name || '';
      titleEl.textContent = currentTitle;
      break;
    case 'external-update': {
      const cur = view.state.doc.toString();
      if (msg.content !== cur) {
        const oldPos = view.state.selection.main.head;
        const oldLine = view.state.doc.lineAt(oldPos);
        const col = oldPos - oldLine.from;
        const newPos = posFromLineCol(msg.content, oldLine.number, col);
        view.dispatch({
          changes: minimalReplaceRange(cur, msg.content),
          selection: EditorSelection.single(Math.min(newPos, msg.content.length)),
        });
      }
      break;
    }
    case 'get-content':
      vscode.postMessage({ type: 'content-for-save', content: view.state.doc.toString() });
      break;
    case 'trigger-sync':
      clearTimeout(syncTimer);
      vscode.postMessage({ type: 'sync', content: view.state.doc.toString() });
      break;
    case 'image-pasted': {
      if (msg.filename && msg.uri) imageMap[msg.filename] = msg.uri;
      const embed = `![[${msg.filename}]]`;
      const pos   = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: embed },
        selection: { anchor: pos + embed.length },
        userEvent: 'input',
      });
      break;
    }
    case 'files-dropped': {
      const files = msg.files || [];
      if (!files.length) break;
      // imgPlugin already ignores any filename whose extension isn't in IMG_EXT, so
      // registering non-image drops in imageMap too is harmless — it's just unused.
      for (const f of files) { if (f.filename && f.uri) imageMap[f.filename] = f.uri; }
      const embed = files.map(f => `![[${f.filename}]]`).join('\n');
      const pos = pendingDropPos != null ? pendingDropPos : view.state.selection.main.head;
      pendingDropPos = null;
      view.dispatch({
        changes: { from: pos, insert: embed },
        selection: { anchor: pos + embed.length },
        userEvent: 'input',
      });
      view.focus();
      break;
    }
    case 'font-update':
      if (msg.font)      root.style.setProperty('--md-font', msg.font);
      if (msg.codeFont !== undefined) root.style.setProperty('--code-font', msg.codeFont);
      if (msg.codeFontSize) root.style.setProperty('--code-font-size', msg.codeFontSize);
      if (msg.fontSize)  root.style.setProperty('--md-font-size', msg.fontSize);
      // Changing the font can change line-height/character metrics after CM6
      // already measured layout once — see the comment by the initial
      // requestMeasure() call above. Re-measure so drawSelection() (and cursor
      // placement) don't stay pinned to the old, now-stale metrics.
      view.requestMeasure();
      break;
    case 'theme-css': {
      let st = document.getElementById('__obsidian-theme');
      if (!st) {
        st = document.createElement('style');
        st.id = '__obsidian-theme';
        document.head.appendChild(st);
      }
      st.textContent = msg.css || '';
      // Same reasoning as font-update: an Obsidian theme can define its own
      // heading font/line-height vars, and this message lands ~300ms after CM6's
      // initial layout — force a re-measure so selection/cursor geometry catches up.
      view.requestMeasure();
      break;
    }
    case 'toggle-source-mode':
      toggleSourceMode();
      break;
    case 'tasks-query-result':
      tasksQueryCache.set(msg.query, msg.result);
      tasksQueryPending.delete(msg.query);
      view.dispatch({ effects: tasksRebuildEffect.of(null) });
      break;
    case 'dataview-query-result': {
      const key = dataviewCacheKey(msg.lang, msg.query);
      dataviewQueryCache.set(key, msg.result);
      dataviewQueryPending.delete(key);
      view.dispatch({ effects: dataviewRebuildEffect.of(null) });
      break;
    }
    case 'dataview-script-result': {
      // No rebuild dispatch here on purpose: DataviewJsWidget.eq() only compares the block's
      // raw source text, never script-loaded state, so a CM6 rebuild wouldn't change which
      // widget instance is on screen anyway — requestDataviewScript's own waiters (inside
      // dvView, already running from toDOM()'s fire-and-forget call) are what actually resume.
      const entry = { content: msg.content, error: msg.error };
      dataviewScriptCache.set(msg.name, entry);
      const waiters = dataviewScriptWaiters.get(msg.name);
      if (waiters) {
        dataviewScriptWaiters.delete(msg.name);
        waiters.forEach(resolve => resolve(entry));
      }
      break;
    }
    case 'dataview-read-file-result':
    case 'dataview-write-file-result': {
      const pending = pendingDataviewFileRequests.get(msg.id);
      if (pending) { pendingDataviewFileRequests.delete(msg.id); pending.resolve(msg); }
      break;
    }
    case 'transclusion-result':
      transclusionCache.set(msg.id, { content: msg.content, title: msg.title, line: msg.line, error: msg.error });
      transclusionPending.delete(msg.id);
      view.dispatch({ effects: transclusionRebuildEffect.of(null) });
      view.plugin(hoverPreviewPlugin)?.refresh();
      break;
    case 'headings-result': {
      const resolve = pendingHeadingRequests.get(msg.id);
      if (resolve) { pendingHeadingRequests.delete(msg.id); resolve(msg.headings || []); }
      break;
    }
    case 'restore-scroll':
      // Double rAF: this message can arrive right as the panel regains focus/visibility after the
      // task-edit dialog closes, and a single frame wasn't always enough to land after whatever
      // internal layout/scroll recalculation was resetting scrollTop in the first place.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { view.scrollDOM.scrollTop = msg.scrollTop; });
      });
      break;
    case 'scroll-to-line': {
      const ln = Math.min(Math.max(1, (msg.line || 0) + 1), view.state.doc.lines);
      const line = view.state.doc.line(ln);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
      view.focus();
      break;
    }
    case 'tasks-changed':
      // Some task, anywhere in the vault, changed (possibly from another file or another
      // editor entirely) — every visible ```tasks``` block's data may now be stale. Re-request
      // each one currently on screen, but deliberately do NOT clear tasksQueryCache first (and
      // don't dispatch a rebuild here): the widget keeps rendering the last-known-good result
      // until the fresh one actually arrives via tasks-query-result, which is what triggers the
      // rebuild. Clearing eagerly used to make every visible block flash to its "loading"
      // placeholder and back on every single edit, even though the data was still fine to look
      // at for the fraction of a second it took to refetch.
      for (const query of tasksQueryCache.keys()) {
        requestTasksQuery(query);
      }
      break;
    case 'dataview-changed':
      // Same reasoning as 'tasks-changed' above: don't clear the cache eagerly, just re-request
      // every dataview block currently on screen and let the response swap it in once it arrives.
      for (const key of dataviewQueryCache.keys()) {
        const sep = key.indexOf(' ');
        requestDataviewQuery(key.slice(0, sep), key.slice(sep + 1));
      }
      break;
  }
});

// ── Paste image ───────────────────────────────────────────────────────────────
container.addEventListener('paste', e => {
  if (!e.clipboardData) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => vscode.postMessage({ type: 'paste-image', data: ev.target.result });
      reader.readAsDataURL(file);
      return;
    }
  }
});

// ── Drag & drop files (OS Explorer/Finder, or VS Code's own Explorer) ─────────
// The actual file-saving/embed-insert logic lives in `linkClickHandler`'s
// dragenter/dragover/drop CM6 handlers above (registered that way specifically
// to run before CM6's own built-in file-as-text drop handling — see the comment
// there). `readFileAsDataUrl`/`pendingDropPos` are shared by that handler and by
// the plain `document`-level fallback below, which only matters for a drop
// landing outside the CM6 editor's own DOM (e.g. the title/breadcrumb area above
// it, which CM6's contentDOM-scoped handler never sees).
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let pendingDropPos = null;

// Temporary diagnostics: confirms whether an external file drag is reaching the
// webview's DOM *at all*. Check via Command Palette → "Developer: Open Webview
// Developer Tools" (with the note panel focused) while performing the drag.
for (const evt of ['dragenter', 'dragover', 'drop']) {
  document.addEventListener(evt, e => {
    const hasFiles = !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'));
    console.log(`[obsidian-like] document ${evt}: hasFiles=${hasFiles} defaultPrevented=${e.defaultPrevented} target=${e.target && e.target.tagName}`);
  }, true); // capture phase, so this always logs even if something else stops propagation first
}

for (const evt of ['dragenter', 'dragover']) {
  document.addEventListener(evt, e => {
    if (e.defaultPrevented) return; // already claimed by linkClickHandler's CM6-level handler
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
}

document.addEventListener('drop', e => {
  if (e.defaultPrevented) return; // already claimed by linkClickHandler's CM6-level handler
  if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const coordPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  pendingDropPos = coordPos != null ? coordPos : view.state.selection.main.head;
  const files = Array.from(e.dataTransfer.files);
  Promise.all(files.map(f => readFileAsDataUrl(f).then(data => ({ name: f.name, data }))))
    .then(payload => vscode.postMessage({ type: 'drop-files', files: payload }))
    .catch(() => { pendingDropPos = null; });
});
