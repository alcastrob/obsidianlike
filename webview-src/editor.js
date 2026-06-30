// webview-src/editor.js — CodeMirror 6 editor for the VS Code vault extension.
// Bundled by esbuild into out/editor.bundle.js.

import { EditorState, EditorSelection, RangeSetBuilder } from "@codemirror/state";
import {
  EditorView, ViewPlugin, Decoration, keymap, drawSelection
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
  '.cm-activeLineGutter': { background: 'transparent' },
  '.cm-line': { padding: '0' },
  // Wiki-link display style
  '.cm-wiki-link': {
    color: 'var(--vscode-textLink-foreground, #4ec9b0)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
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
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3' },
  { tag: tags.heading2, fontSize: '1.4em',  fontWeight: '700', lineHeight: '1.3' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.strong,   fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--vscode-textLink-foreground, #4ec9b0)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: tags.url,  color: 'var(--vscode-textLink-foreground, #4ec9b0)', opacity: '0.5', fontSize: '0.82em' },
  { tag: tags.monospace,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '0.88em',
    background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15))',
    padding: '1px 4px',
    borderRadius: '3px' },
  { tag: tags.quote,
    borderLeft: '3px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4))',
    paddingLeft: '12px',
    opacity: '0.85' },
  // Markdown markers (#, **, *, `, ~~) — rendered dimmer
  { tag: tags.processingInstruction,
    color: 'var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.5))',
    fontSize: '0.82em' },
  { tag: tags.meta,
    color: 'var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.5))' },
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

// ── Live-preview plugin ───────────────────────────────────────────────────────
// Hides markdown syntax markers on lines where the cursor is NOT present.
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
    const ranges = []; // { from, to }

    syntaxTree(state).iterate({
      from: view.viewport.from,
      to:   view.viewport.to,
      enter(node) {
        const ln = state.doc.lineAt(node.from).number;
        if (active.has(ln)) return;
        const n = node.name;

        if (n === 'HeaderMark') {
          // Hide "# " (including the space that follows)
          let end = node.to;
          if (state.doc.sliceString(end, end + 1) === ' ') end++;
          ranges.push({ from: node.from, to: end });
          return false;
        }
        if (n === 'EmphasisMark' || n === 'CodeMark' || n === 'StrikethroughMark') {
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
        if (n === 'LinkMark') {
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
        if (n === 'URL') {
          // Hide URL (the surrounding ( ) are already hidden as LinkMark)
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
      }
    });

    // Sort then merge overlapping/adjacent and build
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder();
    let lastTo = -1;
    for (const { from, to } of ranges) {
      if (from < lastTo) continue; // skip overlap
      try { builder.add(from, to, Decoration.replace({})); } catch (_) {}
      lastTo = to;
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Wiki-link plugin ──────────────────────────────────────────────────────────
// On non-active lines: hides [[ ]] and styles the visible link text.
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
    // Negative lookbehind: skip ![[image]]
    const re = /(?<!!)\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g;
    const all = []; // { from, to, dec }
    let m;
    while ((m = re.exec(str)) !== null) {
      const mFrom = vf + m.index;
      const mTo   = mFrom + m[0].length;
      const ln = state.doc.lineAt(mFrom).number;
      if (active.has(ln)) continue;
      const name  = m[1];
      const alias = m[2]; // undefined if no |alias
      // Hide [[
      all.push({ from: mFrom,     to: mFrom + 2,              dec: Decoration.replace({}) });
      if (alias !== undefined) {
        // [[name| → hide; alias → style
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length + 1, dec: Decoration.replace({}) });
        const aFrom = mFrom + 2 + name.length + 1;
        all.push({ from: aFrom,  to: aFrom + alias.length,    dec: Decoration.mark({ class: 'cm-wiki-link' }) });
      } else {
        // name → style
        all.push({ from: mFrom + 2, to: mFrom + 2 + name.length, dec: Decoration.mark({ class: 'cm-wiki-link' }) });
      }
      // Hide ]]
      all.push({ from: mTo - 2, to: mTo,                      dec: Decoration.replace({}) });
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
      livePreviewPlugin,
      wikiLinkPlugin,
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
      currentTitle = newName; // optimistic update; revertido con title-revert si falla
      vscode.postMessage({ type: 'rename', newName });
    }
  }, 800);
});

titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    view.focus();
  }
  if (e.key === 'Escape') {
    titleEl.textContent = currentTitle;
    view.focus();
  }
});

// ── Editor ────────────────────────────────────────────────────────────────────
const container = document.getElementById('editor');
const view = createEditor(container, init.content || '');
view.focus();

// ── Message handling ──────────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'note-index':
      noteIndex = msg.notes || [];
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
