import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function findMarkdownFiles(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { findMarkdownFiles(fullPath, fileList); }
    else if (entry.isFile() && entry.name.endsWith('.md')) { fileList.push(fullPath); }
  }
  return fileList;
}

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i;

function findImageFiles(dir: string, fileList: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return fileList; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      // Reparse points (Dropbox Smart Sync / OneDrive Files On-Demand placeholder
      // folders) can be misreported by Dirent on Windows; fall back to a real stat.
      try {
        const st = fs.statSync(fullPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }
    }
    if (isDir) { findImageFiles(fullPath, fileList); }
    else if (isFile && IMAGE_EXT_RE.test(entry.name)) { fileList.push(fullPath); }
  }
  return fileList;
}

function getSaveDir(docFsPath: string): string {
  const cfg = vscode.workspace.getConfiguration('vaultTool');
  const location = cfg.get<string>('attachmentsLocation', 'vault');
  const folder   = cfg.get<string>('attachmentsFolder', 'attachments');
  const docDir   = path.dirname(docFsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
  switch (location) {
    case 'samefolder':    return docDir;
    case 'subfolder':     return path.join(docDir, folder);
    case 'specificfolder':
      return path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder);
    default:              return vaultRoot;
  }
}

function getAttachmentRoots(docUri: vscode.Uri): vscode.Uri[] {
  const cfg = vscode.workspace.getConfiguration('vaultTool');
  const location = cfg.get<string>('attachmentsLocation', 'vault');
  const folder   = cfg.get<string>('attachmentsFolder', 'attachments');
  const docDir   = path.dirname(docUri.fsPath);
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
  const roots: string[] = [vaultRoot, docDir];
  if (location === 'subfolder')      { roots.push(path.join(docDir, folder)); }
  if (location === 'specificfolder') { roots.push(path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder)); }
  return [...new Set(roots)].map(r => vscode.Uri.file(r));
}

function getImageMap(webview: vscode.Webview, docUri: vscode.Uri): Record<string, string> {
  const map: Record<string, string> = {};
  const addFile = (fullPath: string) => {
    const name = path.basename(fullPath);
    if (!(name in map)) {
      map[name] = webview.asWebviewUri(vscode.Uri.file(fullPath)).toString();
    }
  };

  // 1) The configured attachments location takes priority.
  const configuredDir = getSaveDir(docUri.fsPath);
  for (const fullPath of findImageFiles(configuredDir)) { addFile(fullPath); }

  // 2) Fall back to a recursive search of the whole vault for anything not found above.
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(docUri.fsPath);
  for (const fullPath of findImageFiles(vaultRoot)) { addFile(fullPath); }

  return map;
}

function getThemeCss(): string {
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!vaultRoot) { return ''; }
  const themeName = vscode.workspace.getConfiguration('vaultTool').get<string>('obsidianTheme', '').trim();
  if (!themeName) { return ''; }
  const cssPath = path.join(vaultRoot, '.obsidian', 'themes', themeName, 'theme.css');
  try { return fs.readFileSync(cssPath, 'utf-8'); } catch { return ''; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function updateWikiLinks(oldName: string, newName: string): Promise<void> {
  const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
  const edit = new vscode.WorkspaceEdit();
  for (const uri of files) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    // Matches [[OldName]] and [[OldName|alias]]
    const re = new RegExp(`\\[\\[${escapeRegex(oldName)}(\\|[^\\]]*)?\\]\\]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const alias = m[1] ?? '';
      edit.replace(uri,
        new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)),
        `[[${newName}${alias}]]`
      );
    }
  }
  if (edit.size > 0) { await vscode.workspace.applyEdit(edit); }
}

function computeBreadcrumb(docUri: vscode.Uri): Array<{ name: string; fsPath: string }> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const rel   = path.relative(root, docUri.fsPath);
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.map((part, i) => ({
    name:   i === parts.length - 1 ? path.basename(part, '.md') : part,
    fsPath: path.join(root, ...parts.slice(0, i + 1)),
  }));
}

// ── Optional soft dependency: angelCastro.obsidian-like-tasks ─────────────────
//
// Two extensions' webviews can't call into each other (full isolation), so when the
// user clicks a task checkbox in the CM6 webview, the *extension host* here (not the
// webview) computes the replacement line(s) by delegating to the Tasks extension's
// exported API, instead of reimplementing its toggle/recurrence state machine.
//
// This is a soft dependency: no `extensionDependencies` entry in package.json, so
// Vault Tool keeps working standalone if the Tasks extension isn't installed —
// `getTasksApi()` resolves to `undefined` and the `toggle-task` handler falls back
// to `naiveToggleTaskLine()`.
interface TaskDTO {
  path: string;
  line: number;
  description: string;
  tags: string[];
  isDone: boolean;
  isOverdue: boolean;
  priority: string;
  dueDate: string | null;
  scheduledDate: string | null;
  startDate: string | null;
  isRecurring: boolean;
  recurrenceRule: string | null;
  heading: string | null;
}
interface TasksQueryResultDTO {
  items: TaskDTO[];
  groups: Array<{ name: string; items: TaskDTO[] }> | null;
  unrecognizedLines: string[];
}
interface TasksExtensionApi {
  isTaskLine(lineText: string): boolean;
  toggleTaskLine(lineText: string): string[];
  // Added alongside ```tasks``` query-block rendering. Declared optional so this
  // still degrades gracefully against an older build of the Tasks extension that
  // only exposes the single-checkbox API above.
  renderTasksQuery?(queryText: string): TasksQueryResultDTO;
  toggleTaskAtLocation?(path: string, line: number): Promise<void>;
  onDidChangeTasks?: vscode.Event<void>;
}

let tasksApiPromise: Promise<TasksExtensionApi | undefined> | undefined;

// Once successfully resolved, the API is cached forever (an activated extension stays active
// for the rest of the session). But if resolution *fails* — the extension isn't found yet, or
// its `activate()` throws — the failure is NOT cached: `tasksApiPromise` is reset to `undefined`
// so the next call retries from scratch, instead of being stuck with a permanently-failed
// lookup for the rest of the session. This matters because `getExtension()` can return
// `undefined` in a narrow window at VS Code startup if this extension's own activation hasn't
// been registered yet relative to ours — a real, if uncommon, race.
function getTasksApi(): Promise<TasksExtensionApi | undefined> {
  if (!tasksApiPromise) {
    tasksApiPromise = (async () => {
      const ext = vscode.extensions.getExtension('angelCastro.obsidian-like-tasks');
      if (!ext) { tasksApiPromise = undefined; return undefined; }
      try { return (await ext.activate()) as TasksExtensionApi; }
      catch { tasksApiPromise = undefined; return undefined; }
    })();
  }
  return tasksApiPromise;
}

// Broadcasts `tasks-changed` to every open panel whenever any task anywhere in
// the workspace changes (e.g. toggled from a different file, or from a tasks-
// query checklist in a different editor entirely), so each panel's ```tasks```
// query cache gets invalidated and re-requests fresh data. Subscribed once at
// module scope (not per-panel) — `activePanels` is what makes it possible to
// fan the single event out to every currently-open webview.
let subscribedToTasksChanges = false;
// Retried a handful of times (a few seconds total) rather than just once: this is called from
// the top of `resolveCustomTextEditor`, so a single long-lived panel that was opened during the
// narrow cold-start race window described above would otherwise never get another chance to
// subscribe — there's no *new* panel-open event to retry from if the user doesn't close and
// reopen it (which is exactly the workaround this is meant to make unnecessary).
async function ensureSubscribedToTasksChanges(retriesLeft = 5): Promise<void> {
  if (subscribedToTasksChanges) { return; }
  const api = await getTasksApi();
  if (!api?.onDidChangeTasks) {
    if (retriesLeft > 0) {
      setTimeout(() => { void ensureSubscribedToTasksChanges(retriesLeft - 1); }, 1500);
    }
    return;
  }
  subscribedToTasksChanges = true;
  api.onDidChangeTasks(() => {
    activePanels.forEach(p => { try { p.webview.postMessage({ type: 'tasks-changed' }); } catch {} });
  });
}

// Fallback used when the Tasks extension isn't installed/active: a plain [ ]/[x]
// flip with no recurrence handling.
function naiveToggleTaskLine(lineText: string): string[] {
  if (/\[ \]/.test(lineText))    { return [lineText.replace('[ ]', '[x]')]; }
  if (/\[[xX]\]/.test(lineText)) { return [lineText.replace(/\[[xX]\]/, '[ ]')]; }
  return [lineText];
}

// ── Shared state ──────────────────────────────────────────────────────────────

let extensionUri: vscode.Uri;
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

// ── Custom editor provider ────────────────────────────────────────────────────

class MarkdownDocumentProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'vaultTool.markdownEditor';

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    void ensureSubscribedToTasksChanges();

    const getFont = (): string =>
      vscode.workspace.getConfiguration('vaultTool').get<string>('markdownFont', '').trim() ||
      'var(--vscode-editor-font-family)';

    const getFontSize = (): number =>
      vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);

    const scriptUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'out', 'editor.bundle.js')
    );

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'out'),
        ...getAttachmentRoots(document.uri),
      ],
    };

    activePanels.push(webviewPanel);
    webviewPanel.onDidDispose(() => {
      const i = activePanels.indexOf(webviewPanel);
      if (i !== -1) { activePanels.splice(i, 1); }
    });

    const imgMap    = getImageMap(webviewPanel.webview, document.uri);
    const themeCss  = getThemeCss();
    const breadcrumb = computeBreadcrumb(document.uri);

    webviewPanel.webview.html = this.buildHtml(
      document.getText(),
      getFont(),
      getFontSize(),
      webviewPanel.webview.cspSource,
      scriptUri.toString(),
      path.basename(document.uri.fsPath, '.md'),
      imgMap,
      breadcrumb
    );

    // Send initial data after webview is ready.
    // Theme CSS is sent as a message (not inlined in HTML) to avoid HTML-parser
    // issues with </style> sequences inside SVG data URLs in theme files.
    setTimeout(() => {
      webviewPanel.webview.postMessage({ type: 'note-index', notes: noteIndex });
      if (themeCss) {
        webviewPanel.webview.postMessage({ type: 'theme-css', css: themeCss });
      }
    }, 300);

    let pendingSaveResolve: ((content: string) => void) | undefined;
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
            fontSize: getFontSize() + 'px',
          });
        }
        if (e.affectsConfiguration('vaultTool.attachmentsLocation') ||
            e.affectsConfiguration('vaultTool.attachmentsFolder')) {
          webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.joinPath(extensionUri, 'out'),
              ...getAttachmentRoots(document.uri),
            ],
          };
        }
        if (e.affectsConfiguration('vaultTool.obsidianTheme')) {
          webviewPanel.webview.postMessage({ type: 'theme-css', css: getThemeCss() });
        }
      }),

      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        const newText = e.document.getText();
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
        if (normalize(newText) === normalize(lastOwnContent)) { return; }
        lastOwnContent = newText;
        webviewPanel.webview.postMessage({ type: 'external-update', content: newText });
      }),

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
            if (pendingSaveResolve) { pendingSaveResolve = undefined; resolve([]); }
          }, 5000);
        });
        e.waitUntil(contentPromise);
      }),

      webviewPanel.onDidChangeViewState(ev => {
        if (!ev.webviewPanel.active) {
          webviewPanel.webview.postMessage({ type: 'trigger-sync' });
        }
      }),

      webviewPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'content-for-save') {
          pendingSaveResolve?.(msg.content as string);

        } else if (msg.type === 'sync') {
          applySync(msg.content as string);

        } else if (msg.type === 'rename') {
          const newName = (msg.newName as string || '').trim();
          const oldName = path.basename(document.uri.fsPath, '.md');
          if (!newName || newName === oldName) { return; }
          if (/[\\/:*?"<>|]/.test(newName)) {
            webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
            vscode.window.showErrorMessage('Nombre no válido: contiene caracteres no permitidos.');
            return;
          }
          const newUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), newName + '.md'));
          document.save().then(() => {
            const wsEdit = new vscode.WorkspaceEdit();
            wsEdit.renameFile(document.uri, newUri, { overwrite: false });
            return vscode.workspace.applyEdit(wsEdit);
          }).then(
            success => {
              if (!success) {
                webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
                vscode.window.showErrorMessage(`No se pudo renombrar a "${newName}".`);
                return;
              }
              // Update [[OldName]] links across all vault files
              updateWikiLinks(oldName, newName);
            },
            err => {
              webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
              vscode.window.showErrorMessage(`No se pudo renombrar a "${newName}": ${err}`);
            }
          );

        } else if (msg.type === 'open-note') {
          const raw = (msg.name as string || '').trim();
          if (!raw) { return; }
          // A wiki-link may carry a directory hint to disambiguate same-named notes,
          // e.g. [[folder/Note]]. Only the immediate parent directory name is used.
          const normalized = raw.replace(/\\/g, '/');
          const segments   = normalized.split('/').filter(Boolean);
          const noteName   = segments.pop() || normalized;
          const dirHint    = segments.length > 0 ? segments[segments.length - 1] : null;
          const currentDir = path.dirname(document.uri.fsPath);

          (async () => {
            let targetUri: vscode.Uri | undefined;

            if (!dirHint) {
              // No disambiguation: prefer a note in the same directory as the link.
              const sameDirCandidate = path.join(currentDir, noteName + '.md');
              if (fs.existsSync(sameDirCandidate)) {
                targetUri = vscode.Uri.file(sameDirCandidate);
              } else {
                const found = await vscode.workspace.findFiles(`**/${noteName}.md`, '**/node_modules/**');
                if (found.length > 0) { targetUri = found[0]; }
              }
            } else {
              // Disambiguation path given: match by the target's parent directory name.
              const found = await vscode.workspace.findFiles(`**/${noteName}.md`, '**/node_modules/**');
              const hinted = found.find(u => path.basename(path.dirname(u.fsPath)).toLowerCase() === dirHint.toLowerCase());
              if (hinted) { targetUri = hinted; }
            }

            if (!targetUri) {
              // Not found anywhere: create it next to the note containing the link
              // (inside the hinted subdirectory, if one was given).
              const targetDir = dirHint ? path.join(currentDir, dirHint) : currentDir;
              if (!fs.existsSync(targetDir)) { fs.mkdirSync(targetDir, { recursive: true }); }
              targetUri = vscode.Uri.file(path.join(targetDir, noteName + '.md'));
              fs.writeFileSync(targetUri.fsPath, '', 'utf-8');
            }

            const col = webviewPanel.viewColumn ?? vscode.ViewColumn.Active;
            await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownDocumentProvider.viewType, col);
            setTimeout(() => { try { webviewPanel.dispose(); } catch {} }, 150);
          })();

        } else if (msg.type === 'open-url') {
          const url = (msg.url as string || '').trim();
          if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }

        } else if (msg.type === 'reveal-path') {
          const fsPath = (msg.fsPath as string || '').trim();
          if (fsPath) { vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath)); }

        } else if (msg.type === 'toggle-task') {
          (async () => {
            try {
              const line = msg.line as number;
              const lineText = document.lineAt(line).text;
              const tasksApi = await getTasksApi();
              const replacementLines = tasksApi?.toggleTaskLine
                ? tasksApi.toggleTaskLine(lineText)
                : naiveToggleTaskLine(lineText);
              const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
              const edit = new vscode.WorkspaceEdit();
              edit.replace(document.uri, document.lineAt(line).range, replacementLines.join(eol));
              await vscode.workspace.applyEdit(edit);
            } catch (err) {
              vscode.window.showErrorMessage(`No se pudo alternar la tarea: ${err}`);
            }
          })();

        } else if (msg.type === 'run-tasks-query') {
          (async () => {
            const tasksApi = await getTasksApi();
            const result: TasksQueryResultDTO = tasksApi?.renderTasksQuery
              ? tasksApi.renderTasksQuery(msg.query as string)
              : { items: [], groups: null, unrecognizedLines: [] };
            webviewPanel.webview.postMessage({ type: 'tasks-query-result', query: msg.query, result });
          })();

        } else if (msg.type === 'toggle-task-at-location') {
          (async () => {
            try {
              const tasksApi = await getTasksApi();
              await tasksApi?.toggleTaskAtLocation?.(msg.path as string, msg.line as number);
            } catch (err) {
              vscode.window.showErrorMessage(`No se pudo alternar la tarea: ${err}`);
            }
          })();

        } else if (msg.type === 'paste-image') {
          try {
            const base64  = (msg.data as string).replace(/^data:image\/[a-z]+;base64,/, '');
            const buffer  = Buffer.from(base64, 'base64');
            const now     = new Date();
            const p2      = (n: number) => String(n).padStart(2, '0');
            const filename = `Pasted image ${now.getFullYear()}${p2(now.getMonth()+1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.png`;
            const saveDir = getSaveDir(document.uri.fsPath);
            if (!fs.existsSync(saveDir)) { fs.mkdirSync(saveDir, { recursive: true }); }
            fs.writeFileSync(path.join(saveDir, filename), buffer);
            const fileUri    = vscode.Uri.file(path.join(saveDir, filename));
            const webviewUri = webviewPanel.webview.asWebviewUri(fileUri).toString();
            webviewPanel.webview.postMessage({ type: 'image-pasted', filename, uri: webviewUri });
          } catch (err) {
            vscode.window.showErrorMessage(`Error al guardar imagen pegada: ${err}`);
          }
        }
      }),
    ];

    webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
  }

  private buildHtml(
    content: string,
    font: string,
    fontSize: number,
    cspSource: string,
    scriptUri: string,
    title: string,
    imageMap:  Record<string, string> = {},
    breadcrumb: Array<{ name: string; fsPath: string }> = []
  ): string {
    const init = JSON.stringify({ content, font, fontSize, noteIndex, title, imageMap, breadcrumb });
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${cspSource} data: blob:; script-src ${cspSource} 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    html, body {
      height: 100%; margin: 0; overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      display: flex; flex-direction: column;
    }
    #doc-breadcrumb {
      flex-shrink: 0;
      max-width: 780px; width: 100%;
      margin: 0 auto; padding: 10px 28px 0; box-sizing: border-box;
      font-size: 11px; opacity: 0.55;
      display: flex; align-items: center; justify-content: center; gap: 2px; flex-wrap: wrap;
      user-select: none;
    }
    .bc-part {
      cursor: pointer; color: inherit; transition: opacity 0.15s;
      padding: 2px 6px;
    }
    .bc-part:hover { opacity: 1; text-decoration: underline; }
    .bc-last { font-weight: 600; opacity: 1; cursor: default; }
    .bc-last:hover { text-decoration: none; }
    .bc-sep { padding: 2px 2px; opacity: 0.4; }
    #doc-header {
      flex-shrink: 0;
      max-width: 780px; width: 100%;
      margin: 0 auto; padding: 18px 28px 0; box-sizing: border-box;
    }
    #doc-title {
      font-size: 2em; font-weight: 700; line-height: 1.3;
      outline: none; background: transparent;
      color: var(--vscode-editor-foreground, #d4d4d4);
      font-family: var(--md-font, var(--vscode-editor-font-family, inherit));
      white-space: pre-wrap; word-break: break-word;
      margin-bottom: 14px; min-height: 1.2em;
      caret-color: var(--vscode-editorCursor-foreground, #aeafad);
    }
    #doc-title:empty::before {
      content: 'Sin título'; opacity: 0.3; pointer-events: none;
    }
    #doc-divider {
      border: none;
      border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
      margin: 0;
    }
    #editor { flex: 1; min-height: 0; overflow: hidden; }
  </style>
  <style id="__obsidian-theme"></style>
</head>
<body>
  <div id="doc-breadcrumb"></div>
  <div id="doc-header">
    <div id="doc-title" contenteditable="plaintext-only" spellcheck="false"></div>
    <hr id="doc-divider">
  </div>
  <div id="editor" class="is-live-preview markdown-source-view mod-cm6"></div>
  <script>window.__vaultInitial = ${init.replace(/<\/script>/gi, '<\\/script>')};</script>
  <script src="${scriptUri}"></script>
  <script>
    /* Sync VS Code theme class → Obsidian theme.css selectors (.theme-dark / .theme-light).
       Runs after <body> exists so document.body is always available. */
    (function() {
      function sync() {
        var b = document.body;
        if (!b) return;
        var dark = b.classList.contains('vscode-dark') || b.classList.contains('vscode-high-contrast');
        b.classList.toggle('theme-dark', dark);
        b.classList.toggle('theme-light', !dark);
        document.documentElement.classList.toggle('theme-dark', dark);
        document.documentElement.classList.toggle('theme-light', !dark);
      }
      sync();
      new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    })();
  </script>
</body>
</html>`;
  }
}

// ── Extension activation ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  const outputChannel = vscode.window.createOutputChannel('Vault Tool');

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
    const panel = vscode.window.createWebviewPanel(
      'vaultKanban', 'Kanban del Vault', vscode.ViewColumn.One, { enableScripts: true }
    );
    panel.webview.html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:1rem;"><h2>Kanban del Vault (placeholder)</h2></body></html>`;
  });

  const toggleSourceCmd = vscode.commands.registerCommand('vaultTool.toggleSourceMode', () => {
    const panel = activePanels.find(p => p.active) ?? activePanels.find(p => p.visible);
    panel?.webview.postMessage({ type: 'toggle-source-mode' });
  });

  context.subscriptions.push(listNotesCmd, openKanbanCmd, toggleSourceCmd);
}

export function deactivate() {}
