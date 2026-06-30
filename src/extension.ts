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

    webviewPanel.webview.html = this.buildHtml(
      document.getText(),
      getFont(),
      getFontSize(),
      webviewPanel.webview.cspSource,
      scriptUri.toString()
    );

    setTimeout(() => {
      webviewPanel.webview.postMessage({ type: 'note-index', notes: noteIndex });
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
            webviewPanel.webview.postMessage({ type: 'image-pasted', filename });
          } catch (err) {
            vscode.window.showErrorMessage(`Error al guardar imagen pegada: ${err}`);
          }
        }
      }),
    ];

    webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
  }

  private buildHtml(
    content: string, font: string, fontSize: number,
    cspSource: string, scriptUri: string
  ): string {
    const init = JSON.stringify({ content, font, fontSize, noteIndex });
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${cspSource} data: blob:; script-src ${cspSource} 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4); }
    #editor { height: 100%; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>window.__vaultInitial = ${init.replace(/<\/script>/gi, '<\\/script>')};</script>
  <script src="${scriptUri}"></script>
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

  context.subscriptions.push(listNotesCmd, openKanbanCmd);
}

export function deactivate() {}
