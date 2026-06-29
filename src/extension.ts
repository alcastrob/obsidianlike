import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Recorre recursivamente el vault buscando ficheros .md
function findMarkdownFiles(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Ignoramos carpetas ocultas y node_modules para no perdernos en .obsidian, .git, etc.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMarkdownFiles(fullPath, fileList);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// Lee el frontmatter YAML muy básico (sin librerías externas, solo para la prueba)
function readFrontmatterTitle(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  return firstLine.startsWith('---') ? path.basename(filePath, '.md') : path.basename(filePath, '.md');
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Vault Tool');

  // Comando 1: listar notas del vault abierto como carpeta de trabajo
  const listNotesCmd = vscode.commands.registerCommand('vaultTool.listNotes', () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Abre primero la carpeta de tu vault en VS Code (Archivo > Abrir carpeta).');
      return;
    }

    const vaultPath = folders[0].uri.fsPath;
    const notes = findMarkdownFiles(vaultPath);

    outputChannel.clear();
    outputChannel.appendLine(`Vault: ${vaultPath}`);
    outputChannel.appendLine(`Notas encontradas: ${notes.length}`);
    outputChannel.appendLine('---');
    notes.forEach(notePath => {
      const relative = path.relative(vaultPath, notePath);
      outputChannel.appendLine(relative);
    });
    outputChannel.show();

    vscode.window.showInformationMessage(`Vault Tool: ${notes.length} notas encontradas. Revisa el panel "Output".`);
  });

  // Comando 2: placeholder del Kanban, abre un webview de prueba
  const openKanbanCmd = vscode.commands.registerCommand('vaultTool.openKanban', () => {
    const panel = vscode.window.createWebviewPanel(
      'vaultKanban',
      'Kanban del Vault',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = `
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"></head>
      <body style="font-family: sans-serif; padding: 1rem;">
        <h2>Kanban del Vault (placeholder)</h2>
        <p>Esto confirma que la instalación local del .vsix funciona y que los webviews se renderizan.</p>
        <p>Aquí es donde se integrará la lógica real del Kanban/Eisenhower.</p>
      </body>
      </html>
    `;
  });

  context.subscriptions.push(listNotesCmd, openKanbanCmd);
}

export function deactivate() {}
