import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';

function findMarkdownFiles(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMarkdownFiles(fullPath, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function stripFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) { return { frontmatter: '', body: text }; }
  const end = text.indexOf('\n---', 3);
  if (end === -1) { return { frontmatter: '', body: text }; }
  return { frontmatter: text.slice(4, end).trim(), body: text.slice(end + 4).trimStart() };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text: string): string {
  try {
    const { frontmatter, body } = stripFrontmatter(text);
    const html = marked.parse(body) as string;
    const fmHtml = frontmatter
      ? `<div class="frontmatter"><pre>${escapeHtml(frontmatter)}</pre></div>`
      : '';
    return fmHtml + html;
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

class MarkdownDocumentProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'vaultTool.markdownEditor';

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: true };

    const getFont = (): string =>
      vscode.workspace.getConfiguration('vaultTool').get<string>('markdownFont', '').trim() ||
      'var(--vscode-editor-font-family)';

    // Incrustar el contenido inicial directamente en el HTML.
    // Así no depende de postMessage ni de timing del webview.
    webviewPanel.webview.html = this.buildHtml(
      renderMarkdown(document.getText()),
      getFont()
    );

    // Resolver pendiente para onWillSaveTextDocument
    let pendingSaveResolve: ((content: string) => void) | undefined;

    // Última versión del contenido que nosotros aplicamos al modelo.
    // Sirve para distinguir nuestros propios WorkspaceEdit de cambios externos.
    let lastOwnContent: string = document.getText();

    const applySync = (content: string) => {
      lastOwnContent = content;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        content
      );
      vscode.workspace.applyEdit(edit);
    };

    const subs: vscode.Disposable[] = [
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vaultTool.markdownFont')) {
          webviewPanel.webview.postMessage({ type: 'font-update', font: getFont() });
        }
      }),

      // Cambios externos al archivo (desde otro editor, git, etc.)
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        const newText = e.document.getText();
        // Normalizar CRLF: VS Code en Windows puede convertir \n→\r\n en el modelo.
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
        if (normalize(newText) === normalize(lastOwnContent)) { return; }
        // Cambio externo: recargar el webview
        lastOwnContent = newText;
        webviewPanel.webview.postMessage({
          type: 'reload',
          html: renderMarkdown(newText),
          font: getFont()
        });
      }),

      // Justo ANTES de que VS Code escriba en disco, pedimos el contenido al webview.
      // waitUntil() bloquea el guardado hasta que el webview responda.
      vscode.workspace.onWillSaveTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }

        const contentPromise = new Promise<vscode.TextEdit[]>(resolve => {
          pendingSaveResolve = (content: string) => {
            pendingSaveResolve = undefined;
            lastOwnContent = content;
            resolve([vscode.TextEdit.replace(
              new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
              ),
              content
            )]);
          };

          webviewPanel.webview.postMessage({ type: 'get-content' });

          setTimeout(() => {
            if (pendingSaveResolve) {
              pendingSaveResolve = undefined;
              resolve([]);
            }
          }, 5000);
        });

        e.waitUntil(contentPromise);
      }),

      // Después de guardar: re-renderizar el webview con el contenido en disco
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.toString() !== document.uri.toString()) { return; }
        webviewPanel.webview.postMessage({
          type: 'render-after-save',
          html: renderMarkdown(doc.getText()),
          font: getFont()
        });
      }),

      // Cuando el panel pierde el foco activo: sincronizar el modelo inmediatamente.
      // Esto hace que el documento quede "sucio" antes de que auto-save lo guarde,
      // y permite cerrar el panel sin diálogo de confirmación.
      webviewPanel.onDidChangeViewState(e => {
        if (!e.webviewPanel.active) {
          webviewPanel.webview.postMessage({ type: 'trigger-sync' });
        }
      }),

      webviewPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'content-for-save') {
          pendingSaveResolve?.(msg.content as string);

        } else if (msg.type === 'sync') {
          // Sincronización periódica del modelo de documento.
          // Hace el documento "dirty" para que auto-save y cierre funcionen.
          applySync(msg.content as string);

        } else if (msg.type === 'render-request') {
          webviewPanel.webview.postMessage({
            type: 'render-response',
            version: msg.version,
            html: renderMarkdown(msg.markdown),
            font: getFont()
          });
        }
      })
    ];

    webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
  }

  private buildHtml(initialHtml: string, font: string): string {
    // JSON.stringify escapa comillas, barras y caracteres de control.
    // Adicionalmente escapa </script> para que no rompa el bloque <script>.
    const H = JSON.stringify(initialHtml).replace(/<\/script>/gi, '<\\/script>');
    const F = JSON.stringify(font);

    return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--md-font, var(--vscode-editor-font-family));
  font-size: 15px;
  line-height: 1.7;
}

/* ── Toolbar ── */
#toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 8px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
  user-select: none;
}
.tb-btn {
  background: transparent;
  color: var(--vscode-tab-inactiveForeground);
  border: 1px solid transparent;
  padding: 2px 8px; border-radius: 3px; cursor: pointer;
  font-size: 12px; font-family: var(--vscode-font-family); line-height: 1.6;
}
.tb-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.tb-sep { width: 1px; background: var(--vscode-panel-border); margin: 3px 4px; align-self: stretch; }

/* ── Área de documento ── */
#doc { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 6rem; }
#editor { outline: none; min-height: calc(100vh - 80px); }
#editor, #editor p, #editor li, #editor blockquote { font-family: var(--md-font, var(--vscode-editor-font-family)); }
#editor code, #editor pre { font-family: var(--vscode-editor-font-family); }

/* ── Estilos markdown ── */
#editor h1,#editor h2,#editor h3,#editor h4,#editor h5,#editor h6
  { line-height:1.3; margin:1.5em 0 0.5em; font-family:var(--md-font,var(--vscode-editor-font-family)); }
#editor h1 { font-size:2em;   border-bottom:1px solid var(--vscode-panel-border); padding-bottom:.3em; }
#editor h2 { font-size:1.5em; border-bottom:1px solid var(--vscode-panel-border); padding-bottom:.2em; }
#editor h3 { font-size:1.25em; }
#editor h4 { font-size:1em; font-weight:600; }
#editor p  { margin-bottom:1em; }
#editor a  { color:var(--vscode-textLink-foreground); text-decoration:none; }
#editor a:hover { text-decoration:underline; }
#editor strong,#editor b { font-weight:700; }
#editor em,#editor i     { font-style:italic; }
#editor code {
  font-size:.875em; background:var(--vscode-textCodeBlock-background);
  padding:.15em .4em; border-radius:3px;
}
#editor pre {
  background:var(--vscode-textCodeBlock-background);
  padding:1em; border-radius:4px; overflow-x:auto; margin-bottom:1em;
}
#editor pre code { background:none; padding:0; }
#editor blockquote {
  border-left:3px solid var(--vscode-activityBar-activeBorder);
  margin:0 0 1em; padding:.5em 0 .5em 1em; opacity:.8;
}
#editor ul,#editor ol { padding-left:2em; margin-bottom:1em; }
#editor li { margin-bottom:.25em; }
#editor img { max-width:100%; border-radius:4px; }
#editor hr  { border:none; border-top:1px solid var(--vscode-panel-border); margin:1.5em 0; }
#editor table { border-collapse:collapse; width:100%; margin-bottom:1em; }
#editor th,#editor td { border:1px solid var(--vscode-panel-border); padding:.4em .8em; }
#editor th { background:var(--vscode-sideBarSectionHeader-background); font-weight:600; }

.frontmatter {
  background:var(--vscode-sideBarSectionHeader-background);
  border:1px solid var(--vscode-panel-border);
  border-radius:4px; padding:.75em 1em; margin-bottom:1.5em;
  font-family:var(--vscode-editor-font-family); font-size:.8em; opacity:.75;
}
.frontmatter pre { white-space:pre-wrap; }
</style>
</head>
<body>

<div id="toolbar">
  <select id="blockType" class="tb-btn" title="Tipo de bloque" onchange="applyBlockType(this.value)">
    <option value="p">Párrafo</option>
    <option value="h1">Título 1</option>
    <option value="h2">Título 2</option>
    <option value="h3">Título 3</option>
    <option value="h4">Título 4</option>
    <option value="pre">Código</option>
  </select>
  <div class="tb-sep"></div>
  <button class="tb-btn" title="Negrita (Ctrl+B)"    onclick="fmt('bold')"><b>N</b></button>
  <button class="tb-btn" title="Cursiva (Ctrl+I)"    onclick="fmt('italic')"><i>C</i></button>
  <button class="tb-btn" title="Tachado"              onclick="fmt('strikeThrough')"><s>T</s></button>
  <button class="tb-btn" title="Código en línea"      onclick="fmtCode()"><code style="font-size:11px">&lt;/&gt;</code></button>
  <div class="tb-sep"></div>
  <button class="tb-btn" title="Lista"                onclick="fmt('insertUnorderedList')">• Lista</button>
  <button class="tb-btn" title="Lista numerada"       onclick="fmt('insertOrderedList')">1. Lista</button>
  <button class="tb-btn" title="Cita"                 onclick="fmt('formatBlock','blockquote')">❝</button>
  <div class="tb-sep"></div>
  <button class="tb-btn" title="Enlace (Ctrl+K)"      onclick="fmtLink()">🔗</button>
  <button class="tb-btn" title="Línea horizontal"     onclick="insertHr()">—</button>
</div>

<div id="doc">
  <div id="editor" contenteditable="true" spellcheck="true"></div>
</div>

<script>
(function () {
  const vscode  = acquireVsCodeApi();
  const editor  = document.getElementById('editor');
  let dirty         = false;
  let renderVersion = 0;
  let renderTimer   = null;
  let syncTimer     = null;

  /* ── Contenido inicial incrustado directamente ── */
  editor.innerHTML = ${H};
  document.body.style.setProperty('--md-font', ${F});

  /* ── Mensajes desde la extensión ── */
  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (data.type === 'render-response') {
      if (data.version !== renderVersion) { return; }
      var pos = saveCursor(editor);
      editor.innerHTML = data.html;
      document.body.style.setProperty('--md-font', data.font);
      restoreCursor(editor, pos);
    } else if (data.type === 'render-after-save') {
      var pos2 = saveCursor(editor);
      editor.innerHTML = data.html;
      document.body.style.setProperty('--md-font', data.font);
      restoreCursor(editor, pos2);
      dirty = false;
    } else if (data.type === 'reload') {
      // Cambio externo al archivo: recargar sin tocar el historial de edición
      var pos3 = saveCursor(editor);
      editor.innerHTML = data.html;
      document.body.style.setProperty('--md-font', data.font);
      restoreCursor(editor, pos3);
      dirty = false;
    } else if (data.type === 'get-content') {
      // VS Code está a punto de guardar: devolver el contenido actual
      vscode.postMessage({ type: 'content-for-save', content: domToMarkdown(editor) });
    } else if (data.type === 'trigger-sync') {
      // El panel perdió el foco activo: sincronizar inmediatamente
      clearTimeout(syncTimer);
      vscode.postMessage({ type: 'sync', content: domToMarkdown(editor) });
    } else if (data.type === 'font-update') {
      document.body.style.setProperty('--md-font', data.font);
    }
  });

  /* ── Input: sincronización del modelo + re-render selectivo ── */
  editor.addEventListener('input', function () {
    dirty = true;

    // 1. Sincronización del modelo de documento (siempre, debounce 400 ms).
    //    Hace el documento "dirty" para auto-save y cierre sin diálogo.
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      vscode.postMessage({ type: 'sync', content: domToMarkdown(editor) });
    }, 400);

    // 2. Re-render visual (solo para sintaxis de bloque markdown).
    clearTimeout(renderTimer);
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { return; }
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    if (node.nodeType !== 3) { return; }
    var txt = node.textContent || '';
    var offset = range.startOffset;
    var lineStart = txt.lastIndexOf('\\n', offset - 1) + 1;
    var lineText = txt.slice(lineStart, offset);

    var blockTriggers = [
      /^#{1,6} /,
      /^[-*+] /,
      /^\\d+\\. /,
      /^> /,
      /^---$/,
      /^\`\`\`/,
    ];

    if (!blockTriggers.some(function (r) { return r.test(lineText); })) { return; }

    renderTimer = setTimeout(function () {
      var version = ++renderVersion;
      vscode.postMessage({ type: 'render-request', version: version, markdown: domToMarkdown(editor) });
    }, 200);
  });

  /* ── Atajos de teclado ── */
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    // Ctrl+S: e.preventDefault() evita el diálogo de guardado del navegador.
    // El guardado real lo gestiona VS Code vía onWillSaveTextDocument.
    if (mod && e.key === 's') { e.preventDefault(); }
    if (mod && e.key === 'b') { e.preventDefault(); fmt('bold'); }
    if (mod && e.key === 'i') { e.preventDefault(); fmt('italic'); }
    if (mod && e.key === 'k') { e.preventDefault(); fmtLink(); }
  });

  /* ── Restaurar cursor ── */
  function saveCursor(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) { return null; }
    var range = sel.getRangeAt(0);
    try {
      // Range API nativa: maneja nodos texto y elemento (br, div vacíos, etc.)
      var pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      var start = pre.toString().length;
      pre.setEnd(range.endContainer, range.endOffset);
      return { start: start, end: pre.toString().length };
    } catch (_) { return null; }
  }
  function restoreCursor(el, pos) {
    if (!pos) { return; }
    var sel = window.getSelection();
    if (!sel) { return; }
    var startNode = null, startOff = 0, endNode = null, endOff = 0, count = 0;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var len  = node.textContent.length;
      if (!startNode && count + len >= pos.start) { startNode = node; startOff = pos.start - count; }
      if (!endNode   && count + len >= pos.end)   { endNode   = node; endOff   = pos.end   - count; break; }
      count += len;
    }
    if (!startNode) { return; }
    try {
      var range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode || startNode, endNode ? endOff : startOff);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  /* ── Barra de herramientas ── */
  window.fmt = function (cmd, value) { editor.focus(); document.execCommand(cmd, false, value); };
  window.applyBlockType = function (tag) { editor.focus(); document.execCommand('formatBlock', false, tag); };
  window.fmtCode = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) { return; }
    var range = sel.getRangeAt(0);
    var code  = document.createElement('code');
    try { range.surroundContents(code); } catch (_) {}
  };
  window.fmtLink = function () {
    var url = prompt('URL del enlace:', 'https://');
    if (url) { editor.focus(); document.execCommand('createLink', false, url); }
  };
  window.insertHr = function () { editor.focus(); document.execCommand('insertHorizontalRule'); };

  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || !editor.contains(sel.anchorNode)) { return; }
    var node = sel.anchorNode;
    var select = document.getElementById('blockType');
    while (node && node !== editor) {
      var tag = (node.nodeName || '').toLowerCase();
      if (select && ['h1','h2','h3','h4','p','pre'].includes(tag)) { select.value = tag; break; }
      node = node.parentNode;
    }
  });

  /* ── DOM → Markdown ── */
  function domToMarkdown(root) {
    function ser(node, ctx) {
      if (node.nodeType === 3) {
        var t = node.textContent || '';
        if (ctx.inPre) { return t; }
        // Strip HTML-formatting \\n at node boundaries (appears after <br>).
        // Internal \\n are preserved as markdown soft line breaks.
        return t.replace(/^([ \\t]*\\n[ \\t]*)+/, '').replace(/([ \\t]*\\n[ \\t]*)+$/, '');
      }
      if (node.nodeType !== 1) { return ''; }
      var tag  = node.tagName.toUpperCase();
      var kids = function (c) { return Array.from(node.childNodes).map(function(n){ return ser(n, c||ctx); }).join(''); };

      if (tag === 'PRE') {
        var codeEl = node.querySelector('code');
        var lang   = (codeEl ? codeEl.className : '').replace('language-', '');
        var text   = (codeEl ? codeEl.textContent : node.textContent) || '';
        return '\`\`\`' + lang + '\\n' + text.trim() + '\\n\`\`\`\\n\\n';
      }
      switch (tag) {
        case 'H1': return '# '      + kids().trim() + '\\n\\n';
        case 'H2': return '## '     + kids().trim() + '\\n\\n';
        case 'H3': return '### '    + kids().trim() + '\\n\\n';
        case 'H4': return '#### '   + kids().trim() + '\\n\\n';
        case 'H5': return '##### '  + kids().trim() + '\\n\\n';
        case 'H6': return '###### ' + kids().trim() + '\\n\\n';
        case 'P':  { var c = kids().trim(); return c ? c + '\\n\\n' : ''; }
        case 'DIV':
          if (node === root) { return kids(); }
          var c2 = kids().trim(); return c2 ? c2 + '\\n\\n' : '\\n';
        case 'SPAN': return kids();
        case 'BR':   return '\\n';
        case 'STRONG': case 'B': return '**' + kids() + '**';
        case 'EM':   case 'I':   return '*'  + kids() + '*';
        case 'DEL':  case 'S':   return '~~' + kids() + '~~';
        case 'CODE': return '\`' + (node.textContent || '') + '\`';
        case 'A':    return '[' + kids() + '](' + (node.getAttribute('href') || '') + ')';
        case 'IMG':  return '![' + (node.getAttribute('alt')||'') + '](' + (node.getAttribute('src')||'') + ')';
        case 'UL': {
          var out = Array.from(node.children).map(function(li){ return serLi(li, ctx.depth||0, false, 0); }).join('');
          return out + (ctx.depth ? '' : '\\n');
        }
        case 'OL': {
          var out2 = Array.from(node.children).map(function(li,i){ return serLi(li, ctx.depth||0, true, i+1); }).join('');
          return out2 + (ctx.depth ? '' : '\\n');
        }
        case 'LI': return serLi(node, ctx.depth||0, false, 0);
        case 'BLOCKQUOTE': {
          var bc = kids().trim().split('\\n').map(function(l){ return '> '+l; }).join('\\n');
          return bc + '\\n\\n';
        }
        case 'HR':    return '---\\n\\n';
        case 'TABLE': return serTable(node);
        default:      return kids();
      }
    }

    function serLi(li, depth, ordered, idx) {
      var indent = '  '.repeat(depth);
      var prefix = ordered ? (idx + '. ') : '- ';
      var text = '', nested = '';
      Array.from(li.childNodes).forEach(function(child) {
        var t = child.nodeName ? child.nodeName.toUpperCase() : '';
        if (t === 'UL') {
          nested += Array.from(child.children).map(function(item,i){ return serLi(item,depth+1,false,i+1); }).join('');
        } else if (t === 'OL') {
          nested += Array.from(child.children).map(function(item,i){ return serLi(item,depth+1,true,i+1); }).join('');
        } else {
          text += ser(child, { depth: depth+1 });
        }
      });
      return indent + prefix + text.trim() + '\\n' + nested;
    }

    function serTable(table) {
      var ths  = Array.from(table.querySelectorAll('th')).map(function(th){ return (th.textContent||'').trim(); });
      if (!ths.length) { return ''; }
      var sep  = ths.map(function(){ return '---'; });
      var rows = Array.from(table.querySelectorAll('tbody tr')).map(function(tr){
        return Array.from(tr.querySelectorAll('td')).map(function(td){ return (td.textContent||'').trim(); });
      });
      return [ths,sep].concat(rows).map(function(r){ return '| '+r.join(' | ')+' |'; }).join('\\n') + '\\n\\n';
    }

    return ser(root, { depth: 0 }).replace(/\\n{3,}/g, '\\n\\n').trim() + '\\n';
  }
})();
</script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Vault Tool');

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownDocumentProvider.viewType,
      new MarkdownDocumentProvider(),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );

  const listNotesCmd = vscode.commands.registerCommand('vaultTool.listNotes', () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Abre primero la carpeta de tu vault en VS Code.');
      return;
    }
    const vaultPath = folders[0].uri.fsPath;
    const notes = findMarkdownFiles(vaultPath);
    outputChannel.clear();
    outputChannel.appendLine(`Vault: ${vaultPath}\nNotas: ${notes.length}\n---`);
    notes.forEach(p => outputChannel.appendLine(path.relative(vaultPath, p)));
    outputChannel.show();
    vscode.window.showInformationMessage(`Vault Tool: ${notes.length} notas encontradas.`);
  });

  const openKanbanCmd = vscode.commands.registerCommand('vaultTool.openKanban', () => {
    const panel = vscode.window.createWebviewPanel('vaultKanban', 'Kanban del Vault', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:1rem;">
  <h2>Kanban del Vault (placeholder)</h2>
</body></html>`;
  });

  context.subscriptions.push(listNotesCmd, openKanbanCmd);
}

export function deactivate() {}
