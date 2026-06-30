// webview-src/editor.js — CodeMirror 6 editor for the VS Code vault extension.
// Bundled by esbuild into out/editor.bundle.js.

import { EditorState, EditorSelection, RangeSetBuilder, Compartment } from "@codemirror/state";
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
  '.cm-wiki-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
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
  // Table lines: invisible but still in layout so CM6 can measure them
  '.cm-table-line-hidden': { visibility: 'hidden' },
  // Overlay layer that renders table widgets above the hidden raw lines
  '.cm-table-overlay-layer': {
    position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
    pointerEvents: 'none', overflow: 'visible', zIndex: '2',
  },
  '.cm-md-table-wrap': { overflowX: 'auto', margin: '4px 0 8px', pointerEvents: 'auto' },
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
  { tag: tags.heading1,
    fontSize: 'var(--h1-size, 1.75em)', fontWeight: '700', lineHeight: '1.3',
    color: 'var(--h1-color, inherit)' },
  { tag: tags.heading2,
    fontSize: 'var(--h2-size, 1.4em)', fontWeight: '700', lineHeight: '1.3',
    color: 'var(--h2-color, inherit)' },
  { tag: tags.heading3,
    fontSize: 'var(--h3-size, 1.15em)', fontWeight: '600',
    color: 'var(--h3-color, inherit)' },
  { tag: tags.heading4,
    fontWeight: '600',
    color: 'var(--h4-color, inherit)' },
  { tag: tags.strong,
    fontWeight: 'var(--bold-weight, 700)',
    color: 'var(--bold-color, inherit)' },
  { tag: tags.emphasis,
    fontStyle: 'italic',
    color: 'var(--italic-color, inherit)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link,
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: tags.url,
    color: 'var(--text-muted, var(--vscode-textLink-foreground, #4ec9b0))',
    opacity: '0.6', fontSize: '0.82em' },
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
class TableWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(other) { return this.src === other.src; }
  toDOM() {
    const wrap  = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';

    const lines = this.src.split('\n').filter(l => l.trim() && l.includes('|'));
    if (lines.length < 2) { wrap.textContent = this.src; return wrap; }

    const parseRow = line =>
      line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

    const headers = parseRow(lines[0]);
    const aligns  = parseRow(lines[1]).map(s => {
      const t = s.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      return 'left';
    });

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    headers.forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.textAlign = aligns[i] || 'left';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    lines.slice(2).forEach(line => {
      const tr = document.createElement('tr');
      parseRow(line).forEach((cell, i) => {
        const td = document.createElement('td');
        td.textContent = cell;
        td.style.textAlign = aligns[i] || 'left';
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
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(other) { return this.src === other.src; }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.style.cssText = 'max-width:100%;height:auto;display:block;margin:4px 0;border-radius:4px;';
    return img;
  }
  ignoreEvent() { return false; }
}

// ── Live-preview plugin ───────────────────────────────────────────────────────
const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
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

      syntaxTree(state).iterate({
        from: view.viewport.from,
        to:   view.viewport.to,
        enter(node) {
          const n = node.name;

          // ── Tables ────────────────────────────────────────────────────────
          // Rendered by tableOverlayPlugin (absolutely positioned overlay).
          // Here we only hide the raw table lines when not active so the
          // overlay is visible. We use visibility:hidden (NOT display:none)
          // so CM6 can still measure line heights without crashing.
          if (n === 'Table') {
            try {
              const fromLine = state.doc.lineAt(node.from);
              const endPos = Math.max(node.from,
                Math.min(node.to, state.doc.length) - 1);
              const toLine = state.doc.lineAt(endPos);

              let isActive = false;
              for (let i = fromLine.number; i <= toLine.number; i++) {
                if (active.has(i)) { isActive = true; break; }
              }
              if (!isActive) {
                for (let ln = fromLine.number; ln <= toLine.number; ln++) {
                  lineDecs.push({ from: state.doc.line(ln).from,
                    dec: Decoration.line({ class: 'cm-table-line-hidden' }) });
                }
              }
            } catch (_) {}
            return false;
          }

          const ln = state.doc.lineAt(node.from).number;
          if (active.has(ln)) return;

          if (n === 'HeaderMark') {
            let end = node.to;
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
            decs.push({ from: node.from, to: end, dec: Decoration.replace({}) });
            return false;
          }
          if (n === 'EmphasisMark' || n === 'CodeMark' || n === 'StrikethroughMark') {
            decs.push({ from: node.from, to: node.to, dec: Decoration.replace({}) });
            return false;
          }
          if (n === 'LinkMark') {
            decs.push({ from: node.from, to: node.to, dec: Decoration.replace({}) });
            return false;
          }
          if (n === 'URL') {
            decs.push({ from: node.from, to: node.to, dec: Decoration.replace({}) });
            return false;
          }
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
    } catch (_) {
      return Decoration.none;
    }
  }
}, { decorations: v => v.decorations });

// ── Table overlay plugin ──────────────────────────────────────────────────────
// Renders tables as absolutely-positioned widgets in an overlay div that sits
// on top of the (visibility:hidden) raw table lines. This avoids all CM6
// block-decoration constraints that caused measurement crashes.
const tableOverlayPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'cm-table-overlay-layer';
    // Append inside scrollDOM so the overlay scrolls with content.
    // scrollDOM needs position:relative for absolute children.
    if (getComputedStyle(view.scrollDOM).position === 'static') {
      view.scrollDOM.style.position = 'relative';
    }
    view.scrollDOM.appendChild(this.overlay);
    this._render(view);
  }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) {
      this._render(u.view);
    }
  }
  _render(view) {
    // Clear previous table widgets
    while (this.overlay.firstChild) this.overlay.removeChild(this.overlay.firstChild);

    const { state } = view;
    const active = getActiveLines(state);
    const scrollDOM = view.scrollDOM;
    const scrollTop  = scrollDOM.scrollTop;
    const scrollLeft = scrollDOM.scrollLeft;
    const scrollRect = scrollDOM.getBoundingClientRect();
    const contentRect = view.contentDOM.getBoundingClientRect();

    syntaxTree(state).iterate({
      from: view.viewport.from,
      to:   view.viewport.to,
      enter: (node) => {
        if (node.name !== 'Table') return;
        try {
          const fromLine = state.doc.lineAt(node.from);
          const endPos   = Math.max(node.from, Math.min(node.to, state.doc.length) - 1);
          const toLine   = state.doc.lineAt(endPos);

          let isActive = false;
          for (let i = fromLine.number; i <= toLine.number; i++) {
            if (active.has(i)) { isActive = true; break; }
          }
          if (isActive) return false;

          const fromCoords = view.coordsAtPos(fromLine.from);
          if (!fromCoords) return false;

          const src = state.doc.sliceString(fromLine.from, toLine.to);
          const el  = new TableWidget(src).toDOM();

          // Position relative to scrollDOM's content origin (scroll-adjusted)
          const top  = fromCoords.top  - scrollRect.top  + scrollTop;
          const left = contentRect.left - scrollRect.left + scrollLeft;
          el.style.cssText =
            `position:absolute;top:${top}px;left:${left}px;` +
            `width:${contentRect.width}px;box-sizing:border-box;`;

          this.overlay.appendChild(el);
        } catch (_) {}
        return false;
      },
    });
  }
  destroy() {
    this.overlay.remove();
  }
});

// ── Wiki-link plugin ──────────────────────────────────────────────────────────
const wikiLinkPlugin = ViewPlugin.fromClass(class {
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
        all.push({ from: aFrom, to: aFrom + alias.length, dec: Decoration.mark({ class: 'cm-wiki-link' }) });
      } else {
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length, dec: Decoration.mark({ class: 'cm-wiki-link' }) });
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
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
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
      const filename = m[1].trim();
      if (!IMG_EXT.test(filename)) continue;
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const basename = filename.split('/').pop();
      const src = imageMap[filename] || imageMap[basename] || '';
      if (!src) continue;
      all.push({ from: mFrom, to: mTo,
        dec: Decoration.replace({ widget: new ImageWidget(src, filename) }) });
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

// ── Wiki-link autocomplete ────────────────────────────────────────────────────
function wikiComplete(ctx) {
  const word = ctx.matchBefore(/\[\[[^\]]*$/);
  if (!word && !ctx.explicit) return null;
  const query = word ? word.text.slice(2).toLowerCase() : '';
  const opts = noteIndex
    .filter(n => n.toLowerCase().includes(query))
    .slice(0, 30)
    .map(name => ({ label: name, type: 'text', apply: `[[${name}]]` }));
  if (!opts.length) return null;
  return { from: word ? word.from : ctx.pos, options: opts, validFor: /^\[\[[^\]]*$/ };
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

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    if (getActiveLines(view.state).has(view.state.doc.lineAt(pos).number)) return false;
    if (findUrlAtPos(view, pos)) { e.preventDefault(); return true; }
    return false;
  },
  // click: fire the action
  click(e, view) {
    const wikiEl = isWikiLinkEl(e.target, view.dom);
    if (wikiEl) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-note', name: wikiEl.textContent.trim() });
      return true;
    }

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    if (getActiveLines(view.state).has(view.state.doc.lineAt(pos).number)) return false;
    const url = findUrlAtPos(view, pos);
    if (url) {
      e.preventDefault();
      vscode.postMessage({ type: 'open-url', url });
      return true;
    }
    return false;
  },
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
      previewCompartment.of([livePreviewPlugin, tableOverlayPlugin, wikiLinkPlugin, imgPlugin]),
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
if (init.breadcrumb && init.breadcrumb.length > 1) {
  init.breadcrumb.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep';
      sep.textContent = '/';
      breadcrumbEl.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'bc-part' + (i === init.breadcrumb.length - 1 ? ' bc-last' : '');
    span.textContent = part.name;
    span.dataset.fspath = part.fsPath;
    breadcrumbEl.appendChild(span);
  });
  breadcrumbEl.addEventListener('click', e => {
    const part = e.target.closest('.bc-part');
    if (part) vscode.postMessage({ type: 'reveal-path', fsPath: part.dataset.fspath });
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
view.focus();

// ── Source mode toggle ────────────────────────────────────────────────────────
function toggleSourceMode() {
  sourceMode = !sourceMode;
  view.dispatch({
    effects: previewCompartment.reconfigure(
      sourceMode ? [] : [livePreviewPlugin, tableOverlayPlugin, wikiLinkPlugin, imgPlugin]
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
    case 'font-update':
      if (msg.font)     root.style.setProperty('--md-font', msg.font);
      if (msg.fontSize) root.style.setProperty('--md-font-size', msg.fontSize);
      break;
    case 'theme-css': {
      let st = document.getElementById('__obsidian-theme');
      if (!st) {
        st = document.createElement('style');
        st.id = '__obsidian-theme';
        document.head.appendChild(st);
      }
      st.textContent = msg.css || '';
      break;
    }
    case 'toggle-source-mode':
      toggleSourceMode();
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
