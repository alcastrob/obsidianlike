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
  // Wiki-link display style
  '.cm-wiki-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // Hyperlink style (markdown links and bare URLs on non-active lines)
  '.cm-md-link': {
    color: 'var(--link-color, var(--text-accent, var(--vscode-textLink-foreground, #4ec9b0)))',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // Table styles
  '.cm-md-table-wrap': { overflowX: 'auto', margin: '4px 0 8px' },
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: 'inherit',
    fontFamily: 'inherit',
  },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--table-border-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)))',
    padding: '6px 12px',
    lineHeight: '1.5',
    verticalAlign: 'top',
  },
  '.cm-md-table th': {
    fontWeight: '600',
    background: 'var(--table-header-background, rgba(128,128,128,0.1))',
    color: 'var(--table-header-color, inherit)',
  },
  '.cm-md-table tr:nth-child(even) td': {
    background: 'var(--table-row-alt-background, rgba(128,128,128,0.04))',
  },
  // Autocomplete tooltip
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
    const headerRow = document.createElement('tr');
    headers.forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.textAlign = aligns[i] || 'left';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
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

// ── Live-preview plugin (headings, emphasis marks, tables) ────────────────────
const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged) {
      this.decorations = this._build(u.view);
    }
  }
  _build(view) {
    const { state } = view;
    const active = getActiveLines(state);
    const decs = []; // { from, to, dec }

    syntaxTree(state).iterate({
      from: view.viewport.from,
      to:   view.viewport.to,
      enter(node) {
        const n = node.name;

        // ── Tables: replace whole block with rendered widget ──
        if (n === 'Table') {
          const firstLine = state.doc.lineAt(node.from);
          // node.to may point past the last \n — resolve safely
          const lastPos = node.to > node.from ? node.to - 1 : node.from;
          const lastLine = state.doc.lineAt(lastPos);
          let isActive = false;
          for (let i = firstLine.number; i <= lastLine.number; i++) {
            if (active.has(i)) { isActive = true; break; }
          }
          if (!isActive) {
            const src = state.doc.sliceString(firstLine.from, lastLine.to);
            decs.push({
              from: firstLine.from,
              to:   lastLine.to,
              dec:  Decoration.replace({ widget: new TableWidget(src), block: true }),
            });
          }
          return false; // don't descend into table children
        }

        // For all other nodes, only process non-active lines
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

    decs.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to, dec } of decs) {
      if (from < lastTo) continue;
      try { builder.add(from, to, dec); } catch (_) {}
      lastTo = to;
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

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
      // Lookup webview URI — try full name, then basename
      const basename = filename.split('/').pop();
      const src = imageMap[filename] || imageMap[basename] || '';
      if (!src) continue;
      all.push({
        from: mFrom, to: mTo,
        dec: Decoration.replace({ widget: new ImageWidget(src, filename) }),
      });
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

// ── Click handler: wiki links and URL links ───────────────────────────────────
const linkClickHandler = EditorView.domEventHandlers({
  click(e, view) {
    // Wiki-link: click on a .cm-wiki-link span → open/create note
    let el = e.target;
    while (el && el !== view.dom) {
      if (el.classList && el.classList.contains('cm-wiki-link')) {
        e.preventDefault();
        vscode.postMessage({ type: 'open-note', name: el.textContent.trim() });
        return true;
      }
      el = el.parentElement;
    }

    // URL link: on non-active lines, click opens in browser
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    if (getActiveLines(view.state).has(line.number)) return false;

    // Walk syntax tree to find URL node at click position
    let url = null;
    const tree = syntaxTree(view.state);
    let cur = tree.resolve(pos, 1);
    while (cur) {
      if (cur.name === 'URL') {
        let raw = view.state.doc.sliceString(cur.from, cur.to);
        if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
        url = raw;
        break;
      }
      if (cur.name === 'Link') {
        // Find first URL child
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

    // Regex fallback for bare https?:// URLs not captured by the syntax tree
    if (!url) {
      const colOffset = pos - line.from;
      const re = /https?:\/\/[^\s)"'\]>]+/g;
      let m;
      while ((m = re.exec(line.text)) !== null) {
        if (m.index <= colOffset && colOffset <= m.index + m[0].length) {
          url = m[0];
          break;
        }
      }
    }

    if (url && /^https?:\/\//.test(url)) {
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
      previewCompartment.of([livePreviewPlugin, wikiLinkPlugin, imgPlugin]),
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

// ── Document title ────────────────────────────────────────────────────────────
const titleEl  = document.getElementById('doc-title');
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
      sourceMode ? [] : [livePreviewPlugin, wikiLinkPlugin, imgPlugin]
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
      // Force imgPlugin to redraw
      view.dispatch({});
      break;
    case 'title-revert':
      currentTitle = msg.name || '';
      titleEl.textContent = currentTitle;
      break;
    case 'external-update': {
      const cur = view.state.doc.toString();
      if (msg.content !== cur) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: msg.content },
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
      // Add new image to map so it renders immediately
      if (msg.filename && msg.uri) imageMap[msg.filename] = msg.uri;
      const embed = `![[${msg.filename}]]`;
      const pos   = view.state.selection.main.head;
      view.dispatch({
        changes:   { from: pos, insert: embed },
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
