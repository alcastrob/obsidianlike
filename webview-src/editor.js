// webview-src/editor.js — CodeMirror 6 editor for the VS Code vault extension.
// Bundled by esbuild into out/editor.bundle.js.

import { EditorState, EditorSelection, RangeSetBuilder, Compartment, StateEffect, Prec } from "@codemirror/state";
import {
  EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection, runScopeHandlers
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  search, openSearchPanel, closeSearchPanel, findNext, findPrevious,
  selectMatches, replaceNext as cmReplaceNext, replaceAll as cmReplaceAll,
  getSearchQuery, setSearchQuery, SearchQuery, searchKeymap
} from "@codemirror/search";

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

// ── Highlightr-style highlighting (https://github.com/chetachiezikeuzor/Highlightr-Plugin) ──
// The Highlightr plugin wraps a selection in `<mark style="background-color: <color>">text</mark>`
// (or, in its "use CSS classes" mode, `<mark class="hltr-<name>">text</mark>`) — real inline HTML,
// since a plain `==highlight==` (already supported natively above) has no way to carry an arbitrary
// per-instance color. Colors are user-configurable (`obsidianLike.highlighterColors`), pushed down
// from the host via window.__vaultInitial the same way noteIndex/imageMap already are, and kept live
// via the 'highlighter-settings' message (see its handler further down) on a config change.
const DEFAULT_HIGHLIGHTER_COLORS = [
  { name: 'Amarillo', color: '#ffd700' },
  { name: 'Verde',    color: '#a3e635' },
  { name: 'Azul',     color: '#7dd3fc' },
  { name: 'Rojo',     color: '#fca5a5' },
  { name: 'Morado',   color: '#d8b4fe' },
  { name: 'Naranja',  color: '#fdba74' },
  { name: 'Cian',     color: '#67e8f9' },
  { name: 'Rosa',     color: '#f9a8d4' },
];
let highlighterColors = (init.highlighterColors && init.highlighterColors.length) ? init.highlighterColors : DEFAULT_HIGHLIGHTER_COLORS;
let highlighterUseCssClasses = !!init.highlighterUseCssClasses;

// Hanging-indent width reserved for a list item's own marker, used by both
// the CSS below and the ListItem/ListMark decoration logic further down.
// Two deliberately different, tight values (not one shared constant, and not
// the earlier, much wider 1.2em/2em split either) — see the long comment on
// the ListMark handling ("marker width, round two") for why: a single shared
// value wide enough to fit a 3-digit ordered marker read as an oversized gap
// after a plain bullet, compared to Obsidian's own compact spacing.
const LIST_BULLET_MARKER_WIDTH_EM  = 1.0;
// Was 1.6 — reported directly against a real Obsidian screenshot ("no se ve
// igual") showing a much tighter gap between an ordered marker ("1.") and
// the text after it than this produced. Tightened; still wide enough for a
// 2-digit marker ("10.") without the text visibly overlapping it.
const LIST_ORDERED_MARKER_WIDTH_EM = 1.2;

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
  // font-size deliberately isn't reset here (nor via any per-instance inline
  // style — an earlier `plainBracketFontSizeStyle` attempt at exactly that,
  // applied to this *outer* span, was removed after it made a bracket's
  // em-relative font-size compound with its own already-correctly-sized
  // *inner* span — see `.cm-md-mark` below for the actual, surgical fix).
  '.cm-wiki-link-raw, .cm-wiki-link-raw *, .cm-plain-brackets, .cm-plain-brackets *': {
    color: 'inherit !important',
    textDecoration: 'none !important',
    cursor: 'text !important',
  },
  // tags.processingInstruction's own class (mdHighlight) — markdown syntax
  // markers in general (a real [text](url) link's own brackets/parens, etc.),
  // meant to look small/faint while editing. Correct for that case.
  '.cm-md-mark': {
    color: 'var(--text-faint, var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.5)))',
    fontSize: '0.82em',
  },
  // Reported directly, with a screen recording: a [[wiki-link]]'s own inner
  // brackets (or a bare [text]'s, via .cm-plain-brackets) rendered visibly
  // smaller than the outer literal "[[" / "]]" and the link text itself,
  // while being edited. Root cause: lezer-markdown tags a wiki-link's inner
  // "[Foo]" as an ordinary shortcut-reference Link (see the long comment
  // above), so its LinkMark bracket characters get the exact same
  // tags.processingInstruction/`.cm-md-mark` treatment a *real* markdown
  // link's own syntax markers get — correct there, but wrong here: this
  // isn't a syntax marker being hidden/shown, it's the visible bracket text
  // of a wiki-link, which should read as plain text at the surrounding
  // text's own size, matching the *outer* "[[" / "]]" (untagged by anything,
  // and therefore already at the correct 1em).
  //
  // Can't just reset `.cm-md-mark`'s font-size to `inherit` unconditionally
  // the way `color`/`textDecoration`/`cursor` are reset above — a bracket
  // inside a heading needs to *keep* the heading's own (larger) font-size,
  // which lives on this exact same element (mdHighlight merges every
  // matching tag's classes onto one span, so a heading-wrapped bracket
  // carries both `cm-header cm-header-N` *and* `cm-md-mark` together, not
  // nested). `:not(.cm-header)` sidesteps the specificity fight entirely
  // instead of trying to win it: every heading spec above shares that one
  // common class, so this selector simply doesn't match a heading-wrapped
  // bracket at all, leaving `.cm-header-N`'s own font-size rule as the only
  // one in effect there — untouched, no ordering/specificity trick needed.
  '.cm-wiki-link-raw .cm-md-mark:not(.cm-header), .cm-plain-brackets .cm-md-mark:not(.cm-header)': {
    fontSize: 'inherit',
  },
  '.cm-md-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // ==highlighted text== — matches Obsidian's own default highlight look.
  '.cm-highlight': {
    backgroundColor: 'var(--text-highlight-bg, rgba(255, 208, 0, 0.4))',
    color: 'var(--text-highlight-fg, inherit)',
    borderRadius: '2px',
    padding: '0 1px',
  },
  // Highlightr-style `<mark style="background-color:...">`/`<mark class="hltr-...">`
  // — the actual color always comes from the document's own inline style (set
  // by applyHighlight) or, in CSS-class mode, from a `.hltr-<name>` rule this
  // codebase doesn't generate (matching the reference plugin's own "use CSS
  // classes" mode, which expects the *user* to supply that CSS via a snippet);
  // this base class only carries the shape, not any color of its own.
  '.cm-html-highlight': { borderRadius: '2px', padding: '0 1px' },
  '.cm-table-menu-swatch': {
    display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%',
    marginRight: '7px', verticalAlign: 'middle',
    border: '1px solid rgba(128,128,128,0.4)',
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
  // Marker color: real Obsidian themes drive this via --list-marker-color
  // (falling back to the theme's own accent color, then a plain muted gray)
  // — reported against a reference Obsidian screenshot showing ordered-list
  // numbers in a distinct, non-body-text color, which neither .cm-list-bullet
  // nor .cm-list-marker-raw (below) ever set before this: an inactive bullet
  // (BulletWidget) got a flat --text-muted, and an ordered marker / active
  // bullet (.cm-list-marker-raw) got no color rule at all, silently
  // inheriting plain body text color instead of reading as a marker.
  '.cm-list-bullet': {
    display: 'inline-block', width: `${LIST_BULLET_MARKER_WIDTH_EM}em`,
    color: 'var(--list-marker-color, var(--text-accent, var(--text-muted, inherit)))',
  },
  // Raw (unrendered) list marker text — an active-line bullet ("- "/"* "/"+ ")
  // or any ordered marker ("1. ", "10. ", ...), neither of which ever becomes
  // a fixed-width BulletWidget (bullets: only while inactive; ordered:
  // never). The actual width is set per-instance as an inline style (see the
  // ListMark handling in livePreviewPlugin) — bullet vs. ordered reserve
  // different widths, so this class-level width is just a fallback.
  '.cm-list-marker-raw': {
    display: 'inline-block', width: `${LIST_BULLET_MARKER_WIDTH_EM}em`,
    color: 'var(--list-marker-color, var(--text-accent, var(--text-muted, inherit)))',
  },
  '.cm-hr': {
    border: 'none',
    borderTop: '2px solid var(--hr-color, var(--background-modifier-border, rgba(128,128,128,0.3)))',
    margin: '1.5em 0',
  },
  // YAML frontmatter "Properties" panel (PropertiesWidget). PropertiesWidget
  // only ever renders on line 1 (parseFrontmatter requires it), so this
  // negative top margin — pulling it up into `.cm-content`'s own 16px top
  // padding — is always safe/correctly scoped without any extra "is this
  // actually the first block" check: there's nothing above it to collide
  // with when it exists at all.
  '.cm-properties': {
    display: 'block',
    margin: '-8px 0 18px',
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
  // alignment from the rule above.
  // `!important` on every property here for the same reason `.cm-code-block`
  // above needs it: an Obsidian vault theme's own CSS (`obsidianLike.obsidianTheme`)
  // loads *after* this, into a later <style> tag (see the theme-css postMessage
  // comment there), and a real-world theme ("Border") was reported to make every
  // one of these icons (in-progress, delegated, done, cancelled — i.e. every
  // status *except* the plain unchecked checkbox, which isn't this rule at all)
  // invisible. Border wasn't inspected directly (its CSS lives in the user's own
  // vault, not this repo), but this is the exact same class of bug already fixed
  // for `.cm-code-block`/`.cm-table-row-hidden`/etc. below: a theme commonly
  // resets generic inline/list-content styling (`display`, `font-size`, `color`)
  // site-wide, and normal CSS specificity doesn't help against a theme rule using
  // its own `!important` — only out-`!important`-ing it reliably wins regardless
  // of what a given theme's selector happens to be.
  // `width`/`height`/`font-size` deliberately use `calc(var(--md-font-size) * N)`
  // instead of a plain `Nem`: `em` on `font-size` is relative to the *parent's*
  // computed font-size, and a theme resetting font-size broadly on generic inline
  // elements (a bare `span` selector, say) would zero out this icon's own
  // `!important`-but-still-relative value right along with it — confirmed with a
  // synthetic worst-case theme in headless Chrome (a `span { font-size: 0
  // !important }` rule reduced this icon to `0px` even with the em value itself
  // marked `!important`, since `!important` only protects *which* declaration
  // wins, not what a relative unit resolves against). `--md-font-size` is a CSS
  // custom property set once on `document.documentElement` (`root.style.setProperty`
  // near this file's init code) — custom properties aren't reset by any `font-size`
  // declaration, however broad, so this stays correct regardless of what a theme
  // does to actual font-size values on ancestor elements.
  //
  // `fontSize` used to be `* 0.7` (shrunk, on the theory that a color-emoji glyph
  // renders larger than a checkbox's own box at the same font-size, so shrinking it
  // would make it fit), combined with `overflow: 'hidden'` to clip whatever still
  // didn't fit. That backfired: a color emoji's *visual* glyph is taller than its
  // nominal font-size box regardless of how small that font-size is (this is normal
  // color-emoji-font behavior, not something scoped to this codebase), so shrinking
  // the font-size never actually stopped the clip from cutting into it — it just
  // shrank the box these icons compete for, making the clip worse. Reported as "los
  // iconos de estado se ven cortados para cualquier estado que no sea To do"
  // (screenshot showed only a corner of the glyph surviving). Fixed by matching the
  // font-size multiplier to the box's own (`* 1`, not `* 0.7`) and dropping
  // `overflow: hidden` — the glyph is now fully visible, at the cost of occasionally
  // overflowing the box's edges slightly rather than a guaranteed-but-broken exact fit.
  '.cm-task-status-icon': {
    display: 'inline-flex !important',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'calc(var(--md-font-size, 14px) * 1) !important',
    height: 'calc(var(--md-font-size, 14px) * 1) !important',
    fontSize: 'calc(var(--md-font-size, 14px) * 1) !important',
    lineHeight: '1 !important',
    color: 'initial !important',
    opacity: '1 !important',
    visibility: 'visible !important',
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
  // One id inside a `.cm-tasks-query-depends` chip that resolved to a real task (see
  // `attachDependencyHoverPreview` below) — dotted underline is the only visual hint it's
  // hoverable, since it isn't otherwise clickable/navigable like a wikilink.
  '.cm-tasks-query-depends-ref': {
    borderBottom: '1px dotted currentColor',
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
    // Holds the sortable label + filter button side by side (see enhanceDataviewTable above);
    // overriding a <th>'s default table-cell display like this is fine in the Chromium engine
    // VS Code webviews run on.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '4px',
  },
  '.cm-dataview-query .dv-th-label': {
    cursor: 'pointer',
    userSelect: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-dataview-query .dv-th-label:hover': {
    opacity: '0.8',
  },
  '.cm-dataview-query .dv-th-sort-indicator': {
    fontSize: '0.85em',
    opacity: '0.8',
  },
  '.cm-dataview-query .dv-th-filter': {
    flex: '0 0 auto',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: '0.45',
    fontSize: '0.85em',
    padding: '0 2px',
    lineHeight: '1',
  },
  '.cm-dataview-query .dv-th-filter:hover, .cm-dataview-query .dv-th-filter.dv-th-filter-active': {
    opacity: '1',
  },
  '.cm-dataview-query .dv-th-filter.dv-th-filter-active': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4a9eff)))',
  },
  // The filter popover is appended to document.body (so it can float above the editor), not
  // under `.cm-dataview-query` — these rules can't be scoped under that ancestor selector.
  //
  // NOTE (found while fixing the dependency-hover popup below, not otherwise addressed here):
  // `EditorView.theme()` (which builds `vsTheme`) compiles every selector that doesn't start
  // with `&` into `.<generated-editor-class> <selector>` (see `buildTheme`/`finish` in
  // @codemirror/view) — a *descendant* combinator, requiring the generated class on an ancestor.
  // That generated class only ever lands on `view.dom` (`.cm-editor` itself, see
  // `hoverPreviewPlugin` above, which correctly appends its own popup there instead of to
  // `document.body`). An element appended straight to `document.body`, as this one is, is a
  // *sibling* of `.cm-editor`, not a descendant of it — so none of the rules below actually
  // match it. In practice this popover likely renders with none of this styling (no
  // `position: fixed`, no background/border/z-index — a plain block flowing wherever it lands
  // in `<body>`), same failure mode diagnosed for `.cm-dep-hover-preview` near `renderTaskRow`,
  // which now sets its styles inline instead of relying on this object for exactly this reason.
  '.dv-filter-popover': {
    position: 'fixed',
    zIndex: '1000',
    minWidth: '180px',
    maxWidth: '320px',
    maxHeight: '60vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--vscode-editorWidget-background, var(--background-secondary, #252526))',
    color: 'var(--vscode-editorWidget-foreground, inherit)',
    border: '1px solid var(--vscode-editorWidget-border, var(--background-modifier-border, rgba(128,128,128,0.4)))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    padding: '6px',
    fontSize: '0.9em',
  },
  '.dv-filter-popover input[type="text"]': {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    fontSize: '0.95em',
    padding: '4px 6px',
    margin: '0 0 6px',
    background: 'var(--background-modifier-form-field, var(--background-secondary))',
    color: 'inherit',
    border: '1px solid var(--background-modifier-border, transparent)',
    borderRadius: '4px',
  },
  '.dv-filter-list': {
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    borderTop: '1px solid var(--background-modifier-border, rgba(128,128,128,0.25))',
    padding: '4px 0',
  },
  '.dv-filter-option': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 4px',
    borderRadius: '3px',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.dv-filter-option:hover': {
    background: 'var(--background-modifier-hover, rgba(128,128,128,0.15))',
  },
  '.dv-filter-select-all': {
    fontWeight: '600',
  },
  '.dv-filter-footer': {
    borderTop: '1px solid var(--background-modifier-border, rgba(128,128,128,0.25))',
    marginTop: '4px',
    paddingTop: '6px',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  '.dv-filter-footer button': {
    font: 'inherit',
    fontSize: '0.9em',
    padding: '3px 10px',
    cursor: 'pointer',
    background: 'var(--vscode-button-secondaryBackground, transparent)',
    color: 'var(--vscode-button-secondaryForeground, inherit)',
    border: '1px solid var(--background-modifier-border, rgba(128,128,128,0.4))',
    borderRadius: '4px',
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
  // ![[file.docx/.xlsx/.pdf]] embed (ExternalFileWidget) — a compact,
  // clickable box naming the file, opening it with the OS's default
  // application on click rather than trying to render it inline.
  '.cm-external-file': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)))',
    borderRadius: '6px',
    background: 'var(--table-row-alt-background, rgba(128,128,128,0.04))',
    padding: '6px 12px',
    margin: '4px 0 10px',
    cursor: 'pointer',
  },
  '.cm-external-file:hover': {
    background: 'var(--vscode-list-hoverBackground, rgba(128,128,128,0.14))',
  },
  '.cm-external-file-icon': { fontSize: '1.1em' },
  '.cm-external-file-name': {
    textDecoration: 'underline',
    color: 'var(--link-color, var(--vscode-textLink-foreground, #4a9eff))',
  },
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
  // Table context menu (TableMenuView / tableContextMenuHandler) — a plain
  // floating DOM element appended to `.cm-editor`, same positioning
  // convention as `.cm-wikilink-suggest`/`.cm-hover-preview` above, just
  // anchored at the right-click point instead of a text/link position.
  '.cm-table-menu': {
    position: 'absolute',
    zIndex: '70',
    minWidth: '190px',
    background: 'var(--vscode-editorWidget-background, #252526)',
    color: 'var(--vscode-editorWidget-foreground, inherit)',
    border: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35))',
    borderRadius: '6px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
    fontSize: '0.92em',
    padding: '4px 0',
  },
  '.cm-table-menu-item': {
    padding: '6px 14px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  '.cm-table-menu-item:hover': {
    background: 'var(--vscode-list-hoverBackground, rgba(128,128,128,0.18))',
  },
  '.cm-table-menu-item.is-disabled': {
    opacity: '0.45',
    cursor: 'default',
  },
  '.cm-table-menu-item.is-disabled:hover': { background: 'transparent' },
  '.cm-table-menu-sep': {
    height: '1px',
    margin: '4px 0',
    background: 'var(--vscode-editorWidget-border, rgba(128,128,128,0.25))',
  },
  // A menu item that opens a nested flyout (e.g. "Highlights") instead of
  // running an action directly — the caret sits at the row's own right edge.
  '.cm-table-menu-item.has-submenu': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  '.cm-table-menu-caret': {
    marginLeft: '14px',
    opacity: '0.6',
    fontSize: '0.85em',
  },
  // The nested flyout itself is just another `.cm-table-menu`, positioned by
  // `TableMenuView._openSubmenu` relative to the row that opened it.
  '.cm-table-menu-submenu': {
    zIndex: '71',
  },
  // Multi-cell range selection (drag or Shift-click across table cells) — see
  // applyTableSelectionHighlight/wireCell's own mousedown handling in TableWidget.
  '.cm-table-cell-selected': {
    backgroundColor: 'var(--text-selection, rgba(70,130,220,0.25)) !important',
    outline: '1px solid var(--interactive-accent, rgba(70,130,220,0.7))',
    outlineOffset: '-1px',
  },
  // Find/replace panel (ObsidianSearchPanel, @codemirror/search's own
  // createPanel hook). `.cm-panels`/`.cm-panels-top` are CM6's own generic
  // panel-row container (@codemirror/view's base theme gives it a full-width
  // opaque background + border, meant for a panel that fills that bar) —
  // neutralized here since this panel manages its own floating-card chrome
  // instead and would otherwise sit inside a visible, empty colored strip at
  // the top of the editor. `position: sticky` (already the default) is left
  // alone: with `search({ top: true })`, that's what keeps this container —
  // and this panel's own `position: absolute` anchored inside it — pinned to
  // the top of the *viewport* as the user scrolls, rather than wherever the
  // top of the document happens to be.
  '.cm-panels, .cm-panels-top, .cm-panels-bottom': {
    background: 'transparent !important',
    borderTop: 'none !important',
    borderBottom: 'none !important',
  },
  '.cm-obsidian-search': {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: '80',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    background: 'var(--vscode-editorWidget-background, #252526)',
    color: 'var(--vscode-editorWidget-foreground, inherit)',
    border: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35))',
    borderRadius: '8px',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
    padding: '6px 8px',
    fontSize: '0.92em',
  },
  '.cm-obsidian-search-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  '.cm-obsidian-search-replace-row[hidden]': { display: 'none' },
  '.cm-obsidian-search-field-wrap': {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    border: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35))',
    borderRadius: '4px',
    padding: '0 4px',
    background: 'var(--vscode-input-background, transparent)',
  },
  '.cm-obsidian-search-input': {
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    padding: '4px 4px',
    width: '160px',
  },
  '.cm-obsidian-search-flags': { display: 'flex', gap: '2px' },
  '.cm-obsidian-search-spacer': { width: '24px', flex: 'none' },
  '.cm-obsidian-search-count': {
    fontSize: '0.85em',
    opacity: '0.65',
    whiteSpace: 'nowrap',
    minWidth: '3em',
    textAlign: 'right',
  },
  '.cm-obsidian-search-icon-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '22px',
    height: '22px',
    padding: '0 4px',
    border: 'none',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '0.95em',
    lineHeight: '1',
  },
  '.cm-obsidian-search-icon-btn:hover': {
    background: 'var(--vscode-list-hoverBackground, rgba(128,128,128,0.18))',
  },
  '.cm-obsidian-search-flag-btn.is-active': {
    background: 'var(--vscode-inputOption-activeBackground, rgba(90,150,255,0.35))',
    color: 'var(--vscode-inputOption-activeForeground, inherit)',
  },
  '.cm-obsidian-search-flag-btn.is-disabled': {
    opacity: '0.4',
    cursor: 'default',
  },
  '.cm-obsidian-search-chevron': {
    fontSize: '0.75em',
    opacity: '0.75',
  },
  // Standalone inline code (`text`) — plain colored monospace text, no chip
  // background/padding/border-radius. Reported against a real Obsidian
  // screenshot (`telemetría` rendered inline in a sentence): the vault's own
  // Live Preview shows inline code as just accent-colored monospace text
  // flowing with the surrounding sentence, not a pill/chip — this used to add
  // a background+padding+radius "chip" look that doesn't match that reference
  // at all. Font/size stay theme-configurable exactly as before; only the
  // box-styling properties were removed.
  '.cm-inline-code': {
    // --code-font is the user-configurable `obsidianLike.codeFont` setting (empty
    // by default, falling through to the Obsidian theme's --font-monospace var,
    // then VS Code's editor font, then a generic monospace).
    fontFamily: 'var(--code-font, var(--font-monospace, var(--vscode-editor-font-family, monospace)))',
    // --code-font-size is the user-configurable `obsidianLike.codeFontSize` setting
    // (default 14px) — an absolute size, unlike the surrounding text's em-relative sizing.
    fontSize: 'var(--code-font-size, 14px)',
    // --code-normal is the Obsidian-theme-driven color; the fallback chain ends
    // on VS Code's own preformatted-text color rather than `inherit`, since
    // `inherit` renders indistinguishably from plain body text when no theme
    // defines --code-normal — the whole point of this rule is a visible accent.
    color: 'var(--code-normal, var(--text-accent, var(--vscode-textPreformat-foreground, #c586c0)))',
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
  // Restyled to match Obsidian's own default code-block look (light, airy card
  // with generous padding) rather than the flat solid-gray box this used to
  // be — reported as looking wrong compared to a real Obsidian screenshot.
  // `--code-background` (theme-overridable) is the base color.
  //
  // An earlier version also layered a faint radial-gradient dot-grid texture
  // on top, trying to match the paper-like grain visible in that reference
  // screenshot — removed after a follow-up report ("¿por qué el fondo... tiene
  // puntos? Quítalos") that it just read as visual noise rather than a subtle
  // texture worth keeping. A plain flat background is a safer default anyway:
  // each content line is its own separate `.cm-line` element (not one shared
  // container for the whole block), so a repeating background pattern is
  // never pixel-perfectly continuous across a multi-line block the way a
  // single real `<pre>` element's texture would be in Obsidian itself — fine
  // at a glance, but not something worth the complexity once it wasn't wanted.
  '.cm-code-block': {
    fontFamily: 'var(--code-font, var(--font-monospace, var(--vscode-editor-font-family, monospace)))',
    fontSize: 'var(--code-font-size, 14px)',
    background: 'var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.05))) !important',
    color: 'var(--code-normal, inherit)',
    borderLeft: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.18))) !important',
    borderRight: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.18))) !important',
    padding: '0 18px !important',
  },
  // The ```/``` fence lines themselves: collapsed to zero height (not just
  // text-hidden) when not the active line, so — matching Obsidian — they don't
  // leave behind an empty, padded line above/below the block. Same technique as
  // .cm-table-row-hidden/.cm-fold-hidden — full zeroing rule lives at the end
  // of this stylesheet, see the comment there (also explains why: this class
  // and .cm-code-block-first/-last below, which sets non-zero margin/border/
  // padding with !important of its own, can end up on the very same line).
  '.cm-code-block-first': {
    borderTop: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.18))) !important',
    borderRadius: '10px 10px 0 0 !important',
    paddingTop: '12px !important', marginTop: '8px !important',
  },
  '.cm-code-block-last': {
    borderBottom: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.18))) !important',
    borderRadius: '0 0 10px 10px !important',
    paddingBottom: '12px !important', marginBottom: '14px !important',
  },
  '.cm-code-block-solo': {
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.18))) !important',
    borderRadius: '10px !important',
    paddingTop: '12px !important', paddingBottom: '12px !important', marginTop: '8px !important', marginBottom: '14px !important',
  },
  // Cancels the standalone inline-code chip look for CodeText found inside a
  // fenced block's own box (see the comment on .cm-inline-code / mdHighlight above).
  '.cm-code-block .cm-inline-code': { background: 'none !important', padding: '0 !important', borderRadius: '0 !important' },
  // Same cancellation, for a fenced block's *raw* (active/being-edited) content
  // lines instead of its rendered/collapsed box — see the long comment where
  // `cm-raw-code-line` is pushed, in livePreviewPlugin's FencedCode handling,
  // for why this needs its own separate rule rather than reusing
  // `.cm-code-block` itself (that class also carries the collapsed box's own
  // background/border/padding, which raw mode must not get).
  '.cm-raw-code-line .cm-inline-code': { background: 'none !important', padding: '0 !important', borderRadius: '0 !important' },
  // Blockquotes (`> text`) — a full-width card: tinted background (with a
  // subtle dot-grid texture, matching a real Obsidian screenshot reference),
  // a colored left bar, and rounded corners on the block's outer edges.
  // Reported against that screenshot: this editor previously only drew a bare
  // 3px left border with muted text and no background at all (the old
  // tags.quote mark spec, now stripped down to just the text color — see
  // mdHighlight above). Every line in the block gets `.cm-blockquote-line`
  // unconditionally (even the active/cursor line — mirrors `.HyperMD-header`,
  // which keeps its own line class while editing too); only the raw "> "
  // marker itself (QuoteMark) hides/reveals per active line, same as
  // HeaderMark. `!important` throughout for the same reason `.cm-code-block`
  // needs it: a later-loading Obsidian theme's own generic line/blockquote
  // CSS can otherwise win the cascade regardless of this rule's specificity.
  // Note this dot texture is a deliberate, distinct choice from the identical
  // pattern tried (and reverted, 3 times) for `.cm-code-block` — that one was
  // rejected as "se ve fatal" for *code*; this is a different element with
  // its own reference screenshot explicitly showing the texture, not a
  // reintroduction of the rejected code-block look.
  '.cm-blockquote-line': {
    background: 'var(--blockquote-background-color, var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06))) !important',
    backgroundImage: 'radial-gradient(circle, rgba(128,128,128,0.14) 1px, transparent 1px) !important',
    backgroundSize: '11px 11px !important',
    borderLeft: '4px solid var(--blockquote-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.5))) !important',
    paddingLeft: '14px !important',
    paddingRight: '10px !important',
  },
  '.cm-blockquote-line-first': {
    borderRadius: '6px 6px 0 0 !important',
    paddingTop: '6px !important',
    marginTop: '4px !important',
  },
  '.cm-blockquote-line-last': {
    borderRadius: '0 0 6px 6px !important',
    paddingBottom: '6px !important',
    marginBottom: '8px !important',
  },
  '.cm-blockquote-line-solo': {
    borderRadius: '6px !important',
    paddingTop: '6px !important', paddingBottom: '6px !important',
    marginTop: '4px !important', marginBottom: '8px !important',
  },
  // ── Callouts (Obsidian `> [!type]`) — a colored card, keyed off
  // `--callout-color` (an "r, g, b" token triple) set per-line inline in
  // livePreviewPlugin's callout pass, so one shared class works for every
  // type instead of one hardcoded class per type. `!important` throughout
  // for the same reason `.cm-blockquote-line`/`.cm-code-block` need it — a
  // later-loading Obsidian theme's own generic line/blockquote CSS can
  // otherwise win the cascade regardless of specificity.
  '.cm-callout-line': {
    background: 'rgba(var(--callout-color, 158, 158, 158), 0.1) !important',
    borderLeft: '4px solid rgb(var(--callout-color, 158, 158, 158)) !important',
    paddingLeft: '14px !important',
    paddingRight: '10px !important',
    boxShadow: 'var(--callout-nest-shadow, none) !important',
  },
  '.cm-callout-line-first': { borderRadius: '6px 6px 0 0 !important', paddingTop: '8px !important', marginTop: '4px !important' },
  '.cm-callout-line-last': { borderRadius: '0 0 6px 6px !important', paddingBottom: '8px !important', marginBottom: '8px !important' },
  '.cm-callout-line-solo': {
    borderRadius: '6px !important',
    paddingTop: '8px !important', paddingBottom: '8px !important',
    marginTop: '4px !important', marginBottom: '8px !important',
  },
  // This span is the widget's own root DOM, sitting inline in the text flow
  // (before the real title text, when there's a custom title — see
  // CalloutHeaderWidget). With no vertical-align set, an inline-flex box
  // defaults to baseline alignment — and since neither it nor its icon child
  // has a real text baseline, the browser synthesizes one from the box's own
  // bottom edge, which plants the icon's bottom at the surrounding text's
  // baseline and lets the rest of its ~18px height stick up well above the
  // ~14px text's cap-height. Reported directly against a screenshot showing
  // the icon floating noticeably above the title text. `middle` aligns the
  // box's own vertical center with a point ~half an x-height above the
  // baseline instead — the standard fix for an inline icon next to text.
  '.cm-callout-header-inline': {
    display: 'inline-flex', alignItems: 'center', fontWeight: '600', verticalAlign: 'middle',
  },
  // margin-right (not a flex `gap` on the parent) so the spacing is correct
  // whether the title renders *inside* this same widget (no custom title —
  // gap would work there) or as separate real document text *after* the
  // widget (a custom title — gap can't reach across that boundary at all,
  // since gap only spaces a flex container's own children).
  '.cm-callout-icon': { display: 'inline-flex', width: '18px', height: '18px', flex: '0 0 auto', marginRight: '6px' },
  '.cm-callout-icon-svg': { width: '100%', height: '100%' },
  '.cm-callout-title': { fontWeight: '600' },
  '.cm-callout-fold': {
    display: 'inline-flex', width: '15px', height: '15px', marginLeft: '6px',
    verticalAlign: 'middle', cursor: 'pointer',
    transition: 'transform 0.1s ease', transform: 'rotate(90deg)',
  },
  '.cm-callout-fold.is-collapsed': { transform: 'rotate(0deg)' },
  '.cm-callout-fold svg': { width: '100%', height: '100%' },
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
  // Only the text color lives here — the border/background/padding "card" look
  // is now a block-wide line class (`.cm-blockquote-line` etc., in vsTheme),
  // built in livePreviewPlugin's own Blockquote handling, not this per-character
  // mark (which — like tags.monospace for fenced code — can't span a multi-line
  // block as one element, so it used to render as a stack of disconnected
  // left-border fragments instead of one cohesive box).
  { tag: tags.quote,
    color: 'var(--blockquote-color, var(--text-muted, inherit))' },
  // class-only (see the heading entries above for why): needs a stable name so
  // vsTheme's own `.cm-md-mark` rule can be selectively overridden for the
  // [[wiki-link]]/bare-bracket case below — see that rule's own comment.
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
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

// Matches a closed "[[target]]" or "[[target|alias]]" wiki-link, allowing the
// target/alias text to itself contain ONE level of nested "[[...]]" — needed
// because a heading's own raw text can legitimately contain a wiki-link
// (e.g. "# Ver [[Pepe]]"), and a "note#section" reference to that heading
// (`![[note#Ver [[Pepe]]]]`) then has a nested "[[Pepe]]" sitting inside the
// outer target that must not be mistaken for the outer link's own closing
// "]]". A plain `[^\]]+`-style char class (the original pattern here) always
// stops at the *first* `]` it sees, which is the inner link's closing bracket
// — truncating the captured target/section and leaving the real outer "]]"
// as unmatched, dangling literal text.
//
// The alternation is `(?:(?!\[\[)[^\]|]|\[\[[^\[\]]*\]\])`: at each position,
// either consume one character that is not "]"/"|" and not the start of a
// literal "[[" run, OR — if a literal "[[" *does* start here — consume an
// entire simple (non-nested-again) "[[...]]" chunk as one atomic unit. The
// `(?!\[\[)` guard is what keeps a *lone*, unpaired "[" (e.g. a heading like
// "# Tareas [urgente]") matching as plain text instead of being swallowed by
// the nested-chunk branch and failing to close — only a genuine doubled "[["
// is treated as the start of a nested link. Only one level of nesting is
// handled (a link inside a link inside a link is not a realistic case here);
// the alias group's own alternation intentionally omits the "|" exclusion
// nested-chunk-internally since an inner link's own "|alias" isn't meant to
// interact with the outer link's alias splitting.
// String source (not a RegExp literal) because every call site below needs
// its own regex instance — `.exec()`-driven loops elsewhere in this file
// already rely on independent `lastIndex` state per scan (see
// findLinkContextAt's own "fresh copy... to avoid any lastIndex
// state-sharing bug" comment) — sharing one `RegExp` object with the `g`
// flag across unrelated loops would reintroduce exactly that bug.
const WIKI_LINK_RE_SRC =
  '(?<!!)\\[\\[((?:(?!\\[\\[)[^\\]|]|\\[\\[[^\\[\\]]*\\]\\])+?)' +
  '(?:\\|((?:(?!\\[\\[)[^\\]]|\\[\\[[^\\[\\]]*\\]\\])*?))?\\]\\]';

// Same nested-bracket reasoning as WIKI_LINK_RE_SRC above, for "![[target]]"
// (images and transclusions — imgPlugin/transclusionPlugin below). Unlike
// the plain-link pattern, "|" is deliberately left *inside* the single
// capture group here (both plugins split on the first "|" themselves,
// downstream, to separate a filename from an image width/caption param, or
// a transclusion target from... nothing currently, but the split logic is
// shared) rather than being excluded/captured separately by the regex.
const EMBED_RE_SRC = '!\\[\\[((?:(?!\\[\\[)[^\\]]|\\[\\[[^\\[\\]]*\\]\\])+)\\]\\]';

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
  // A literal "<br>" (also "<br/>"/"<br />", case-insensitive) is the standard way to force a
  // line break inside a markdown table cell, whose own raw syntax can't contain a real newline
  // without breaking the row — restored to a real line break *after* escaping (so it survives as
  // an actual <br> element) rather than showing as literal, escaped "&lt;br&gt;" text. Only this
  // one specific tag shape is let through; every other "<...>" in the raw text stays escaped/inert.
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  // Highlightr-style `<mark>` highlights (see htmlHighlightPlugin's own comment
  // for the full picture) — same "restore after escaping" trick as <br> above,
  // so a highlight typed into a task's description/table cell/transcluded
  // paragraph renders as a real highlighted span here too, not literal escaped
  // tag text. `&quot;` in the pattern matches the escaped `"` from the initial
  // HTML-escape above.
  s = s.replace(/&lt;mark style=&quot;background-color:\s*([^;&]+);?&quot;&gt;([^\n]*?)&lt;\/mark&gt;/gi,
    (_, color, inner) => `<mark class="cm-html-highlight" style="background-color:${color};">${inner}</mark>`);
  s = s.replace(/&lt;mark class=&quot;(hltr-[\w-]+)&quot;&gt;([^\n]*?)&lt;\/mark&gt;/gi,
    (_, cls, inner) => `<mark class="cm-html-highlight ${cls}">${inner}</mark>`);
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
  s = s.replace(/==([^=\n]+?)==/g, '<mark class="cm-highlight">$1</mark>');
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
  // Wiki-links [[target]] or [[target|alias]] — nested-bracket-aware, see
  // WIKI_LINK_RE_SRC's own comment above for why (a "#section" naming a
  // heading that itself contains a "[[link]]" is a valid, real target).
  const baseAttr = basePath ? ` data-wiki-base="${String(basePath).replace(/"/g, '&quot;')}"` : '';
  s = s.replace(new RegExp(WIKI_LINK_RE_SRC, 'g'), (_, tgt, alias) =>
    `<span data-wiki="${tgt}"${baseAttr} style="color:var(--link-color,var(--vscode-textLink-foreground,#4a9eff));` +
    `text-decoration:underline;cursor:pointer;">${alias || tgt}</span>`
  );
  // Restore inline code
  s = s.replace(/\x00C(\d+)\x00/g, (_, i) =>
    `<code style="font-family:monospace;background:rgba(128,128,128,0.18);padding:1px 4px;border-radius:3px;">${codes[+i]}</code>`
  );
  return s;
}

// ── Table parsing/serialization ─────────────────────────────────────────────
// Shared by TableWidget's own rendering and the table-editing context menu
// below (tableContextMenuHandler/mutateTableAt) — factored out rather than
// duplicated so a row/column edit and a fresh render always agree on exactly
// what a "cell" is.
function parseTableRow(line) {
  // A literal "\|" is an escaped pipe — the author's way of putting a real "|" character inside
  // a cell without it being read as a column separator — so it's protected from the split below.
  // Unlike an earlier version of this fix, the escape itself is *not* kept in the resulting cell
  // text (restored to a plain "|" instead of "\|") — the backslash is a serialization detail of
  // the raw markdown file, not something a WYSIWYG cell should ever show while editing or
  // rendering; reported directly ("tiene que verse un | sin el caracter de escape"). The
  // *content* model (this function's return value, and everywhere else in this file that reads
  // t.header/t.rows) always holds the clean character; serializeTableRow re-escapes it on the
  // way back out, so the round trip through the actual .md file stays valid regardless. Every
  // *real* separator needs at least one whitespace character on each side, mirroring what
  // serializeTableRow itself always writes ("| " between cells, " |" at the very end) — so a
  // bare, unescaped "|" glued directly onto surrounding text (not meant as a delimiter at all)
  // isn't mistaken for one.
  const ESCAPED_PIPE = '\x00ESCPIPE\x00';
  let s = line.replace(/\\\|/g, ESCAPED_PIPE);
  s = s.replace(/^\s*\|/, '');
  s = s.replace(/\s\|\s*$/, '');
  return s.split(/\s\|\s/).map(c => c.trim().split(ESCAPED_PIPE).join('|'));
}

// { header: string[], delim: string[], rows: string[][] } from a table's raw
// multi-line source text, or null if it doesn't look like a table (fewer
// than 2 pipe-containing lines — no header/delimiter row pair).
function parseTableSrc(src) {
  const lines = (src || '').split('\n').filter(l => l.trim() && l.includes('|'));
  if (lines.length < 2) return null;
  return { header: parseTableRow(lines[0]), delim: parseTableRow(lines[1]), rows: lines.slice(2).map(parseTableRow) };
}

function serializeTableRow(cells) {
  // Inverse of parseTableRow's own unescaping: a literal "|" in a cell's *content* (the clean
  // character the WYSIWYG view/edit always shows) must round-trip back out as "\|", or it would
  // either get misread as a real column separator on the next parse (if it happens to land with
  // whitespace on both sides) or, at best, silently change what founds a "real" separator.
  return '| ' + cells.map(c => (c || '').trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
}

function serializeTable(t) {
  return [t.header, t.delim, ...t.rows].map(serializeTableRow).join('\n');
}

function tableAligns(t) {
  return t.delim.map(s => {
    const v = s.trim();
    if (v.startsWith(':') && v.endsWith(':')) return 'center';
    if (v.endsWith(':')) return 'right';
    return 'left';
  });
}

// Row/column mutators — plain in-place edits on the parsed { header, delim,
// rows } shape, applied by mutateTableAt below. `rowIndex`/`colIndex` here
// always refer to *data* rows (excluding the header) and 0-based columns.
function insertTableRow(t, rowIndex) {
  t.rows.splice(rowIndex, 0, new Array(t.header.length).fill(''));
}
function deleteTableRow(t, rowIndex) {
  if (rowIndex >= 0 && rowIndex < t.rows.length) t.rows.splice(rowIndex, 1);
}
function insertTableColumn(t, colIndex) {
  t.header.splice(colIndex, 0, `Columna ${t.header.length + 1}`);
  t.delim.splice(colIndex, 0, '---');
  for (const row of t.rows) row.splice(colIndex, 0, '');
}
function deleteTableColumn(t, colIndex) {
  if (t.header.length <= 1) return; // never delete the last remaining column
  t.header.splice(colIndex, 1);
  t.delim.splice(colIndex, 1);
  for (const row of t.rows) row.splice(colIndex, 1);
}
// Plural variants backing the table context menu's "Eliminar filas"/"Eliminar
// columnas" items, shown instead of the singular ones when a right-click lands
// inside a multi-row/-column cell selection (see tableContextMenuHandler).
// Descending sort so each splice() doesn't shift the position of an
// index still waiting to be removed later in the same pass.
function deleteTableRows(t, rowIndices) {
  const sorted = [...new Set(rowIndices)].filter(i => i >= 0 && i < t.rows.length).sort((a, b) => b - a);
  for (const idx of sorted) t.rows.splice(idx, 1);
}
function deleteTableColumns(t, colIndices) {
  const sorted = [...new Set(colIndices)].filter(i => i >= 0 && i < t.header.length).sort((a, b) => b - a);
  for (const idx of sorted) {
    if (t.header.length <= 1) break; // never delete the last remaining column
    t.header.splice(idx, 1);
    t.delim.splice(idx, 1);
    for (const row of t.rows) row.splice(idx, 1);
  }
}

// A table cell is directly `contentEditable` — typing into it commits straight back to the
// document (via `mutateTableAt`, same helper the row/column context-menu actions already use),
// instead of the table ever falling back to raw `| pipe | source |` text the way it used to
// whenever the cursor landed on one of its lines.
//
// A table cell shows *rendered* inline formatting (bold/italic/strikethrough/inline-code) while
// not focused, and swaps to the raw markdown text for editing on focus (see wireCell's own
// focus/blur listeners below) — same "raw while active, rendered otherwise" convention used
// everywhere else in this file (headings, wiki-links, ...), just applied per-cell instead of
// per-line. Deliberately a separate, narrower function from renderCell rather than reusing it
// outright: renderCell also renders wiki-links/#tags/bare-URLs as blue, clickable-*looking* spans,
// but a cell's own `mousedown` listener (wireCell, below) calls `e.stopPropagation()` so a click
// never bubbles up to `linkClickHandler`'s own `[data-wiki]`/`.cm-md-link` handling — rendering
// those here would look interactive while doing nothing at all on click, which is worse than
// plain text. Bold/italic/strikethrough/code have no such click affordance to fake, so they're
// safe to render unconditionally.
function renderTableCellDisplay(raw) {
  let s = (raw || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // See renderCell's own identical line for why: "<br>" is the standard way to force a line
  // break inside a table cell's raw markdown (which can't contain a real newline), so it's
  // restored to a real <br> element after escaping instead of showing as literal text.
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\x00C${codes.length - 1}\x00`; });
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/==(.+?)==/g, '<mark class="cm-highlight">$1</mark>');
  s = s.replace(/\x00C(\d+)\x00/g, (_, i) =>
    `<code style="font-family:monospace;background:rgba(128,128,128,0.18);padding:1px 4px;border-radius:3px;">${codes[+i]}</code>`
  );
  return s;
}

function commitTableCell(view, tableFrom, isHeader, rowIndex, colIndex, value) {
  mutateTableAt(view, tableFrom + 1, t => {
    if (isHeader) { t.header[colIndex] = value; }
    else if (t.rows[rowIndex]) { t.rows[rowIndex][colIndex] = value; }
  });
}

// Finds the (possibly just-rebuilt, after a commit above triggered a redecoration) cell at
// (rowIndex, colIndex) within the table starting at `tableFrom`, and focuses it — used by
// Tab/Shift+Tab/Enter navigation, which must re-query the DOM after each commit rather than
// holding onto the cell element it started from, since that element's own table widget was just
// torn down and replaced (its `eq()` no longer matches once the underlying text changed).
function focusTableCell(view, tableFrom, isHeader, rowIndex, colIndex) {
  const tableEl = view.dom.querySelector(`table.cm-table[data-table-from="${tableFrom}"]`);
  if (!tableEl) return;
  const selector = isHeader ? `th[data-col="${colIndex}"]` : `td[data-col="${colIndex}"]`;
  const scope = isHeader ? tableEl.querySelector('thead') : tableEl.querySelector(`tbody tr[data-row="${rowIndex}"]`);
  const cell = scope && scope.querySelector(selector);
  if (cell) {
    cell.focus();
    // Place the caret at the end rather than leaving it at the browser's default (start) —
    // matches where you'd expect to land after tabbing/entering into a fresh cell.
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ── Multi-cell selection (spreadsheet-style range select/copy/paste) ─────────
// Each cell is its own independent `contentEditable` element (see the comment at the top of
// this section), which is great for single-cell editing but gives no built-in way to select a
// *rectangle* of cells the way a real spreadsheet does — dragging across contentEditable
// elements just produces an ordinary browser text selection spanning arbitrary characters
// across them, not a discrete set of whole cells. `tableCellSelection` (module-level — only one
// table can have an active range at a time, same reasoning as `activeLinkFrom` elsewhere in this
// file) tracks that range instead: `{ tableFrom, anchorRow, anchorCol, focusRow, focusCol }`,
// row `-1` meaning the header (mirrors the `-1` convention `wireCell`'s own `rowIndex` already
// uses for it). `dragState` tracks an in-progress mouse drag before it's known whether it's a
// genuine range drag or just a plain single-cell click (see wireCell's own mousedown handler).
let tableCellSelection = null;
let dragState = null;

// Applies (or clears, if there's no active selection for this table) the `.cm-table-cell-
// selected` class to every cell in `tableEl` — called after every change to `tableCellSelection`
// affecting this table, and once at the end of `toDOM()` so a selection survives the widget
// rebuild a commit/paste triggers (mutateTableAt always produces a *new* table element; the
// selection itself is module state that isn't torn down along with the old DOM).
function applyTableSelectionHighlight(tableEl) {
  const tableFrom = Number(tableEl.dataset.tableFrom);
  const sel = tableCellSelection && tableCellSelection.tableFrom === tableFrom ? tableCellSelection : null;
  const rMin = sel ? Math.min(sel.anchorRow, sel.focusRow) : null;
  const rMax = sel ? Math.max(sel.anchorRow, sel.focusRow) : null;
  const cMin = sel ? Math.min(sel.anchorCol, sel.focusCol) : null;
  const cMax = sel ? Math.max(sel.anchorCol, sel.focusCol) : null;
  tableEl.querySelectorAll('th[data-col], td[data-col]').forEach(cell => {
    const isHeader = cell.tagName === 'TH';
    const row = isHeader ? -1 : Number(cell.closest('tr').dataset.row);
    const col = Number(cell.dataset.col);
    const inRange = !!sel && row >= rMin && row <= rMax && col >= cMin && col <= cMax;
    cell.classList.toggle('cm-table-cell-selected', inRange);
  });
}

// A plain mousedown *inside* the table with an active selection is handled by wireCell's own
// listener (which decides whether to keep, replace, or extend the range) — this only needs to
// clear the selection when the user clicks *away* from it entirely: elsewhere in the document,
// a different table, or outside the editor altogether. Installed once, lazily, the same
// single-flight-guard pattern as `ensureDataviewNoticeContainer`/`dvPopoverOutsideHandlerInstalled`
// elsewhere in this file.
let tableSelectionOutsideHandlerInstalled = false;
function ensureTableSelectionOutsideHandler() {
  if (tableSelectionOutsideHandlerInstalled) return;
  tableSelectionOutsideHandlerInstalled = true;
  document.addEventListener('mousedown', e => {
    if (!tableCellSelection) return;
    const ownTable = e.target.closest && e.target.closest(`table.cm-table[data-table-from="${tableCellSelection.tableFrom}"]`);
    if (ownTable) return;
    const prevFrom = tableCellSelection.tableFrom;
    tableCellSelection = null;
    const staleTable = document.querySelector(`table.cm-table[data-table-from="${prevFrom}"]`);
    if (staleTable) applyTableSelectionHighlight(staleTable);
  }, true);
}

class TableWidget extends WidgetType {
  constructor(view, from, src) { super(); this.view = view; this.from = from; this.src = src; }
  eq(other) { return this.from === other.from && this.src === other.src; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;margin:4px 0 10px;width:100%;display:block;';

    const t = parseTableSrc(this.src);
    if (!t) {
      // Unparseable as a table (shouldn't normally happen — `parseTableSrc` only needs a
      // header + delimiter line pair — but if it ever does, this stays editable as plain text
      // rather than stranding the user with no way to fix it up from the rendered view: on blur,
      // whatever was typed is written back as-is (not re-parsed as a table), so it's always at
      // least *some* valid document content, just not necessarily a table anymore.
      wrap.style.cssText += 'white-space:pre;font-family:monospace;opacity:0.75;';
      wrap.contentEditable = 'true';
      wrap.textContent = this.src;
      wrap.dataset.tableFrom = String(this.from);
      wrap.addEventListener('mousedown', e => e.stopPropagation());
      wrap.addEventListener('blur', () => {
        const value = wrap.textContent;
        if (value === this.src) return;
        const range = findTableRangeAt(this.view.state, this.from + 1);
        if (!range) return;
        this.view.dispatch({ changes: { from: range.fromLine.from, to: range.toLine.to, insert: value } });
      });
      return wrap;
    }

    const aligns = tableAligns(t);

    const BORDER   = '1px solid rgba(128,128,128,0.38)';
    const CELL     = `border:${BORDER};padding:5px 12px;line-height:1.5;vertical-align:top;color:inherit;`;
    const TH_EXTRA = 'font-weight:600;background:rgba(128,128,128,0.12);';

    const table = document.createElement('table');
    // `cm-table` marks this as *our* rendered table for tableContextMenuHandler
    // below, so a right-click can be routed to row/column management instead
    // of the generic "create table" item. `data-table-from` lets cell-navigation
    // (focusTableCell above) re-find this exact table after a commit rebuilds it.
    table.className = 'cm-table';
    table.dataset.tableFrom = String(this.from);
    table.style.cssText =
      'border-collapse:collapse;width:100%;font-size:inherit;font-family:inherit;color:inherit;';

    const colCount = t.header.length;
    const lastRowIndex = t.rows.length - 1;

    // Shared keydown/blur wiring for both `<th>` and `<td>` cells — `isHeader`/`rowIndex`/`colIndex`
    // identify the cell being edited, `nextCoords()` computes where Tab/Enter should land (and
    // whether a new row needs inserting first, when tabbing/entering past the last cell/row).
    const wireCell = (cell, isHeader, rowIndex, colIndex) => {
      cell.contentEditable = 'true';
      cell.dataset.col = String(colIndex);
      const row = isHeader ? -1 : rowIndex;
      cell.addEventListener('mousedown', e => {
        e.stopPropagation();
        // A right-click (button 2) mousedown fires right before its own `contextmenu`
        // event — without this guard it fell through to the plain-click branch below,
        // which unconditionally clears any active multi-cell selection before
        // tableContextMenuHandler's `contextmenu` listener ever got a chance to see it,
        // so right-clicking a selected range always looked like a single-cell click to
        // the menu. Left completely untouched here; the browser's native contextmenu
        // event does its own thing regardless of what this handler does.
        if (e.button !== 0) return;
        const tableEl = cell.closest('table');
        if (e.shiftKey && tableCellSelection && tableCellSelection.tableFrom === this.from) {
          // Extend the *existing* range's own anchor to this cell instead of starting a new
          // one — matches Shift-click's usual "grow the selection from wherever it already
          // started" meaning in a spreadsheet, rather than always anchoring at the last-clicked
          // cell.
          tableCellSelection = { tableFrom: this.from, anchorRow: tableCellSelection.anchorRow,
            anchorCol: tableCellSelection.anchorCol, focusRow: row, focusCol: colIndex };
          applyTableSelectionHighlight(tableEl);
          e.preventDefault(); // don't also move the text caret/focus into this cell
          return;
        }
        // A plain (non-shift) mousedown always starts fresh — if a range was already
        // selected, this click means "I want to edit/select just this cell," so it's cleared
        // immediately; if the drag that follows *does* move to a different cell (tracked by
        // the table-level mousemove listener below), a new range takes over from here.
        if (tableCellSelection) { tableCellSelection = null; applyTableSelectionHighlight(tableEl); }
        dragState = { tableFrom: this.from, anchorRow: row, anchorCol: colIndex, moved: false };
        const onMouseUp = () => {
          document.removeEventListener('mouseup', onMouseUp);
          if (dragState && dragState.tableFrom === this.from && dragState.moved) {
            // A genuine range was just dragged out — focus the table itself (no single cell
            // stays focused while a multi-cell range is active) so a following Ctrl+C/Ctrl+V
            // has somewhere to fire from; see the table's own copy/paste listeners below.
            tableEl.tabIndex = -1;
            tableEl.focus();
          }
          dragState = null;
        };
        document.addEventListener('mouseup', onMouseUp);
      });

      const commitAndGo = (nextIsHeader, nextRow, nextCol, insertRowFirst) => {
        const value = cell.textContent;
        if (insertRowFirst) {
          mutateTableAt(this.view, this.from + 1, tt => {
            if (isHeader) { tt.header[colIndex] = value; } else { tt.rows[rowIndex][colIndex] = value; }
            insertTableRow(tt, tt.rows.length);
          });
        } else if (value !== (isHeader ? t.header[colIndex] : t.rows[rowIndex][colIndex])) {
          commitTableCell(this.view, this.from, isHeader, rowIndex, colIndex, value);
        }
        focusTableCell(this.view, this.from, nextIsHeader, nextRow, nextCol);
      };

      // Rendered (bold/italic/strikethrough/code) while not focused, raw markdown while
      // being edited — see renderTableCellDisplay's own comment for why this is a
      // dedicated function rather than reusing renderCell wholesale.
      cell.addEventListener('focus', () => {
        cell.textContent = isHeader ? t.header[colIndex] : t.rows[rowIndex][colIndex];
      });

      cell.addEventListener('blur', () => {
        const value = cell.textContent;
        if (value !== (isHeader ? t.header[colIndex] : t.rows[rowIndex][colIndex])) {
          commitTableCell(this.view, this.from, isHeader, rowIndex, colIndex, value);
        }
        cell.innerHTML = renderTableCellDisplay(value);
      });

      cell.addEventListener('keydown', e => {
        // CM6 already ignores every keydown originating inside this table
        // (see TableWidget.ignoreEvent above) — its own keymap
        // (defaultKeymap/historyKeymap/Mod-b/Mod-i) never sees these events
        // at all now, so there's nothing left for a blanket
        // e.stopPropagation() here to defend against, and — importantly —
        // not calling it means a key we don't otherwise act on (Ctrl+S,
        // plain typing, Backspace, Ctrl+C/V/X, ...) keeps bubbling normally
        // to the browser's native contentEditable handling and to whatever
        // sits above CM6 (VS Code's own keybinding forwarding). Only
        // Tab/Enter/Escape are ours to fully consume — cell-to-cell
        // navigation, not document editing — so only those three still call
        // stopPropagation, each right alongside their own preventDefault.
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            if (isHeader) { if (colIndex > 0) commitAndGo(true, -1, colIndex - 1, false); return; }
            if (colIndex > 0) { commitAndGo(false, rowIndex, colIndex - 1, false); return; }
            if (rowIndex > 0) { commitAndGo(false, rowIndex - 1, colCount - 1, false); return; }
            commitAndGo(true, -1, colCount - 1, false);
            return;
          }
          if (colIndex < colCount - 1) {
            commitAndGo(isHeader ? true : false, isHeader ? -1 : rowIndex, colIndex + 1, false);
            return;
          }
          if (isHeader) {
            if (t.rows.length > 0) { commitAndGo(false, 0, 0, false); } else { commitAndGo(false, 0, 0, true); }
            return;
          }
          if (rowIndex < lastRowIndex) { commitAndGo(false, rowIndex + 1, 0, false); return; }
          commitAndGo(false, rowIndex + 1, 0, true); // past the last cell of the last row: grow the table
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (isHeader) {
            if (t.rows.length > 0) { commitAndGo(false, 0, colIndex, false); } else { commitAndGo(false, 0, colIndex, true); }
            return;
          }
          if (rowIndex < lastRowIndex) { commitAndGo(false, rowIndex + 1, colIndex, false); return; }
          commitAndGo(false, rowIndex + 1, colIndex, true); // past the last row: grow the table
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cell.textContent = isHeader ? t.header[colIndex] : t.rows[rowIndex][colIndex];
          cell.blur();
        }
      });
    };

    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    t.header.forEach((h, i) => {
      const th = document.createElement('th');
      th.style.cssText = CELL + TH_EXTRA + `text-align:${aligns[i] || 'left'};`;
      th.innerHTML = renderTableCellDisplay(h);
      wireCell(th, true, -1, i);
      hRow.appendChild(th);
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    t.rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      tr.dataset.row = String(ri);
      if (ri % 2 === 1) tr.style.background = 'rgba(128,128,128,0.05)';
      row.forEach((cell, i) => {
        const td = document.createElement('td');
        td.style.cssText = CELL + `text-align:${aligns[i] || 'left'};`;
        td.innerHTML = renderTableCellDisplay(cell);
        wireCell(td, false, ri, i);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Extending an in-progress drag: fires continuously while the mouse button is held (see
    // wireCell's own mousedown, which starts `dragState` and clears any stale selection) —
    // moving onto a *different* cell than the drag started on is what actually turns a plain
    // click into a range selection; a drag that never leaves its own starting cell stays a
    // normal single-cell click.
    table.addEventListener('mousemove', e => {
      if (!(e.buttons & 1)) { dragState = null; return; } // button released — nothing to extend
      if (!dragState || dragState.tableFrom !== this.from) return; // no drag, or it belongs to another table
      const cellEl = e.target.closest && e.target.closest('td,th');
      if (!cellEl) return;
      const overRow = cellEl.tagName === 'TH' ? -1 : Number(cellEl.closest('tr').dataset.row);
      const overCol = Number(cellEl.dataset.col);
      if (!dragState.moved && overRow === dragState.anchorRow && overCol === dragState.anchorCol) return;
      dragState.moved = true;
      tableCellSelection = { tableFrom: this.from, anchorRow: dragState.anchorRow,
        anchorCol: dragState.anchorCol, focusRow: overRow, focusCol: overCol };
      // A cell mid-edit would otherwise keep silently holding the text cursor underneath the
      // highlight — blur it so a following Ctrl+C/Ctrl+V acts on the *range*, not on whatever
      // was still focused when the drag started.
      if (document.activeElement && table.contains(document.activeElement)) { document.activeElement.blur(); }
      applyTableSelectionHighlight(table);
    });

    // Copy/paste across the *whole selected range* — only intervenes when a multi-cell (or
    // even single-cell-but-explicitly-selected-as-a-range) selection is active; with no active
    // range this returns early and the native per-cell copy/paste (already working via each
    // cell's own contentEditable text, see TableWidget.ignoreEvent) proceeds completely
    // unchanged. `e.clipboardData.setData`/`getData` — not the async navigator.clipboard API —
    // since these fire as real browser `copy`/`paste` events (native Ctrl+C/Ctrl+V, or the
    // table-menu's own execCommand-driven ones), which is the standard, permission-free way to
    // override clipboard content in response to one.
    table.addEventListener('copy', e => {
      const sel = tableCellSelection;
      if (!sel || sel.tableFrom !== this.from) return;
      const rMin = Math.min(sel.anchorRow, sel.focusRow), rMax = Math.max(sel.anchorRow, sel.focusRow);
      const cMin = Math.min(sel.anchorCol, sel.focusCol), cMax = Math.max(sel.anchorCol, sel.focusCol);
      if (rMin === rMax && cMin === cMax) return; // exactly one cell — plain native copy is fine
      const rows = [];
      for (let r = rMin; r <= rMax; r++) {
        const rowVals = [];
        for (let c = cMin; c <= cMax; c++) {
          rowVals.push(r === -1 ? (t.header[c] || '') : ((t.rows[r] && t.rows[r][c]) || ''));
        }
        rows.push(rowVals);
      }
      e.clipboardData.setData('text/plain', buildClipboardTsv(rows));
      e.clipboardData.setData('text/html', buildClipboardHtmlTable(rows));
      e.preventDefault();
    });
    // Same range-detection/early-return as the copy listener just above, plus
    // the actual removal a cut implies (copy alone never deleted anything).
    // Reported: cutting a multi-cell selection did nothing at all — no
    // handler for `cut` existed here before, only copy/paste, so
    // TableWidget.ignoreEvent's old unconditional "ignore" left the browser's
    // native cut to fire against the focused <table> element itself (not
    // contentEditable, nothing native to cut), silently doing nothing and
    // writing nothing to the clipboard either.
    table.addEventListener('cut', e => {
      const sel = tableCellSelection;
      if (!sel || sel.tableFrom !== this.from) return;
      const rMin = Math.min(sel.anchorRow, sel.focusRow), rMax = Math.max(sel.anchorRow, sel.focusRow);
      const cMin = Math.min(sel.anchorCol, sel.focusCol), cMax = Math.max(sel.anchorCol, sel.focusCol);
      if (rMin === rMax && cMin === cMax) return; // exactly one cell — plain native cut is fine
      const rows = [];
      for (let r = rMin; r <= rMax; r++) {
        const rowVals = [];
        for (let c = cMin; c <= cMax; c++) {
          rowVals.push(r === -1 ? (t.header[c] || '') : ((t.rows[r] && t.rows[r][c]) || ''));
        }
        rows.push(rowVals);
      }
      e.clipboardData.setData('text/plain', buildClipboardTsv(rows));
      e.clipboardData.setData('text/html', buildClipboardHtmlTable(rows));
      e.preventDefault();
      // Cutting the *whole* table (every row and every column selected) removes
      // the table's own document range entirely — matches "Eliminar tabla" and
      // is what a selected-and-cut empty table needs to actually disappear,
      // rather than leaving an unchanged (already blank) table skeleton behind.
      const isWholeTable = rMin === -1 && rMax === t.rows.length - 1 && cMin === 0 && cMax === t.header.length - 1;
      tableCellSelection = null;
      if (isWholeTable) {
        deleteWholeTable(this.view, this.from + 1);
        return;
      }
      // A partial range: spreadsheet-style cut clears just the selected
      // cells' own text, leaving the rest of the table untouched.
      mutateTableAt(this.view, this.from + 1, tt => {
        for (let r = rMin; r <= rMax; r++) {
          for (let c = cMin; c <= cMax; c++) {
            if (r === -1) { tt.header[c] = ''; }
            else if (tt.rows[r]) { tt.rows[r][c] = ''; }
          }
        }
      });
    });
    table.addEventListener('paste', e => {
      const sel = tableCellSelection;
      if (!sel || sel.tableFrom !== this.from) return;
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      let rows = html ? parseHtmlTableToRows(html) : null;
      if (!rows) {
        const text = e.clipboardData.getData('text/plain');
        if (text) rows = tsvTextToRows(text);
      }
      if (!rows || rows.length === 0) return;
      const rMin = Math.min(sel.anchorRow, sel.focusRow), cMin = Math.min(sel.anchorCol, sel.focusCol);
      const wideness = Math.max(...rows.map(r => r.length));
      mutateTableAt(this.view, this.from + 1, tt => {
        // Grow the table first (extra columns, then extra rows) if the pasted block is bigger
        // than what's already there, mirroring how a spreadsheet paste extends the sheet to fit.
        while (tt.header.length < cMin + wideness) { insertTableColumn(tt, tt.header.length); }
        while (tt.rows.length < rMin + rows.length) { insertTableRow(tt, tt.rows.length); }
        rows.forEach((rowVals, ri) => {
          const targetRow = rMin + ri;
          rowVals.forEach((val, ci) => {
            const targetCol = cMin + ci;
            if (targetRow === -1) { tt.header[targetCol] = val; }
            else if (tt.rows[targetRow]) { tt.rows[targetRow][targetCol] = val; }
          });
        });
      });
      // Extends the visible selection to cover the pasted extent (matching spreadsheet UX) —
      // the mutation above rebuilds the whole widget from scratch, so this only needs to update
      // the module-level state; the fresh toDOM() call (below) re-applies the highlight itself.
      tableCellSelection = { tableFrom: this.from, anchorRow: rMin, anchorCol: cMin,
        focusRow: rMin + rows.length - 1, focusCol: cMin + wideness - 1 };
    });

    ensureTableSelectionOutsideHandler();
    applyTableSelectionHighlight(table);
    wrap.appendChild(table);
    return wrap;
  }
  // CM6's InputState gates ALL of its own event handling (built-in commands
  // AND every domEventHandlers-registered extension handler, e.g.
  // tableContextMenuHandler's `contextmenu` listener) behind this per-event
  // check (`eventBelongsToEditor`, @codemirror/view) — not just clicks, as
  // the name might suggest. Cells are real `contentEditable` elements meant
  // to be edited natively; CM6 having its own opinion about keydown/paste/
  // copy/cut inside them only gets in the way: `handlers.paste`/`.copy`/
  // `.cut` (its built-ins for those three) and its keymap (Backspace/Ctrl+B/
  // Ctrl+Z/etc. via defaultKeymap/historyKeymap) all act on *the document*,
  // not the cell's own text — but still call `preventDefault()` regardless
  // of whether they did anything, which silently blocks the browser's own
  // native action for that same key on the focused contentEditable element.
  // Reported as "no puedo ni copiar ni pegar texto" in a cell, and
  // separately as Ctrl+S (and, by extension, any other keybinding) not
  // firing while the cursor was in a cell — the previous fix for the first
  // symptom was `e.stopPropagation()` in wireCell's own keydown listener,
  // which does stop CM6's keymap from seeing the event, but stopPropagation
  // is all-or-nothing: it also stops the event from ever reaching whatever
  // listener VS Code's own webview host uses (above contentDOM, in the same
  // document) to relay a keydown into its keybinding service — silently
  // swallowing Ctrl+S and everything like it. Returning `true` here for
  // just these four event types (via `ignoreEvent`, CM6's own sanctioned
  // opt-out) means CM6 skips them entirely: no command runs, nothing gets
  // prevented, and the event keeps bubbling normally past contentDOM,
  // restoring both native copy/paste/typing and outer keybinding forwarding
  // at once — without touching mousedown/click/contextmenu/dragover/drop,
  // which CM6 (and this file's own tableContextMenuHandler/linkClickHandler)
  // still need to see for the row/column context menu and cursor-placement
  // suppression to keep working.
  ignoreEvent(event) {
    if (event.type === 'keydown') return true;
    if (event.type === 'paste' || event.type === 'copy' || event.type === 'cut') {
      // A genuine multi-cell range (tableCellSelection, set by dragging
      // across cells — see the "Multi-cell selection" section) has its own
      // dedicated copy/paste/cut listeners wired directly on the <table>
      // element (below, in toDOM()). Defer to those entirely rather than
      // letting CM6 also try to act on its own, unrelated document selection
      // for the very same event — reported: selecting several cells and
      // cutting via Ctrl+X did nothing at all, and clipboard content after
      // that "cut" was empty (a following paste pasted nothing), because
      // there was previously no `cut` handler at all for this selection mode
      // (only copy/paste existed) — CM6 ignored the event (old unconditional
      // return true below) with nothing else to act on it, so the browser's
      // default cut action ran against the focused <table> itself (not
      // contentEditable, nothing to cut) and silently did nothing.
      if (tableCellSelection && tableCellSelection.tableFrom === this.from) return true;
      // Otherwise: an empty table selected as part of a real CM6 selection
      // (e.g. Shift+arrow from just before it to just after it) and then cut
      // did nothing — "la tabla sigue ahí". Root cause: this used to ignore
      // these three events unconditionally whenever their target sat
      // anywhere inside the widget's own DOM (any cell), which is right for
      // genuine in-cell editing (see above) but wrong here — the actual
      // document selection extended beyond this one table, so treating the
      // event as "purely in-cell" let CM6 skip it entirely, silently
      // dropping a cut/copy/paste that should have acted on that wider
      // selection like anywhere else in the editor. Only ignore when the
      // current selection sits entirely inside this table's own range —
      // i.e. this really is in-cell interaction, not a cut/copy/paste of a
      // selection that happens to include (or start/end inside) the table.
      const sel = this.view.state.selection.main;
      const range = findTableRangeAt(this.view.state, this.from + 1);
      if (range && (sel.from < range.fromLine.from || sel.to > range.toLine.to)) {
        return false;
      }
      return true;
    }
    return false;
  }
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
  //
  // Explicit `selection` — same fix, same reasoning, as mutateTableAt's own
  // comment (see there for the full story): a stray CM6 cursor sitting right
  // at this widget's own closing boundary (an easy click to make, just below
  // the panel) would otherwise risk being pulled back inside the freshly
  // re-serialized frontmatter text on every property edit, via CM6's default
  // (ambiguous at that exact boundary) position-mapping — reported as "con
  // los frontmatters pasa algo parecido" right after the identical table bug.
  commit(newProps) {
    const insert = serializeFrontmatter(newProps);
    this.view.dispatch({
      changes: { from: this.from, to: this.to, insert },
      selection: mapSelectionOutsideReplacedRange(this.view.state, this.from, this.to, insert),
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
      // PropertiesWidget.ignoreEvent (below) already makes CM6 skip every
      // keydown/paste/copy/cut originating inside this panel entirely, so
      // there's nothing left here to defend the input's own native typing/
      // deletion/paste against — see that method's comment for the full
      // story (same fix as TableWidget's identical bug). Only Enter is ours
      // to consume, to commit-and-blur instead of doing nothing (a plain
      // text <input> has no native action for Enter anyway).
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
  // Same fix/reasoning as TableWidget.ignoreEvent (see that comment for the
  // full story): CM6's own keymap/paste/copy/cut handling only ever gets in
  // the way of these real <input>/<checkbox> elements' native behavior, and
  // a bare e.stopPropagation() to defend against it (the previous fix, now
  // removed from every keydown listener above) also silently blocked
  // keybindings like Ctrl+S from ever reaching whatever listens for them
  // above CM6. Returning true for just these four event types lets CM6
  // ignore them entirely while leaving mousedown/click (cursor-placement
  // suppression, pill removal, "+ Añadir propiedad" toggling) untouched.
  ignoreEvent(event) {
    return event.type === 'keydown' || event.type === 'paste' ||
           event.type === 'copy' || event.type === 'cut';
  }
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

// ── Horizontal rule widget ──────────────────────────────────────────────────
// Renders "---"/"***"/"___" as an actual <hr>, matching Obsidian's live
// preview. Single-line replace (like TableWidget's header line), not
// block:true — the whole match is one document line, so there's nothing to
// collapse across multiple lines the way a table body needs.
class HorizontalRuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr';
    return hr;
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

// ── Task-dependency reference hover popup ───────────────────────────────────
// Hovering a resolved dependency id inside a ```tasks``` row's `⛔` chip (see
// renderTaskRow below) shows the referenced task's own description — mirrors the
// [[wikilink]] Ctrl+hover preview (HoverPreviewView) further up this file, but simpler:
// no modifier key needed (a dependency id isn't otherwise clickable/navigable, so
// there's no click-vs-hover ambiguity to gate behind Ctrl), and the referenced task's
// data already arrived with the query result (`TaskDTO.dependsOnTasks`) instead of a
// host round-trip like the wikilink preview's transclusion fetch. A single popup `dom`
// is created once and reused (shown/hidden) across every row, same as HoverPreviewView.
//
// Styled entirely via inline `style`, not a `vsTheme` class like `.dv-filter-popover`
// above: `EditorView.theme()` only ever attaches its generated scoping class to
// `view.dom` (`.cm-editor` itself), so any rule for a plain class selector only matches
// elements *inside* `.cm-editor` — this popup is appended straight to `document.body`
// (so it can float above the editor, same reasoning `.dv-filter-popover` states for
// itself), which is a sibling of `.cm-editor`, not a descendant, so a `vsTheme` class
// here would silently never apply. Confirmed by reading `buildTheme`/`finish` in
// `@codemirror/view`'s own source rather than guessing. Reported as "no hay popup ni
// nada (aparece en la parte más baja de la pantalla)" — exactly the symptom of an
// unstyled `position: static` div landing whatever `document.body` happened to lay
// out for it (bottom of the page, past everything else). `var(--...)` custom-property
// lookups below still resolve fine via inline styles — that's ordinary CSS custom
// property inheritance up the real DOM tree, unrelated to CM6's own theme scoping.
const DEP_HOVER_DELAY = 300; // mirrors HOVER_PREVIEW_DELAY above
let depHoverPopupEl = null;
let depHoverShowTimer = null;
let depHoverHideTimer = null;

function depHoverEnsurePopup() {
  if (depHoverPopupEl) return depHoverPopupEl;
  const pop = document.createElement('div');
  pop.style.cssText = [
    'display:none',
    'position:fixed',
    'z-index:1000',
    'min-width:160px',
    'max-width:360px',
    'background:var(--vscode-editorWidget-background, var(--background-secondary, #252526))',
    'color:var(--vscode-editorWidget-foreground, inherit)',
    'border:1px solid var(--vscode-editorWidget-border, var(--background-modifier-border, rgba(128,128,128,0.4)))',
    'border-radius:4px',
    'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    'padding:6px 10px',
    'font-size:0.85em',
    'line-height:1.4',
  ].join(';');
  // Keeps the popup open while the pointer is over the popup itself (e.g. to select/copy its
  // text), same as HoverPreviewView's own overPopup flag.
  pop.addEventListener('mouseenter', () => clearTimeout(depHoverHideTimer));
  pop.addEventListener('mouseleave', depHoverScheduleHide);
  document.body.appendChild(pop);
  depHoverPopupEl = pop;
  return pop;
}

function depHoverScheduleHide() {
  clearTimeout(depHoverHideTimer);
  depHoverHideTimer = setTimeout(() => {
    if (depHoverPopupEl) depHoverPopupEl.style.display = 'none';
  }, 150);
}

// `x`/`y` are viewport coordinates (`clientX`/`clientY`, captured at `mouseenter` time — see
// `attachDependencyHoverPreview` below) — positioning off the cursor rather than the hovered
// ref span's own `getBoundingClientRect()` (the first version of this) reads as a normal tooltip
// stuck to the mouse, and incidentally still sits right next to the ref span too, since the
// pointer has to be over that (small, ~6-character) span for `mouseenter` to have fired at all.
function depHoverShow(x, y, info) {
  clearTimeout(depHoverHideTimer);
  const pop = depHoverEnsurePopup();
  pop.textContent = '';

  const desc = document.createElement('div');
  desc.style.cssText = 'white-space:normal;word-break:break-word;';
  const statusPrefix = info.statusSymbol && info.statusSymbol !== ' ' ? `[${info.statusSymbol}] ` : (info.isDone ? '[x] ' : '');
  desc.textContent = statusPrefix + info.description;
  pop.appendChild(desc);

  const meta = document.createElement('div');
  meta.style.cssText = 'margin-top:4px;opacity:0.6;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  meta.textContent = info.path + ':' + (info.line + 1);
  pop.appendChild(meta);

  pop.style.display = 'block';
  // Offset down-right of the cursor (not right on top of it) so the popup doesn't immediately
  // cover the pointer and self-trigger its own mouseleave; clamped to the viewport on both axes
  // so it doesn't run off-screen when hovering a ref near the right or bottom edge.
  const left = Math.min(x + 12, window.innerWidth - pop.offsetWidth - 8);
  const top = Math.min(y + 16, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = Math.max(4, left) + 'px';
  pop.style.top = Math.max(4, top) + 'px';
}

// Appends a dependency chip's leading emoji (`⛔ `) as its own span, hoverable exactly like an
// individual id ref when `firstInfo` resolves to something — otherwise plain text. Without this,
// only the id text itself (the ~6-character ref span) triggered the popup; reported as "el icono
// claro que se ve, pero si dejo el cursor sobre él, no pasa nada" — the emoji is the visually
// obvious part of the chip, so a reader naturally hovers *that*, not the small id next to it.
// Points at the *first* resolved entry when a chip has several ids — there's no single id the
// emoji itself could unambiguously belong to, and defaulting to the first one is more useful than
// making the emoji inert.
function appendDependencyEmoji(container, emoji, firstInfo) {
  const emojiEl = document.createElement('span');
  emojiEl.textContent = emoji;
  if (firstInfo) attachDependencyHoverPreview(emojiEl, firstInfo);
  container.appendChild(emojiEl);
}

// `info` is one entry of `TaskDTO.dependsOnTasks`/`TaskDTO.blocking` (already resolved
// host-side) — see the callers in renderTaskRow, which only call this for an id that actually
// resolved to a task.
function attachDependencyHoverPreview(el, info) {
  el.addEventListener('mouseenter', (e) => {
    clearTimeout(depHoverShowTimer);
    const x = e.clientX;
    const y = e.clientY;
    depHoverShowTimer = setTimeout(() => depHoverShow(x, y, info), DEP_HOVER_DELAY);
  });
  el.addEventListener('mouseleave', () => {
    clearTimeout(depHoverShowTimer);
    depHoverScheduleHide();
  });
}

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
    // `TaskDTO.blocking` (tasks elsewhere in the vault that depend on *this* one, the inverse of
    // `dependsOnTasks`) has no chip of its own — an earlier version gave it a separate `➡️` chip,
    // but a screen recording of someone hunting for that popup showed them hovering *this* badge
    // and waiting, never reaching the separate chip further along the row; removed per explicit
    // request ("la funcionalidad de la referencia debe caer sobre 🆔 [id] y consume espacio
    // físico") once it was clear the id badge was the natural (and only needed) hover target —
    // it's this task's own identity, the thing every `blocking` entry actually points at. Shows
    // the first blocking task if there's more than one (no single id a shared hover target could
    // unambiguously point at otherwise). A no-op when nothing depends on this task yet.
    if (t.blocking && t.blocking.length > 0) {
      attachDependencyHoverPreview(idEl, t.blocking[0]);
    }
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
    // `dependsOnTasks` (only present from a rebuilt sibling "Tasks" extension, same
    // degrade-gracefully pattern as `id`/`statusSymbol` above) resolves each id to the task it
    // points at. An id with no entry (older host build, or a stale id) falls back to plain
    // unlinked text instead of a hoverable one.
    const resolvedById = new Map((t.dependsOnTasks || []).map(d => [d.id, d]));
    appendDependencyEmoji(dep, '⛔ ', resolvedById.get(t.dependsOn[0]));
    t.dependsOn.forEach((id, i) => {
      if (i > 0) dep.append(',');
      const info = resolvedById.get(id);
      if (!info) { dep.append(id); return; }
      const ref = document.createElement('span');
      ref.className = 'cm-tasks-query-depends-ref';
      ref.textContent = id;
      attachDependencyHoverPreview(ref, info);
      dep.appendChild(ref);
    });
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

  // Backlink to the file (and heading, if the task sits under one) the task was found in.
  // Used to reuse the `[data-wiki]` wikilink-navigation pattern (`open-note`), which has two
  // problems for this specific case, reported as "debería abrir ese documento en una nueva
  // pestaña y hacer scroll hasta dejar la posición donde está la tarea a la vista (y con el
  // cursor al principio de la tarea)": (1) `navigateToTarget` (the `open-note` handler,
  // extension.ts) disposes the *source* panel after navigating — fine for a normal in-document
  // wikilink click (that's how note-to-note navigation is supposed to work here), wrong for a
  // dashboard-style ```tasks``` listing, which the user wants to stay open while jumping to
  // inspect one result; and (2) it only scrolls to `t.heading`'s line when the target has one,
  // never to the *task's own* line, and never places the cursor there. Dedicated `data-path`/
  // `data-line` attributes (own class `cm-tasks-query-backlink-link`, checked in
  // `linkClickHandler` below) posting `open-task-location` instead — opened as a genuine new
  // tab (`preview: false` on the host side) and scrolled/cursor-placed via the same
  // `scroll-to-line` message `openNoteAtLine`/`navigateToTarget`'s own heading-scroll already
  // use, just aimed at `t.line` instead of a heading's line.
  const noteName = (t.path || '').replace(/\.md$/i, '').split('/').pop();
  if (noteName) {
    const back = document.createElement('span');
    back.className = 'cm-tasks-query-backlink';
    const link = document.createElement('span');
    link.className = 'cm-tasks-query-backlink-link';
    link.dataset.path = t.path;
    link.dataset.line = String(t.line);
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
  // `zoom factor <N>%` query line (see the sibling Tasks extension's core/Query/Query.ts) — CSS
  // `zoom`, not `font-size`/`transform: scale`, for the same reason its own Markdown Preview
  // renderer uses it: it scales this container's entire rendered subtree as one unit (text,
  // emoji/icon badges, padding, layout box included), which a font-size change alone wouldn't do
  // for anything sized in fixed px, and `transform: scale` wouldn't reflow (leaves the original
  // box size behind, just visually shrunk inside it). Safe here for the same reason it's safe in
  // that renderer: this webview is Chromium-based too. Omitted entirely at the default 100%
  // (normal size) rather than set to the literal string '100%', so a query with no zoom factor
  // renders identically to before this existed.
  const zoomFactor = result && result.zoomFactor;
  container.style.zoom = zoomFactor && zoomFactor !== 100 ? zoomFactor + '%' : '';

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

// ── Excel-like client-side sort/filter for ```dataview TABLE results ──────────
// Purely a display-layer transform over the sibling extension's already-rendered
// <table class="dv-table"> — never touches the underlying DQL query or asks the
// host to re-run anything, just reorders/hides the <tr>s already in the DOM.
// Clicking a column header cycles sort (none → asc → desc); the small ▾ button
// next to each header opens a checkbox-list filter popover (search box + one
// checkbox per unique value + "select all"), mirroring Excel's AutoFilter.
//
// State lives in `dvTableState` (keyed by the <table> element itself via a
// WeakMap) rather than as widget fields, so it survives `livePreviewPlugin`
// rebuilds that reuse the same DOM node (DataviewQueryWidget.eq() returning
// true keeps CM6 from calling toDOM() again) — it only resets when fresh query
// results genuinely replace the table (a new toDOM() call, see below).
const dvTableState = new WeakMap(); // <table> -> { originalRows, sortCol, sortDir, filters: Map<col, Set<excludedValue>> }

function dvCellText(tr, col) {
  const cell = tr.children[col];
  return cell ? cell.textContent.trim() : '';
}

// Numeric compare when both sides parse as numbers (so "2" sorts before "10"),
// locale string compare otherwise; blanks always sort last regardless of
// direction — same conventions as Excel's own column sort.
function dvCompareCells(a, b) {
  if (a === '' && b === '') return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function dvRowPassesFilters(state, tr, exceptCol) {
  for (const [col, excluded] of state.filters) {
    if (col === exceptCol) continue;
    if (excluded.has(dvCellText(tr, col))) return false;
  }
  return true;
}

function dvApplyTable(table, state) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  let rows = state.originalRows.filter((tr) => dvRowPassesFilters(state, tr, -1));
  if (state.sortCol != null) {
    const dir = state.sortDir === 'desc' ? -1 : 1;
    rows = rows
      .slice()
      .sort((ra, rb) => dvCompareCells(dvCellText(ra, state.sortCol), dvCellText(rb, state.sortCol)) * dir);
  }
  tbody.replaceChildren(...rows);

  const headRow = table.tHead && table.tHead.rows[0];
  if (headRow) {
    Array.from(headRow.cells).forEach((th, i) => {
      const indicator = th.querySelector('.dv-th-sort-indicator');
      if (indicator) indicator.textContent = state.sortCol === i ? (state.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      const filterBtn = th.querySelector('.dv-th-filter');
      if (filterBtn) filterBtn.classList.toggle('dv-th-filter-active', !!(state.filters.get(i) && state.filters.get(i).size));
    });
  }
}

function dvClosePopover() {
  const existing = document.querySelector('.dv-filter-popover');
  if (existing) existing.remove();
}

let dvPopoverOutsideHandlerInstalled = false;
function ensureDvPopoverOutsideHandler() {
  if (dvPopoverOutsideHandlerInstalled) return;
  dvPopoverOutsideHandlerInstalled = true;
  // Appended to document.body (so it can float above the CM6 editor), not a descendant of the
  // widget — CM6's own event handling never sees clicks inside it, so this is the only place
  // that needs to close it on an outside click.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.dv-filter-popover') || e.target.closest('.dv-th-filter')) return;
    dvClosePopover();
  });
}

function dvOpenFilterPopover(table, state, col, anchorBtn) {
  dvClosePopover();

  // Cascading like Excel's own AutoFilter: the value list for this column only considers rows
  // that already pass every *other* column's active filter, not the full original set.
  const values = new Set();
  for (const tr of state.originalRows) {
    if (dvRowPassesFilters(state, tr, col)) values.add(dvCellText(tr, col));
  }
  const excluded = state.filters.get(col) || new Set();

  const pop = document.createElement('div');
  pop.className = 'dv-filter-popover';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Buscar…';
  pop.appendChild(search);

  const selectAllRow = document.createElement('label');
  selectAllRow.className = 'dv-filter-option dv-filter-select-all';
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllRow.append(selectAllCb, document.createTextNode(' Seleccionar todo'));
  pop.appendChild(selectAllRow);

  const list = document.createElement('div');
  list.className = 'dv-filter-list';
  pop.appendChild(list);

  const rowsByValue = new Map();
  const sortedValues = [...values].sort(dvCompareCells);
  for (const v of sortedValues) {
    const row = document.createElement('label');
    row.className = 'dv-filter-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !excluded.has(v);
    cb.dataset.value = v;
    row.append(cb, document.createTextNode(' ' + (v === '' ? '(vacío)' : v)));
    list.appendChild(row);
    rowsByValue.set(v, row);
  }

  const updateSelectAll = () => {
    const boxes = [...list.querySelectorAll('input[type="checkbox"]')].filter((cb) => cb.closest('label').style.display !== 'none');
    selectAllCb.checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
    selectAllCb.indeterminate = !selectAllCb.checked && boxes.some((cb) => cb.checked);
  };
  updateSelectAll();

  const commitFilter = () => {
    if (excluded.size > 0) state.filters.set(col, excluded);
    else state.filters.delete(col);
    dvApplyTable(table, state);
  };

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const [v, row] of rowsByValue) {
      row.style.display = q === '' || v.toLowerCase().includes(q) ? '' : 'none';
    }
    updateSelectAll();
  });

  selectAllCb.addEventListener('change', () => {
    for (const row of list.querySelectorAll('label')) {
      if (row.style.display === 'none') continue;
      const cb = row.querySelector('input');
      cb.checked = selectAllCb.checked;
      if (cb.checked) excluded.delete(cb.dataset.value);
      else excluded.add(cb.dataset.value);
    }
    commitFilter();
  });

  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) excluded.delete(cb.dataset.value);
    else excluded.add(cb.dataset.value);
    updateSelectAll();
    commitFilter();
  });

  const footer = document.createElement('div');
  footer.className = 'dv-filter-footer';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Borrar filtro';
  clearBtn.addEventListener('click', () => {
    state.filters.delete(col);
    dvApplyTable(table, state);
    dvClosePopover();
  });
  footer.appendChild(clearBtn);
  pop.appendChild(footer);

  document.body.appendChild(pop);
  const btnRect = anchorBtn.getBoundingClientRect();
  const left = Math.min(btnRect.left, window.innerWidth - pop.offsetWidth - 8);
  pop.style.left = Math.max(4, left) + 'px';
  pop.style.top = (btnRect.bottom + 4) + 'px';
  search.focus();
}

function enhanceDataviewTable(table) {
  const thead = table.tHead;
  const tbody = table.tBodies[0];
  if (!thead || !tbody || !thead.rows.length) return;

  const state = { originalRows: [...tbody.rows], sortCol: null, sortDir: 'asc', filters: new Map() };
  dvTableState.set(table, state);
  ensureDvPopoverOutsideHandler();

  Array.from(thead.rows[0].cells).forEach((th, col) => {
    const text = th.textContent;
    th.textContent = '';

    const label = document.createElement('span');
    label.className = 'dv-th-label';
    label.textContent = text;
    const indicator = document.createElement('span');
    indicator.className = 'dv-th-sort-indicator';
    label.appendChild(indicator);
    label.addEventListener('click', () => {
      if (state.sortCol !== col) { state.sortCol = col; state.sortDir = 'asc'; }
      else if (state.sortDir === 'asc') { state.sortDir = 'desc'; }
      else { state.sortCol = null; state.sortDir = 'asc'; }
      dvApplyTable(table, state);
    });

    const filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'dv-th-filter';
    filterBtn.textContent = '▾';
    filterBtn.title = 'Filtrar';
    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (document.querySelector('.dv-filter-popover')) { dvClosePopover(); return; }
      dvOpenFilterPopover(table, state, col, filterBtn);
    });

    th.append(label, filterBtn);
  });
}

function enhanceDataviewTables(root) {
  root.querySelectorAll('table.dv-table').forEach(enhanceDataviewTable);
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
      enhanceDataviewTables(wrap);
    } else {
      const loading = document.createElement('div');
      loading.className = 'cm-dataview-query-loading';
      loading.textContent = 'Cargando consulta dataview…';
      wrap.appendChild(loading);
    }
    return wrap;
  }
  // The sort label / filter button are real interactive controls, unlike the rest of this
  // widget's content (plain text, or `[data-wiki]` links already handled via
  // `linkClickHandler`'s preventDefault-on-mousedown guards) — same reasoning as
  // TasksQueryWidget's filter-input guard above: without this, clicking them moved the cursor
  // into this block's document range, swapping the widget out for raw source before the click
  // could register. The filter popover itself lives outside the editor's DOM (appended to
  // document.body), so CM6 never routes its clicks through here in the first place.
  ignoreEvent(event) {
    return !!(event.target && event.target.closest && event.target.closest('.dv-th-label, .dv-th-filter'));
  }
}

// `.cm-wiki-link-raw`/`.cm-plain-brackets` (below) used to carry an inline `style` here
// restoring font-size (then, briefly today, also weight/family/color/line-height/style) when
// the bracket sits inside a heading — removed entirely. Reported as "corchetes enormes": opening
// and closing a bracket on a heading line made the brackets *and* their enclosed text render
// nearly twice the heading's own size.
//
// Root cause, confirmed with a real EditorView in jsdom (throwaway script, not checked in) that
// dumped the actual class list and the actual injected stylesheet text for "# [Test] Heading":
// every one of the bracket's own inner pieces — "[", the enclosed text, "]" — each get their own
// nested `<span class="cm-header cm-header-1 ...">` from mdHighlight's own highlightTree (heading
// tagging reaches the bracket's contents exactly like it reaches the rest of the heading line),
// and `.cm-header-1`'s own font-size rule (`.ͼo .cm-header-1`, a *two-class* compound selector)
// reliably wins there over any of tags.link/tags.url/tags.processingInstruction's own single-
// class auto-generated combo rules — by CSS specificity, unconditionally, independent of
// stylesheet load order (2 classes always beats 1). In other words: **every inner span was
// already rendering at the correct heading size on its own, with no help needed.** The inline
// style this function used to return was applied to the *outer* wrapping span (`cm-wiki-link-
// raw`/`cm-plain-brackets`, added by livePreviewPlugin — a *different* element than the inner
// mdHighlight-generated spans it wraps, confirmed nested, not merged, by the same dump). Because
// its own font-size was *also* declared in `em` — relative to *its own* parent's font-size — and
// the inner spans' `1.75em` is in turn relative to *that already-enlarged* outer span, the two
// multiplied together (≈1.75 × 1.75 ≈ 3× the base size) instead of composing to the single
// intended heading size. The original bug this function was introduced to fix (an *earlier*,
// broader version of the shared reset rule below applying `font-size: inherit !important` via a
// `.selector *` descendant selector, which *does* reach the inner spans directly and *does* beat
// their own non-!important rule) was already fixed by narrowing that rule to exclude font-size —
// nothing here was ever actually needed to keep a bracket inside a heading correctly sized;
// restoring it here on the *outer* span only ever added the compounding on top.
function plainBracketFontSizeStyle() {
  return '';
}

// ── Callouts (Obsidian-style `> [!type]` blockquotes) ────────────────────────
// https://obsidian.md/help/callouts — a callout is an ordinary blockquote
// whose own first line (after its own "> " marker) is "[!type]", optionally
// followed by "+"/"-" (foldable, default expanded/collapsed) and a custom
// title. Detection is a separate, whole-document pass (collectCallouts,
// below) — same reasoning as collectHeadings/foldPlugin: the actual
// rendering hook lives inside livePreviewPlugin's existing (viewport-scoped)
// Blockquote handling, but fold state/atomicRanges/moveVerticalByLine all
// need the full picture regardless of what's currently scrolled into view.
const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-])?[ \t]*(.*)$/;

// Canonical type -> { color: "r, g, b", icon }. Colors/icons mirror
// Obsidian's own built-in callout defaults; aliases per the spec page. An
// unrecognized type still renders as a callout (per spec) using the "note"
// appearance, with its own literal typed name (title-cased) as the default
// title instead of "Note".
const CALLOUT_DEFS = {
  note:     { color: '68, 138, 255',  icon: 'pencil' },
  abstract: { color: '0, 191, 188',   icon: 'clipboard-list', aliases: ['summary', 'tldr'] },
  info:     { color: '8, 109, 221',   icon: 'info' },
  todo:     { color: '0, 122, 255',   icon: 'circle-check' },
  tip:      { color: '0, 191, 188',   icon: 'flame', aliases: ['hint', 'important'] },
  success:  { color: '8, 185, 78',    icon: 'check', aliases: ['check', 'done'] },
  question: { color: '236, 117, 0',   icon: 'help-circle', aliases: ['help', 'faq'] },
  warning:  { color: '236, 117, 0',   icon: 'alert-triangle', aliases: ['caution', 'attention'] },
  failure:  { color: '233, 49, 71',   icon: 'x', aliases: ['fail', 'missing'] },
  danger:   { color: '233, 49, 71',   icon: 'zap', aliases: ['error'] },
  bug:      { color: '233, 49, 71',   icon: 'bug' },
  example:  { color: '120, 82, 238',  icon: 'list' },
  quote:    { color: '158, 158, 158', icon: 'quote', aliases: ['cite'] },
};
const CALLOUT_ALIASES = {};
for (const key of Object.keys(CALLOUT_DEFS)) {
  CALLOUT_ALIASES[key] = key;
  for (const a of CALLOUT_DEFS[key].aliases || []) CALLOUT_ALIASES[a] = key;
}
function resolveCalloutType(rawType) {
  const canonical = CALLOUT_ALIASES[rawType.toLowerCase()];
  return canonical ? { canonical, ...CALLOUT_DEFS[canonical] } : { canonical: null, ...CALLOUT_DEFS.note };
}
function defaultCalloutTitle(rawType, canonical) {
  const t = canonical || rawType;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Small hand-drawn 24x24 stroke icon set — this bundle has no icon-library
// dependency (stays fully offline/self-contained), so these are simplified
// approximations rather than a pixel-perfect Lucide reproduction; good
// enough to be recognizable per type.
const CALLOUT_ICON_PATHS = {
  pencil:           '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'clipboard-list': '<rect x="4" y="4" width="16" height="18" rx="2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12h6M9 16h6M9 8h2"/>',
  info:             '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'circle-check':   '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  flame:            '<path d="M8.5 14.5a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  check:            '<path d="M20 6 9 17l-5-5"/>',
  'help-circle':    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x:                '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  zap:              '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  bug:              '<ellipse cx="12" cy="14" rx="6" ry="7"/><path d="M9 3.5 12 7l3-3.5"/><path d="M12 7v13"/><path d="M4 12H2M22 12h-2M4.5 18 3 20M19.5 18l1.5 2M4.5 8 3 6M19.5 8l1.5-2"/>',
  list:             '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  quote:            '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
};
function calloutIconSvgMarkup(iconName) {
  const inner = CALLOUT_ICON_PATHS[iconName] || CALLOUT_ICON_PATHS.pencil;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" class="cm-callout-icon-svg">${inner}</svg>`;
}

// Rendered in place of the "[!type]+/-" marker (and the default title, when
// no custom one is given — there's no text run in the document to attach a
// mark decoration to in that case, so the widget renders it itself).
class CalloutHeaderWidget extends WidgetType {
  constructor(icon, color, titleText) { super(); this.icon = icon; this.color = color; this.titleText = titleText; }
  eq(o) { return this.icon === o.icon && this.color === o.color && this.titleText === o.titleText; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-callout-header-inline';
    span.contentEditable = 'false';
    span.style.color = `rgb(${this.color})`;
    const icon = document.createElement('span');
    icon.className = 'cm-callout-icon';
    icon.innerHTML = calloutIconSvgMarkup(this.icon);
    span.appendChild(icon);
    if (this.titleText) {
      const title = document.createElement('span');
      title.className = 'cm-callout-title';
      title.textContent = this.titleText;
      span.appendChild(title);
    }
    return span;
  }
  ignoreEvent() { return false; }
}

// ── Callout folding ("+"/"-" indicator, click-to-toggle) ─────────────────────
// Mirrors the heading-fold machinery (foldedSet/foldEffect, further down)
// but a callout's *default* folded state comes from its own "+"/"-" marker
// rather than always starting expanded, so only explicit user overrides are
// stored here (Blockquote node.from -> folded boolean) — a callout with no
// entry just uses its own marker's default on every rebuild.
const calloutFoldEffect = StateEffect.define();
const calloutFoldOverride = new Map();
function calloutFoldedState(pos, foldChar) {
  return calloutFoldOverride.has(pos) ? calloutFoldOverride.get(pos) : foldChar === '-';
}

class CalloutFoldToggle extends WidgetType {
  constructor(pos, folded, color) { super(); this.pos = pos; this.folded = folded; this.color = color; }
  eq(o) { return this.pos === o.pos && this.folded === o.folded && this.color === o.color; }
  toDOM() {
    const outer = document.createElement('span');
    outer.className = 'cm-callout-fold' + (this.folded ? ' is-collapsed' : '');
    outer.style.color = `rgb(${this.color})`;
    outer.contentEditable = 'false';
    outer.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    const pos = this.pos, folded = this.folded;
    outer.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    outer.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      calloutFoldOverride.set(pos, !folded);
      if (currentView) currentView.dispatch({ effects: calloutFoldEffect.of(pos) });
    });
    return outer;
  }
  ignoreEvent() { return false; }
}

// One entry per Blockquote node whose own first line is "[!type]..." —
// mirrors collectHeadings' role for foldPlugin, but as its own function
// since a callout is blockquote-scoped, not a distinct node type lezer
// itself ever emits.
function collectCallouts(state) {
  const out = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Blockquote') return;
      let child = node.node.firstChild;
      while (child && child.name !== 'QuoteMark') child = child.nextSibling;
      if (!child) return;
      const fromLine = state.doc.lineAt(node.from);
      let bodyStart = child.to;
      if (state.doc.sliceString(bodyStart, bodyStart + 1) === ' ') bodyStart++;
      if (bodyStart > fromLine.to) return;
      const headerText = state.doc.sliceString(bodyStart, fromLine.to);
      const m = CALLOUT_RE.exec(headerText);
      if (!m) return;
      let toLine = state.doc.lineAt(node.to);
      if (toLine.from === node.to && toLine.number > fromLine.number) {
        toLine = state.doc.line(toLine.number - 1);
      }
      const rawType = m[1];
      const foldChar = m[2] || null;
      const rawTitle = (m[3] || '').trim();
      const resolved = resolveCalloutType(rawType);
      const titleFrom = bodyStart + (m[0].length - m[3].length);
      out.push({
        pos: node.from,
        fromLineNum: fromLine.number,
        toLineNum: toLine.number,
        fromLineTo: fromLine.to,
        markerFrom: bodyStart,
        markerTo: rawTitle ? titleFrom : fromLine.to,
        titleFrom: rawTitle ? titleFrom : -1,
        titleTo: rawTitle ? fromLine.to : -1,
        canonical: resolved.canonical, color: resolved.color, icon: resolved.icon,
        foldChar,
        foldable: foldChar === '+' || foldChar === '-',
        title: rawTitle || defaultCalloutTitle(rawType, resolved.canonical),
        hasCustomTitle: !!rawTitle,
      });
    },
  });
  out.forEach(c => { c.folded = c.foldable && calloutFoldedState(c.pos, c.foldChar); });
  return out;
}

// Character-position spans of every currently-folded callout's own body
// (everything after its header line through its own extent) — same role as
// computeFoldedSpans (below) for headings, feeding the same three
// consumers: rendering collapse, atomicRanges, moveVerticalByLine.
function computeFoldedCalloutSpans(state, callouts) {
  // Folding is a Live Preview affordance — Source Mode shows raw markdown
  // with nothing collapsed, so a fold toggled before switching modes must not
  // keep hiding/blocking content (or skipping over it on Up/Down) once there.
  // sourceMode itself lives further down this file (declared later, but this
  // is only ever called at runtime, well after that declaration has run).
  if (sourceMode) return [];
  callouts = callouts || collectCallouts(state);
  const spans = [];
  for (const c of callouts) {
    if (!c.folded || c.toLineNum <= c.fromLineNum) continue;
    spans.push({ from: state.doc.line(c.fromLineNum + 1).from, to: state.doc.line(c.toLineNum).to });
  }
  return spans;
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
    if (u.docChanged && calloutFoldOverride.size) {
      // Remap explicit callout-fold overrides through the edit, same
      // reasoning/mechanism as foldPlugin's own foldedSet remap below.
      const remapped = new Map();
      for (const [pos, val] of calloutFoldOverride) {
        const mp = u.changes.mapPos(pos, 1);
        if (mp != null) remapped.set(mp, val);
      }
      calloutFoldOverride.clear();
      remapped.forEach((v, k) => calloutFoldOverride.set(k, v));
    }
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some(t => t.effects.some(e =>
          e.is(tasksRebuildEffect) || e.is(dataviewRebuildEffect) || e.is(calloutFoldEffect)))) {
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
      // Line numbers recognised as task-checkbox lines, so the plain ListMark→BulletWidget
      // replacement below can skip them (the task checkbox widget already covers that span).
      const taskLines = new Set();
      // Line numbers already given a `.cm-blockquote-line*` class — a nested
      // blockquote's own Blockquote node spans a subset of its parent's lines,
      // and the tree walk visits the outer one first (top-down `enter`), so
      // without this a nested `> > quote` line would get two separate
      // Decoration.line pushes at the exact same `line.from` point. That's the
      // same "two decorations at one point" collision documented elsewhere in
      // this file (see hiddenLineDeco's blank-line fix) for a line+replace
      // pair; here it'd be two same-point line decorations instead, with no
      // guarantee both survive the RangeSetBuilder merge. Tracking handled
      // lines and skipping on the (later-visited, nested) duplicate avoids
      // relying on that being safe at all.
      const blockquoteHandledLines = new Set();

      // ── Callouts — precomputed once per rebuild (whole-document, same
      // reasoning as collectHeadings/foldPlugin) so the tree walk below can
      // just consult calloutLineStack instead of re-detecting callouts
      // per-node, and so nested callouts combine into a single Decoration.line
      // per physical line instead of racing each other for one of CM6's "only
      // one decoration survives at an identical point" collisions. Order is
      // outer-first (collectCallouts' own tree walk visits parents before
      // children), so calloutLineStack's arrays are outer→inner.
      const calloutList = collectCallouts(state);
      // A callout's own "[!type]" marker parses as a shortcut-reference Link
      // node to lezer-markdown — the exact same "any [...] shape looks like a
      // link" quirk documented on the bare-`[text]`/`.cm-plain-brackets` check
      // further down this walk — so without this exclusion that check fires on
      // every callout header too, racing our own marker-replace decoration for
      // the same span and (when there's a custom title, so the two ranges
      // aren't identical-length) silently winning the "only one decoration
      // survives" collision documented throughout this file, leaving the
      // marker visibly raw. `node.from` for that Link node is exactly the "["
      // position, i.e. this callout's own `markerFrom`.
      const calloutMarkerFroms = new Set(calloutList.map(c => c.markerFrom));
      const calloutLineStack = new Map(); // line number -> descriptor[] (outer -> inner)
      for (const c of calloutList) {
        const effTo = c.folded ? c.fromLineNum : c.toLineNum;
        for (let cln = c.fromLineNum; cln <= effTo; cln++) {
          if (!calloutLineStack.has(cln)) calloutLineStack.set(cln, []);
          calloutLineStack.get(cln).push(c);
        }
      }
      for (const c of calloutList) {
        const headerActive = active.has(c.fromLineNum);
        // Fold chevron — deliberately not gated by headerActive: togglable
        // even while the title line is being edited, unlike the icon/title
        // below (which only render once editing moves off that line).
        if (c.foldable) {
          decs.push({ from: c.fromLineTo, to: c.fromLineTo,
            dec: Decoration.widget({ widget: new CalloutFoldToggle(c.pos, c.folded, c.color), side: 1 }) });
        }
        if (!headerActive) {
          decs.push({ from: c.markerFrom, to: c.markerTo,
            dec: Decoration.replace({ widget: new CalloutHeaderWidget(c.icon, c.color, c.hasCustomTitle ? '' : c.title) }) });
          if (c.hasCustomTitle) {
            decs.push({ from: c.titleFrom, to: c.titleTo,
              dec: Decoration.mark({ class: 'cm-callout-title', attributes: { style: `color:rgb(${c.color})` } }) });
          }
        }
      }
      for (const [cln, stack] of calloutLineStack) {
        const inner = stack[stack.length - 1];
        const effTo = inner.folded ? inner.fromLineNum : inner.toLineNum;
        let cls = 'cm-callout-line';
        if (inner.fromLineNum === effTo) cls += ' cm-callout-line-solo';
        else if (cln === inner.fromLineNum) cls += ' cm-callout-line-first';
        else if (cln === effTo) cls += ' cm-callout-line-last';
        const styleParts = [`--callout-color:${inner.color}`];
        if (stack.length > 1) {
          cls += ' cm-callout-nested';
          const shadows = [];
          for (let i = 0; i < stack.length - 1; i++) {
            shadows.push(`inset ${(i + 1) * 5}px 0 0 0 rgba(${stack[i].color}, 0.85)`);
          }
          styleParts.push(`--callout-nest-shadow:${shadows.join(',')}`);
        }
        const line = state.doc.line(cln);
        lineDecs.push({ from: line.from,
          dec: Decoration.line({ class: cls, attributes: { style: styleParts.join(';') } }) });
      }
      // Collapse every line within each currently-folded callout's body —
      // same blank-line-guarded technique as foldPlugin's own heading-fold
      // collapse (see hiddenLineDeco's own comment for why the guard matters).
      for (const { from, to } of computeFoldedCalloutSpans(state, calloutList)) {
        const startLn = state.doc.lineAt(from).number;
        const endLn = state.doc.lineAt(to).number;
        for (let cln = startLn; cln <= endLn; cln++) {
          const line = state.doc.line(cln);
          if (line.to > line.from) decs.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
          lineDecs.push({ from: line.from, dec: hiddenLineDeco('cm-fold-hidden') });
        }
      }

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
          if (node.name === 'BulletList' || node.name === 'OrderedList') { listDepth--; }
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
          //
          // Checked against `node.to <= fm.to` — whether the node is fully
          // *contained inside* the frontmatter block — not whether its own
          // start line merely falls at or before the frontmatter's closing
          // line. That second (original) check matched the tree's own root
          // `Document` node too: it always starts on line 1, which is always
          // "<= fmCloseLine" whenever a frontmatter exists at all, so `enter`
          // returned `false` for the *root* itself the very first time it
          // ran — and returning false stops the walk from descending into
          // that node's children at all, meaning nothing after the
          // frontmatter (headings, lists, code fences, tables, wiki-links,
          // ...) was ever visited, for the rest of the document, on *any*
          // note that had a frontmatter block. Confirmed with a real
          // `EditorState` and a full tree dump (throwaway script, not
          // checked in): the old check's very first log line was `BAIL
          // Document from=0 to=<wholeDocLength>`. Reported as "cuando hay un
          // frontmatter en la página, los estilos dejan de aplicarse" — every
          // heading showed its raw "#", every list its raw "*"/"-", every
          // fenced code block its raw backticks, unconditionally, on any
          // frontmatter-containing note. `node.to <= fm.to` instead only
          // matches a node whose *entire* span sits inside the frontmatter
          // (the same dump confirmed this correctly bails on the
          // frontmatter's own `HorizontalRule`/`Paragraph`/`BulletList`
          // nodes while leaving `Document` — and everything after the
          // frontmatter — alone).
          if (fmCloseLine > 0 && node.to <= fm.to) { return false; }

          // ── Lists — indentation + spacing from the preceding block ────────
          if (n === 'BulletList' || n === 'OrderedList') {
            if (listDepth === 0) { awaitingFirstItem = true; }
            listDepth++;
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
            // classes below. `markerW` depends on the *current* (innermost)
            // list's own type — a fixed, tight reservation per type (not one
            // shared value wide enough to fit a 3-digit ordered marker, which
            // read as an oversized gap after a plain bullet — see the
            // ListMark handling's own comment for the two-round history
            // here), matching Obsidian's own compact spacing. The ListMark
            // handling further down gives the raw marker text itself (an
            // active-line bullet, or any ordered marker, which is never
            // BulletWidget-replaced at all) the same per-type width, so the
            // marker's actual rendered footprint always equals what this
            // formula reserves regardless of active/inactive state.
            const isOrderedItem = node.node.parent && node.node.parent.name === 'OrderedList';
            const markerW = isOrderedItem ? LIST_ORDERED_MARKER_WIDTH_EM : LIST_BULLET_MARKER_WIDTH_EM;
            // Per-level nesting indent used to be a hardcoded 1.5em multiplier,
            // ignoring the vault theme's own --list-indent (a real Obsidian CSS
            // var — Border, e.g., sets it to 2em). Reading it via calc() means a
            // theme that customizes list indentation is actually respected here,
            // instead of this editor always reserving a fixed amount regardless
            // of what the loaded theme asks for. Falls back to 2em (Obsidian's
            // own conventional default) when no theme (or an unrelated one) is
            // loaded, so unstyled/default vaults aren't affected by this change.
            const nestPart = `calc(var(--list-indent, 2em) * ${depth})`;
            const firstLineStyle = `padding-left:calc(${nestPart} + ${markerW}em);text-indent:-${markerW}em`;
            const contLineStyle = `padding-left:calc(${nestPart} + ${markerW}em)`;
            // Task checkbox lines read flush with the surrounding prose's left margin
            // instead of indented like a regular list item — a checklist isn't "a sublist
            // of the document", Obsidian's own Tasks plugin renders a top-level one the
            // same way. Shifts the whole indent formula left by exactly one nesting level
            // (`depth - 1` instead of `depth`) rather than hardcoding 0, so a *nested* task
            // (depth 2+ — a subtask under another task, or under a plain bullet) still
            // reads one level deeper than its parent; only the true top level (depth 1)
            // lands at 0.
            const taskNestPart = `calc(var(--list-indent, 2em) * ${depth - 1})`;
            const taskFirstLineStyle = `padding-left:calc(${taskNestPart} + ${markerW}em);text-indent:-${markerW}em`;
            const taskContLineStyle = `padding-left:calc(${taskNestPart} + ${markerW}em)`;

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
          // Rendered unconditionally — *not* gated behind `!isActive` the way this used to be
          // (and the way most other live-preview elements still are): every `<td>`/`<th>` TableWidget
          // renders is itself `contentEditable`, committing edits straight back to the document via
          // `mutateTableAt` (see TableWidget/commitTableCell above) the same way `PropertiesWidget`'s
          // real `<input>`s already do for frontmatter — so there's no more "reveal raw `| pipe |`
          // source to let you edit it" fallback to fall back to. Reported as "can't fill a table with
          // data — the cursor landing on any of its lines just drops into raw markdown mode instead of
          // letting me type into a cell," which was this `isActive` check doing exactly what it was
          // written to do, for a widget that (until now) had no other way to accept input.
          if (n === 'Table') {
            try {
              const fromLine = state.doc.lineAt(node.from);
              // computeTableEndLine, not node.to directly — see its own long
              // comment (just above findTableRangeAt) for why trusting the
              // syntax node's own end here swallowed whatever the user typed
              // on the very next line as soon as it stopped being blank.
              const toLine   = computeTableEndLine(state, fromLine, node.to);

              const src = state.doc.sliceString(fromLine.from, toLine.to);
              // First line replaced by the rendered widget (single-line, safe)
              decs.push({ from: fromLine.from, to: fromLine.to,
                dec: Decoration.replace({ widget: new TableWidget(view, fromLine.from, src) }) });
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
            if (isActive) {
              // Raw mode (cursor somewhere inside) intentionally shows this
              // block completely unrendered — no marker hiding, no box
              // styling, per the block-wide design above — but mdHighlight's
              // own unconditional syntax highlighting still tags a fenced
              // block's CodeText with the exact same tags.monospace class
              // InlineCode gets (see the long "Inline code vs. fenced code
              // block styling" comment near vsTheme), giving each raw
              // content line the small standalone-inline-code "chip" look —
              // background, padding, border-radius — fragmented one chip per
              // *line*, since a highlighted range can't span a block
              // boundary as a single element, so a multi-line block reads as
              // a stack of disconnected pills instead of plain raw text.
              // Reported as "el texto tiene un estilo raro (se aplica un
              // background solo al texto)." The existing `.cm-code-block
              // .cm-inline-code` override (below, in vsTheme) only ever
              // fires once the block is actually rendered/collapsed — that
              // class is never applied while raw — so it doesn't reach this
              // case. This pushes a *different*, minimal marker class over
              // the exact same lines instead, active or not, purely so
              // `.cm-raw-code-line .cm-inline-code` (vsTheme) can cancel the
              // chip look unconditionally — deliberately not reusing
              // `.cm-code-block` itself, which also carries background/
              // border/padding for the *collapsed* box look that raw mode
              // must NOT get (the user confirmed raw mode itself is fine,
              // only the per-line chip background is the problem).
              for (let ln = fromLine.number; ln <= toLine.number; ln++) {
                lineDecs.push({ from: state.doc.line(ln).from, dec: Decoration.line({ class: 'cm-raw-code-line' }) });
              }
              return false;
            }

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

          // ── Blockquotes — card-style box, active + inactive (mirrors headings
          // just below: the box stays on even while editing a line inside it;
          // only the raw "> " marker itself, QuoteMark further down this same
          // switch, hides/reveals per active line) ──────────────────────────
          if (n === 'Blockquote') {
            try {
              const fromLine = state.doc.lineAt(node.from);
              // node.to normally lands right at the end of the block's last
              // quoted line (a blank line always terminates a blockquote in
              // CommonMark, so — unlike FencedCode while unclosed — there's no
              // "runs away to EOF" case to guard against here). The one edge
              // case worth handling: node.to landing exactly on the *next*
              // line's own start (i.e. including the trailing newline), which
              // would make a naive `lineAt(node.to)` report one line too many.
              let toLine = state.doc.lineAt(node.to);
              if (toLine.from === node.to && toLine.number > fromLine.number) {
                toLine = state.doc.line(toLine.number - 1);
              }
              for (let bln = fromLine.number; bln <= toLine.number; bln++) {
                if (blockquoteHandledLines.has(bln)) continue;
                blockquoteHandledLines.add(bln);
                // A callout (or a plain quote nested inside one) gets its own
                // box styling from the dedicated callout pass above instead —
                // see collectCallouts/calloutLineStack, just above this walk.
                if (calloutLineStack.has(bln)) continue;
                const line = state.doc.line(bln);
                let cls = 'cm-blockquote-line';
                if (fromLine.number === toLine.number) cls += ' cm-blockquote-line-solo';
                else if (bln === fromLine.number) cls += ' cm-blockquote-line-first';
                else if (bln === toLine.number) cls += ' cm-blockquote-line-last';
                lineDecs.push({ from: line.from, dec: Decoration.line({ class: cls }) });
              }
            } catch (_) {}
            // Don't return false — QuoteMark, nested lists/blockquotes and the
            // quoted text itself still need their own normal processing.
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
              !(!activeLinkClosed && activeLinkFrom === node.from - 1) &&
              !calloutMarkerFroms.has(node.from)) {
            decs.push({ from: node.from, to: node.to, dec: Decoration.mark({
              class: 'cm-plain-brackets',
              attributes: { style: plainBracketFontSizeStyle(node) },
            }) });
          }

          if (n === 'ListMark') {
            // Task-checkbox lines are already fully replaced by TaskCheckboxWidget
            // (added while processing the enclosing ListItem, above) — skip the plain
            // bullet replacement so the two decorations don't overlap.
            if (taskLines.has(ln)) { return false; }
            const markText = state.doc.sliceString(node.from, node.to);
            const isBullet = /^[-*+]$/.test(markText);
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
            // Deliberately NOT gated behind the active-line check below (unlike
            // every other marker-hiding case in this walk) — a list marker's
            // own rendered *width*, not just whether it's shown raw or hidden,
            // has to stay identical across active/inactive lines, or the
            // hanging-indent math above (the ListItem handling's own
            // per-type `markerW`) stops matching what's actually on screen.
            // Before this fix: an inactive bullet line got BulletWidget's
            // fixed-width `.cm-list-bullet` span, but an *active* bullet line
            // fell through to plain raw "- "/"* " text at its own (narrower)
            // natural width, and an ordered marker ("1. ", "10. ", "100. ")
            // was never width-constrained at all — active or not, since it
            // never matches `/^[-*+]$/` and so never got BulletWidget either.
            // Net effect: the paragraph text right after the marker visibly
            // jumped left/right depending on whichever of those cases was on
            // screen. Reported as "la lista de viñetas tiene alineación
            // diferente dependiendo si la estás editando o no esa linea".
            // Fixed by giving the raw marker text — active bullet lines, and
            // ordered lists unconditionally — the same fixed-width
            // inline-block box (`cm-list-marker-raw`) that BulletWidget
            // already uses on an inactive bullet line, so both states of a
            // bullet marker reserve identical width.
            //
            // Marker width, round two: the *first* version of this fix used
            // one shared width for both bullet and ordered markers (wide
            // enough to fit a 3-digit ordered number like "100."), on the
            // theory that a bulleted and an ordered list's own text should
            // line up at the same column. Reported back against a real
            // Obsidian screenshot of the same text: Obsidian's own spacing is
            // much tighter, and doesn't actually force bullet/ordered text to
            // share a column either (a "•" and a "1." don't occupy the same
            // rendered width to begin with). Reverted to a per-type width —
            // `LIST_BULLET_MARKER_WIDTH_EM`/`LIST_ORDERED_MARKER_WIDTH_EM`,
            // both tighter than the original pre-session values — chosen
            // purely via the inline style below rather than the shared class,
            // so this decoration (not just `.cm-list-bullet`) can vary width
            // by marker type. The active/inactive-jump fix above is
            // independent of this and still holds either way.
            const markerW = isBullet ? LIST_BULLET_MARKER_WIDTH_EM : LIST_ORDERED_MARKER_WIDTH_EM;
            if (isBullet && !active.has(ln)) {
              decs.push({ from: node.from, to: end, dec: Decoration.replace({ widget: new BulletWidget() }) });
            } else {
              decs.push({ from: node.from, to: end, dec: Decoration.mark({
                class: 'cm-list-marker-raw',
                attributes: { style: `width:${markerW}em` },
              }) });
            }
            return false;
          }

          if (active.has(ln)) return;

          // ── Horizontal rule ("---"/"***"/"___" on its own line) ──────────
          // The frontmatter delimiters are their own "---" lines too, but
          // those are already fully bailed out of this walk above (any node
          // with `node.to <= fm.to`), so a HorizontalRule only ever reaches
          // this branch when it's a real thematic break in the document body.
          if (n === 'HorizontalRule') {
            const line = state.doc.lineAt(node.from);
            decs.push({ from: line.from, to: line.to, dec: Decoration.replace({ widget: new HorizontalRuleWidget() }) });
            return false;
          }

          if (n === 'HeaderMark') {
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
            decs.push({ from: node.from, to: end, dec: Decoration.replace({}) });
            return false;
          }
          // Blockquote's "> " prefix — one QuoteMark node per quoted line (lezer
          // pushes a fresh one for every line, including continuation lines —
          // confirmed against @lezer/markdown's own DefaultSkipMarkup.Blockquote).
          // Same hide-on-non-active-line treatment as HeaderMark: the block's
          // own card styling (.cm-blockquote-line*, pushed above) stays on
          // regardless, only the raw "> " marker itself reveals while editing.
          if (n === 'QuoteMark') {
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
            decs.push({ from: node.from, to: end, dec: Decoration.replace({}) });
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

// ── ==highlight== plugin ──────────────────────────────────────────────────────
// `==text==` isn't real CommonMark/GFM syntax, so lezer-markdown never parses it into a
// syntax-tree node — unlike bold/italic/strikethrough (EmphasisMark/StrikethroughMark, handled
// in livePreviewPlugin's own tree walk via mdHighlight's tag-based styling), there's nothing to
// hook a tag onto here. Implemented the same way mdLinkPlugin/wikiLinkPlugin already handle their
// own non-tree-based syntax: a plain regex scan over the viewport. Unlike mdLinkPlugin's
// whole-match widget replacement (which shows fully raw text with no styling at all while
// active), this mirrors bold/italic/strikethrough's actual convention instead — the highlighted
// *text* stays visually marked regardless of cursor position (a `Decoration.mark` over the inner
// span, not gated on `active`), and only the raw "==" markers hide on non-active lines, exactly
// like `**`/`*`/`~~` do for their own markers.
const highlightMarkPlugin = ViewPlugin.fromClass(class {
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
    const re = /==([^=\n]+?)==/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      all.push({ from: mFrom + 2, to: mTo - 2, dec: Decoration.mark({ class: 'cm-highlight' }) });
      if (!active.has(ln)) {
        all.push({ from: mFrom,     to: mFrom + 2, dec: Decoration.replace({}) });
        all.push({ from: mTo - 2,   to: mTo,       dec: Decoration.replace({}) });
      }
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

// ── Highlightr-style `<mark>` rendering + apply/remove ────────────────────────
function highlighterSlug(name) {
  // Strip combining diacritical marks (U+0300-U+036F) by character code
  // rather than a regex Unicode-range literal — this file has a documented
  // history of literal Unicode bytes silently corrupting in source under
  // concurrent edits (see the dataviewCacheKey NUL-byte gotcha elsewhere in
  // this file), so an explicit charCodeAt check avoids relying on any such
  // literal surviving intact at all.
  const decomposed = String(name).toLowerCase().normalize('NFD');
  let stripped = '';
  for (const ch of decomposed) {
    const code = ch.codePointAt(0);
    if (code < 0x0300 || code > 0x036f) stripped += ch;
  }
  return stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'color';
}
// Matches exactly what applyHighlight (below) writes: either a style-based mark
// (this codebase's own default) or a class-based one (obsidianLike.highlighterUseCssClasses —
// the Highlightr-plugin-compatible alternative). Single-line only, same scope as ==highlight==.
const HTML_HIGHLIGHT_RE_SRC = '<mark(?: style="background-color:\\s*([^;"]+);?"| class="(hltr-[\\w-]+)")[^>]*>([^\\n]*?)<\\/mark>';

const htmlHighlightPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) { this.decorations = this._build(u.view); }
  }
  _build(view) {
    const { state } = view;
    const active = getActiveLines(state);
    const { from: vf, to: vt } = view.viewport;
    const str = state.doc.sliceString(vf, vt);
    const re = new RegExp(HTML_HIGHLIGHT_RE_SRC, 'gi');
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const openLen = m[0].indexOf('>') + 1;
      const innerFrom = mFrom + openLen;
      const innerTo   = mTo - '</mark>'.length;
      if (innerTo <= innerFrom) continue;
      const ln = state.doc.lineAt(mFrom).number;
      const spec = { class: 'cm-html-highlight' + (m[2] ? ' ' + m[2] : '') };
      if (m[1]) spec.attributes = { style: `background-color:${m[1]};` };
      all.push({ from: innerFrom, to: innerTo, dec: Decoration.mark(spec) });
      if (!active.has(ln)) {
        all.push({ from: mFrom,     to: innerFrom, dec: Decoration.replace({}) });
        all.push({ from: innerTo,   to: mTo,       dec: Decoration.replace({}) });
      }
    }
    all.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of all) {
      if (from !== to && from < lastTo) continue;
      try { builder.add(from, to, dec); } catch (_) {}
      if (to > lastTo) lastTo = to;
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// Finds a `<mark>...</mark>` whose *inner* content exactly matches [from, to) —
// i.e. the current selection sits precisely on an existing highlight's text —
// used so re-applying the same color toggles it off instead of double-wrapping,
// and so a right-click / toolbar can offer "Quitar resaltado" only when relevant.
function findEnclosingMark(state, from, to) {
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return null; // marks are single-line only here
  const re = new RegExp(HTML_HIGHLIGHT_RE_SRC, 'gi');
  let m;
  while ((m = re.exec(line.text)) !== null) {
    const mFrom = line.from + m.index;
    const mTo   = mFrom + m[0].length;
    const openLen = m[0].indexOf('>') + 1;
    const innerFrom = mFrom + openLen;
    const innerTo   = mTo - '</mark>'.length;
    if (innerFrom === from && innerTo === to) {
      return { mFrom, mTo, innerFrom, innerTo, color: m[1] || null, cls: m[2] || null };
    }
  }
  return null;
}

function highlightOpenTag(color, name) {
  return highlighterUseCssClasses
    ? `<mark class="hltr-${highlighterSlug(name)}">`
    : `<mark style="background-color:${color};">`;
}

// Applies `color`/`name` to the current selection: wraps it in a fresh
// <mark>, rewrites an already-wrapped selection's color in place, or — if
// the selection is already wrapped in *this same* color — unwraps it
// (toggle off), matching the reference plugin's own "click again to remove"
// behavior described in its README.
function applyHighlight(view, color, name) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return;
  const existing = findEnclosingMark(state, sel.from, sel.to);
  const cls = 'hltr-' + highlighterSlug(name);
  const isSameColor = existing && (highlighterUseCssClasses
    ? existing.cls === cls
    : !!existing.color && existing.color.trim().toLowerCase() === color.toLowerCase());
  let changes, newSel;
  if (existing && isSameColor) {
    const inner = state.sliceDoc(existing.innerFrom, existing.innerTo);
    changes = { from: existing.mFrom, to: existing.mTo, insert: inner };
    newSel = EditorSelection.range(existing.mFrom, existing.mFrom + inner.length);
  } else if (existing) {
    const openTag = highlightOpenTag(color, name);
    changes = { from: existing.mFrom, to: existing.innerFrom, insert: openTag };
    const delta = openTag.length - (existing.innerFrom - existing.mFrom);
    newSel = EditorSelection.range(existing.innerFrom + delta, existing.innerTo + delta);
  } else {
    const openTag = highlightOpenTag(color, name);
    const text = state.sliceDoc(sel.from, sel.to);
    changes = { from: sel.from, to: sel.to, insert: openTag + text + '</mark>' };
    newSel = EditorSelection.range(sel.from + openTag.length, sel.from + openTag.length + text.length);
  }
  view.dispatch({ changes, selection: newSel, userEvent: 'input.highlight' });
  view.focus();
}

function removeHighlight(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return;
  const existing = findEnclosingMark(state, sel.from, sel.to);
  if (!existing) return;
  const inner = state.sliceDoc(existing.innerFrom, existing.innerTo);
  view.dispatch({
    changes: { from: existing.mFrom, to: existing.mTo, insert: inner },
    selection: EditorSelection.range(existing.mFrom, existing.mFrom + inner.length),
    userEvent: 'input.highlight',
  });
  view.focus();
}

// ── Wiki-link plugin ──────────────────────────────────────────────────────────
// Dispatched by the `note-index` message handler so wikiLinkPlugin re-checks
// which links resolve — unlike docChanged/selectionSet/viewportChanged, a
// noteIndex update carries no doc/viewport change of its own to key off of.
const noteIndexRebuildEffect = StateEffect.define();

// { level, text } for every ATX heading in the *currently open* document —
// mirrors the host's parseHeadings() (same "1-6 #'s, text, optional trailing
// #'s" shape) but reads the already-open CM6 state directly rather than a
// vscode.workspace.openTextDocument round-trip, since this document's own
// text is already right here. Backs same-document `[[#section]]` links (see
// noteTargetExists and WikiSuggestView.recompute below) — those don't name a
// note at all, so there's nothing to look up in noteIndex/get-headings for.
function currentDocHeadings(state) {
  const headings = [];
  syntaxTree(state).iterate({
    enter(node) {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (m) {
        const line = state.doc.lineAt(node.from);
        const hm = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.text);
        headings.push({ level: +m[1], text: hm ? hm[1].trim() : '' });
        return false;
      }
    }
  });
  return headings;
}

// Mirrors resolveNoteUri's rules host-side (splitTarget + splitDirHint): a
// target may carry a "#section" suffix (irrelevant to existence) and a single
// directory-hint segment (`folder/Note`, only the immediate parent name).
// Existence only, not full resolution — doesn't need to know the *current*
// note's directory, since "no hint" existence is "some note has this name
// anywhere" (same-dir-first vs. vault-wide fallback both resolve if either
// matches) and "with hint" existence just needs a name+parent-dir match.
//
// `state` (optional, the CM6 state of the currently open document) is only
// consulted for the `[[#section]]` case below — a target with no note part
// at all isn't a note lookup, it's a same-document heading reference, so
// checking it against noteIndex (which only tracks note names) always
// resolved to "no note is named ''" and rendered every such link as broken,
// even when the section heading genuinely exists in this very document.
function noteTargetExists(rawTarget, state) {
  // A .docx/.xlsx/.pdf target isn't in noteIndex (that only tracks .md notes)
  // — there's no cheap client-side way to check whether it actually exists in
  // the vault without a new round-trip, so it's treated as always-resolved
  // rather than incorrectly dimming a link that in fact opens fine (host-side
  // resolution at click time is what actually matters for whether it works).
  if (isExternalFileTarget(rawTarget)) return true;
  const hashIdx = rawTarget.indexOf('#');
  const notePart = hashIdx === -1 ? rawTarget : rawTarget.slice(0, hashIdx);
  if (!notePart) {
    const section = (hashIdx === -1 ? '' : rawTarget.slice(hashIdx + 1)).trim().toLowerCase();
    if (!section || !state) return true;
    return currentDocHeadings(state).some(h => h.text.toLowerCase() === section);
  }
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
// cursor deliberately lands inside it — typing/deleting, Left/Right, Home/End,
// or a mouse click. The one deliberate exception is Up/Down: moveVerticalByLine's
// column-preserving landing spot inside a link on the way to a different line
// is essentially arbitrary, not something the user aimed for, so a vertical
// move that merely *passes through* a link must never newly activate it —
// only clear an already-active one once the cursor ends up outside it (see
// `dispatchingVerticalMove` below). Once activated, a link *stays* raw —
// including through further navigation of any kind within the same link —
// until the cursor moves outside its outer brackets, at which point it
// reverts to normal rendering.
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

  // Fresh instance per call — see WIKI_LINK_RE_SRC's own comment for both the
  // nested-bracket-aware pattern and why this can't share a RegExp object
  // with wikiLinkPlugin's own independent .exec() loop.
  const closedRe = new RegExp(WIKI_LINK_RE_SRC, 'g');
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
    // Any deliberate cursor move (edit, Left/Right, Home/End, a mouse click)
    // can *newly* activate a link the cursor lands inside. The one exception
    // is a vertical (Up/Down) move — see dispatchingVerticalMove's own comment
    // and the block comment above this plugin — which only ever falls through
    // to the "clear if now outside" branch below, never activates fresh.
    if (userEdited || (u.selectionSet && !dispatchingVerticalMove)) {
      const ctx = findLinkContextAt(u.state, u.state.selection.main.head);
      if (ctx) { activeLinkFrom = ctx.from; activeLinkTo = ctx.to; activeLinkClosed = ctx.closed; }
      else { activeLinkFrom = activeLinkTo = null; }
      return;
    }

    // Vertical-move pass-through (or a non-user-input doc change with no
    // selection change at all): never *newly* activates — only clears an
    // existing activation once the cursor ends up outside it.
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
    // Nested-bracket-aware — see WIKI_LINK_RE_SRC's own comment.
    const re = new RegExp(WIKI_LINK_RE_SRC, 'g');
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      if (isLinkActivated(mFrom, mTo)) continue;
      const name  = m[1];
      const alias = m[2];
      const linkClass = 'cm-wiki-link' + (noteTargetExists(name, state) ? '' : ' cm-wiki-link-missing');
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

// A wiki-link/transclusion target ending in *any* extension other than a
// recognized image one (IMG_EXT, handled separately by imgPlugin) or `.md`
// (a plain note reference) opens (or embeds a clickable "open" box for) the
// real file with the OS's own default application (vscode.env.openExternal
// on the host side) instead of being treated as a markdown note reference —
// see `isExternalFileTarget`, `ExternalFileWidget`, and the
// `open-external-file` message handler. Matches real Obsidian's own
// behavior for any non-note, non-image attachment.
//
// Previously a fixed list (`.docx|.xlsx|.pdf` only) — reported as "no
// funciona" for a `.zip`/`.txt` link or embed: falling outside that list
// meant it went through the normal note-resolution path instead, which
// appends ".md" and searches for that, so a real "archivo.zip" in the vault
// was never going to match a search for "archivo.zip.md" and always showed
// a false "not found", even though the file plainly exists (and Obsidian
// itself opens it fine). Matched by shape (any `.ext` suffix) rather than an
// enumerated list, so this covers whatever attachment type shows up next
// without needing another list update.
const EXTERNAL_FILE_EXT = /\.[a-z0-9]+$/i;
function isExternalFileTarget(raw) {
  const filename = (raw || '').split('#')[0].split('|')[0].trim();
  return EXTERNAL_FILE_EXT.test(filename) && !IMG_EXT.test(filename) && !/\.md$/i.test(filename);
}
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
    // Nested-bracket-aware — see EMBED_RE_SRC's own comment.
    const re = new RegExp(EMBED_RE_SRC, 'g');
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
// A delimiter row (the required second line of a GFM table, e.g. "| --- | :---: |")
// contains nothing but dashes/colons/pipes/whitespace — checked against the line
// *after* a candidate header line to tell a real table apart from a paragraph
// line that merely happens to contain a "|" character.
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

// Renders a read-only <table> from consecutive pipe-containing lines starting at
// lines[startIdx] — same parseTableSrc/tableAligns this file already uses for the
// live, editable TableWidget, just without any of its contentEditable/keydown
// wiring, since transcluded content isn't meant to be edited in place (editing
// happens in the source note). Returns the DOM node plus the index just past the
// last table line consumed, so the caller's line-scanning loop can resume there.
function renderMarkdownTable(lines, startIdx) {
  let i = startIdx;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { i++; }
  const t = parseTableSrc(lines.slice(startIdx, i).join('\n'));
  if (!t) return null;
  const aligns = tableAligns(t);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow-x:auto;margin:0.4em 0;';
  const table = document.createElement('table');
  table.className = 'cm-table';
  table.style.cssText = 'border-collapse:collapse;width:100%;font-size:inherit;font-family:inherit;color:inherit;';
  const BORDER   = '1px solid rgba(128,128,128,0.38)';
  const CELL     = `border:${BORDER};padding:5px 12px;line-height:1.5;vertical-align:top;color:inherit;`;
  const TH_EXTRA = 'font-weight:600;background:rgba(128,128,128,0.12);';

  const thead = document.createElement('thead');
  const hRow  = document.createElement('tr');
  t.header.forEach((h, ci) => {
    const th = document.createElement('th');
    th.style.cssText = CELL + TH_EXTRA + `text-align:${aligns[ci] || 'left'};`;
    th.innerHTML = renderCell(h);
    hRow.appendChild(th);
  });
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  t.rows.forEach((row, ri) => {
    const tr = document.createElement('tr');
    if (ri % 2 === 1) tr.style.background = 'rgba(128,128,128,0.05)';
    row.forEach((cell, ci) => {
      const td = document.createElement('td');
      td.style.cssText = CELL + `text-align:${aligns[ci] || 'left'};`;
      td.innerHTML = renderCell(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return { el: wrap, next: i };
}

// A "![[...]]" embed found on its own line inside transcluded content. Until
// now this fell through to the generic paragraph case (renderMarkdownBlock's
// own line-accumulation, feeding renderCell — which only understands inline
// markdown, not "![[...]]" embed syntax) and rendered as inert escaped text,
// e.g. a literal "![[foto.png]]" instead of the actual image. Reused
// ImageWidget/ExternalFileWidget's own toDOM() rather than re-implementing
// either: same imageMap lookup imgPlugin itself uses (basename fallback
// included), same clickable open-externally box for a non-image attachment.
// Returns null for anything this doesn't recognize (an unresolved image, or
// a nested note transclusion) — the caller then falls back to the original
// plain-text rendering, unchanged.
function renderEmbedBlock(raw) {
  const pipeIdx = raw.indexOf('|');
  const targetPart = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw).trim();
  const param = pipeIdx >= 0 ? raw.slice(pipeIdx + 1).trim() : '';
  const filename = targetPart.split('#')[0].trim();
  if (IMG_EXT.test(filename)) {
    const basename = filename.split('/').pop();
    const src = imageMap[filename] || imageMap[basename] || '';
    if (!src) return null;
    let width = null, caption = null;
    if (param) {
      if (/^\d+(?:px)?$/i.test(param)) width = parseInt(param, 10) + 'px';
      else caption = param;
    }
    return new ImageWidget(src, filename, width, caption).toDOM();
  }
  if (isExternalFileTarget(filename)) {
    return new ExternalFileWidget(targetPart).toDOM();
  }
  return null;
}

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
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      const table = renderMarkdownTable(lines, i);
      if (table) { frag.appendChild(table.el); i = table.next; continue; }
    }
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
    // A "![[...]]" embed alone on its own line — see renderEmbedBlock's own
    // comment. Checked before the generic bullet-list branch below since a
    // line starting with "!" never matches that branch's own "[-*+]" test.
    const embedM = /^\s*!\[\[([^\]]+)\]\]\s*$/.exec(line);
    if (embedM) {
      const node = renderEmbedBlock(embedM[1]);
      if (node) { flushPara(); frag.appendChild(node); i++; continue; }
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0.3em 0;padding-left:1.4em;';
      while (i < lines.length) {
        const lm = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!lm) break;
        const li = document.createElement('li');
        // Task checkbox lines ("- [ ] .../- [x] ...") get the same
        // checkbox + done styling as the live editor's TaskCheckboxWidget
        // (read-only here — reused via a plain disabled <input>/status-icon
        // <span>, same convention already used for a dataview TASK block's
        // rows, since editing a transcluded task in place doesn't make
        // sense). Previously fell through to the plain-<li> branch below,
        // which just ran the whole line (including its own "[ ] "/"[x] "
        // literal text) through renderCell — no checkbox, no strikethrough.
        const taskM = TASK_LINE_RE.exec(lines[i]);
        if (taskM) {
          const statusChar = taskM[3];
          const isDone = /[xX-]/.test(statusChar);
          li.className = `cm-task-line${isDone ? ' cm-task-done' : ''}`;
          li.style.listStyle = 'none';
          if (statusChar === ' ') {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'cm-task-checkbox';
            cb.disabled = true;
            li.appendChild(cb);
          } else {
            const icon = document.createElement('span');
            icon.className = 'cm-task-checkbox';
            icon.textContent = STATUS_ICON[statusChar] || statusChar;
            li.appendChild(icon);
          }
          const desc = document.createElement('span');
          desc.innerHTML = renderCell(taskM[4]);
          li.appendChild(desc);
        } else {
          li.innerHTML = renderCell(lm[1]);
        }
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

// A "![[file.docx/.xlsx/.pdf]]" embed can't be rendered as markdown text the
// way a note transclusion can — there's no content to fetch/slice a section
// out of — so transclusionPlugin routes these here instead of into
// TransclusionWidget/get-transclusion: a simple clickable box naming the
// file, opening it with the OS's default application on click (same
// `open-external-file` message a plain [[file.docx]] link sends — see
// isWikiLinkEl's click handler and EXTERNAL_FILE_EXT).
class ExternalFileWidget extends WidgetType {
  constructor(target) { super(); this.target = target; }
  eq(other) { return this.target === other.target; }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-external-file';
    box.dataset.target = this.target;
    box.title = 'Abrir con la aplicación del sistema';
    const icon = document.createElement('span');
    icon.className = 'cm-external-file-icon';
    icon.textContent = '📎';
    const name = document.createElement('span');
    name.className = 'cm-external-file-name';
    name.textContent = this.target;
    box.appendChild(icon);
    box.appendChild(name);
    return box;
  }
  ignoreEvent() { return false; }
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
    // Nested-bracket-aware — see EMBED_RE_SRC's own comment.
    const re = new RegExp(EMBED_RE_SRC, 'g');
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
      // A non-note, non-image embed (.docx/.xlsx/.pdf/.zip/.txt/...) has no
      // text content to fetch/render — see ExternalFileWidget's own comment —
      // so it never goes through the get-transclusion round-trip at all.
      // isExternalFileTarget (not a direct EXTERNAL_FILE_EXT test) so a
      // literal ".md" suffix still falls through to the normal transclusion
      // path below rather than being misrouted here.
      if (isExternalFileTarget(filenameGuess)) {
        all.push({ from: mFrom, to: mTo, dec: Decoration.replace({ widget: new ExternalFileWidget(raw) }) });
        continue;
      }
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

// ── Table context menu (create / manage rows & columns) ────────────────────────
// Right-clicking a rendered table (TableWidget's own <table class="cm-table">,
// tagged above) shows a small floating menu for adding/removing the row or
// column under the pointer; right-clicking anywhere else in the editor offers
// "Crear tabla" to insert a new one. This replaces the native browser/VS Code
// context menu inside the editor (`e.preventDefault()` below) — table editing
// doesn't have any other entry point in this editor (there's no ribbon/toolbar),
// so a context menu is the only reasonable place for it, same as Obsidian's own.

// A GFM table has no blank-line-terminated boundary the way this editor
// needs one — per spec (and confirmed against lezer-markdown's own actual
// behavior with a real EditorState, throwaway script, not checked in), a
// `Table` node keeps absorbing *any* subsequent non-blank line as a "lazy
// continuation" row, pipe character or not, stopping only at a genuine blank
// line or EOF. That's correct GFM parsing, but disastrous for a widget whose
// whole replaced range is derived from this node: the instant the user types
// a single character on the blank line right after a table — the most
// natural place to start writing the next paragraph — that line (and
// everything non-blank after it, until the next real blank line) gets pulled
// into the *same* Table node. `TableWidget`'s own `parseTableSrc` silently
// drops any line without a "|" from what it renders as a row, so that typed
// text doesn't just render wrong, it vanishes from view entirely while still
// occupying document positions inside the widget's own takeover range — and
// the next table edit's `serializeTable` call, having never parsed it as
// anything, deletes it outright. Reported over two rounds as "todo se vuelve
// loco" (typed text ending up spliced into the table, then — after the
// selection-mapping fix — fragmenting into stray single characters on
// separate lines instead): both were downstream symptoms of this same
// oversized range, not separate bugs. Confirmed directly: typing one
// character on the blank line after a 5-line table grew the syntax tree's
// own Table node from 5 lines to 7, immediately swallowing a `![[...]]`
// embed on the line after too.
//
// Fix: never trust the syntax node's own `.to` as the table's *effective*
// end for rendering/editing purposes. Walk forward from the header line
// instead, including a line only while it still looks like table syntax (a
// literal "|"), and stop at the first one that doesn't — mirroring
// `parseTableSrc`'s own row filter, so the range this editor treats as "the
// table" and the range `parseTableSrc` actually turns into rows always
// agree. The syntax node's own `.to` is still used as an outer bound (a
// table can't be *narrower* than what lezer parsed, only this editor's own
// notion of where it *effectively* ends needs to be narrower than lezer's).
function computeTableEndLine(state, fromLine, nodeTo) {
  const nodeToLine = state.doc.lineAt(Math.max(fromLine.from, Math.min(nodeTo, state.doc.length) - 1));
  let toLine = fromLine;
  for (let ln = fromLine.number; ln <= nodeToLine.number; ln++) {
    const line = state.doc.line(ln);
    if (ln > fromLine.number && !line.text.includes('|')) break;
    toLine = line;
  }
  return toLine;
}

// Finds the syntax-tree `Table` node containing `pos` (if any) and returns the
// same { fromLine, toLine } character-position range livePreviewPlugin's own
// Table handling computes — kept in exact agreement with that so a menu action
// always replaces precisely the span TableWidget itself was built from.
function findTableRangeAt(state, pos) {
  let found = null;
  syntaxTree(state).iterate({
    from: Math.max(0, pos - 1), to: Math.min(state.doc.length, pos + 1),
    enter(node) {
      // Capture plain numbers immediately, not `node` itself — lezer reuses
      // one mutable SyntaxNodeRef across the whole traversal for performance,
      // so a reference held past this callback (and read only after
      // `iterate()` returns) would end up reflecting whatever node the
      // traversal visited *last*, not the Table actually matched here.
      if (node.name === 'Table' && node.from <= pos && pos <= node.to) {
        found = { from: node.from, to: node.to };
        return false;
      }
    },
  });
  if (!found) return null;
  const fromLine = state.doc.lineAt(found.from);
  const toLine   = computeTableEndLine(state, fromLine, found.to);
  return { fromLine, toLine };
}

// Computes a safe selection for a transaction that replaces [oldFrom, oldTo]
// with `insert` — shared by mutateTableAt and PropertiesWidget.commit, the
// two places in this file that replace an entire widget-owned range (a
// table's own source lines, the frontmatter block) without the user ever
// having placed a *CM6* cursor inside it in the first place (editing happens
// through the cell/panel's own DOM controls instead).
//
// Reported bug, confirmed with a real EditorView in jsdom (throwaway script,
// not checked in): clicking just below a table (or just below a frontmatter
// panel) can resolve to a position sitting *exactly* at the widget's own
// closing boundary — a very easy click to make, since that boundary is
// precisely where "the widget" visually ends and "real editable content"
// visually begins. CM6's default position-mapping for a change with no
// explicit `selection` is ambiguous for a position sitting *exactly* at the
// edge of the replaced range: it can get pulled to the *end* of the newly
// inserted content — i.e. back inside the table/frontmatter's own text —
// instead of staying just past it. Every subsequent cell/property commit
// (mutateTableAt has no other way to reach this range) re-dispatches with
// that same ambiguity, so the stray cursor never escapes on its own; the
// next real keystroke typed there (the user, believing they're editing
// normal content below the block) lands inside the block's own markdown
// instead — confirmed via video: characters ended up spliced into a table's
// delimiter row, corrupting it, while the user was trying to type text after
// the table entirely.
//
// Fix: explicitly redirect any selection range whose anchor/head sits *at or
// within* [oldFrom, oldTo] to land just past the newly inserted content —
// never leaving it ambiguous. A position clearly outside that span (before
// or after) still maps the ordinary way (shifted by the length delta for
// anything after). This makes the class of bug structurally impossible
// rather than patching the one reported symptom: it holds regardless of how
// the stray cursor got near the boundary, and regardless of how many
// consecutive commits follow (verified with a throwaway script simulating 4
// commits in a row with the cursor sitting at the boundary the whole time —
// it never drifted inside).
function mapSelectionOutsideReplacedRange(state, oldFrom, oldTo, insert) {
  const delta = insert.length - (oldTo - oldFrom);
  const newTo = oldFrom + insert.length;
  const afterPos = Math.min(newTo + 1, state.doc.length + delta);
  const mapPos = (pos) => {
    if (pos < oldFrom) return pos;
    if (pos > oldTo) return pos + delta;
    return afterPos;
  };
  return EditorSelection.create(
    state.selection.ranges.map(r => EditorSelection.range(mapPos(r.anchor), mapPos(r.head))),
    state.selection.mainIndex
  );
}

// Re-resolves the table's current range from `pos` (a position anchor
// captured once, at the moment the context menu was opened — see
// tableContextMenuHandler below) rather than trusting any range computed at
// that same moment, so a menu item clicked a little later (nothing should
// have changed in between, but there's no need to assume that) still edits
// the table's actual current text.
function mutateTableAt(view, pos, mutateFn) {
  const range = findTableRangeAt(view.state, pos);
  if (!range) return;
  const { fromLine, toLine } = range;
  const t = parseTableSrc(view.state.doc.sliceString(fromLine.from, toLine.to));
  if (!t) return;
  mutateFn(t);
  const insert = serializeTable(t);
  view.dispatch({
    changes: { from: fromLine.from, to: toLine.to, insert },
    selection: mapSelectionOutsideReplacedRange(view.state, fromLine.from, toLine.to, insert),
  });
}

// Removes a table's own document range entirely — see the "Eliminar tabla"
// menu item's own comment above for why this exists as a direct action
// rather than relying on selecting the table and cutting it.
function deleteWholeTable(view, pos) {
  const range = findTableRangeAt(view.state, pos);
  if (!range) return;
  const { fromLine, toLine } = range;
  tableCellSelection = null;
  view.dispatch({
    changes: { from: fromLine.from, to: toLine.to, insert: '' },
    selection: EditorSelection.cursor(fromLine.from),
  });
  view.focus();
}

// Inserts a starter 2-column table at `pos`, as its own block (blank line(s)
// separating it from whatever text is already there).
function insertTableTemplate(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const lineEmpty = line.text.trim() === '';
  let insertFrom, prefix, suffix;
  if (lineEmpty) {
    insertFrom = line.from; prefix = ''; suffix = '';
  } else if (pos <= line.from) {
    // pos sits at the very *start* of a non-blank line — e.g. right on the
    // boundary between two adjacent headings, where doc.lineAt(pos) resolves
    // to the *second* one. The table belongs before this line, not after it:
    // reported directly as right-clicking between two headings and choosing
    // "Crear tabla" dropping the table below the second heading instead of
    // between the two.
    insertFrom = line.from; prefix = ''; suffix = '\n\n';
  } else {
    insertFrom = line.to; prefix = '\n\n'; suffix = '';
  }
  const body = '| Columna 1 | Columna 2 |\n| --- | --- |\n|  |  |\n';
  const insert = prefix + body + suffix;
  // Cursor lands right *after* the table, not inside it. This mattered a lot
  // more before TableWidget started rendering unconditionally (see its own
  // comment) — back when a table only rendered as a real <table> while the
  // cursor sat on none of its own lines, an earlier version of this function
  // selected the "Columna 1" placeholder text for immediate retyping, which
  // left the table stuck in raw-markdown mode (no <table class="cm-table">
  // for tableContextMenuHandler's right-click detection to find) until the
  // user clicked elsewhere first. Tables always render now regardless of
  // cursor position, so that specific failure mode is gone either way — this
  // is kept mainly because landing past the table is still the more sensible
  // default cursor position after inserting a block. Lands right after the
  // table's own body — before any trailing blank-line `suffix` pushing a
  // following heading back down — not at the very end of `insert`.
  view.dispatch({
    changes: { from: insertFrom, to: insertFrom, insert },
    selection: EditorSelection.cursor(insertFrom + prefix.length + body.length),
  });
  view.focus();
}

// ── Table <-> external clipboard (Excel/Outlook) interop ──────────────────────
// Excel/Outlook (and most spreadsheet/office apps) recognize a copied range as "a table" by its
// `text/html` clipboard payload containing a real `<table>` — plain text (even tab-separated)
// pastes there as one block of text instead. Conversely, when THEY put something on the
// clipboard, it also carries a `text/html` `<table>` (richer, preserves the original grid)
// alongside a `text/plain` tab-separated fallback. These helpers are the shared conversion layer
// between that world and this editor's own markdown table source / plain `string[][]` shapes —
// used by "Copiar como tabla"/"Pegar como tabla" below (the generic right-click menu, operating
// on a text selection or the system clipboard as a whole).

function escapeHtmlText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// rows: string[][] (plain cell text) -> a real HTML <table> string for the `text/html` clipboard
// MIME type. A literal newline inside a cell becomes a <br> — Excel/Outlook both render that as
// a line break within the cell, and renderCell/renderTableCellDisplay already render a "<br>"
// found in a *markdown* cell back as one (see their own comments), so this stays consistent with
// that convention in the other direction.
function buildClipboardHtmlTable(rows) {
  const trs = rows.map((row, ri) => {
    const tag = ri === 0 ? 'th' : 'td';
    const cells = row.map(c => `<${tag}>${escapeHtmlText(c).replace(/\r\n|\n/g, '<br>')}</${tag}>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><tbody>${trs}</tbody></table>`;
}

// rows: string[][] -> tab-separated text (Excel/Sheets' own plain-text clipboard shape).
function buildClipboardTsv(rows) {
  return rows.map(row => row.map(c => String(c == null ? '' : c).replace(/\r?\n/g, ' ')).join('\t')).join('\n');
}

// Plain tab-separated clipboard text (from Excel/Sheets, or another app's own text/plain
// fallback) -> string[][]. Only reached when no text/html table was found (see pasteAsTable
// below), so this only needs to handle the common "cells separated by tabs, rows separated by
// newlines" shape — a real spreadsheet copy always carries text/html too, so anything more
// exotic (quoted commas, embedded tabs, ...) is out of scope here.
function tsvTextToRows(text) {
  return text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0).map(l => l.split('\t'));
}

// A `text/html` clipboard payload (Excel/Outlook/Sheets/Word all produce one when copying a
// range) -> string[][] of each cell's own text content. DOMParser runs entirely offline with no
// script execution, so this is safe against arbitrary clipboard HTML.
function parseHtmlTableToRows(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    const rows = [...table.querySelectorAll('tr')]
      .map(tr => [...tr.querySelectorAll('td,th')].map(td => td.textContent.replace(/\u00a0/g, ' ').trim()))
      .filter(r => r.length > 0);
    return rows.length > 0 ? rows : null;
  } catch (_) { return null; }
}

// string[][] (first row treated as the header) -> a markdown pipe-table's raw source text.
// Escapes a literal "|" in any cell — parseTableRow's own escaping only protects an *already*-
// escaped "\|" found in hand-typed/pasted markdown source; this is the inverse direction,
// turning arbitrary external text into markdown that will itself parse back correctly — and
// turns a real line break within a cell into a literal "<br>" (see buildClipboardHtmlTable's own
// comment for the matching case in the other direction), since raw table-row syntax can't
// contain one.
function rowsToMarkdownTable(rows) {
  const esc = c => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\r\n|\n/g, '<br>').trim();
  const colCount = Math.max(1, ...rows.map(r => r.length));
  const pad = row => { const r = row.slice(0, colCount).map(esc); while (r.length < colCount) r.push(''); return r; };
  const header = rows.length > 0 ? pad(rows[0]) : Array(colCount).fill('');
  const delim = Array(colCount).fill('---');
  const dataRows = rows.slice(1).map(pad);
  return [header, delim, ...dataRows].map(serializeTableRow).join('\n');
}

// "Pegar como tabla" — reads the clipboard (the async Clipboard API this file's own
// copySelection/pasteAtCursor already rely on as their own fallback), prefers a text/html
// <table> (Excel/Outlook/Sheets copy one alongside their plain-text fallback, preserving the
// real grid) and falls back to parsing text/plain as tab-separated text otherwise, then inserts
// the result as a real markdown table at `pos` — same placement rule as insertTableTemplate
// (own line if blank, otherwise a new block after the current line).
async function pasteAsTable(view, pos) {
  let rows = null;
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/html')) {
          rows = parseHtmlTableToRows(await (await item.getType('text/html')).text());
          if (rows) break;
        }
      }
      if (!rows) {
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text();
            if (text.trim()) rows = tsvTextToRows(text);
            break;
          }
        }
      }
    } else if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text.trim()) rows = tsvTextToRows(text);
    }
  } catch (_) { /* clipboard read denied/unavailable */ }

  if (!rows || rows.length === 0) {
    new DataviewNotice('El portapapeles no contiene una tabla ni texto separado por tabulaciones.');
    return;
  }

  const clampedPos = Math.min(pos, view.state.doc.length);
  const line = view.state.doc.lineAt(clampedPos);
  const lineEmpty = line.text.trim() === '';
  // Same "before vs. after this line" placement rule as insertTableTemplate
  // (see its own comment) — a pos resolving to the very start of a non-blank
  // line (e.g. right between two adjacent headings) belongs before that line.
  let insertFrom, prefix, suffix;
  if (lineEmpty) {
    insertFrom = line.from; prefix = ''; suffix = '';
  } else if (clampedPos <= line.from) {
    insertFrom = line.from; prefix = ''; suffix = '\n\n';
  } else {
    insertFrom = line.to; prefix = '\n\n'; suffix = '';
  }
  const body = rowsToMarkdownTable(rows) + '\n';
  const insert = prefix + body + suffix;
  view.dispatch({
    changes: { from: insertFrom, to: insertFrom, insert },
    selection: EditorSelection.cursor(insertFrom + prefix.length + body.length),
  });
  view.focus();
}

// "Copiar como tabla" — lives in a *rendered* table's own right-click menu (alongside add/
// remove row/column, see tableContextMenuHandler below), not the generic empty-space one: it
// operates on the whole table the user right-clicked, resolved the same way every other item in
// that menu already finds it (findTableRangeAt via `pos`), not on whatever happens to be
// text-selected. Writes both a text/html <table> and a tab-separated text/plain fallback to the
// clipboard — so pasting the result into Excel/Outlook lands as a real table/grid instead of a
// block of text with visible "|" characters.
async function copyTableAsClipboard(view, pos) {
  const range = findTableRangeAt(view.state, pos);
  const t = range && parseTableSrc(view.state.doc.sliceString(range.fromLine.from, range.toLine.to));
  if (!t) {
    new DataviewNotice('No se encontró una tabla en esa posición.');
    return;
  }
  // parseTableSrc/parseTableRow already hand back the clean, unescaped "|" character — only
  // "<br>" (rowsToMarkdownTable's own line-break escape) still needs undoing here, back into a
  // real newline, so Excel/Outlook read it as a line break within the cell rather than literal
  // markdown source.
  const unescape = c => String(c == null ? '' : c).replace(/<br\s*\/?>/gi, '\n');
  const rows = [t.header, ...t.rows].map(row => row.map(unescape));
  const tsv = buildClipboardTsv(rows);
  const html = buildClipboardHtmlTable(rows);
  try {
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(tsv);
      new DataviewNotice('Copiado como texto separado por tabulaciones (el formato de tabla enriquecida no está disponible aquí).');
    }
  } catch (_) {
    new DataviewNotice('No se pudo copiar al portapapeles.');
  }
}

// Writes a multi-cell tableCellSelection's own range to the clipboard, for
// the table's right-click "Cortar"/"Copiar" items (see copySelectionInTable/
// cutSelectionInTable below) — same clipboard-writing shape as
// copyTableAsClipboard just above, but scoped to `sel`'s own range rather
// than the whole table.
async function copyTableCellSelectionToClipboard(view, pos, sel) {
  const range = findTableRangeAt(view.state, pos);
  const t = range && parseTableSrc(view.state.doc.sliceString(range.fromLine.from, range.toLine.to));
  if (!t) return null;
  const rMin = Math.min(sel.anchorRow, sel.focusRow), rMax = Math.max(sel.anchorRow, sel.focusRow);
  const cMin = Math.min(sel.anchorCol, sel.focusCol), cMax = Math.max(sel.anchorCol, sel.focusCol);
  const rows = [];
  for (let r = rMin; r <= rMax; r++) {
    const rowVals = [];
    for (let c = cMin; c <= cMax; c++) {
      rowVals.push(r === -1 ? (t.header[c] || '') : ((t.rows[r] && t.rows[r][c]) || ''));
    }
    rows.push(rowVals);
  }
  try {
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([buildClipboardTsv(rows)], { type: 'text/plain' }),
        'text/html': new Blob([buildClipboardHtmlTable(rows)], { type: 'text/html' }),
      })]);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(buildClipboardTsv(rows));
    }
  } catch (_) { /* clipboard write denied/unavailable */ }
  return { t, rMin, rMax, cMin, cMax };
}

// Same "clear the selected cells, or delete the whole table if every row and
// column was selected" logic as TableWidget's own `cut` listener (see its
// comment) — duplicated rather than shared because that one runs synchronously
// inside a real `cut` event (writing via `e.clipboardData`), while this one
// writes via the async Clipboard API instead (see copySelectionInTable's own
// comment for why the menu path doesn't go through a real `cut` event at all).
async function cutTableCellSelectionAndClearOrDelete(view, pos, sel) {
  const result = await copyTableCellSelectionToClipboard(view, pos, sel);
  if (!result) return;
  const { t, rMin, rMax, cMin, cMax } = result;
  tableCellSelection = null;
  const isWholeTable = rMin === -1 && rMax === t.rows.length - 1 && cMin === 0 && cMax === t.header.length - 1;
  if (isWholeTable) { deleteWholeTable(view, pos); return; }
  mutateTableAt(view, pos, tt => {
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        if (r === -1) { tt.header[c] = ''; }
        else if (tt.rows[r]) { tt.rows[r][c] = ''; }
      }
    }
  });
}

// The table's own right-click "Cortar"/"Copiar" (see tableContextMenuHandler
// below) can't just call cutSelection/copySelection when a multi-cell
// tableCellSelection is active — those only ever act on CM6's own document
// selection, which a mouse-dragged cell range never touches at all (see
// wireCell's own comment on why). Deliberately does *not* try
// document.execCommand('cut'/'copy') + relying on TableWidget's own `cut`/
// `copy` DOM listeners picking up the resulting synthetic event first — a
// menu click is already a real user gesture, so there's no permission
// advantage to that indirection, and unlike a genuine Ctrl+X/Ctrl+C keypress
// there's no guarantee a *programmatically triggered* cut/copy command
// reliably dispatches a real event in every embedding context. Goes straight
// to the same async Clipboard API this exact menu's own "Copiar como tabla"
// already uses successfully, instead.
function copySelectionInTable(view, tableEl, activeSel) {
  if (!activeSel) { copySelection(view); return; }
  copyTableCellSelectionToClipboard(view, view.posAtDOM(tableEl), activeSel);
}
function cutSelectionInTable(view, tableEl, activeSel) {
  if (!activeSel) { cutSelection(view); return; }
  cutTableCellSelectionAndClearOrDelete(view, view.posAtDOM(tableEl), activeSel);
  view.focus();
}

// ── Cortar/Copiar/Pegar for the custom context menu ─────────────────────────
// tableContextMenuHandler suppresses VS Code's own native context menu
// wherever it has something to offer (see its own comment), which meant Cut/
// Copy/Paste — normally just "whatever the native menu already provides" —
// disappeared from the right-click menu entirely, even outside a table.
// Reimplemented here so this extension's own menu is a real replacement, not
// a strict subset: `document.execCommand('copy'/'cut'/'paste')` is tried
// first since it operates on the browser's actual DOM selection — which CM6
// keeps in sync with its own selection model precisely so that native
// behaviors like this (and screen readers, Find-in-page, ...) keep working —
// and, for paste, so it flows through CM6's own native `paste` event
// handling rather than a raw text insertion that bypasses it. `execCommand`
// is old and can be blocked/unsupported in some embedding contexts, so a
// Clipboard API (`navigator.clipboard`) fallback backs each one up; Ctrl+C/
// X/V keep working exactly as before regardless of any of this, since
// neither path here changes anything about that.
function copySelection(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)).catch(() => {});
  }
}
function cutSelection(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  copySelection(view);
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' }, userEvent: 'delete.cut' });
  view.focus();
}
function pasteAtCursor(view) {
  let ok = false;
  try { ok = document.execCommand('paste'); } catch (_) { ok = false; }
  if (ok) { view.focus(); return; }
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(text => {
      if (!text) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: EditorSelection.cursor(sel.from + text.length),
        userEvent: 'input.paste',
      });
      view.focus();
    }).catch(() => {});
  }
}

class TableMenuView {
  constructor(view) {
    this.view = view;
    this.dom = null;
    this.submenuDom = null;
    this._onDocMouseDown = e => {
      if (this.dom && !this.dom.contains(e.target) && !(this.submenuDom && this.submenuDom.contains(e.target))) this.hide();
    };
    this._onDocKeyDown = e => { if (e.key === 'Escape') this.hide(); };
  }
  destroy() { this.hide(); }
  hide() {
    this._closeSubmenu();
    if (!this.dom) return;
    this.dom.remove();
    this.dom = null;
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    document.removeEventListener('keydown', this._onDocKeyDown, true);
  }
  _closeSubmenu() {
    if (this.submenuDom) { this.submenuDom.remove(); this.submenuDom = null; }
  }
  // Builds one menu level's DOM — shared by the top-level menu and a nested
  // submenu flyout (see `_openSubmenu`) — from `items`:
  // Array<{ label, action, disabled? } | { label, items } | { separator: true }>.
  // A `{ label, items }` entry (no `action` of its own) opens a nested flyout
  // on hover instead of running anything directly — used for the "Highlights"
  // submenu grouping the color entries + "Quitar resaltado" (see
  // tableContextMenuHandler's generic branch). `onAccept` runs whenever any
  // leaf item's own action fires, at any nesting depth — it's always the same
  // callback (closing the *entire* menu tree), passed down unchanged.
  _buildMenu(items, onAccept) {
    const menu = document.createElement('div');
    menu.className = 'cm-table-menu';
    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'cm-table-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'cm-table-menu-item' + (it.disabled ? ' is-disabled' : '') + (it.items ? ' has-submenu' : '');
      // `it.swatch` (a CSS color) renders a small color dot before the label —
      // used by the Highlightr-style "resaltar" entries so each color is
      // recognizable at a glance, not just by its name.
      if (it.swatch) {
        const dot = document.createElement('span');
        dot.className = 'cm-table-menu-swatch';
        dot.style.background = it.swatch;
        row.appendChild(dot);
        row.appendChild(document.createTextNode(it.label));
      } else {
        row.appendChild(document.createTextNode(it.label));
      }
      if (it.items) {
        const caret = document.createElement('span');
        caret.className = 'cm-table-menu-caret';
        caret.textContent = '▸';
        row.appendChild(caret);
      }
      if (it.disabled) { menu.appendChild(row); continue; }
      row.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      if (it.items) {
        row.addEventListener('mouseenter', () => this._openSubmenu(row, it.items, onAccept));
      } else {
        row.addEventListener('mouseenter', () => this._closeSubmenu());
        row.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          onAccept();
          it.action();
        });
      }
      menu.appendChild(row);
    }
    return menu;
  }
  _openSubmenu(parentRow, subItems, onAccept) {
    this._closeSubmenu();
    const sub = this._buildMenu(subItems, onAccept);
    sub.classList.add('cm-table-menu-submenu');
    this.view.dom.appendChild(sub);
    const editorRect = this.view.dom.getBoundingClientRect();
    const parentRect = parentRow.getBoundingClientRect();
    const subRect = sub.getBoundingClientRect();
    let left = parentRect.right - editorRect.left - 2;
    if (left + subRect.width > editorRect.width) left = Math.max(0, parentRect.left - editorRect.left - subRect.width + 2);
    let top = parentRect.top - editorRect.top;
    if (top + subRect.height > editorRect.height) top = Math.max(0, editorRect.height - subRect.height);
    sub.style.left = left + 'px';
    sub.style.top  = top + 'px';
    this.submenuDom = sub;
  }
  // `clientX`/`clientY` are viewport coordinates from the triggering contextmenu event.
  show(clientX, clientY, items) {
    this.hide();
    const menu = this._buildMenu(items, () => this.hide());
    this.view.dom.appendChild(menu);

    // Called from a domEventHandlers callback (contextmenu), not from CM6's own
    // update()/measure cycle, so a direct synchronous getBoundingClientRect()
    // read here is safe — same reasoning linkClickHandler's drop handler
    // already relies on for its own posAtCoords call.
    const editorRect = this.view.dom.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = clientX - editorRect.left;
    let top  = clientY - editorRect.top;
    if (left + menuRect.width > editorRect.width) left = Math.max(0, editorRect.width - menuRect.width - 4);
    if (top + menuRect.height > editorRect.height) top = Math.max(0, top - menuRect.height);
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
    this.dom = menu;

    // Deferred registration: the same right-click that opened the menu would
    // otherwise immediately bubble to this brand-new document-level listener
    // as part of its own event dispatch (mousedown normally precedes
    // contextmenu, but on some platforms/browsers a synthetic follow-up can
    // still be in flight) and close the menu before the user sees it.
    setTimeout(() => {
      document.addEventListener('mousedown', this._onDocMouseDown, true);
      document.addEventListener('keydown', this._onDocKeyDown, true);
    }, 0);
  }
}

const tableMenuPlugin = ViewPlugin.fromClass(TableMenuView);

const tableContextMenuHandler = EditorView.domEventHandlers({
  contextmenu(e, view) {
    if (!view.contentDOM.contains(e.target)) return false;
    // Widgets with their own real form controls (PropertiesWidget's text
    // inputs, a ```tasks``` query's filter box, ...) need the native
    // right-click menu for cut/copy/paste/select-all — don't hijack those.
    if (e.target.closest && e.target.closest('input, textarea, select')) return false;
    const menu = view.plugin(tableMenuPlugin);
    if (!menu) return false;

    const tableEl = e.target.closest && e.target.closest('table.cm-table');
    if (tableEl) {
      const cellEl = e.target.closest('td, th');
      if (!cellEl) { e.preventDefault(); return true; } // inside the table box but not on a cell — nothing to offer
      const isHeader = cellEl.tagName === 'TH';
      const colIndex = Number(cellEl.dataset.col);
      const rowEl = cellEl.closest('tr');
      const rowIndex = !isHeader && rowEl && rowEl.dataset.row !== undefined ? Number(rowEl.dataset.row) : -1;
      const pos = view.posAtDOM(tableEl);

      // If there's an active multi-cell selection (see "Multi-cell selection"
      // above tableCellSelection's own definition) *and the right-clicked cell
      // is actually inside it*, offer to delete every row/column it spans
      // instead of just the one cell that happens to be under the pointer —
      // requested directly: "cuando selecciono varias celdas... que se permita
      // eliminar todas las filas/columnas de las celdas seleccionadas". A
      // right-click outside the current selection intentionally falls back to
      // the plain single row/column behavior below, same as clicking outside
      // it already clears the selection elsewhere in this file.
      const activeSel = tableCellSelection && tableCellSelection.tableFrom === Number(tableEl.dataset.tableFrom)
        ? tableCellSelection : null;
      // Reported: Cortar/Copiar showed disabled in this menu despite a
      // clearly-highlighted multi-cell range being selected. Root cause: this
      // only ever checked CM6's own document-level selection
      // (view.state.selection.main) — but a mouse-dragged cell range never
      // touches that at all (each cell's own mousedown stops propagation
      // before CM6 sees it, see wireCell's own comment), so it's tracked
      // entirely in tableCellSelection instead. The table's own cut/copy
      // listeners (in TableWidget.toDOM(), below) already act on exactly this
      // — activeSel here is that same check — so Cortar/Copiar must be
      // enabled whenever it's set, not just when CM6's selection is non-empty.
      const hasSelection = !view.state.selection.main.empty || !!activeSel;
      let selRowIndices = null, selColIndices = null;
      if (activeSel) {
        const rMin = Math.min(activeSel.anchorRow, activeSel.focusRow), rMax = Math.max(activeSel.anchorRow, activeSel.focusRow);
        const cMin = Math.min(activeSel.anchorCol, activeSel.focusCol), cMax = Math.max(activeSel.anchorCol, activeSel.focusCol);
        const clickedRow = isHeader ? -1 : rowIndex;
        if (clickedRow >= rMin && clickedRow <= rMax && colIndex >= cMin && colIndex <= cMax) {
          // Header row (-1) is excluded — deleting it was never supported by
          // this menu (nothing above it, see the singular row branch below),
          // so a selection spanning header+data rows only deletes the data ones.
          const rows = [];
          for (let r = Math.max(rMin, 0); r <= rMax; r++) rows.push(r);
          if (rows.length > 1) selRowIndices = rows;
          if (cMax > cMin) selColIndices = Array.from({ length: cMax - cMin + 1 }, (_, i) => cMin + i);
        }
      }

      const items = [
        { label: 'Cortar',  action: () => cutSelectionInTable(view, tableEl, activeSel), disabled: !hasSelection },
        { label: 'Copiar',  action: () => copySelectionInTable(view, tableEl, activeSel), disabled: !hasSelection },
        { label: 'Pegar',   action: () => pasteAtCursor(view) },
        { separator: true },
        { label: 'Añadir columna a la izquierda', action: () => mutateTableAt(view, pos, t => insertTableColumn(t, colIndex)) },
        { label: 'Añadir columna a la derecha',   action: () => mutateTableAt(view, pos, t => insertTableColumn(t, colIndex + 1)) },
        selColIndices
          ? { label: 'Eliminar columnas', action: () => { const cols = selColIndices; tableCellSelection = null; mutateTableAt(view, pos, t => deleteTableColumns(t, cols)); } }
          : { label: 'Eliminar columna',  action: () => mutateTableAt(view, pos, t => deleteTableColumn(t, colIndex)) },
        { separator: true },
      ];
      if (isHeader) {
        items.push({ label: 'Añadir fila abajo', action: () => mutateTableAt(view, pos, t => insertTableRow(t, 0)) });
      } else if (rowIndex >= 0) {
        items.push({ label: 'Añadir fila arriba', action: () => mutateTableAt(view, pos, t => insertTableRow(t, rowIndex)) });
        items.push({ label: 'Añadir fila abajo',  action: () => mutateTableAt(view, pos, t => insertTableRow(t, rowIndex + 1)) });
        items.push(selRowIndices
          ? { label: 'Eliminar filas', action: () => { const rows = selRowIndices; tableCellSelection = null; mutateTableAt(view, pos, t => deleteTableRows(t, rows)); } }
          : { label: 'Eliminar fila',  action: () => mutateTableAt(view, pos, t => deleteTableRow(t, rowIndex)) });
      }
      items.push({ separator: true });
      items.push({ label: 'Copiar como tabla', action: () => copyTableAsClipboard(view, pos) });
      // Direct "delete this whole table" affordance — reported as: creating an
      // empty table, selecting it with the cursor, and cutting it left it
      // fully in place. Selecting/cutting a table as a block is fragile (each
      // cell is its own separate contentEditable — see TableWidget's own
      // comments), so rather than depend on that working, this removes the
      // table's own document range directly, the same reliable way "Eliminar
      // fila"/"Eliminar columna" above already mutate the table.
      items.push({ label: 'Eliminar tabla', action: () => deleteWholeTable(view, pos) });
      e.preventDefault();
      menu.show(e.clientX, e.clientY, items);
      return true;
    }

    // Not inside a rendered table — offer to create one at the click position.
    // posAtCoords returns null for a click that's within contentDOM's own DOM
    // bounds but below the last rendered line (a short document leaves blank
    // space there that's still part of .cm-content) — falling straight through
    // to `return false` there was the main reason the native Cut/Copy/Paste
    // menu "sometimes" showed up instead of this one: any right-click below
    // the visible text (a very easy spot to land on) never reached this far.
    // Falling back to end-of-document instead means a right-click anywhere in
    // the editor's own content area reliably gets *some* menu from here.
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.doc.length;
    const sel = view.state.selection.main;
    const hasSelection = !sel.empty;
    const items = [
      { label: 'Cortar', action: () => cutSelection(view), disabled: !hasSelection },
      { label: 'Copiar', action: () => copySelection(view), disabled: !hasSelection },
      { label: 'Pegar',  action: () => pasteAtCursor(view) },
      { separator: true },
      { label: 'Crear tabla', action: () => insertTableTemplate(view, pos) },
      { label: 'Pegar como tabla', action: () => pasteAsTable(view, pos) },
    ];
    // Highlightr-style "resaltar" entries — reachable only from this
    // right-click menu (there is no automatic mouseup-triggered popup on
    // selection; that was reported as intrusive and removed) — grouped into
    // their own "Highlights" submenu rather than listed flat alongside
    // Cortar/Copiar/Pegar/Crear tabla, so the top level menu stays short
    // regardless of how many colors are configured. Only added when the menu
    // already has something else in it — requested directly, so a right-click
    // never surfaces a menu whose only content is this submenu. Disabled (not
    // hidden) when there's no selection to act on, so the feature stays
    // discoverable even before selecting anything.
    if (items.length > 0) {
      const existingMark = hasSelection && findEnclosingMark(view.state, sel.from, sel.to);
      const highlightItems = highlighterColors.map(c => ({
        label: c.name, swatch: c.color, disabled: !hasSelection, action: () => applyHighlight(view, c.color, c.name),
      }));
      highlightItems.push({ label: 'Quitar resaltado', disabled: !existingMark, action: () => removeHighlight(view) });
      items.push({ separator: true });
      items.push({ label: 'Highlights', items: highlightItems });
    }
    e.preventDefault();
    menu.show(e.clientX, e.clientY, items);
    return true;
  },
});

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
    this.mode = 'headings';
    this.notePart = notePart;
    this.query = ctx.raw.slice(hashIdx + 1);
    this.open = true;
    this.selected = 0;

    // Bare "[[#" — no note name at all — means "a heading in this same
    // document," not a lookup of some other note's headings. Those are
    // already available synchronously off the live CM6 state (no
    // get-headings host round-trip needed, and nothing to be "not found").
    if (!notePart) {
      this.loading = false;
      const q = this.query.toLowerCase();
      this.items = currentDocHeadings(this.view.state)
        .filter(h => h.text.toLowerCase().includes(q))
        .slice(0, WIKI_SUGGEST_SCAN_MAX)
        .map(h => ({ type: 'heading', level: h.level, text: h.text }));
      this.render();
      return;
    }

    this.loading = true;
    this.items = [];
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
  // newline (a long paragraph, or a single long list-item's own text) can
  // still span several on-screen rows. Moving by document-line-number alone
  // (the `else` branch below) would skip straight over those extra rows to
  // the next real line — e.g. landing on the blank line after a long
  // paragraph instead of the paragraph's own second visual row.
  //
  // First version of this same-line-row step reused CM6's own pixel-based
  // view.moveVertically() for a single, freshly-computed step, trusting it
  // whenever the result stayed on the same document line (state.doc.lineAt
  // comparison). Reported back as still reproducible on macOS specifically —
  // a 3-row-wrapped list item where Down correctly moved row 1 → row 2, but
  // the *second* Down (row 2 → row 3) landed past the item entirely, on
  // whatever document line follows it. Not reproduced with byte-identical
  // content on Windows/headless Chrome (built a real EditorView via Puppeteer
  // against this exact bundle and stepped through it — every row-to-row move
  // came out correct there). That points at view.moveVertically's own
  // internal single-step goal-column math occasionally overshooting by more
  // than one visual row depending on platform font-rendering/hinting — the
  // same class of pixel-based unreliability this whole custom keymap exists
  // to route around for *cross*-line moves, just now hit inside the one
  // remaining call to a CM6 pixel primitive this function still had.
  //
  // Second attempt (dropping view.moveVertically for a measured "jump one
  // row-height, then check it's still inside curLine's own coordsAtPos-
  // measured top/bottom") fixed one real bug — mixing view.lineBlockAt's
  // internal document-coordinate space with coordsAtPos's viewport space —
  // but was reported still reproducing on real macOS hardware, at a
  // *different* row-to-row step than originally reported (via a live
  // devtools-console repro, cursor rect logged after every keypress): two
  // consecutive single-row steps measured ~56px then ~28px, a clean 2:1
  // ratio, on the same wrapped list item. Root cause: assuming every visual
  // row of a wrapped line is the same height (`rowH`, measured from just the
  // *current* row) breaks the instant row spacing isn't uniform — which it
  // isn't here, since this particular list item is the first item of a
  // freshly-started list (interrupted by the blockquote right above it in
  // the user's real note), and gets its own extra top margin/padding for
  // spacing from the preceding block (see the "Lists — indentation +
  // spacing" ListItem handling: `cm-list-first`). A step sized off the
  // *current* row's height can under- or overshoot whenever the *next* row's
  // effective vertical offset differs from that assumption, exactly this
  // margin-adjacent case.
  //
  // Third attempt: nudge just a few px past the current row's own measured
  // edge (its bottom, moving down; its top, moving up) and trust whatever
  // view.posAtCoords resolves there, on the theory that landing 1-3px past
  // the edge always lands in the very first pixel of whatever comes next,
  // however far away that actually is — no step-size assumption needed.
  // Reported still overshooting, on the very first press this time, for
  // exactly this margin-adjacent list item (reproduced with the real note's
  // own structure — the blockquote-interrupted list — via Puppeteer against
  // this exact bundle, not checked in). Root cause, found by also dumping
  // view.posAtCoords's *own* resulting coordsAtPos alongside its returned
  // position: a 3px nudge past the row's bottom edge resolved to a position
  // one character *to the left* of the start, still on the *exact same*
  // visual row (identical top/bottom to the starting position) — browsers
  // don't reliably treat "a few px past a line's bottom edge" as "inside the
  // next line" for hit-testing; posAtCoords can snap back to the nearest
  // actual glyph on the row the coordinate came closest to, especially with
  // a larger gap (this item's own extra top margin, from `cm-list-first`)
  // between rows than the nudge accounted for. Checking only "a different
  // offset than before" (the previous version's paranoia check) missed this
  // entirely, since a neighboring character on the *same* row also differs.
  //
  // Fixed by verifying the *row itself* changed (comparing the resolved
  // position's own coordsAtPos().top against the starting row's top, not
  // just comparing character offsets or document-line numbers), and — if it
  // didn't — widening the nudge and retrying, since the only reason a nudge
  // past the edge could fail to leave the current row is that the actual gap
  // to the next row is larger than the nudge tried. Growing additively
  // (rather than assuming any particular gap size up front) means this
  // adapts to whatever margin/padding this specific line and its neighbor
  // happen to carry, instead of hardcoding a number that only happens to
  // work for plain, unspaced wrapped text.
  //
  // Fourth attempt: still reported overshooting on real macOS hardware —
  // this time on the *last* row of a 3-row wrapped item specifically (the
  // list item's own line rendered at 84px total / 3 rows of 28px each,
  // confirmed via a live devtools measurement — so the row genuinely exists,
  // the bug is failing to land on it). Root cause: querying posAtCoords at
  // the *cursor's own* x (preserved from the previous, wider row) fails
  // whenever the *next* row's actual text doesn't extend out that far
  // horizontally (short last lines of a wrapped paragraph are common) — the
  // browser's hit-testing at a point past a row's own rendered content can
  // resolve to whatever it considers nearest, which past a short row's end
  // can be the (empty, full-width) line below rather than that row's own
  // last character, misreporting a different document line entirely even
  // though the row we wanted is right there.
  //
  // Fixed the fourth attempt's specific failure (adding a "safe x" fallback)
  // but a live trace (Puppeteer, real ArrowDown keypresses against this exact
  // bundle, then a hand-simulation of the same candidate search from the
  // live post-keypress state) showed *neither* x — not the cursor's own, not
  // curLine.from's — ever resolving inside the target row at all, for any
  // nudge: `view.posAtCoords` kept returning a position on the *next
  // document line* even for a y solidly inside the target row's own measured
  // [top, bottom) band (confirmed by also directly mapping every character
  // offset of curLine to its own row via coordsAtPos, independent of any
  // pixel guessing). Root cause: curLine.from's x is this *specific* item's
  // marker-row (row 0) indent, which differs from every *continuation* row's
  // own (different, un-indented-by-the-marker) hanging-indent x — so it was
  // never actually "safe" for a later row to begin with. More fundamentally,
  // *any* fixed x guess is fragile here: even CM6's own view.moveVertically,
  // tried directly (bypassing this codebase entirely) from the same
  // document position, reproduced the identical overshoot — this is a real
  // Chromium hit-testing quirk with short wrapped rows next to
  // differently-sized content (this item's own leading inline-code span),
  // not something specific to any of this function's own attempts.
  //
  // Fixed for real by not guessing coordinates at all: walk curLine's own
  // characters one at a time via view.coordsAtPos (never posAtCoords), in
  // the requested direction, until the row (top) actually changes — this can
  // only ever agree with where the text really is, since it's reading real
  // rendered positions of real characters, not hit-testing an unclaimed
  // point in space. Once the next row is found, a second short walk within
  // *that* row picks whichever character's own left is closest to the
  // cursor's current x, preserving the usual "keep roughly the same column"
  // feel without ever needing to know a row's rendered width in advance.
  let newHead = null;
  const headCoords = view.coordsAtPos(range.head);
  if (headCoords) {
    const startTop = headCoords.top;
    let p = range.head;
    let rowStart = null;
    while (true) {
      p += dir;
      if (p < curLine.from || p > curLine.to) break; // ran off curLine — no further row this direction
      const c = view.coordsAtPos(p);
      if (c && Math.abs(c.top - startTop) > 4) { rowStart = p; break; }
    }
    if (rowStart != null) {
      const rowTop = view.coordsAtPos(rowStart).top;
      let best = rowStart;
      let bestDist = Math.abs(view.coordsAtPos(rowStart).left - headCoords.left);
      let q = rowStart;
      while (true) {
        q += dir;
        if (q < curLine.from || q > curLine.to) break;
        const c = view.coordsAtPos(q);
        if (!c || Math.abs(c.top - rowTop) > 4) break; // left the newly-found row
        const dist = Math.abs(c.left - headCoords.left);
        if (dist < bestDist) { bestDist = dist; best = q; }
      }
      newHead = best;
    }
  }

  if (newHead != null) {
    // Still within the same wrapped document line — and deliberately leave
    // vGoalCol untouched (this isn't a line-to-line jump, so it has no
    // bearing on that column-preservation mechanism).
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
    // Also skip over a folded callout's collapsed body — same reasoning,
    // same computeFoldedSpans-shaped single source of truth (see
    // computeFoldedCalloutSpans's own comment).
    for (const span of [...computeFoldedSpans(state), ...computeFoldedCalloutSpans(state)]) {
      const spanFromLine = state.doc.lineAt(span.from).number;
      const spanToLine = state.doc.lineAt(span.to).number;
      if (targetLineNum >= spanFromLine && targetLineNum <= spanToLine) {
        targetLineNum = dir > 0 ? spanToLine + 1 : spanFromLine - 1;
      }
    }
    // Same reasoning as the fold-span check above, for frontmatterAtomicRanges
    // (see its own comment): that facet protects CM6's own built-in
    // navigation/pointer paths, but this function bypasses those entirely for
    // a cross-line jump, so it needs its own explicit check. Frontmatter is
    // always anchored at the document's very start (parseFrontmatter requires
    // line 1), so the only way to land inside it via vertical movement is
    // pressing Up from somewhere below it — there's no "coming from above" to
    // account for, unlike a fold, which can be approached from either
    // direction.
    const fm = parseFrontmatter(state);
    if (fm) {
      const fmCloseLine = state.doc.lineAt(fm.to).number;
      if (targetLineNum <= fmCloseLine) { targetLineNum = fmCloseLine + 1; }
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

// findUrlAtPos is driven purely by a resolved document position, not by hit-testing
// a real DOM element the way the .cm-wiki-link/.cm-md-link/etc. checks below are —
// so it can't tell "the click landed on this character" apart from "posAtCoords
// clamped an out-of-bounds click onto the nearest character." The clearest case:
// clicking in the blank area below the document's last line, when that line is a
// bare URL — posAtCoords clamps the click onto that line (commonly right at its
// end), so findUrlAtPos happily reports a URL even though the pointer was visibly
// below the text, not on it. Guards that check by requiring the click's own Y
// coordinate to actually fall inside the resolved position's rendered row.
function clickResolvesOnRow(view, pos, clientY) {
  const coords = view.coordsAtPos(pos);
  if (!coords) return true;
  return clientY >= coords.top && clientY <= coords.bottom;
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
    const externalFile = e.target.closest('.cm-external-file');
    if (externalFile) { e.preventDefault(); return true; }
    const taskCb = e.target.closest('.cm-task-checkbox');
    if (taskCb) { e.preventDefault(); return true; }
    const taskQueryEditBtn = e.target.closest('.cm-task-query-edit-btn');
    if (taskQueryEditBtn) { e.preventDefault(); return true; }
    const taskQueryBacklink = e.target.closest('.cm-tasks-query-backlink-link');
    if (taskQueryBacklink) { e.preventDefault(); return true; }

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    if (clickResolvesOnRow(view, pos, e.clientY) && findUrlAtPos(view, pos)) { e.preventDefault(); return true; }
    return false;
  },
  // click: fire the action
  click(e, view) {
    const wikiEl = isWikiLinkEl(e.target, view.dom);
    if (wikiEl) {
      e.preventDefault();
      const target = wikiEl.dataset.target || wikiEl.textContent.trim();
      // A .docx/.xlsx/.pdf target isn't a note to open in this editor — hand
      // it to the OS's own default application instead (see EXTERNAL_FILE_EXT).
      vscode.postMessage(isExternalFileTarget(target)
        ? { type: 'open-external-file', name: target }
        : { type: 'open-note', name: target });
      return true;
    }
    const tableWiki = e.target.closest('[data-wiki]');
    if (tableWiki) {
      e.preventDefault();
      // `data-wiki-base` (see renderCell) is only set for wikilinks rendered on behalf of another
      // file (e.g. a tasks-query row's description) — forwarded so the host resolves/creates
      // relative to *that* file's directory instead of always defaulting to the open document's.
      const target = tableWiki.dataset.wiki;
      vscode.postMessage(isExternalFileTarget(target)
        ? { type: 'open-external-file', name: target, basePath: tableWiki.dataset.wikiBase }
        : { type: 'open-note', name: target, basePath: tableWiki.dataset.wikiBase });
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
    const externalFile = e.target.closest('.cm-external-file');
    if (externalFile) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-external-file', name: externalFile.dataset.target });
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
    // A tasks-query row's backlink, same `data-path`/`data-line` convention as the two above —
    // see the comment by its construction in renderTaskRow for why this isn't routed through
    // `[data-wiki]`/`open-note` like a normal wikilink.
    const taskQueryBacklink = e.target.closest('.cm-tasks-query-backlink-link');
    if (taskQueryBacklink) {
      e.preventDefault();
      vscode.postMessage({
        type: 'open-task-location',
        path: taskQueryBacklink.dataset.path,
        line: Number(taskQueryBacklink.dataset.line),
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
    const url = clickResolvesOnRow(view, pos, e.clientY) ? findUrlAtPos(view, pos) : null;
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
  // See the identical guard on computeFoldedCalloutSpans (this file's callout
  // section) — same reasoning applies to heading folds: folding is a Live
  // Preview affordance, so it must be a no-op in Source Mode.
  if (sourceMode) return [];
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
      const foldedSpans = computeFoldedSpans(state, headings);
      const all = [], lineDecs = [];

      for (const h of headings) {
        // Fold toggle widget — only for heading lines in viewport, and only
        // when this heading isn't itself hidden inside an ancestor's folded
        // content (e.g. an "## Hijo"/"### Nieto" nested under a folded "#
        // Padre"). Pushing one unconditionally here — the original code —
        // put a widget decoration at exactly the same zero-length point
        // (h.lineFrom, h.lineFrom) as that nested heading's own line's
        // hiddenLineDeco below, the identical "two decorations at one point,
        // only one survives" collision already diagnosed for blank lines
        // (see the comment on the collapse loop below): confirmed with a
        // real EditorView in jsdom (throwaway script, not checked in) that
        // every *nested heading's own line* kept its FoldToggle widget and
        // never got `cm-fold-hidden`, while its surrounding paragraph lines
        // (no competing widget decoration) collapsed correctly — reported as
        // "folding a heading with nested headings inside still leaves blank
        // space," one gap per nested heading. A hidden heading's fold toggle
        // wouldn't be usable anyway (its own line is invisible), so skipping
        // it here loses no behavior.
        const hiddenByFold = foldedSpans.some(sp => h.lineFrom >= sp.from && h.lineFrom <= sp.to);
        if (!hiddenByFold && h.lineTo >= vf && h.lineFrom <= vt) {
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
      for (const { from, to } of foldedSpans) {
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
  // Folded headings and folded callouts share the same atomic-range
  // treatment (see computeFoldedCalloutSpans' own comment) — merged and
  // sorted into one facet rather than two, since RangeSetBuilder requires
  // strictly ordered inserts.
  const spans = [...computeFoldedSpans(view.state), ...computeFoldedCalloutSpans(view.state)]
    .sort((a, b) => a.from - b.from || a.to - b.to);
  for (const { from, to } of spans) {
    if (to > from) { try { builder.add(from, to, Decoration.replace({})); } catch (_) {} }
  }
  return builder.finish();
});

// Blocks any cursor position from line 2 through the frontmatter's own
// closing "---" line — requested: the cursor should only ever be able to
// land *below* the frontmatter panel, never inside its own (raw, hidden)
// text. foldAtomicRanges (above) established the exact same
// EditorView.atomicRanges mechanism and its semantics for folded heading
// content, so this mirrors it rather than inventing a new approach. The `to`
// bound is computed the same way computeFoldedSpans computes a fold's own
// upper bound (one *less* than wherever the next valid content actually
// starts) — here that's the frontmatter's closing "---" line's own `.to`,
// not `.to + 1`, since the newline right after it is exactly the boundary a
// redirected cursor should land just past, not before.
//
// Deliberately does *not* cover line 1 itself, where PropertiesWidget's own
// interactive controls (text inputs, pills, checkboxes) render. First
// version covered [0, to] — the whole block — which broke clicking into the
// panel's own text `<input>`s entirely (reported right after shipping:
// "no puedo editar el contenido de un frontmatter"). Root cause: CM6's own
// pointer handling resolves *any* click within a widget-replaced range back
// to that widget's single anchor position, then — specifically because that
// position falls inside an atomic range — takes a different path than a
// plain click that needs no remapping, one that suppresses the mousedown's
// default action; a browser only auto-focuses the element under a mousedown
// if that default action isn't prevented, so the click reached the `<input>`
// but never actually focused it. Line 1 doesn't need atomicRanges protection
// in the first place: it's already a single `Decoration.replace({widget})`
// spanning the entire line, so there's no raw text there for a cursor to
// land "inside" of regardless — the only two reachable positions on it are
// its own boundaries (0 and its own `.to`), both already effectively inert.
// The actual gap this facet needs to close is lines 2..N, which — unlike
// line 1 — are collapsed one line at a time (hiddenLineDeco per line, not
// one combined widget) and therefore do have reachable boundary positions
// between them for a cursor to slip into, exactly like the folded-heading
// gap foldAtomicRanges already closes.
//
// Registered *inside* previewCompartment (with previewCompartment's other
// entries below), not alongside foldAtomicRanges outside it: PropertiesWidget
// itself only ever renders in Live Preview — Source Mode shows the raw YAML
// as ordinary, fully editable text (see PropertiesWidget's own top comment
// for why there's deliberately no other raw-YAML view) — so this must be
// disabled right along with it, not left active over now-genuinely-editable
// text.
const frontmatterAtomicRanges = EditorView.atomicRanges.of(view => {
  const fm = parseFrontmatter(view.state);
  if (!fm) return Decoration.none;
  const from = view.state.doc.line(1).to + 1;
  const to = view.state.doc.lineAt(fm.to).to;
  const builder = new RangeSetBuilder();
  if (to > from) { try { builder.add(from, to, Decoration.replace({})); } catch (_) {} }
  return builder.finish();
});

// ── Find/replace panel (Ctrl+F) ────────────────────────────────────────────────
// Built on @codemirror/search's own query/state/highlighting machinery
// (search(), getSearchQuery/setSearchQuery, findNext/findPrevious,
// selectMatches) rather than hand-rolling cursor iteration and match
// highlighting from scratch — that part (including the automatic
// .cm-searchMatch decoration on every match in the viewport) is exactly what
// that package already gets right. Only the *panel* is custom
// (`createPanel`, the one documented extension point for this): the
// library's own default panel is a plain, unstyled `<form>` with English
// labels and no match counter, and the user asked for a specific look (a
// small floating card top-right, match counter, case/word/regex toggles,
// collapsible replace row) matching Obsidian's own panel.

// Simple heuristic case-matching for a plain-text (non-regex) replace: if the
// matched text is all-caps, all-lowercase, or capitalized, the replacement
// text is transformed to match. Deliberately not attempted for a regex
// query — `query.replace` can contain `$1`-style backreferences there, and
// "preserve case" against an arbitrary regex match has no single obviously
// correct meaning, so the preserve-case toggle is simply disabled/ignored in
// that mode (see ObsidianSearchPanel's own commit()/replaceOne()/replaceAll()).
function matchReplacementCase(source, replacement) {
  if (!replacement) return replacement;
  if (source === source.toUpperCase() && source !== source.toLowerCase()) return replacement.toUpperCase();
  if (source === source.toLowerCase()) return replacement.toLowerCase();
  if (source[0] && source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Counts total matches and finds the 0-based index of whichever one (if any)
// exactly matches the current selection — findNext/findPrevious/
// openSearchPanel all set the selection to precisely a match's own range, so
// this equality check is how "3 de 12" knows which one is "current" without
// the library exposing that as its own public concept. Capped at
// MAX_COUNTED_MATCHES so a very common short query (e.g. a single letter) in
// a huge document can't make every keystroke re-scan the whole thing
// unbounded — same defensive cap selectMatches itself uses internally
// (1000), just surfaced to the display instead of silently refusing to act.
const MAX_COUNTED_MATCHES = 999;
function computeMatchInfo(query, state) {
  if (!query.valid) return { total: 0, index: -1, truncated: false };
  const sel = state.selection.main;
  let total = 0, index = -1, truncated = false;
  const cursor = query.getCursor(state);
  let r;
  while (!(r = cursor.next()).done) {
    if (r.value.from === sel.from && r.value.to === sel.to) index = total;
    total++;
    if (total >= MAX_COUNTED_MATCHES) { truncated = true; break; }
  }
  return { total, index, truncated };
}

// Replace-one with case preservation — mirrors @codemirror/search's own
// replaceNext (only replaces when the selection sits exactly on a match;
// otherwise just advances to one first, same "press once to select, press
// again to replace" UX every editor's find/replace uses), the one addition
// being matchReplacementCase on the inserted text.
function replaceOnePreservingCase(view) {
  const query = getSearchQuery(view.state);
  const { state } = view;
  if (state.readOnly || !query.valid) return false;
  const sel = state.selection.main;
  const cursor = query.getCursor(state, sel.from);
  const r = cursor.next();
  if (!r.done && r.value.from === sel.from && r.value.to === sel.to) {
    const matched = state.sliceDoc(r.value.from, r.value.to);
    const insert = matchReplacementCase(matched, query.replace);
    const changes = state.changes({ from: r.value.from, to: r.value.to, insert });
    const nr = query.getCursor(state, r.value.to).next();
    view.dispatch({
      changes,
      selection: nr.done ? undefined : EditorSelection.single(nr.value.from, nr.value.to).map(changes),
      userEvent: 'input.replace',
    });
    return true;
  }
  return findNext(view);
}

// Replace-all with case preservation — same shape as @codemirror/search's
// own replaceAll, plus matchReplacementCase per match.
function replaceAllPreservingCase(view) {
  const query = getSearchQuery(view.state);
  const { state } = view;
  if (state.readOnly || !query.valid) return false;
  const changes = [];
  const cursor = query.getCursor(state);
  let r;
  while (!(r = cursor.next()).done) {
    const matched = state.sliceDoc(r.value.from, r.value.to);
    changes.push({ from: r.value.from, to: r.value.to, insert: matchReplacementCase(matched, query.replace) });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input.replace.all' });
  return true;
}

class ObsidianSearchPanel {
  constructor(view) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.showReplace = !!this.query.replace;
    this.preserveCase = false;

    this.dom = document.createElement('div');
    this.dom.className = 'cm-obsidian-search';
    // @codemirror/search's own default panel relies on this same pattern —
    // keydown events on these <input>s never reach CM6's contentDOM-scoped
    // keymap at all (they're siblings of it, not descendants), so F3/Mod-g/
    // Escape/etc. (searchKeymap, scoped "search-panel") have to be replayed
    // by hand via runScopeHandlers, exactly like the library's own panel does.
    this.dom.addEventListener('keydown', e => {
      if (runScopeHandlers(view, e, 'search-panel')) { e.preventDefault(); return; }
      if (e.key === 'Enter' && e.target === this.searchInput) {
        e.preventDefault();
        (e.shiftKey ? findPrevious : findNext)(view);
      } else if (e.key === 'Enter' && e.target === this.replaceInput) {
        e.preventDefault();
        this.replaceOne();
      }
    });

    // ── Row 1: search ──
    const row1 = document.createElement('div');
    row1.className = 'cm-obsidian-search-row';

    this.toggleBtn = this.makeIconButton('▾', 'Mostrar reemplazar', () => this.setShowReplace(!this.showReplace));
    this.toggleBtn.classList.add('cm-obsidian-search-chevron');
    row1.appendChild(this.toggleBtn);

    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'cm-obsidian-search-field-wrap';
    this.searchInput = document.createElement('input');
    this.searchInput.className = 'cm-obsidian-search-input';
    this.searchInput.setAttribute('main-field', 'true');
    this.searchInput.placeholder = 'Buscar…';
    this.searchInput.value = this.query.search;
    this.searchInput.addEventListener('input', () => this.commit());
    fieldWrap.appendChild(this.searchInput);

    const flags = document.createElement('span');
    flags.className = 'cm-obsidian-search-flags';
    this.caseBtn = this.makeFlagButton('Aa', 'Sensible a mayúsculas', () => { this.caseSensitive = !this.caseSensitive; this.commit(); });
    this.wordBtn = this.makeFlagButton('ab', 'Palabra completa', () => { this.wholeWord = !this.wholeWord; this.commit(); });
    this.wordBtn.style.textDecoration = 'underline';
    this.regexBtn = this.makeFlagButton('.*', 'Expresión regular', () => { this.regexp = !this.regexp; this.commit(); });
    this.caseSensitive = this.query.caseSensitive;
    this.wholeWord = this.query.wholeWord;
    this.regexp = this.query.regexp;
    flags.appendChild(this.caseBtn);
    flags.appendChild(this.wordBtn);
    flags.appendChild(this.regexBtn);
    fieldWrap.appendChild(flags);
    row1.appendChild(fieldWrap);

    this.countEl = document.createElement('span');
    this.countEl.className = 'cm-obsidian-search-count';
    row1.appendChild(this.countEl);

    row1.appendChild(this.makeIconButton('↑', 'Anterior (Shift+Enter)', () => findPrevious(view)));
    row1.appendChild(this.makeIconButton('↓', 'Siguiente (Enter)', () => findNext(view)));
    row1.appendChild(this.makeIconButton('☰', 'Seleccionar todas las coincidencias', () => selectMatches(view)));
    row1.appendChild(this.makeIconButton('×', 'Cerrar', () => closeSearchPanel(view)));

    // ── Row 2: replace ──
    const row2 = document.createElement('div');
    row2.className = 'cm-obsidian-search-row cm-obsidian-search-replace-row';
    this.replaceRow = row2;

    const spacer = document.createElement('span');
    spacer.className = 'cm-obsidian-search-spacer';
    row2.appendChild(spacer);

    this.replaceInput = document.createElement('input');
    this.replaceInput.className = 'cm-obsidian-search-input';
    this.replaceInput.placeholder = 'Reemplazar…';
    this.replaceInput.value = this.query.replace;
    this.replaceInput.addEventListener('input', () => this.commit());
    row2.appendChild(this.replaceInput);

    this.preserveCaseBtn = this.makeFlagButton('AB', 'Preservar mayúsculas/minúsculas (solo texto plano)', () => {
      if (this.regexp) { return; }
      this.preserveCase = !this.preserveCase;
      this.syncFlagButtons();
    });
    row2.appendChild(this.preserveCaseBtn);
    row2.appendChild(this.makeIconButton('↩', 'Reemplazar', () => this.replaceOne()));
    row2.appendChild(this.makeIconButton('⇉', 'Reemplazar todo', () => this.replaceAll()));

    this.dom.appendChild(row1);
    this.dom.appendChild(row2);
    this.setShowReplace(this.showReplace);
    this.syncFlagButtons();
    this.refreshCount();
  }

  makeIconButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-obsidian-search-icon-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the field
    btn.addEventListener('click', onClick);
    return btn;
  }

  makeFlagButton(label, title, onClick) {
    const btn = this.makeIconButton(label, title, onClick);
    btn.classList.add('cm-obsidian-search-flag-btn');
    return btn;
  }

  syncFlagButtons() {
    this.caseBtn.classList.toggle('is-active', this.caseSensitive);
    this.wordBtn.classList.toggle('is-active', this.wholeWord);
    this.regexBtn.classList.toggle('is-active', this.regexp);
    this.preserveCaseBtn.classList.toggle('is-active', this.preserveCase);
    this.preserveCaseBtn.disabled = this.regexp;
    this.preserveCaseBtn.classList.toggle('is-disabled', this.regexp);
  }

  setShowReplace(show) {
    this.showReplace = show;
    this.replaceRow.hidden = !show;
    this.toggleBtn.textContent = show ? '▾' : '▸';
  }

  commit() {
    const query = new SearchQuery({
      search: this.searchInput.value,
      caseSensitive: this.caseSensitive,
      regexp: this.regexp,
      wholeWord: this.wholeWord,
      replace: this.replaceInput.value,
    });
    this.syncFlagButtons();
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
    this.refreshCount();
  }

  refreshCount() {
    const { total, index, truncated } = computeMatchInfo(this.query, this.view.state);
    if (!this.query.search) { this.countEl.textContent = ''; }
    else if (total === 0) { this.countEl.textContent = 'Sin resultados'; }
    else {
      const totalText = truncated ? `${total}+` : String(total);
      this.countEl.textContent = `${index === -1 ? '?' : index + 1} de ${totalText}`;
    }
  }

  replaceOne() {
    if (this.preserveCase && !this.regexp) { replaceOnePreservingCase(this.view); }
    else { cmReplaceNext(this.view); }
    this.refreshCount();
  }

  replaceAll() {
    if (this.preserveCase && !this.regexp) { replaceAllPreservingCase(this.view); }
    else { cmReplaceAll(this.view); }
    this.refreshCount();
  }

  update(update) {
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.searchInput.value = this.query.search;
          this.replaceInput.value = this.query.replace;
          this.caseSensitive = this.query.caseSensitive;
          this.wholeWord = this.query.wholeWord;
          this.regexp = this.query.regexp;
          this.syncFlagButtons();
          queryChanged = true;
        }
      }
    }
    if (queryChanged || update.selectionSet || update.docChanged) { this.refreshCount(); }
  }

  mount() { this.searchInput.focus(); this.searchInput.select(); }

  get top() { return true; }
}

// ── Ordered-list auto-renumbering ──────────────────────────────────────────────
// Deleting (or adding) an item in the middle of a numbered list should shift every
// following sibling item's own number to stay sequential — e.g. deleting item "2." from a
// 1/2/3 list should turn the old "3." into "2." automatically, matching Obsidian's own live-
// numbering behavior. lezer-markdown has no notion of "this list's numbering just became
// inconsistent" to react to, so this reacts the same regex-driven way mdLinkPlugin/
// highlightMarkPlugin already handle syntax lezer doesn't parse: after a genuine user edit,
// rewrite the run's numbers to be sequential, starting from whatever number the *first* item
// in the run already has (so a list deliberately started at, say, "5." keeps starting there).
// Registered outside previewCompartment (unlike the decoration plugins above) — renumbering is
// a real edit to the document's own text, not a rendering choice, so it applies in source mode
// (raw markdown, no live-preview decorations) exactly the same as in live preview.
const ORDERED_MARKER_RE = /^(\s*)(\d+)([.)])(\s+)/;

// Finds the full contiguous run of ordered-list-item lines (same indent as the line at
// `lineNumber`, tolerating blank lines and more-deeply-indented content — nested sub-lists,
// wrapped continuation text — in between without ending the run) containing that line.
// Returns null if that line isn't itself part of an ordered list at all.
function findOrderedListRun(doc, lineNumber) {
  const anchor = doc.line(lineNumber);
  const anchorMarker = ORDERED_MARKER_RE.exec(anchor.text);
  const indent = anchorMarker ? anchorMarker[1].length : -1;
  if (indent === -1) return null;
  const belongs = text => {
    if (!text.trim()) return true; // blank line — allowed inside a "loose" list
    const m = ORDERED_MARKER_RE.exec(text);
    if (m && m[1].length === indent) return true; // sibling item, same nesting depth
    // Deeper-indented content (nested sub-list, wrapped continuation text) belongs to
    // whichever item precedes it — skip over it without ending the run.
    return /^\s*/.exec(text)[0].length > indent;
  };
  let first = lineNumber, last = lineNumber;
  while (first > 1 && belongs(doc.line(first - 1).text)) first--;
  while (last < doc.lines && belongs(doc.line(last + 1).text)) last++;
  // A blank line only "belongs" *between* two real items — trim any that got swept in
  // at either edge with no item of this run left on that side.
  while (first < last && !doc.line(first).text.trim()) first++;
  while (last > first && !doc.line(last).text.trim()) last--;
  return { first, last, indent };
}

const orderedListRenumberPlugin = ViewPlugin.fromClass(class {
  update(u) {
    if (!u.docChanged) return;
    // Only a genuine insert/delete triggers this — never this plugin's *own* renumbering
    // dispatch below (tagged with a distinct userEvent, so this check is false for it) or an
    // external-update/autosave reconciliation, either of which could otherwise loop or fight
    // with an edit still in flight.
    if (!u.transactions.some(t => t.isUserEvent('input') || t.isUserEvent('delete'))) return;
    const view = u.view;
    // Deferred to a microtask: CM6 disallows dispatching a new transaction synchronously from
    // inside a ViewPlugin's own update() call (it's still mid-way through processing the one
    // that triggered this) — same reasoning WikiSuggestView's render() defers its own layout
    // reads via requestMeasure rather than reading synchronously inside update(). By the next
    // microtask tick the triggering transaction has fully landed, so re-deriving everything
    // fresh from view.state here (rather than trying to reuse anything computed during the
    // update() call) is both simpler and immune to any staleness from the deferral.
    Promise.resolve().then(() => {
      const state = view.state;
      const doc = state.doc;
      const anchorLine = doc.lineAt(Math.min(state.selection.main.head, doc.length)).number;
      const seen = new Set();
      const changes = [];
      // The cursor's own line plus one neighbour on each side — covers a merged-line backspace
      // (the cursor now sits where the deleted line used to start) and an Enter-split insertion
      // alike, without re-scanning the whole document on every keystroke.
      for (let ln = Math.max(1, anchorLine - 1); ln <= Math.min(doc.lines, anchorLine + 1); ln++) {
        const run = findOrderedListRun(doc, ln);
        if (!run || seen.has(run.first)) continue;
        seen.add(run.first);
        let expected = null;
        for (let l = run.first; l <= run.last; l++) {
          const line = doc.line(l);
          const m = ORDERED_MARKER_RE.exec(line.text);
          // findOrderedListRun's own "belongs" check already treats a deeper-indented
          // line (a nested sub-list, wrapped continuation text) as tolerated *filler*
          // within [first,last] without making it a member of *this* run's sequence —
          // this loop has to honor that same boundary, or a nested item that happens to
          // itself start with a bare `\d+[.)]` marker gets swept into the outer run's
          // numbering and has its own (correctly independent) number stomped to match
          // the outer sequence. Was missing here: `ORDERED_MARKER_RE` matches a marker
          // regardless of indent, so without this check every level-N+1 item inside a
          // level-N run's line range got treated as if it were level-N's own next item.
          if (!m || m[1].length !== run.indent) continue;
          if (expected == null) expected = +m[2]; // first item's own number sets the start
          if (+m[2] !== expected) {
            const numFrom = line.from + m[1].length;
            changes.push({ from: numFrom, to: numFrom + m[2].length, insert: String(expected) });
          }
          expected++;
        }
      }
      if (changes.length > 0) { view.dispatch({ changes, userEvent: 'ordered-list.renumber' }); }
    });
  }
});

// ── List item indent/outdent via Tab/Shift-Tab (nest into / out of a sub-list) ──
// Reported: pressing Tab right after an ordered marker ("3. |Subelemento") only
// added leading whitespace — CommonMark already treats a deep-enough-indented
// line as nested content of the preceding item, so the line *looked* indented,
// but its own marker text stayed "3." instead of restarting at "1." for the new
// nested list, and the outer list's remaining items (e.g. "4.") never shifted
// down to fill the gap the demoted item left behind.
//
// Bullet-marker equivalent of ORDERED_MARKER_RE — reindenting a bullet item
// needs no renumbering, but still needs its own marker/indent shape to rebuild
// it at a different indent.
const BULLET_MARKER_RE = /^(\s*)([-*+])( +)/;

// Parses a line's own list marker (ordered or bullet) into enough to rebuild it
// at a different indent: `{ indent, prefixLen, type, punct|bullet }`. `prefixLen`
// is the full marker match length (indent + marker + trailing space) — i.e.
// where this line's own *content* starts, the same quantity CommonMark itself
// requires a nested item's content to be indented at least as far as for it to
// parse as belonging to the preceding item at all.
function parseListMarkerLine(text) {
  const om = ORDERED_MARKER_RE.exec(text);
  if (om) return { indent: om[1].length, prefixLen: om[0].length, type: 'ordered', punct: om[3] };
  const bm = BULLET_MARKER_RE.exec(text);
  if (bm) return { indent: bm[1].length, prefixLen: bm[0].length, type: 'bullet', bullet: bm[2] };
  return null;
}

// Rebuilds `line`'s own leading marker to sit at `newIndent` spaces, reusing its
// own marker type/punctuation/bullet character unchanged — an ordered item
// always restarts at "1" (whatever run it ends up adjacent to, if any, gets
// renumbered sequentially by orderedListRenumberPlugin right after this
// dispatches — same as any other edit that changes an ordered list's
// structure, since this is tagged with the 'input' userEvent prefix that
// plugin's own update() already watches for).
function rebuildListLine(view, line, marker, newIndent) {
  const content = line.text.slice(marker.prefixLen);
  const newMarkerText = marker.type === 'ordered' ? `1${marker.punct} ` : `${marker.bullet} `;
  const newPrefix = ' '.repeat(newIndent) + newMarkerText;
  const cursorInLine = view.state.selection.main.head - line.from;
  const newCursorInLine = cursorInLine <= marker.prefixLen
    ? newPrefix.length
    : newPrefix.length + (cursorInLine - marker.prefixLen);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newPrefix + content },
    selection: { anchor: line.from + newCursorInLine },
    userEvent: 'input.indent',
  });
  return true;
}

// Tab on a list-item line: nests it one level deeper under the nearest
// preceding *sibling* item (same indent, walking back past any of that
// sibling's own already-nested content/blank lines — the same tolerance
// findOrderedListRun already uses for "this belongs to the item above it").
// No sibling directly above at this exact indent → nothing sensible to nest
// under, so this returns false and falls through to Tab's default behavior
// instead of silently doing nothing or something surprising.
function demoteListLine(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const marker = parseListMarkerLine(line.text);
  if (!marker) return false;
  let ln = line.number - 1;
  while (ln >= 1) {
    const text = state.doc.line(ln).text;
    if (!text.trim()) { ln--; continue; }
    const m = parseListMarkerLine(text);
    if (m && m.indent === marker.indent) return rebuildListLine(view, line, marker, m.prefixLen);
    if (/^\s*/.exec(text)[0].length > marker.indent) { ln--; continue; } // nested content of that sibling — keep looking past it
    break; // shallower (or non-list) line reached first — no sibling to nest under
  }
  return false;
}

// Shift-Tab: the inverse — un-nests the line to sit as a sibling of its own
// current parent (the nearest preceding line with *less* indent) instead of as
// that parent's child. No shallower list-item line above at all → this item is
// already at the top level, nothing to promote out of.
function promoteListLine(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const marker = parseListMarkerLine(line.text);
  if (!marker || marker.indent === 0) return false;
  let ln = line.number - 1;
  while (ln >= 1) {
    const text = state.doc.line(ln).text;
    if (text.trim()) {
      const m = parseListMarkerLine(text);
      if (m && m.indent < marker.indent) return rebuildListLine(view, line, marker, m.indent);
    }
    ln--;
  }
  return false;
}

const listIndentKeymap = Prec.highest(keymap.of([
  { key: 'Tab', run: demoteListLine },
  { key: 'Shift-Tab', run: promoteListLine },
]));

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
      previewCompartment.of([livePreviewPlugin, mdLinkPlugin, highlightMarkPlugin, htmlHighlightPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin, frontmatterAtomicRanges, foldPlugin, foldAtomicRanges]),
      orderedListRenumberPlugin,
      listIndentKeymap,
      // Find/replace panel (Ctrl+F — see obsidianSearchPanelPlugin's own
      // comment for why the actual keybinding is a real VS Code command
      // instead of relying on searchKeymap's own Mod-f reaching this webview
      // reliably). `top: true` so the panel's containing block (.cm-panels-top)
      // sticks to the *top* of the scroll container as the user scrolls —
      // ObsidianSearchPanel positions itself absolutely inside that
      // container, so this is what keeps it pinned near the top-right of the
      // visible viewport rather than wherever the bottom of the document
      // happens to be.
      search({ top: true, createPanel: view => new ObsidianSearchPanel(view) }),
      keymap.of(searchKeymap),
      linkClickHandler,
      hoverPreviewPlugin,
      tableMenuPlugin,
      tableContextMenuHandler,
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
// `var(--x, fallback)` only substitutes `fallback` when `--x` is *undefined* —
// a custom property explicitly set to an empty string still counts as "set" (to
// the empty token stream), so `font-family: var(--code-font, var(--font-
// monospace, ...))` with `--code-font: ;` doesn't fall through the chain at
// all: the whole declaration becomes invalid at computed-value time and
// `font-family` reverts to its *inherited* value instead — silently skipping
// every fallback, including the final hardcoded `monospace`. Reported as code
// blocks not using the configured monospace font at all (`obsidianLike.codeFont`
// empty is the default/common case, so this bit essentially everyone). Fixed by
// never calling `setProperty` with an empty value — `removeProperty` instead,
// so the custom property is genuinely undefined and `var()`'s fallback chain
// actually runs.
function setFontVar(name, value) {
  if (value) { root.style.setProperty(name, value); } else { root.style.removeProperty(name); }
}
setFontVar('--md-font', init.font);
setFontVar('--code-font', init.codeFont);
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
      sourceMode ? [] : [livePreviewPlugin, highlightMarkPlugin, htmlHighlightPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin, frontmatterAtomicRanges, foldPlugin, foldAtomicRanges]
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
      // setFontVar (see its own comment above) — not a plain setProperty —
      // so clearing a custom font back to "use the theme/editor default"
      // actually falls through var()'s fallback chain instead of leaving
      // --md-font/--code-font set to an inert empty string.
      if (msg.font !== undefined)     setFontVar('--md-font', msg.font);
      if (msg.codeFont !== undefined) setFontVar('--code-font', msg.codeFont);
      if (msg.codeFontSize) root.style.setProperty('--code-font-size', msg.codeFontSize);
      if (msg.fontSize)  root.style.setProperty('--md-font-size', msg.fontSize);
      // Changing the font can change line-height/character metrics after CM6
      // already measured layout once — see the comment by the initial
      // requestMeasure() call above. Re-measure so drawSelection() (and cursor
      // placement) don't stay pinned to the old, now-stale metrics.
      view.requestMeasure();
      break;
    case 'highlighter-settings':
      // Live update on a `obsidianLike.highlighterColors`/`...UseCssClasses`
      // config change — no reload needed, since these are only ever read at
      // toolbar/menu-build time (buildHighlighterMenuItems) or at write time
      // (applyHighlight), not baked into any already-built decoration.
      if (msg.colors && msg.colors.length) highlighterColors = msg.colors;
      if (msg.useCssClasses !== undefined) highlighterUseCssClasses = !!msg.useCssClasses;
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
    case 'open-search-panel':
      openSearchPanel(view);
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
    // Sent once, the first time the sibling "Obsidian-like Image Toolkit" extension's assets
    // resolve (see injectImageToolkitIfAvailable in extension.ts) — loads its stylesheet/script
    // as real <link>/<script> tags. Settings are handed to the script via a global read
    // synchronously at its own top level, so it must be set *before* the <script> is appended.
    case 'load-image-toolkit':
      if (msg.styleUri) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = msg.styleUri;
        document.head.appendChild(link);
      }
      window.__imageToolkitSettings = msg.settings || {};
      if (msg.scriptUri) {
        const script = document.createElement('script');
        script.src = msg.scriptUri;
        document.body.appendChild(script);
      }
      break;
    // Sent on every later change to an `obsidianlikeImageToolkit.*` setting — the toolkit script
    // is already loaded by this point, so just hand it the fresh settings via a DOM event instead
    // of reloading the whole script.
    case 'image-toolkit-settings':
      window.__imageToolkitSettings = msg.settings || {};
      window.dispatchEvent(new CustomEvent('image-toolkit-settings-changed', { detail: msg.settings || {} }));
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
