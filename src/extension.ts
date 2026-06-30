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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addHeadingDataMd(markdownBody: string, html: string): string {
  const headings: string[] = [];
  markdownBody.replace(/^(#{1,6} .+)$/gm, (line) => { headings.push(line.trim()); return line; });
  if (headings.length === 0) { return html; }
  let i = 0;
  return html.replace(/<h([1-6])>/gi, (_, d) => {
    const md = i < headings.length ? escapeHtml(headings[i++]) : '';
    return `<h${d} data-md="${md}">`;
  });
}

function renderMarkdown(text: string, preprocessBody?: (body: string) => string): string {
  try {
    const { frontmatter, body } = stripFrontmatter(text);
    const processedBody = preprocessBody ? preprocessBody(body) : body;
    const html = marked.parse(processedBody) as string;
    const fmHtml = frontmatter
      ? `<div class="frontmatter"><pre>${escapeHtml(frontmatter)}</pre></div>`
      : '';
    return fmHtml + addHeadingDataMd(body, html);
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

function getSaveDir(docFsPath: string): string {
  const cfg = vscode.workspace.getConfiguration('vaultTool');
  const location = cfg.get<string>('attachmentsLocation', 'vault');
  const folder = cfg.get<string>('attachmentsFolder', 'attachments');
  const docDir = path.dirname(docFsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
  switch (location) {
    case 'samefolder':     return docDir;
    case 'subfolder':      return path.join(docDir, folder);
    case 'specificfolder':
      return path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder);
    default:               return vaultRoot;
  }
}

function resolveAttachmentPath(fileName: string, docFsPath: string): string | undefined {
  const cfg = vscode.workspace.getConfiguration('vaultTool');
  const location = cfg.get<string>('attachmentsLocation', 'vault');
  const folder = cfg.get<string>('attachmentsFolder', 'attachments');
  const docDir = path.dirname(docFsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;

  let candidate: string;
  switch (location) {
    case 'samefolder':     candidate = path.join(docDir, fileName); break;
    case 'subfolder':      candidate = path.join(docDir, folder, fileName); break;
    case 'specificfolder':
      candidate = path.isAbsolute(folder)
        ? path.join(folder, fileName)
        : path.join(vaultRoot, folder, fileName);
      break;
    default:               candidate = path.join(vaultRoot, fileName); break;
  }
  return fs.existsSync(candidate) ? candidate : undefined;
}

function getAttachmentRoots(docUri: vscode.Uri): vscode.Uri[] {
  const cfg = vscode.workspace.getConfiguration('vaultTool');
  const location = cfg.get<string>('attachmentsLocation', 'vault');
  const folder = cfg.get<string>('attachmentsFolder', 'attachments');
  const docDir = path.dirname(docUri.fsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;

  const roots: string[] = [vaultRoot, docDir];
  if (location === 'subfolder') {
    roots.push(path.join(docDir, folder));
  } else if (location === 'specificfolder') {
    roots.push(path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder));
  }
  return [...new Set(roots)].map(r => vscode.Uri.file(r));
}

class MarkdownDocumentProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'vaultTool.markdownEditor';

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: getAttachmentRoots(document.uri)
    };

    const getFont = (): string =>
      vscode.workspace.getConfiguration('vaultTool').get<string>('markdownFont', '').trim() ||
      'var(--vscode-editor-font-family)';

    const getFontSize = (): number =>
      vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);

    const render = (text: string): string => renderMarkdown(text, body => {
      // 1. Imágenes embebidas
      let result = body.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (_m, rawName: string, extra?: string) => {
        const fileName = rawName.trim();
        const resolved = resolveAttachmentPath(fileName, document.uri.fsPath);
        if (!resolved) {
          return `<span class="attachment-missing">[${escapeHtml(fileName)}]</span>`;
        }
        const uri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(resolved));
        const orig = `![[${fileName}${extra !== undefined ? '|' + extra : ''}]]`;
        let widthAttr = '';
        let captionHtml = '';
        if (extra !== undefined && extra.trim() !== '') {
          const trimmed = extra.trim();
          const wm = trimmed.match(/^(\d+)\s*(?:px)?$/i);
          if (wm) { widthAttr = ` width="${parseInt(wm[1], 10)}"`; }
          else { captionHtml = `<figcaption>${escapeHtml(trimmed)}</figcaption>`; }
        }
        return `\n\n<div class="obsidian-embed" data-obsidian="${escapeHtml(orig)}"><img src="${uri}" alt="${escapeHtml(fileName)}"${widthAttr}>${captionHtml}</div>\n\n`;
      });
      // 2. Wiki links [[Nota]] o [[Nota|Alias]]
      result = result.replace(/\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (_m, name: string, alias?: string) => {
        const target = name.trim();
        const display = alias ? alias.trim() : target;
        return `<span class="wiki-link" data-target="${escapeHtml(target)}">${escapeHtml(display)}</span>`;
      });
      return result;
    });

    // Registrar panel para recibir actualizaciones del índice de notas
    activePanels.push(webviewPanel);
    webviewPanel.onDidDispose(() => {
      const i = activePanels.indexOf(webviewPanel);
      if (i !== -1) { activePanels.splice(i, 1); }
    });

    webviewPanel.webview.html = this.buildHtml(
      render(document.getText()),
      getFont(),
      getFontSize(),
      webviewPanel.webview.cspSource
    );

    // Enviar índice de notas al webview (con pequeño delay para que el HTML cargue)
    setTimeout(() => {
      webviewPanel.webview.postMessage({ type: 'note-index', notes: noteIndex });
    }, 300);

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
        if (e.affectsConfiguration('vaultTool.markdownFont') ||
            e.affectsConfiguration('editor.fontSize')) {
          webviewPanel.webview.postMessage({
            type: 'font-update',
            font: getFont(),
            fontSize: getFontSize() + 'px'
          });
        }
        if (e.affectsConfiguration('vaultTool.attachmentsLocation') ||
            e.affectsConfiguration('vaultTool.attachmentsFolder')) {
          webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: getAttachmentRoots(document.uri)
          };
          webviewPanel.webview.postMessage({
            type: 'render-after-save',
            html: render(document.getText()),
            font: getFont()
          });
        }
      }),

      // Cambios externos al archivo (desde otro editor, git, etc.)
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        const newText = e.document.getText();
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
        if (normalize(newText) === normalize(lastOwnContent)) { return; }
        lastOwnContent = newText;
        webviewPanel.webview.postMessage({
          type: 'reload',
          html: render(newText),
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

      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.toString() !== document.uri.toString()) { return; }
        webviewPanel.webview.postMessage({
          type: 'render-after-save',
          html: render(doc.getText()),
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
            html: render(msg.markdown),
            font: getFont()
          });

        } else if (msg.type === 'paste-image') {
          try {
            const base64 = (msg.data as string).replace(/^data:image\/[a-z]+;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');
            const now = new Date();
            const p2 = (n: number) => String(n).padStart(2, '0');
            const filename = `Pasted image ${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.png`;
            const saveDir = getSaveDir(document.uri.fsPath);
            if (!fs.existsSync(saveDir)) { fs.mkdirSync(saveDir, { recursive: true }); }
            fs.writeFileSync(path.join(saveDir, filename), buffer);
            webviewPanel.webview.postMessage({ type: 'image-pasted', filename });
          } catch (err) {
            vscode.window.showErrorMessage(`Error al guardar imagen pegada: ${err}`);
          }
        }
      })
    ];

    webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
  }

  private buildHtml(initialHtml: string, font: string, fontSize: number, cspSource: string): string {
    const H  = JSON.stringify(initialHtml).replace(/<\/script>/gi, '<\\/script>');
    const F  = JSON.stringify(font);
    const FS = JSON.stringify(fontSize + 'px');

    return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${cspSource} data: blob:;">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--md-font, var(--vscode-editor-font-family));
  font-size: var(--md-font-size, 15px);
  line-height: 1.7;
}


/* ── Área de documento ── */
#doc { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 6rem; }
#editor { outline: none; min-height: calc(100vh - 80px); }
#editor, #editor p, #editor li, #editor blockquote { font-family: var(--md-font, var(--vscode-editor-font-family)); }
#editor code, #editor pre { font-family: var(--vscode-editor-font-family); }

/* ── Estilos markdown ── */
#editor h1,#editor h2,#editor h3,#editor h4,#editor h5,#editor h6
  { line-height:1.3; margin:1.5em 0 0.5em; font-family:var(--md-font,var(--vscode-editor-font-family)); }
#editor h1 { font-size:2em; }
#editor h2 { font-size:1.5em; }
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
.obsidian-embed { display: block; margin: 0.5em 0; }
.obsidian-embed img { max-width: 100%; display: block; }
.obsidian-embed figcaption {
  text-align: center; font-size: 0.85em; margin-top: 0.3em;
  color: var(--vscode-descriptionForeground); font-style: italic;
}
.obsidian-embed.raw-mode-img { opacity: 0.75; }
.wiki-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
  text-decoration-color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
#note-picker {
  display: none; position: fixed; z-index: 999;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px; min-width: 220px; max-width: 440px;
  max-height: 280px; overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35);
}
.np-item {
  padding: 5px 12px; cursor: pointer; font-size: 0.875em;
  color: var(--vscode-dropdown-foreground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.np-item.np-active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.np-item:hover { background: var(--vscode-list-hoverBackground); }
.attachment-missing {
  color: var(--vscode-errorForeground);
  font-style: italic;
  font-size: .9em;
}
/* ── Colapso de secciones ── */
.fold-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1em;
  margin-right: 0.2em;
  cursor: pointer;
  user-select: none;
  font-style: normal;
  font-weight: 400;
  font-size: 0.55em;
  vertical-align: middle;
  opacity: 0.3;
  transform: rotate(90deg);
  transition: transform 0.15s ease, opacity 0.15s;
  line-height: 1;
}
strong.raw-mode, b.raw-mode { font-weight: normal; font-style: normal; opacity: 0.75; }
em.raw-mode, i.raw-mode { font-style: normal; font-weight: normal; opacity: 0.75; }
.fold-btn:hover { opacity: 0.75; }
.fold-btn::before { content: '▶'; }
h1.collapsed > .fold-btn, h2.collapsed > .fold-btn,
h3.collapsed > .fold-btn, h4.collapsed > .fold-btn,
h5.collapsed > .fold-btn, h6.collapsed > .fold-btn {
  transform: rotate(0deg);
}

/* ── Live preview: heading en modo edición ── */
h1.raw-mode, h2.raw-mode, h3.raw-mode,
h4.raw-mode, h5.raw-mode, h6.raw-mode {
  font-size: var(--md-font-size, 15px);
  font-weight: 400;
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 0.2em;
  line-height: inherit;
  color: var(--vscode-editor-foreground);
  opacity: 0.75;
}
</style>
</head>
<body>


<div id="note-picker"></div>
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
  var currentBlock     = null;  // bloque donde está el cursor ahora
  var currentRawBlock  = null;  // bloque en modo raw (solo headings / imágenes)
  var currentRawInline = null;
  var rawModeChanging  = false;

  /* ── Note picker ── */
  var noteIndex        = [];
  var notePickerRange  = null;
  var npActiveIdx      = 0;
  var picker = document.getElementById('note-picker');
  picker.style.display = 'none'; // garantizar que el inline style esté establecido

  function searchNotes(q) {
    var lq = q.toLowerCase();
    return noteIndex.filter(function(n) { return n.toLowerCase().includes(lq); }).slice(0, 15);
  }
  function getTextBeforeCursor() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) { return null; }
    var rng = sel.getRangeAt(0);
    if (!rng.collapsed || !editor.contains(rng.startContainer)) { return null; }
    if (rng.startContainer.nodeType !== 3) { return null; }
    return { text: rng.startContainer.textContent.slice(0, rng.startOffset),
             node: rng.startContainer, offset: rng.startOffset };
  }
  function closeNotePicker() {
    picker.style.display = 'none';
    notePickerRange = null;
  }
  function setNpActive(idx) {
    var items = picker.querySelectorAll('.np-item');
    npActiveIdx = Math.max(0, Math.min(idx, items.length - 1));
    items.forEach(function(item, i) {
      item.classList.toggle('np-active', i === npActiveIdx);
      if (i === npActiveIdx) { item.scrollIntoView({ block: 'nearest' }); }
    });
  }
  function selectNote(name) {
    if (!notePickerRange) { return; }
    notePickerRange.deleteContents();
    var inserted = document.createTextNode('[[' + name + ']]');
    notePickerRange.insertNode(inserted);
    var sel2 = window.getSelection();
    if (sel2) {
      var r2 = document.createRange();
      r2.setStartAfter(inserted); r2.collapse(true);
      sel2.removeAllRanges(); sel2.addRange(r2);
    }
    closeNotePicker();
    dirty = true;
    clearTimeout(syncTimer); clearTimeout(renderTimer);
    var mdSel = domToMarkdown(editor);
    vscode.postMessage({ type: 'sync', content: mdSel });
    var rvSel = ++renderVersion;
    vscode.postMessage({ type: 'render-request', version: rvSel, markdown: mdSel });
  }
  function openNotePicker(results, rect) {
    picker.innerHTML = '';
    npActiveIdx = 0;
    results.forEach(function(name, i) {
      var item = document.createElement('div');
      item.className = 'np-item' + (i === 0 ? ' np-active' : '');
      item.textContent = name;
      item.addEventListener('mousedown', function(e) { e.preventDefault(); selectNote(name); });
      picker.appendChild(item);
    });
    if (results.length === 0) { picker.style.display = 'none'; return; }
    picker.style.display = 'block';
    var top = rect.bottom + 4;
    var left = rect.left;
    if (top + 280 > window.innerHeight) { top = Math.max(0, rect.top - 4 - picker.offsetHeight); }
    if (left + 440 > window.innerWidth) { left = Math.max(0, window.innerWidth - 444); }
    picker.style.top = top + 'px';
    picker.style.left = left + 'px';
  }

  function getTopLevelBlock(node) {
    if (!node) { return null; }
    var el = (node.nodeType === 3) ? node.parentElement : node;
    while (el && el.parentElement !== editor) { el = el.parentElement; }
    return (el && el !== editor) ? el : null;
  }
  function isHeading(el) {
    return el && /^H[1-6]$/.test(el.tagName);
  }
  function hasObsidianImage(el) {
    if (!el) { return false; }
    if (el.classList && el.classList.contains('obsidian-embed')) { return true; }
    return !!(el.querySelector && el.querySelector('img[data-obsidian]'));
  }
  function collectParagraphMd(el) {
    var parts = [];
    el.childNodes.forEach(function(child) {
      if (child.nodeType === 3) {
        parts.push(child.textContent || '');
      } else if (child.nodeType === 1) {
        var t2 = child.tagName ? child.tagName.toUpperCase() : '';
        if (t2 === 'IMG') {
          parts.push(child.getAttribute('data-obsidian') ||
            ('![' + (child.getAttribute('alt') || '') + '](' + (child.getAttribute('src') || '') + ')'));
        } else if (t2 === 'BR') {
          parts.push('\\n');
        } else if (t2 === 'STRONG' || t2 === 'B') {
          parts.push('**' + (child.textContent || '') + '**');
        } else if (t2 === 'EM' || t2 === 'I') {
          parts.push('*' + (child.textContent || '') + '*');
        } else if (t2 === 'CODE') {
          parts.push('\`' + (child.textContent || '') + '\`');
        } else if (t2 === 'A') {
          parts.push('[' + (child.textContent || '') + '](' + (child.getAttribute('href') || '') + ')');
        } else {
          parts.push(child.textContent || '');
        }
      }
    });
    return parts.join('').trim();
  }

  /* ── Colapso de secciones ── */
  function toggleCollapse(headingEl) {
    var depth = parseInt(headingEl.tagName[1]);
    var toCollapse = !headingEl.classList.contains('collapsed');
    headingEl.classList.toggle('collapsed', toCollapse);
    var sib = headingEl.nextElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName) && parseInt(sib.tagName[1]) <= depth) { break; }
      sib.style.display = toCollapse ? 'none' : '';
      sib = sib.nextElementSibling;
    }
  }
  function addFoldBtn(headingEl) {
    if (headingEl.querySelector('.fold-btn')) { return; }
    var btn = document.createElement('span');
    btn.className = 'fold-btn';
    btn.setAttribute('contenteditable', 'false');
    btn.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); toggleCollapse(headingEl); });
    headingEl.insertBefore(btn, headingEl.firstChild);
  }
  function initFoldBtns() {
    editor.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h) {
      if (!h.classList.contains('raw-mode')) { addFoldBtn(h); }
    });
  }

  /* ── Inline live-preview: negrita / cursiva ── */
  function findInlineEl(node) {
    // Solo activamos si el anchorNode ES un nodo de texto (nodeType 3).
    // Si el navegador pone el cursor en el elemento mismo (p.ej. en la
    // frontera entre <strong> y el texto siguiente), lo tratamos como
    // "fuera" del elemento para que exitInlineRaw se dispare.
    if (!node || node.nodeType !== 3) { return null; }
    var el = node.parentElement;
    while (el && el !== editor) {
      var t = el.tagName;
      if (t === 'STRONG' || t === 'B' || t === 'EM' || t === 'I') { return el; }
      el = el.parentElement;
    }
    return null;
  }
  function enterInlineRaw(el) {
    if (!el || el.classList.contains('raw-mode')) { return; }
    var isB = (el.tagName === 'STRONG' || el.tagName === 'B');
    var d = isB ? '**' : '*';
    var inner = el.textContent || '';
    var sel = window.getSelection();
    var off = d.length;
    if (sel && sel.rangeCount) {
      try {
        var pr = document.createRange();
        pr.selectNodeContents(el);
        pr.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
        off = d.length + pr.toString().length;
      } catch (_) {}
    }
    rawModeChanging = true;
    el.classList.add('raw-mode');
    el.textContent = d + inner + d;
    var tn = el.firstChild;
    if (tn && sel) {
      try {
        var ir = document.createRange();
        ir.setStart(tn, Math.min(off, tn.textContent.length));
        ir.collapse(true);
        sel.removeAllRanges();
        sel.addRange(ir);
      } catch (_) {}
    }
    rawModeChanging = false;
  }
  function exitInlineRaw(el) {
    if (!el || !el.classList.contains('raw-mode')) { return; }
    rawModeChanging = true;
    var raw = el.textContent || '';
    el.classList.remove('raw-mode');
    var boldM = raw.match(/^\\*\\*([\s\S]*)\\*\\*$/);
    var emM   = !boldM && raw.match(/^\\*([\s\S]*)\\*$/);
    if (boldM) {
      if (el.tagName === 'STRONG' || el.tagName === 'B') {
        el.textContent = boldM[1];
      } else {
        var nb = document.createElement('strong'); nb.textContent = boldM[1];
        if (el.parentNode) { el.parentNode.replaceChild(nb, el); }
      }
    } else if (emM) {
      if (el.tagName === 'EM' || el.tagName === 'I') {
        el.textContent = emM[1];
      } else {
        var ne = document.createElement('em'); ne.textContent = emM[1];
        if (el.parentNode) { el.parentNode.replaceChild(ne, el); }
      }
    } else if (raw.trim()) {
      var nt = document.createTextNode(raw);
      if (el.parentNode) { el.parentNode.replaceChild(nt, el); }
    } else {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }
    rawModeChanging = false;
  }

  function enterRawMode(el) {
    if (!el || el.classList.contains('raw-mode')) { return; }
    if (isHeading(el)) {
      var depth = parseInt(el.tagName[1]);
      var md = el.getAttribute('data-md') || ('#'.repeat(depth) + ' ' + (el.textContent || ''));
      var sel = window.getSelection();
      var cursorOff = depth + 1;
      if (sel && sel.rangeCount) {
        try {
          var preR = document.createRange();
          preR.selectNodeContents(el);
          preR.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
          cursorOff = (depth + 1) + preR.toString().length;
        } catch (_) {}
      }
      rawModeChanging = true;
      el.classList.add('raw-mode');
      el.textContent = md;
      var tn = el.firstChild;
      if (tn && sel) {
        try {
          var rr = document.createRange();
          rr.setStart(tn, Math.min(cursorOff, tn.textContent.length));
          rr.collapse(true);
          sel.removeAllRanges();
          sel.addRange(rr);
        } catch (_) {}
      }
      rawModeChanging = false;
    } else if (hasObsidianImage(el)) {
      var imd = el.getAttribute('data-obsidian') || collectParagraphMd(el);
      el.setAttribute('data-cache-html', el.innerHTML);
      el.setAttribute('data-cache-md', imd);
      var isel = window.getSelection();
      rawModeChanging = true;
      el.classList.add('raw-mode');
      el.classList.add('raw-mode-img');
      el.textContent = imd;
      var itn = el.firstChild;
      if (itn && isel) {
        try {
          var irr = document.createRange();
          irr.setStart(itn, itn.textContent.length);
          irr.collapse(true);
          isel.removeAllRanges();
          isel.addRange(irr);
        } catch (_) {}
      }
      rawModeChanging = false;
    }
  }
  function exitRawMode(el) {
    if (!el || !el.classList.contains('raw-mode')) { return; }
    if (el.classList.contains('raw-mode-img')) {
      rawModeChanging = true;
      var currentMdImg = (el.textContent || '').trim();
      var cachedHtml   = el.getAttribute('data-cache-html') || '';
      var cachedMdImg  = el.getAttribute('data-cache-md')  || '';
      el.removeAttribute('data-cache-html');
      el.removeAttribute('data-cache-md');
      el.classList.remove('raw-mode');
      el.classList.remove('raw-mode-img');
      el.innerHTML = cachedHtml;
      rawModeChanging = false;
      if (currentMdImg !== cachedMdImg) {
        el.setAttribute('data-obsidian', currentMdImg);
        var content = domToMarkdown(editor);
        vscode.postMessage({ type: 'sync', content: content });
        var rv = ++renderVersion;
        vscode.postMessage({ type: 'render-request', version: rv, markdown: content });
      }
      return;
    }
    rawModeChanging = true;
    var md = (el.textContent || '').trimEnd();
    var match = md.match(/^(#{1,6})\\s+([\\s\\S]*)$/);
    if (match) {
      var newDepth = match[1].length;
      var text = match[2].trimEnd();
      var newMdStr = match[1] + ' ' + text;
      if (parseInt(el.tagName[1]) !== newDepth) {
        var newH = document.createElement('h' + newDepth);
        newH.setAttribute('data-md', newMdStr);
        newH.textContent = text;
        el.parentNode.replaceChild(newH, el);
        addFoldBtn(newH);
      } else {
        el.setAttribute('data-md', newMdStr);
        el.classList.remove('raw-mode');
        el.textContent = text;
        addFoldBtn(el);
      }
    } else if (md.trim()) {
      var newP = document.createElement('p');
      newP.textContent = md;
      el.parentNode.replaceChild(newP, el);
    } else {
      el.classList.remove('raw-mode');
      addFoldBtn(el);
    }
    rawModeChanging = false;
  }

  /* ── Contenido inicial incrustado directamente ── */
  editor.innerHTML = ${H};
  document.body.style.setProperty('--md-font', ${F});
  document.body.style.setProperty('--md-font-size', ${FS});
  initFoldBtns();

  /* ── Mensajes desde la extensión ── */
  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (data.type === 'render-response') {
      if (data.version !== renderVersion) { return; }
      var pos = saveCursor(editor);
      currentBlock = null; currentRawBlock = null; currentRawInline = null;
      rawModeChanging = true;
      editor.innerHTML = data.html;
      rawModeChanging = false;
      initFoldBtns();
      document.body.style.setProperty('--md-font', data.font);
      restoreCursor(editor, pos);
    } else if (data.type === 'render-after-save') {
      var pos2 = saveCursor(editor);
      currentBlock = null; currentRawBlock = null; currentRawInline = null;
      rawModeChanging = true;
      editor.innerHTML = data.html;
      rawModeChanging = false;
      initFoldBtns();
      document.body.style.setProperty('--md-font', data.font);
      restoreCursor(editor, pos2);
      dirty = false;
    } else if (data.type === 'reload') {
      var pos3 = saveCursor(editor);
      currentBlock = null; currentRawBlock = null; currentRawInline = null;
      rawModeChanging = true;
      editor.innerHTML = data.html;
      rawModeChanging = false;
      initFoldBtns();
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
      if (data.fontSize) { document.body.style.setProperty('--md-font-size', data.fontSize); }
    } else if (data.type === 'image-pasted') {
      var embed = '![[' + data.filename + ']]';
      document.execCommand('insertText', false, embed);
      dirty = true;
      clearTimeout(syncTimer);
      clearTimeout(renderTimer);
      var mdForImg = domToMarkdown(editor);
      vscode.postMessage({ type: 'sync', content: mdForImg });
      var imgVersion = ++renderVersion;
      vscode.postMessage({ type: 'render-request', version: imgVersion, markdown: mdForImg });
    } else if (data.type === 'note-index') {
      noteIndex = data.notes || [];
    }
  });

  /* ── Pegar imágenes desde el portapapeles ── */
  editor.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) { return; }
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (!file) { continue; }
        var reader = new FileReader();
        reader.onload = function(ev) {
          vscode.postMessage({ type: 'paste-image', data: ev.target.result });
        };
        reader.readAsDataURL(file);
        return;
      }
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

    // 2. Re-render visual (solo para sintaxis de bloque markdown; no en raw mode).
    if (currentRawBlock || currentRawInline) { return; }
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

    // Note picker: comprueba [[ ANTES que los blockTriggers
    if (!currentRawBlock) {
      var nb = getTextBeforeCursor();
      if (nb) {
        var db = nb.text.lastIndexOf('[[');
        if (db !== -1 && (db === 0 || nb.text[db - 1] !== '!') && nb.text.indexOf(']]', db) === -1) {
          notePickerRange = document.createRange();
          notePickerRange.setStart(nb.node, db);
          notePickerRange.setEnd(nb.node, nb.offset);
          var nresults = searchNotes(nb.text.slice(db + 2));
          var nsel2 = window.getSelection();
          if (nsel2 && nsel2.rangeCount) {
            openNotePicker(nresults, nsel2.getRangeAt(0).getBoundingClientRect());
          }
          return; // suprimir re-render mientras el picker está abierto
        } else { closeNotePicker(); }
      } else { closeNotePicker(); }
    }

    var blockTriggers = [
      /^#{1,6} /,
      /^[-*+] /,
      /^\\d+\\. /,
      /^> /,
      /^---$/,
      /^\`\`\`/,
      /^!\\[\\[/,
    ];

    if (!blockTriggers.some(function (r) { return r.test(lineText); })) { return; }

    renderTimer = setTimeout(function () {
      var version = ++renderVersion;
      vscode.postMessage({ type: 'render-request', version: version, markdown: domToMarkdown(editor) });
    }, 200);
  });

  /* ── Atajos de teclado ── */
  document.addEventListener('keydown', function (e) {
    // Note picker: navegar / seleccionar / cerrar
    if (picker.style.display === 'block') {
      if (e.key === 'Escape')    { e.preventDefault(); closeNotePicker(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setNpActive(npActiveIdx + 1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setNpActive(npActiveIdx - 1); return; }
      if (e.key === 'Enter') {
        var items = picker.querySelectorAll('.np-item');
        if (items[npActiveIdx]) { e.preventDefault(); selectNote(items[npActiveIdx].textContent); return; }
      }
    }
    var mod = e.ctrlKey || e.metaKey;
    // Ctrl+S: e.preventDefault() evita el diálogo de guardado del navegador.
    // El guardado real lo gestiona VS Code vía onWillSaveTextDocument.
    if (mod && e.key === 's') { e.preventDefault(); }
    if (mod && e.key === 'b') { e.preventDefault(); fmt('bold'); }
    if (mod && e.key === 'i') { e.preventDefault(); fmt('italic'); }
    if (mod && e.key === 'k') { e.preventDefault(); fmtLink(); }

    // Enter en cabecera: crear párrafo debajo en lugar de dejar que Chromium
    // cree otro <hN> (que dispararía enterRawMode y saltaría el cursor).
    if (e.key === 'Enter' && !mod && !e.shiftKey) {
      var hSel = window.getSelection();
      if (hSel && hSel.rangeCount) {
        var hBlock = getTopLevelBlock(hSel.anchorNode);
        if (hBlock && isHeading(hBlock)) {
          e.preventDefault();
          // Si la cabecera está en raw mode, salir antes de crear el párrafo
          if (currentRawBlock === hBlock) {
            exitRawMode(hBlock);
            currentRawBlock = null;
            currentBlock = hBlock; // hBlock ahora está renderizado
          }
          // Insertar <p> vacío debajo de la cabecera
          var hNewP = document.createElement('p');
          hNewP.innerHTML = '<br>';
          var hAfter = hBlock.nextSibling;
          hBlock.parentNode.insertBefore(hNewP, hAfter);
          // Mover cursor al nuevo párrafo
          rawModeChanging = true;
          try {
            var hRange = document.createRange();
            hRange.setStart(hNewP, 0);
            hRange.collapse(true);
            hSel.removeAllRanges();
            hSel.addRange(hRange);
          } catch (_) {}
          rawModeChanging = false;
          dirty = true;
          clearTimeout(syncTimer);
          syncTimer = setTimeout(function () {
            vscode.postMessage({ type: 'sync', content: domToMarkdown(editor) });
          }, 400);
        }
      }
    }
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

  var inlineCheckTimer = null;

  /* checkInlineMode: lee la posición del cursor y entra/sale del modo raw
     inline según corresponda. Se llama de forma diferida (setTimeout 0)
     para que el DOM esté estable tras cualquier mutación. */
  function checkInlineMode() {
    if (rawModeChanging || currentRawBlock) { return; }
    var csel = window.getSelection();
    if (!csel || !editor.contains(csel.anchorNode)) {
      if (currentRawInline) { exitInlineRaw(currentRawInline); currentRawInline = null; }
      return;
    }
    var inlineEl = findInlineEl(csel.anchorNode);
    if (inlineEl === currentRawInline) { return; }
    if (currentRawInline) { exitInlineRaw(currentRawInline); currentRawInline = null; }
    currentRawInline = inlineEl;
    if (currentRawInline) { enterInlineRaw(currentRawInline); }
  }

  function scheduleInlineCheck() {
    clearTimeout(inlineCheckTimer);
    inlineCheckTimer = setTimeout(checkInlineMode, 0);
  }

  /* click y keyup: disparo inmediato (el cursor ya está en posición final) */
  editor.addEventListener('click', function () { scheduleInlineCheck(); });
  document.addEventListener('keyup', function (ekup) {
    var nav = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'];
    if (nav.indexOf(ekup.key) !== -1) { scheduleInlineCheck(); }
  });

  document.addEventListener('selectionchange', function () {
    if (rawModeChanging) { return; }
    var sel = window.getSelection();
    if (!sel || !editor.contains(sel.anchorNode)) {
      clearTimeout(inlineCheckTimer);
      if (picker.style.display === 'block') { closeNotePicker(); }
      // Cursor fuera del editor: salir de cualquier modo raw inmediatamente
      if (currentRawInline) { exitInlineRaw(currentRawInline); currentRawInline = null; }
      if (currentRawBlock)  { exitRawMode(currentRawBlock);    currentRawBlock  = null; }
      currentBlock = null;
      return;
    }
    // ── Block-level live-preview (headings / imágenes): inmediato ──
    var block = getTopLevelBlock(sel.anchorNode);
    if (block !== currentBlock) {
      clearTimeout(inlineCheckTimer);
      currentBlock = block;
      if (currentRawInline) { exitInlineRaw(currentRawInline); currentRawInline = null; }
      if (currentRawBlock && currentRawBlock !== block) { exitRawMode(currentRawBlock); currentRawBlock = null; }
      if (!currentRawBlock && block && (isHeading(block) || hasObsidianImage(block))) {
        currentRawBlock = block;
        enterRawMode(block);
      }
    }
    // ── Inline live-preview: diferido para que el DOM se estabilice ──
    // Esto cubre movimientos de cursor que no son click ni tecla de navegación
    // (p.ej. Ctrl+A, selección con shift, etc.) y también actúa como respaldo.
    scheduleInlineCheck();
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
      // Headings en raw-mode: el textContent ya es el markdown fuente
      if (/^H[1-6]$/.test(tag) && node.classList && node.classList.contains('raw-mode')) {
        return (node.textContent || '').trimEnd() + '\\n\\n';
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
          if (node.classList && node.classList.contains('obsidian-embed')) {
            if (node.classList.contains('raw-mode-img')) {
              return (node.textContent || '').trim() + '\\n\\n';
            }
            return (node.getAttribute('data-obsidian') || '') + '\\n\\n';
          }
          var c2 = kids().trim(); return c2 ? c2 + '\\n\\n' : '\\n';
        case 'SPAN':
          if (node.classList && node.classList.contains('wiki-link')) {
            var wt = node.getAttribute('data-target') || '';
            var wd = node.textContent || '';
            return wd === wt ? '[[' + wt + ']]' : '[[' + wt + '|' + wd + ']]';
          }
          return kids();
        case 'BR':   return '\\n';
        case 'STRONG': case 'B':
          if (node.classList && node.classList.contains('raw-mode')) { return node.textContent || ''; }
          return '**' + kids() + '**';
        case 'EM': case 'I':
          if (node.classList && node.classList.contains('raw-mode')) { return node.textContent || ''; }
          return '*' + kids() + '*';
        case 'DEL':  case 'S':   return '~~' + kids() + '~~';
        case 'CODE': return '\`' + (node.textContent || '') + '\`';
        case 'A':    return '[' + kids() + '](' + (node.getAttribute('href') || '') + ')';
        case 'IMG': {
          var obsidian = node.getAttribute('data-obsidian');
          if (obsidian) { return obsidian; }
          return '![' + (node.getAttribute('alt')||'') + '](' + (node.getAttribute('src')||'') + ')';
        }
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

/* ── Índice de notas (compartido entre todos los paneles) ── */
let noteIndex: string[] = [];
const activePanels: vscode.WebviewPanel[] = [];

async function buildNoteIndex(): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    noteIndex = files.map(f => path.basename(f.fsPath, '.md'));
  } catch { noteIndex = []; }
  activePanels.forEach(p => {
    try { p.webview.postMessage({ type: 'note-index', notes: noteIndex }); } catch {}
  });
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Vault Tool');

  // Construir índice de notas y mantenerlo actualizado
  buildNoteIndex();
  const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  mdWatcher.onDidCreate(() => buildNoteIndex());
  mdWatcher.onDidDelete(() => buildNoteIndex());
  context.subscriptions.push(mdWatcher);

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
