// webview-src/editor.js — CodeMirror 6 editor for the VS Code vault extension.
// Bundled by esbuild into out/editor.bundle.js.

import { EditorState, EditorSelection, RangeSetBuilder, Compartment, StateEffect } from "@codemirror/state";
import {
  EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentWithTab
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

// ── Bootstrap data ───────────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const init   = window.__vaultInitial || {};
let noteIndex = init.noteIndex || [];
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
  '.cm-md-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // Collapsed table rows (lines 2..N replaced by empty + height:0)
  '.cm-table-row-hidden': {
    height: '0 !important', lineHeight: '0 !important',
    overflow: 'hidden', padding: '0 !important', minHeight: '0 !important',
  },
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
  // Task checkbox lines (- [ ] / - [x] ...), rendered by TaskCheckboxWidget.
  '.cm-task-line': { paddingLeft: '0' },
  '.cm-task-done': {
    color: 'var(--text-muted, inherit)',
    textDecoration: 'line-through',
  },
  '.cm-task-checkbox': {
    display: 'inline-block',
    width: '1em', height: '1em',
    margin: '0 0.4em 0 0',
    verticalAlign: 'middle',
    cursor: 'pointer',
    position: 'relative', top: '-1px',
  },
  '.cm-task-overdue': {
    color: 'var(--text-error, #e06c75)',
    fontWeight: 'bold',
  },
  // ```tasks``` query block rendering (see TasksQueryWidget).
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
  '.cm-tasks-query-list': {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  '.cm-tasks-query-item': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.3em',
    lineHeight: '1.5',
  },
  '.cm-tasks-query-item.cm-task-done .cm-tasks-query-desc': {
    color: 'var(--text-muted, inherit)',
    textDecoration: 'line-through',
  },
  '.cm-tasks-query-desc': { flex: '1 1 auto' },
  '.cm-tasks-query-badge': {
    opacity: '0.75',
    fontSize: '0.9em',
    whiteSpace: 'nowrap',
  },
  // Folded heading content
  '.cm-fold-hidden': {
    height: '0 !important', lineHeight: '0 !important',
    overflow: 'hidden', padding: '0 !important', minHeight: '0 !important',
    visibility: 'hidden',
  },
  // Heading fold indicator — mirrors Obsidian's .cm-fold-indicator structure
  '.cm-fold-indicator': {
    display: 'inline-block', cursor: 'pointer', userSelect: 'none',
    opacity: '0.35', transition: 'opacity 0.15s', verticalAlign: 'middle',
  },
  '.cm-fold-indicator:hover': { opacity: '0.85' },
  '.cm-fold-indicator .svg-icon.right-triangle': {
    width: '14px', height: '14px', verticalAlign: 'middle',
    transition: 'transform 0.15s',
  },
  '.cm-fold-indicator.is-collapsed .svg-icon.right-triangle': {
    transform: 'rotate(-90deg)',
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
  { tag: tags.monospace,
    fontFamily: 'var(--font-monospace, var(--vscode-editor-font-family, monospace))',
    fontSize: '0.88em',
    background: 'var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)))',
    color: 'var(--code-normal, inherit)',
    padding: '1px 4px', borderRadius: '3px' },
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
function renderCell(raw) {
  // HTML-escape first to prevent injection
  let s = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Protect inline code from further processing
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\x00C${codes.length - 1}\x00`; });
  // Bold-italic → bold → italic (order matters: ** before *)
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Wiki-links [[target]] or [[target|alias]]
  s = s.replace(/(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (_, tgt, alias) =>
    `<span data-wiki="${tgt}" style="color:var(--link-color,var(--vscode-textLink-foreground,#4a9eff));` +
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

// ── Task checkbox widget ──────────────────────────────────────────────────────
// Renders a real <input type="checkbox">. Unlike BulletWidget, this is rendered on
// the active/cursor line too (not gated behind `active.has(ln)`) so it stays
// clickable while editing the task text. `line` is the 0-based doc line number,
// read back by the click handler and sent to the extension host as `toggle-task`.
class TaskCheckboxWidget extends WidgetType {
  constructor(checked, line) { super(); this.checked = checked; this.line = line; }
  eq(other) { return this.checked === other.checked && this.line === other.line; }
  toDOM() {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-task-checkbox';
    input.checked = this.checked;
    input.dataset.line = String(this.line);
    return input;
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

const TASK_PRIORITY_ICON = {
  Highest: '🔺', High: '⏫', Medium: '🔼', Low: '🔽', Lowest: '⏬',
};

// Renders a single TaskDTO as a checklist row. Mirrors TaskCheckboxWidget's DOM
// shape (a real <input type="checkbox">, cm-task-checkbox class) but carries
// both `data-path` and `data-line` since results can come from any file in the
// vault, not just the currently open document — the click handler below reads
// both and sends `toggle-task-at-location` instead of `toggle-task`.
function renderTaskRow(t) {
  const row = document.createElement('div');
  row.className = 'cm-tasks-query-item' + (t.isDone ? ' cm-task-done' : '');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'cm-task-checkbox cm-task-query-checkbox';
  cb.checked = !!t.isDone;
  cb.dataset.path = t.path;
  cb.dataset.line = String(t.line);
  row.appendChild(cb);

  const desc = document.createElement('span');
  desc.className = 'cm-tasks-query-desc' + (t.isOverdue ? ' cm-task-overdue' : '');
  desc.textContent = t.description || '';
  row.appendChild(desc);

  const icon = TASK_PRIORITY_ICON[t.priority];
  if (icon) {
    const p = document.createElement('span');
    p.className = 'cm-tasks-query-badge';
    p.textContent = icon;
    row.appendChild(p);
  }
  if (t.dueDate) {
    const d = document.createElement('span');
    d.className = 'cm-tasks-query-badge' + (t.isOverdue ? ' cm-task-overdue' : '');
    d.textContent = '📅 ' + t.dueDate;
    row.appendChild(d);
  }
  if (t.isRecurring && t.recurrenceRule) {
    const r = document.createElement('span');
    r.className = 'cm-tasks-query-badge';
    r.textContent = '🔁 ' + t.recurrenceRule;
    row.appendChild(r);
  }
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

// Renders a TasksQueryResultDTO into `container` (a freshly-created wrapper div).
function renderTasksQueryResult(container, result) {
  const groups = result && result.groups;
  const items  = (result && result.items) || [];

  if (groups) {
    const nonEmpty = groups.filter(g => g.items && g.items.length > 0);
    if (nonEmpty.length === 0) {
      renderEmptyNotice(container);
    } else {
      nonEmpty.forEach(g => {
        const h = document.createElement('div');
        h.className = 'cm-tasks-query-group-title';
        h.textContent = g.name;
        container.appendChild(h);
        container.appendChild(renderTaskList(g.items));
      });
    }
  } else if (items.length > 0) {
    container.appendChild(renderTaskList(items));
  } else {
    renderEmptyNotice(container);
  }

  const unrecognized = (result && result.unrecognizedLines) || [];
  if (unrecognized.length > 0) {
    const warn = document.createElement('div');
    warn.className = 'cm-tasks-query-warning';
    warn.textContent = '⚠ Líneas no reconocidas: ' + unrecognized.join(' | ');
    container.appendChild(warn);
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
  ignoreEvent() { return false; }
}

// ── Live-preview plugin ───────────────────────────────────────────────────────
const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some(t => t.effects.some(e => e.is(tasksRebuildEffect)))) {
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

      syntaxTree(state).iterate({
        from: view.viewport.from,
        to:   view.viewport.to,
        leave(node) {
          if (node.name === 'BulletList' || node.name === 'OrderedList') { listDepth--; }
        },
        enter(node) {
          const n = node.name;

          // ── Lists — indentation + spacing from the preceding block ────────
          if (n === 'BulletList' || n === 'OrderedList') {
            if (listDepth === 0) { awaitingFirstItem = true; }
            listDepth++;
            return; // descend into ListItem children
          }
          if (n === 'ListItem') {
            const line = state.doc.lineAt(node.from);
            const lineStart = line.from;
            const depthClass = `cm-list-depth-${Math.min(listDepth, 4)}`;
            const firstClass = awaitingFirstItem ? ' cm-list-first' : '';

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
                  class: `HyperMD-list-line cm-list-line ${depthClass}${firstClass} cm-task-line${isDone ? ' cm-task-done' : ''}`
                }) });

              const cbM = TASK_CHECKBOX_RE.exec(line.text);
              if (cbM) {
                const markStart = lineStart + cbM[1].length;
                let end = lineStart + cbM[0].length;
                if (state.doc.sliceString(end, end + 1) === ' ') end++;
                decs.push({ from: markStart, to: end,
                  dec: Decoration.replace({ widget: new TaskCheckboxWidget(isDone, line.number - 1) }) });

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
                dec: Decoration.line({ class: `HyperMD-list-line cm-list-line ${depthClass}${firstClass}` }) });
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
                // Remaining lines: replace content + collapse via line decoration
                for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                  const line = state.doc.line(ln);
                  decs.push({ from: line.from, to: line.to,
                    dec: Decoration.replace({}) });
                  lineDecs.push({ from: line.from,
                    dec: Decoration.line({ class: 'cm-table-row-hidden' }) });
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
            if (info === 'tasks') {
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
                  const codeTextNode = node.node.getChild('CodeText');
                  const queryText = codeTextNode
                    ? state.doc.sliceString(codeTextNode.from, codeTextNode.to).trim()
                    : '';

                  const cached = tasksQueryCache.get(queryText);
                  if (!cached) { requestTasksQuery(queryText); }

                  decs.push({ from: fromLine.from, to: fromLine.to,
                    dec: Decoration.replace({ widget: new TasksQueryWidget(queryText, cached) }) });
                  for (let ln = fromLine.number + 1; ln <= toLine.number; ln++) {
                    const line = state.doc.line(ln);
                    decs.push({ from: line.from, to: line.to,
                      dec: Decoration.replace({}) });
                    lineDecs.push({ from: line.from,
                      dec: Decoration.line({ class: 'cm-table-row-hidden' }) });
                  }
                }
              } catch (_) {}
              return false;
            }
            // Not a tasks block — fall through so normal FencedCode/CodeMark/
            // CodeText handling (unchanged) still applies.
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
const wikiLinkPlugin = ViewPlugin.fromClass(class {
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
    const re = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;
    const all = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const name  = m[1];
      const alias = m[2];
      all.push({ from: mFrom,     to: mFrom + 2, dec: Decoration.replace({}) });
      if (alias !== undefined) {
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length + 1, dec: Decoration.replace({}) });
        const aFrom = mFrom + 2 + name.length + 1;
        all.push({ from: aFrom, to: aFrom + alias.length,
          dec: Decoration.mark({ class: 'cm-wiki-link', attributes: { 'data-target': name } }) });
      } else {
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length,
          dec: Decoration.mark({ class: 'cm-wiki-link', attributes: { 'data-target': name } }) });
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

// ── Wiki-link / transclusion autocomplete ─────────────────────────────────────
// Triggers on both `[[` (links) and `![[` (transclusions) since the match is on
// `[[` alone (see the regex below) — the leading `!`, if present, is left as-is
// and only the `[[...]]` span gets replaced by `apply`. Once the typed text
// contains a `#`, the source switches to querying that note's headings (in
// document order, i.e. the same hierarchical order they appear in the file)
// instead of the note index.
const pendingHeadingRequests = new Map(); // request id -> resolve
let headingsReqSeq = 0;

function requestHeadings(note) {
  return new Promise(resolve => {
    const id = 'h' + (++headingsReqSeq);
    pendingHeadingRequests.set(id, resolve);
    vscode.postMessage({ type: 'get-headings', id, note });
  });
}

async function wikiComplete(ctx) {
  const word = ctx.matchBefore(/\[\[[^\]]*$/);
  if (!word && !ctx.explicit) return null;
  const inner = word ? word.text.slice(2) : '';
  const hashIdx = inner.indexOf('#');

  if (hashIdx === -1) {
    const query = inner.toLowerCase();
    const opts = noteIndex
      .filter(n => n.toLowerCase().includes(query))
      .slice(0, 30)
      .map(name => ({ label: name, type: 'text', apply: `[[${name}]]` }));
    if (!opts.length) return null;
    // Excludes '#' so typing one invalidates this result and forces CM to re-run
    // wikiComplete, switching to the heading-search branch below.
    return { from: word ? word.from : ctx.pos, options: opts, validFor: /^\[\[[^\]#]*$/ };
  }

  const notePart = inner.slice(0, hashIdx);
  if (!notePart) return null;
  const sectionQuery = inner.slice(hashIdx + 1).toLowerCase();
  const headings = await requestHeadings(notePart);
  const opts = headings
    .filter(h => h.text.toLowerCase().includes(sectionQuery))
    .map(h => ({
      label: '#'.repeat(h.level) + ' ' + h.text,
      type: 'text',
      apply: `[[${notePart}#${h.text}]]`,
    }));
  if (!opts.length) return null;
  return { from: word ? word.from : ctx.pos, options: opts, validFor: /^\[\[[^\]#]*#[^\]]*$/ };
}

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
      vscode.postMessage({ type: 'open-note', name: tableWiki.dataset.wiki });
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
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('svg-icon', 'right-triangle');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 8L12 17L21 8');
    svg.appendChild(path); inner.appendChild(svg); outer.appendChild(inner);
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

      for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const folded = foldedSet.has(h.lineFrom);

        // Fold toggle widget — only for heading lines in viewport
        if (h.lineTo >= vf && h.lineFrom <= vt) {
          all.push({ from: h.lineFrom, to: h.lineFrom,
            dec: Decoration.widget({ widget: new FoldToggle(h.lineFrom, folded), side: -1 }) });
        }

        if (!folded) continue;

        // Find end of folded range: next heading at same or higher level
        let foldEnd = state.doc.length;
        for (let j = i + 1; j < headings.length; j++) {
          if (headings[j].level <= h.level) {
            foldEnd = headings[j].lineFrom > 0 ? headings[j].lineFrom - 1 : 0;
            break;
          }
        }

        // Collapse every line after the heading up to foldEnd
        if (foldEnd > h.lineTo) {
          const startLn = state.doc.lineAt(h.lineTo + 1).number;
          const endLn   = state.doc.lineAt(foldEnd).number;
          for (let ln = startLn; ln <= endLn; ln++) {
            const line = state.doc.line(ln);
            all.push({ from: line.from, to: line.to, dec: Decoration.replace({}) });
            lineDecs.push({ from: line.from,
              dec: Decoration.line({ class: 'cm-fold-hidden' }) });
          }
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
      previewCompartment.of([livePreviewPlugin, mdLinkPlugin, wikiLinkPlugin, imgPlugin, transclusionPlugin]),
      foldPlugin,
      linkClickHandler,
      autocompletion({ override: [wikiComplete], closeOnBlur: true }),
      keymap.of([
        { key: 'Mod-b', run: v => toggleWrap(v, '**') },
        { key: 'Mod-i', run: v => toggleWrap(v, '*')  },
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      vsTheme,
      EditorView.updateListener.of(u => {
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

// ── Message handling ──────────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'note-index':
      noteIndex = msg.notes || [];
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
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: msg.content } });
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
      if (msg.font)     root.style.setProperty('--md-font', msg.font);
      if (msg.fontSize) root.style.setProperty('--md-font-size', msg.fontSize);
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
    case 'transclusion-result':
      transclusionCache.set(msg.id, { content: msg.content, title: msg.title, line: msg.line, error: msg.error });
      transclusionPending.delete(msg.id);
      view.dispatch({ effects: transclusionRebuildEffect.of(null) });
      break;
    case 'headings-result': {
      const resolve = pendingHeadingRequests.get(msg.id);
      if (resolve) { pendingHeadingRequests.delete(msg.id); resolve(msg.headings || []); }
      break;
    }
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
// Without a `dragover` handler that calls preventDefault(), the browser never
// considers this a valid drop target (per the HTML5 DnD spec, `drop` only fires
// on an element whose `dragover` default was prevented) — so an OS file drag
// over this webview used to fall through entirely to VS Code's own default of
// opening the dropped file as a new editor tab. Claiming both events here lets
// the webview handle it instead: save the file into the configured attachments
// dir (host-side, mirroring paste-image but keeping the original filename) and
// insert `![[filename]]` at the drop position — same embed convention already
// used for pasted images and note transclusions.
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let pendingDropPos = null;

container.addEventListener('dragover', e => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

container.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const coordPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  pendingDropPos = coordPos != null ? coordPos : view.state.selection.main.head;
  const files = Array.from(e.dataTransfer.files);
  Promise.all(files.map(f => readFileAsDataUrl(f).then(data => ({ name: f.name, data }))))
    .then(payload => vscode.postMessage({ type: 'drop-files', files: payload }))
    .catch(() => { pendingDropPos = null; });
});
