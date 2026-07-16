import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

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
  const cfg = vscode.workspace.getConfiguration('obsidianLike');
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

// Keeps the original filename when possible (unlike paste-image's timestamped
// name, a dropped/attached file's real name is known and worth preserving),
// only disambiguating with a " N" suffix on an actual collision. Shared by the
// `drop-files` message handler and the `vaultTool.insertAttachment` command.
function uniqueAttachmentName(saveDir: string, filename: string): string {
  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  for (let n = 1; fs.existsSync(path.join(saveDir, candidate)); n++) {
    candidate = `${base} ${n}${ext}`;
  }
  return candidate;
}

function getAttachmentRoots(docUri: vscode.Uri): vscode.Uri[] {
  const cfg = vscode.workspace.getConfiguration('obsidianLike');
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

// Resolves the theme name case-insensitively before giving up: an exact-case
// lookup only works by accident on case-insensitive filesystems (default NTFS on
// Windows). On a case-sensitive one (common for a vault synced onto macOS via
// iCloud/Dropbox/git, or an explicitly case-sensitive APFS volume), a casing
// mismatch between the `obsidianLike.obsidianTheme` setting and the theme's actual
// on-disk folder name makes the exact-case path silently miss, and the previous
// bare `catch { return ''; }` swallowed that with no feedback — every heading/etc.
// CSS var the theme defines (--h1-size, --h1-color, ...) then just never reaches
// the webview, so headings fall back to vsTheme's hardcoded defaults instead of
// the theme's actual styling (looks "off", not obviously broken).
function getThemeCss(): string {
  const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!vaultRoot) { return ''; }
  const themeName = vscode.workspace.getConfiguration('obsidianLike').get<string>('obsidianTheme', '').trim();
  if (!themeName) { return ''; }
  const themesDir = path.join(vaultRoot, '.obsidian', 'themes');

  const exactPath = path.join(themesDir, themeName, 'theme.css');
  try { return fs.readFileSync(exactPath, 'utf-8'); } catch { /* fall through to case-insensitive lookup */ }

  // Case-insensitive fallback, matched by *name only* — deliberately not gated on
  // `Dirent.isDirectory()` this time. A first attempt at this fallback did gate on
  // it and still failed on a real macOS vault with the theme folder visibly present:
  // readdirSync's Dirent type can misreport for reparse points / cloud-sync
  // placeholders (iCloud Drive, Dropbox, OneDrive) / network or FUSE mounts — the
  // exact same class of bug findImageFiles already has to work around elsewhere in
  // this file, and it isn't actually Windows-specific, just more commonly hit there.
  // Since the only thing that matters here is whether theme.css is readable at the
  // expected path, skip the dirent-type check entirely and just try reading it for
  // every name-matching candidate.
  let entries: string[] = [];
  try { entries = fs.readdirSync(themesDir); } catch { /* .obsidian/themes itself missing or unreadable */ }
  for (const name of entries) {
    if (name.toLowerCase() !== themeName.toLowerCase()) { continue; }
    try { return fs.readFileSync(path.join(themesDir, name, 'theme.css'), 'utf-8'); } catch { /* keep looking */ }
  }

  vscode.window.showWarningMessage(
    `Obsidian-like: no se encontró el tema "${themeName}" en "${themesDir}". ` +
    (entries.length > 0
      ? `Carpetas encontradas ahí: ${entries.join(', ')}.`
      : `No se pudo leer esa carpeta — comprueba que .obsidian/themes existe en el vault que tienes abierto como carpeta de workspace.`)
  );
  return '';
}

// ── Fixing up wiki-links after a note is renamed or moved ─────────────────────
// Covers both: (1) the in-app title-edit rename (webview `rename` message, which
// itself calls `WorkspaceEdit.renameFile()`) and (2) any rename/move done in VS
// Code's own file explorer (drag, cut/paste, F2, moving a whole folder) — both
// paths go through `vscode.workspace.applyEdit`/the real filesystem, which is
// exactly what fires `vscode.workspace.onDidRenameFiles` (wired in `activate()`
// below). So this is the *only* place link-fixup logic lives; the webview's
// `rename` handler no longer does it separately.
//
// Unlike a name-only replace, a move can also change which directory a link
// needs to disambiguate against, so a link's target must actually be resolved
// (using the *pre-move* vault state) before deciding whether it points at the
// file that moved:
//   - Not every `[[Note]]`/`[[folder/Note]]` naming the moved file's old name
//     necessarily resolved to *this* file — another note could share that name
//     elsewhere in the vault. `resolvesToOldTarget` replays `resolveNoteUri`'s
//     exact vault-wide-first / directory-hint-as-tiebreak resolution rules
//     against a snapshot of the vault from just before the move (the current
//     file list with the moved file's new path swapped back to its old one) to
//     check.
//   - Once a link is confirmed to target the moved file, its notePart is
//     rewritten using the *new* location: no directory hint if the linking note
//     and the moved note now share a directory, otherwise the moved note's new
//     immediate parent folder name — mirroring `splitDirHint`'s "only the
//     immediate parent segment is ever used as a hint" rule, so the rewritten
//     link stays resolvable through the exact same lookup path as any other.
// `#section`/`|alias` suffixes are left untouched; only the note/dir part changes.

function resolvesToOldTarget(
  notePart: string,
  linkingDir: string,
  oldFileList: string[],
  oldFsPath: string
): boolean {
  const { noteName, dirHint } = splitDirHint(notePart);
  if (path.basename(oldFsPath, '.md').toLowerCase() !== noteName.toLowerCase()) { return false; }

  const candidates = oldFileList.filter(f => path.basename(f, '.md').toLowerCase() === noteName.toLowerCase());
  if (candidates.length === 0) { return false; }
  if (candidates.length === 1) { return candidates[0].toLowerCase() === oldFsPath.toLowerCase(); }

  // Multiple same-named notes existed pre-move — same tie-break order as resolveNoteUri:
  // directory hint first, then same-directory-as-the-link, then a deterministic (sorted)
  // first match, since there's no real `findFiles` order to replay against a static list.
  if (dirHint) {
    const dirMatch = candidates.find(f => path.basename(path.dirname(f)).toLowerCase() === dirHint.toLowerCase());
    if (dirMatch) { return dirMatch.toLowerCase() === oldFsPath.toLowerCase(); }
  }
  const sameDirMatch = candidates.find(f => path.dirname(f).toLowerCase() === linkingDir.toLowerCase());
  if (sameDirMatch) { return sameDirMatch.toLowerCase() === oldFsPath.toLowerCase(); }
  const sorted = [...candidates].sort();
  return sorted[0].toLowerCase() === oldFsPath.toLowerCase();
}

// Nested-bracket-aware: a heading's own raw text can legitimately contain a
// "[[link]]" (e.g. "# Ver [[Pepe]]"), and a "note#section" reference to that
// heading (`[[note#Ver [[Pepe]]]]` / `![[note#Ver [[Pepe]]]]`) then has a
// nested "[[Pepe]]" sitting inside the outer target. A plain `[^\]]+`-style
// char class (the original pattern here) always stops at the *first* `]` —
// the inner link's own closing bracket — truncating the captured inner text
// and leaving the real outer "]]" as unmatched, dangling literal text; for
// this function specifically, that meant a rename-fixup rewrite could
// corrupt an unrelated note's markdown by replacing only part of such a
// link. Same pattern/reasoning as WIKI_LINK_RE_SRC/EMBED_RE_SRC in
// webview-src/editor.js (kept independent since the two files aren't
// bundled together) — `(?!\[\[)` lets a lone, unpaired "[" (e.g. a heading
// like "# Tareas [urgente]") still match as plain text, only a genuine
// doubled "[[" is treated as the start of a nested link. Only one level of
// nesting is handled.
const WIKI_TARGET_RE = /(!?)\[\[((?:(?!\[\[)[^\]]|\[\[[^\[\]]*\]\])+)\]\]/g;

async function fixUpLinksForMovedNote(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const oldName = path.basename(oldUri.fsPath, '.md');
  const newName = path.basename(newUri.fsPath, '.md');
  const newDir  = path.dirname(newUri.fsPath);
  if (oldUri.fsPath === newUri.fsPath) { return; }

  const allMd = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
  // The vault as it was just before the move: same file list, with the moved
  // file's new path swapped back to its old one (every other file's location is
  // unaffected by this single move).
  const oldFileList = allMd.map(u => u.fsPath === newUri.fsPath ? oldUri.fsPath : u.fsPath);

  const edit = new vscode.WorkspaceEdit();
  for (const docUri of allMd) {
    if (docUri.fsPath === newUri.fsPath) { continue; } // only incoming links from other notes are in scope
    const doc = await vscode.workspace.openTextDocument(docUri);
    const text = doc.getText();
    const linkingDir = path.dirname(docUri.fsPath);

    WIKI_TARGET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_TARGET_RE.exec(text)) !== null) {
      const bang = m[1];
      const inner = m[2];
      const pipeIdx = inner.indexOf('|');
      const targetRaw    = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
      const aliasSuffix  = pipeIdx >= 0 ? inner.slice(pipeIdx) : '';
      const hashIdx = targetRaw.indexOf('#');
      const notePart     = hashIdx >= 0 ? targetRaw.slice(0, hashIdx) : targetRaw;
      const sectionSuffix = hashIdx >= 0 ? targetRaw.slice(hashIdx) : '';

      if (!resolvesToOldTarget(notePart, linkingDir, oldFileList, oldUri.fsPath)) { continue; }

      const newNotePart = newDir === linkingDir ? newName : `${path.basename(newDir)}/${newName}`;
      edit.replace(docUri,
        new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)),
        `${bang}[[${newNotePart}${sectionSuffix}${aliasSuffix}]]`
      );
    }
  }
  if (edit.size > 0) { await vscode.workspace.applyEdit(edit); }
}

// `onDidRenameFiles` fires for both files and folders — a folder move/rename gives
// only the folder's own old/new URI, not each markdown file inside it, so those
// need to be discovered under the *new* location and individually rebased onto
// their corresponding pre-move path before `fixUpLinksForMovedNote` can process them.
async function handleWorkspaceRename(files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>): Promise<void> {
  for (const { oldUri, newUri } of files) {
    let isDirectory = false;
    try { isDirectory = fs.statSync(newUri.fsPath).isDirectory(); } catch { continue; } // moved again/deleted since; skip

    if (isDirectory) {
      for (const newFilePath of findMarkdownFiles(newUri.fsPath)) {
        const rel = path.relative(newUri.fsPath, newFilePath);
        await fixUpLinksForMovedNote(vscode.Uri.file(path.join(oldUri.fsPath, rel)), vscode.Uri.file(newFilePath));
      }
    } else if (path.extname(newUri.fsPath).toLowerCase() === '.md') {
      await fixUpLinksForMovedNote(oldUri, newUri);
    }
  }
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

// ── Wiki-link / transclusion target resolution ────────────────────────────────
// Shared by `open-note`, `open-transclusion`, `get-transclusion` and `get-headings`.
// A target may carry an optional "#section" suffix (heading text, any level — the
// notation doesn't imply level 1) and an optional directory hint segment
// (`folder/Note`) to disambiguate same-named notes elsewhere in the vault.

function splitTarget(raw: string): { notePart: string; section: string | null } {
  const idx = raw.indexOf('#');
  if (idx === -1) { return { notePart: raw, section: null }; }
  return { notePart: raw.slice(0, idx), section: raw.slice(idx + 1).trim() || null };
}

function splitDirHint(notePart: string): { noteName: string; dirHint: string | null } {
  const normalized = notePart.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const noteName = segments.pop() || normalized;
  const dirHint = segments.length > 0 ? segments[segments.length - 1] : null;
  return { noteName, dirHint };
}

// Escapes glob metacharacters `findFiles`'s pattern would otherwise treat specially
// (`[...]` character class, `{...}` brace expansion) so a literal note name containing
// them (e.g. "Proyecto [2024]") is matched as plain text instead of silently failing to
// match anything (or matching the wrong thing). `(`/`)`/`*`/`?` are deliberately left
// alone — not special in a bare glob without a preceding extglob prefix (`@`/`!`/`+`), so
// escaping them would be needless, and a real `*`/`?` in a note name is vanishingly rare
// compared to brackets, which are common in project/date-tagged note names.
function escapeGlob(name: string): string {
  return name.replace(/[[\]{}]/g, '\\$&');
}

// Resolves a `[[wiki-link]]` target the same way Obsidian itself does: by filename,
// searched across the *entire* vault, never scoped to just `currentDir` or a directory
// hint — those only ever break a tie when more than one note shares the name, exactly
// mirroring how `[[folder/Note]]` disambiguates in Obsidian rather than restricting the
// search to that folder. A note that lives in some third, unrelated directory (neither
// `currentDir` nor any dirHint) must still resolve here — this is what a "task listing
// in note A links to a task in note B, whose own [[wikilink]] points at note C" click
// needs, since the earlier `data-wiki-base` fix only got `currentDir` right (the task's
// own note, B), not the vault-wide search this function does regardless of it.
async function resolveNoteUri(notePart: string, currentDir: string): Promise<vscode.Uri | undefined> {
  const { noteName, dirHint } = splitDirHint(notePart);
  const found = await vscode.workspace.findFiles(`**/${escapeGlob(noteName)}.md`, '**/node_modules/**');
  if (found.length === 0) { return undefined; }
  if (found.length === 1) { return found[0]; }
  // Multiple notes share this name — prefer an explicit directory hint first (Obsidian's
  // own disambiguation mechanism), then a note in the same directory as the link, then
  // just the first match rather than reporting "not found" over an arbitrary tie.
  if (dirHint) {
    const dirMatch = found.find(u => path.basename(path.dirname(u.fsPath)).toLowerCase() === dirHint.toLowerCase());
    if (dirMatch) { return dirMatch; }
  }
  const sameDirMatch = found.find(u => path.dirname(u.fsPath) === currentDir);
  return sameDirMatch ?? found[0];
}

// Same shape as resolveNoteUri, for a `[[file.docx]]`/`[[file.xlsx]]`/`[[file.pdf]]`
// wiki-link/embed target (see EXTERNAL_FILE_EXT in editor.js) — the one
// difference is the glob pattern searches for `notePart` *as-is*, with no
// `.md` appended, since the target already names the real file including its
// own extension.
async function resolveExternalFileUri(notePart: string, currentDir: string): Promise<vscode.Uri | undefined> {
  const { noteName, dirHint } = splitDirHint(notePart);
  const found = await vscode.workspace.findFiles(`**/${escapeGlob(noteName)}`, '**/node_modules/**');
  if (found.length === 0) { return undefined; }
  if (found.length === 1) { return found[0]; }
  if (dirHint) {
    const dirMatch = found.find(u => path.basename(path.dirname(u.fsPath)).toLowerCase() === dirHint.toLowerCase());
    if (dirMatch) { return dirMatch; }
  }
  const sameDirMatch = found.find(u => path.dirname(u.fsPath) === currentDir);
  return sameDirMatch ?? found[0];
}

// Opens a local file with whatever the OS has registered as its default
// application. `vscode.env.openExternal(Uri.file(...))` — the "correct",
// documented way to do this — was tried first, but reported (both for a
// .pdf and a .docx target, on Windows) as failing with "El sistema no puede
// encontrar el archivo especificado (0x2)" even though the resolved path was
// genuinely correct and openable directly from Explorer; a known reliability
// gap in how `openExternal` hands a local file:// URI off to the OS shell on
// some Windows configurations, not a bug in this extension's own path
// resolution. Spawning the OS's native "open" mechanism directly is the
// standard, more reliable workaround for this exact scenario in Electron-
// based tooling. `execFile` (not `exec`) is deliberate — arguments are
// passed as an array, never concatenated into a shell command string, so a
// filename containing spaces or shell-metacharacters (quotes, `&`, `%`, ...)
// can't corrupt the command or be (mis)interpreted by a shell at all.
function openFileWithOsDefaultApp(fsPath: string): void {
  const fail = (err: Error) =>
    vscode.window.showErrorMessage(`No se pudo abrir "${path.basename(fsPath)}": ${err.message}`);
  if (process.platform === 'win32') {
    // "start" is a cmd.exe built-in, not its own executable, so cmd.exe is
    // the process actually spawned; start's own argument convention treats
    // the first quoted argument as a window title, hence the empty "" — a
    // real path there instead would be misread as the title and the actual
    // path as a *second*, ignored argument if it contains spaces.
    execFile('cmd.exe', ['/c', 'start', '""', fsPath], (err) => { if (err) fail(err); });
  } else if (process.platform === 'darwin') {
    execFile('open', [fsPath], (err) => { if (err) fail(err); });
  } else {
    execFile('xdg-open', [fsPath], (err) => { if (err) fail(err); });
  }
}

// ATX headings only (# .. ######), skipping fenced code blocks so a "#" inside a
// code sample isn't mistaken for a heading. `line` is the 0-based document line
// number, directly usable with `TextDocument.lineAt()` / the webview's scroll-to-line.
function parseHeadings(text: string): Array<{ level: number; text: string; line: number }> {
  const lines = text.split(/\r\n|\n/);
  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { continue; }
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) { headings.push({ level: m[1].length, text: m[2].trim(), line: i }); }
  }
  return headings;
}

// Resolves a wiki-link/transclusion target, opens it in the same column (creating
// an empty note when missing, mirroring the pre-existing open-note behavior — but
// only when `createIfMissing`, since a transclusion pointing nowhere should just
// report "not found" rather than silently creating a blank note), and — when the
// target carries a "#section" — scrolls the target panel to that heading's line.
async function navigateToTarget(
  raw: string,
  currentDocUri: vscode.Uri,
  sourcePanel: vscode.WebviewPanel,
  createIfMissing: boolean,
  // Absolute directory to resolve/create relative to, overriding the open document's own
  // directory — needed when `raw` isn't a link the user typed into the open document at all, but
  // text rendered on that document's behalf for *another* file (a tasks-query row's description,
  // see `data-wiki-base`/renderCell in editor.js). Without this, a wikilink inside such text would
  // resolve (or, worse, get silently created as a blank file) relative to the wrong note entirely.
  baseDirOverride?: string
): Promise<void> {
  const { notePart, section } = splitTarget(raw);
  const currentDir = baseDirOverride ?? path.dirname(currentDocUri.fsPath);
  let targetUri = await resolveNoteUri(notePart, currentDir);

  if (!targetUri) {
    if (!createIfMissing) {
      vscode.window.showWarningMessage(`No se encontró la nota "${notePart}".`);
      return;
    }
    const { noteName, dirHint } = splitDirHint(notePart);
    const targetDir = dirHint ? path.join(currentDir, dirHint) : currentDir;
    if (!fs.existsSync(targetDir)) { fs.mkdirSync(targetDir, { recursive: true }); }
    targetUri = vscode.Uri.file(path.join(targetDir, noteName + '.md'));
    fs.writeFileSync(targetUri.fsPath, '', 'utf-8');
  }

  let scrollLine: number | undefined;
  if (section) {
    try {
      const text = (await vscode.workspace.openTextDocument(targetUri)).getText();
      const match = parseHeadings(text).find(h => h.text.toLowerCase() === section.toLowerCase());
      if (match) { scrollLine = match.line; }
    } catch { /* target unreadable — just skip the scroll */ }
  }

  const col = sourcePanel.viewColumn ?? vscode.ViewColumn.Active;
  await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownDocumentProvider.viewType, col);

  if (scrollLine != null) {
    const targetPanel = panelsByPath.get(targetUri.fsPath);
    if (targetPanel) {
      setTimeout(() => { try { targetPanel.webview.postMessage({ type: 'scroll-to-line', line: scrollLine }); } catch {} }, 350);
    }
  }
  setTimeout(() => { try { sourcePanel.dispose(); } catch {} }, 150);
}

// Public entry point for *other* extensions (e.g. angelCastro.obsidianlike-search) that
// want a result to open in this extension's rendered custom editor instead of the plain
// text editor, optionally landing on a specific 0-based line. Exposed as the
// `vaultTool.openNoteAtLine` command (see activate() below) rather than an exported API
// object, since webviews can't be handed across the extension-host process boundary
// anyway — reuses the same openWith + delayed scroll-to-line message as
// navigateToTarget above.
async function openNoteAtLine(targetUri: vscode.Uri, line?: number): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownDocumentProvider.viewType);
  if (line == null) { return; }
  const targetPanel = panelsByPath.get(targetUri.fsPath);
  if (targetPanel) {
    setTimeout(() => { try { targetPanel.webview.postMessage({ type: 'scroll-to-line', line }); } catch {} }, 350);
  }
}

// ── Optional soft dependency: angelCastro.obsidian-like-tasks ─────────────────
//
// Two extensions' webviews can't call into each other (full isolation), so when the
// user clicks a task checkbox in the CM6 webview, the *extension host* here (not the
// webview) computes the replacement line(s) by delegating to the Tasks extension's
// exported API, instead of reimplementing its toggle/recurrence state machine.
//
// This is a soft dependency: no `extensionDependencies` entry in package.json, so
// Obsidian-like keeps working standalone if the Tasks extension isn't installed —
// `getTasksApi()` resolves to `undefined` and the `toggle-task` handler falls back
// to `naiveToggleTaskLine()`.
interface TaskDTO {
  path: string;
  line: number;
  description: string;
  tags: string[];
  // Optional so this degrades gracefully against an older build of the sibling extension that
  // doesn't send them yet — see `statusSymbol` above for the same pattern.
  id?: string;
  dependsOn?: string[];
  isDone: boolean;
  // Added alongside the note-checkbox status-icon fix in `webview-src/editor.js` — `isDone`
  // alone can't distinguish "in progress" from "todo" from a custom status letter, which
  // `renderTaskRow` needs to show a matching icon instead of a plain checked/unchecked box.
  // Optional so this still degrades gracefully against an older build of the sibling
  // extension that doesn't send it yet.
  statusSymbol?: string;
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
  // only exposes the single-checkbox API above. `queryFilePath` (also optional, for the same
  // older-build reason) expands `{{query.file.path}}` inside the query text.
  renderTasksQuery?(queryText: string, queryFilePath?: string): TasksQueryResultDTO;
  toggleTaskAtLocation?(path: string, line: number): Promise<void>;
  // Opens the Tasks extension's own "Create or edit Task" webview dialog for the
  // task at (path, line) and applies the result. Used by `vaultTool.editTaskAtCursor`
  // (this editor's own `activeTextEditor`-based cursor tracking doesn't exist here —
  // we're a CustomTextEditorProvider, not a TextEditor — so the Tasks extension has
  // no way to know which task the user meant unless told explicitly).
  editTaskAtLocation?(path: string, line: number): Promise<void>;
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

// ── Dataview soft dependency ─────────────────────────────────────────────────
// Same soft-dependency shape as the Tasks extension above: a ```dataview```/
// ```dql```/```dataviewjs``` block needs data indexed from the *entire vault*
// by the sibling "angelCastro.obsidianlike-dataview" extension, which the
// webview can't compute locally from the current document's AST alone. No
// `extensionDependencies` entry in package.json, so Obsidian-like keeps working
// standalone if that extension isn't installed — the block just renders an
// explanatory error instead of a table/list.
//
// Unlike the Tasks integration, the sibling extension returns ready-to-embed
// HTML (`renderQueryResultHtml`/`renderDataviewJsOutputHtml`) rather than a
// structured DTO: dataview result shapes (LIST/TABLE/TASK/CALENDAR, arbitrary
// column expressions) are far more varied than the Tasks extension's fixed
// TaskDTO, so re-deriving a DOM renderer for all of them here isn't worth it.
// The returned markup uses `data-wiki` (not `command:` links) for navigable
// cells, which `linkClickHandler` below already understands generically.
interface DataviewQueryResultDTO { ok: boolean; html: string }
interface DataviewExtensionApi {
  runQuery(queryText: string): unknown;
  runDataviewJs(code: string, currentFilePath?: string): Promise<{ ok: boolean; output: unknown[]; error?: string }>;
  renderQueryResultHtml(result: unknown): string;
  renderDataviewJsOutputHtml(nodes: unknown[], error?: string): string;
  onDidChangeIndex: vscode.Event<void>;
}

let dataviewApiPromise: Promise<DataviewExtensionApi | undefined> | undefined;

// Same "retry on failure, cache on success" reasoning as getTasksApi() above.
function getDataviewApi(): Promise<DataviewExtensionApi | undefined> {
  if (!dataviewApiPromise) {
    dataviewApiPromise = (async () => {
      const ext = vscode.extensions.getExtension('angelCastro.obsidianlike-dataview');
      if (!ext) { dataviewApiPromise = undefined; return undefined; }
      try { return (await ext.activate()) as DataviewExtensionApi; }
      catch { dataviewApiPromise = undefined; return undefined; }
    })();
  }
  return dataviewApiPromise;
}

function escapeHtmlForDataviewError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// `lang` is the fence's info string ('dataview' | 'dql' | 'dataviewjs'); `currentFilePath` is the
// vault-relative path of the note the block lives in, used as `dv.current()` for dataviewjs.
async function renderDataviewBlock(lang: string, query: string, currentFilePath: string): Promise<DataviewQueryResultDTO> {
  const api = await getDataviewApi();
  if (!api) {
    return {
      ok: false,
      html: '<div class="dv-error">La extensión "Obsidian-like Dataview" no está instalada o activa.</div>',
    };
  }
  try {
    if (lang === 'dataviewjs') {
      const result = await api.runDataviewJs(query, currentFilePath);
      return { ok: result.ok, html: api.renderDataviewJsOutputHtml(result.output, result.error) };
    }
    return { ok: true, html: api.renderQueryResultHtml(api.runQuery(query)) };
  } catch (err) {
    return { ok: false, html: `<div class="dv-error">${escapeHtmlForDataviewError(err)}</div>` };
  }
}

// Broadcasts `dataview-changed` to every open panel whenever the sibling extension's workspace
// index changes (a note was edited/created/deleted anywhere in the vault), so each panel's
// ```dataview``` block cache gets invalidated and re-requests fresh data. Mirrors
// ensureSubscribedToTasksChanges()'s retry-on-cold-start-race reasoning above.
let subscribedToDataviewChanges = false;
async function ensureSubscribedToDataviewChanges(retriesLeft = 5): Promise<void> {
  if (subscribedToDataviewChanges) { return; }
  const api = await getDataviewApi();
  if (!api?.onDidChangeIndex) {
    if (retriesLeft > 0) {
      setTimeout(() => { void ensureSubscribedToDataviewChanges(retriesLeft - 1); }, 1500);
    }
    return;
  }
  subscribedToDataviewChanges = true;
  api.onDidChangeIndex(() => {
    activePanels.forEach(p => { try { p.webview.postMessage({ type: 'dataview-changed' }); } catch {} });
  });
}

// ── Image Toolkit soft dependency ────────────────────────────────────────────
// Same soft-dependency shape as Tasks/Dataview above, but with one structural
// difference: those two hand back a value the *host* renders into HTML/DTOs
// itself. This sibling ("angelCastro.obsidianlike-imagetoolkit", repo
// c:\git\obsidianlike_imageToolkit) instead owns a whole click-to-zoom/pan/
// rotate/... *webview* script — its DOM lives inside this editor's own
// webview, which is something only this host can inject (two extensions'
// webviews can't share a document). So `getImageToolkitApi()` only hands over
// *where* that script/stylesheet live on disk and *what* the current settings
// are; `resolveCustomTextEditor` below is the one that adds those paths to
// `localResourceRoots`, converts them to webview URIs, and posts them to the
// webview to be loaded as a real <script>/<link> tag (see the
// `load-image-toolkit` handler in webview-src/editor.js).
interface ImageToolkitWebviewAssets { scriptPath: string; stylePath: string; }
interface ImageToolkitApi {
  getWebviewAssets(): ImageToolkitWebviewAssets;
  getSettings(): Record<string, unknown>;
  onDidChangeSettings: vscode.Event<void>;
}

let imageToolkitApiPromise: Promise<ImageToolkitApi | undefined> | undefined;
// Same "retry on failure, cache on success" reasoning as getTasksApi()/getDataviewApi() above.
function getImageToolkitApi(): Promise<ImageToolkitApi | undefined> {
  if (!imageToolkitApiPromise) {
    imageToolkitApiPromise = (async () => {
      const ext = vscode.extensions.getExtension('angelCastro.obsidianlike-imagetoolkit');
      if (!ext) { imageToolkitApiPromise = undefined; return undefined; }
      try { return (await ext.activate()) as ImageToolkitApi; }
      catch { imageToolkitApiPromise = undefined; return undefined; }
    })();
  }
  return imageToolkitApiPromise;
}

// The asset *paths* are static for the lifetime of the install (they don't depend on which
// document/panel is open), so they're resolved once process-wide and reused by every panel's
// localResourceRoots instead of re-activating the sibling extension per panel.
let imageToolkitAssetRoots: vscode.Uri[] = [];
let imageToolkitAssetsPromise: Promise<ImageToolkitWebviewAssets | undefined> | undefined;
function getImageToolkitAssets(): Promise<ImageToolkitWebviewAssets | undefined> {
  if (!imageToolkitAssetsPromise) {
    imageToolkitAssetsPromise = (async () => {
      const api = await getImageToolkitApi();
      if (!api) { return undefined; }
      const assets = api.getWebviewAssets();
      imageToolkitAssetRoots = [
        vscode.Uri.file(path.dirname(assets.scriptPath)),
        vscode.Uri.file(path.dirname(assets.stylePath)),
      ];
      return assets;
    })();
  }
  return imageToolkitAssetsPromise;
}

// Broadcasts fresh settings to every open panel whenever the user changes an
// `obsidianlikeImageToolkit.*` setting, mirroring ensureSubscribedTo{Tasks,Dataview}Changes()'s
// retry-on-cold-start-race reasoning above.
let subscribedToImageToolkitChanges = false;
async function ensureSubscribedToImageToolkitChanges(retriesLeft = 5): Promise<void> {
  if (subscribedToImageToolkitChanges) { return; }
  const api = await getImageToolkitApi();
  if (!api?.onDidChangeSettings) {
    if (retriesLeft > 0) {
      setTimeout(() => { void ensureSubscribedToImageToolkitChanges(retriesLeft - 1); }, 1500);
    }
    return;
  }
  subscribedToImageToolkitChanges = true;
  api.onDidChangeSettings(() => {
    const settings = api.getSettings();
    activePanels.forEach(p => { try { p.webview.postMessage({ type: 'image-toolkit-settings', settings }); } catch {} });
  });
}

// Injects the Image Toolkit's webview script/stylesheet into one already-open panel: extends its
// localResourceRoots, then posts `load-image-toolkit` so editor.js appends the actual <script>/
// <link> tags. Split out of resolveCustomTextEditor (rather than awaited inline there) because
// getImageToolkitAssets() depends on activating another extension, which resolveCustomTextEditor
// itself can't block on without delaying every document's first paint on the (common, negligible
// once cached) case where the sibling extension isn't installed at all.
async function injectImageToolkitIfAvailable(webviewPanel: vscode.WebviewPanel, docUri: vscode.Uri): Promise<void> {
  const assets = await getImageToolkitAssets();
  if (!assets) { return; }
  const api = await getImageToolkitApi();
  if (!api) { return; }
  webviewPanel.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'out'),
      ...getAttachmentRoots(docUri),
      ...imageToolkitAssetRoots,
    ],
  };
  const scriptUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(assets.scriptPath)).toString();
  const styleUri  = webviewPanel.webview.asWebviewUri(vscode.Uri.file(assets.stylePath)).toString();
  try {
    webviewPanel.webview.postMessage({ type: 'load-image-toolkit', scriptUri, styleUri, settings: api.getSettings() });
  } catch { /* panel disposed before this resolved */ }
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
let extensionContext: vscode.ExtensionContext;
// Sent to the webview for the [[ ]] wiki-link suggester (WikiSuggestView in
// editor.js): `dir` is the vault-relative parent directory ('' for root-level
// notes), shown as subtext under the note name, mirroring Obsidian's own
// suggester. `fsPath` is only used host-side, to match note-history entries
// (absolute paths) back to a name/dir pair — it isn't sent to the webview.
interface NoteIndexEntry { name: string; dir: string; fsPath: string }
let noteIndex: NoteIndexEntry[] = [];
const activePanels: vscode.WebviewPanel[] = [];
// Tracks the panel currently showing each document path, so navigateToTarget can
// find a just-opened (or already-open) target panel to send `scroll-to-line` to.
const panelsByPath: Map<string, vscode.WebviewPanel> = new Map();
// Last cursor line reported by each panel's `cursor-position` message (updated on every CM6
// selection change — see editor.js). VS Code never exposes this webview as a `TextEditor`, so
// this cache is the only way `vaultTool.editTaskAtCursor` (below) can know which line to hand
// off without re-implementing cursor tracking on the host side.
const panelCursorLine: Map<vscode.WebviewPanel, number> = new Map();
// Same idea, for `view.scrollDOM.scrollTop` (updated on every CM6 scroll — see editor.js).
// Opening the "Create or edit Task" dialog (`showTaskEditDialog` in the Tasks extension) as a
// `ViewColumn.Beside` tab steals focus from this panel for as long as it's open; on a long note,
// that round trip was observed to leave the panel scrolled back to the top once the dialog
// closed (both on Apply and on Cancel — even Cancel, which never touches the document, still
// showed it, so the cause is the focus/visibility change itself, not the resulting edit).
// Restoring the last-known scrollTop explicitly after the dialog closes (`edit-task-at-location`
// and `vaultTool.editTaskAtCursor` below) fixes this regardless of the exact underlying
// mechanism, the same defensive way `panelCursorLine` sidesteps not having a real `TextEditor`.
const panelScrollTop: Map<vscode.WebviewPanel, number> = new Map();

async function buildNoteIndex(): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    noteIndex = files.map(f => {
      const relDir = vaultRoot
        ? path.dirname(path.relative(vaultRoot, f.fsPath)).replace(/\\/g, '/')
        : '';
      return { name: path.basename(f.fsPath, '.md'), dir: relDir === '.' ? '' : relDir, fsPath: f.fsPath };
    });
  } catch { noteIndex = []; }
  activePanels.forEach(p => {
    try {
      p.webview.postMessage({ type: 'note-index', notes: noteIndex });
      p.webview.postMessage({ type: 'note-history', notes: recentNoteEntries() });
    } catch {}
  });
}

// ── Recently-opened notes history (for the "open note" quick pick and the
// [[ ]] wiki-link suggester's empty-query "recent files" list) ───────────────
// Persisted in globalState — not tied to a single window/session, and survives
// VS Code restarts, same as Obsidian's own quick switcher history. Recorded from
// resolveCustomTextEditor, the single choke point every note passes through
// regardless of how it was opened (Explorer, wiki-link, quick pick itself, etc).
const NOTE_HISTORY_KEY = 'vaultTool.noteHistory';
const NOTE_HISTORY_LIMIT = 50;

function recordNoteOpened(fsPath: string): void {
  const history = extensionContext.globalState.get<string[]>(NOTE_HISTORY_KEY, []);
  const next = [fsPath, ...history.filter(p => p !== fsPath)].slice(0, NOTE_HISTORY_LIMIT);
  void extensionContext.globalState.update(NOTE_HISTORY_KEY, next);
}

function getNoteHistory(): string[] {
  return extensionContext.globalState.get<string[]>(NOTE_HISTORY_KEY, []);
}

// Maps the fsPath history onto current noteIndex entries (name + dir), dropping
// any history entry whose file no longer exists — same filtering the "open
// note" quick pick already does for its own recent-items list.
function recentNoteEntries(): NoteIndexEntry[] {
  const byPath = new Map(noteIndex.map(e => [e.fsPath, e]));
  const out: NoteIndexEntry[] = [];
  for (const p of getNoteHistory()) {
    const e = byPath.get(p);
    if (e) { out.push(e); }
  }
  return out;
}

function broadcastRecentNotes(): void {
  const entries = recentNoteEntries();
  activePanels.forEach(p => {
    try { p.webview.postMessage({ type: 'note-history', notes: entries }); } catch {}
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
    void ensureSubscribedToDataviewChanges();
    void ensureSubscribedToImageToolkitChanges();
    void injectImageToolkitIfAvailable(webviewPanel, document.uri);
    recordNoteOpened(document.uri.fsPath);
    broadcastRecentNotes();

    const getFont = (): string =>
      vscode.workspace.getConfiguration('obsidianLike').get<string>('markdownFont', '').trim() ||
      'var(--vscode-editor-font-family)';

    const getCodeFont = (): string =>
      vscode.workspace.getConfiguration('obsidianLike').get<string>('codeFont', '').trim();

    const getCodeFontSize = (): number =>
      vscode.workspace.getConfiguration('obsidianLike').get<number>('codeFontSize', 14);

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
        ...imageToolkitAssetRoots,
      ],
    };

    activePanels.push(webviewPanel);
    panelsByPath.set(document.uri.fsPath, webviewPanel);
    webviewPanel.onDidDispose(() => {
      const i = activePanels.indexOf(webviewPanel);
      if (i !== -1) { activePanels.splice(i, 1); }
      if (panelsByPath.get(document.uri.fsPath) === webviewPanel) { panelsByPath.delete(document.uri.fsPath); }
      panelCursorLine.delete(webviewPanel);
      panelScrollTop.delete(webviewPanel);
    });

    const imgMap    = getImageMap(webviewPanel.webview, document.uri);
    const themeCss  = getThemeCss();
    const breadcrumb = computeBreadcrumb(document.uri);

    webviewPanel.webview.html = this.buildHtml(
      document.getText(),
      getFont(),
      getCodeFont(),
      getCodeFontSize(),
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
      webviewPanel.webview.postMessage({ type: 'note-history', notes: recentNoteEntries() });
      if (themeCss) {
        webviewPanel.webview.postMessage({ type: 'theme-css', css: themeCss });
      }
    }, 300);

    let pendingSaveResolve: ((content: string) => void) | undefined;
    let pendingFlush: Promise<void> | undefined;
    let lastOwnContent: string = document.getText();

    const fullRange = () =>
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));

    // Serializes every full-document replace (both the regular debounced 'sync'
    // from the webview and the fresher content fetched in onWillSaveTextDocument
    // below) through a single promise chain, so they always apply in the order
    // they were requested. Without this, a 'sync' that arrives while the
    // onWillSaveTextDocument round-trip to the webview is still in flight could
    // finish (and get applied) *before* that now-stale round-trip's own edit —
    // silently overwriting newer keystrokes with older content. Reported on
    // macOS as text visibly disappearing right when VS Code's own autosave fired
    // mid-typing; not reproduced reliably on Windows, consistent with a race
    // rather than a deterministic bug.
    //
    // `applyingOwnEdit` guards a second, narrower race this alone didn't close:
    // onDidChangeTextDocument (below) decides whether a change is "ours" (skip)
    // or external (forward as external-update) by comparing against
    // `lastOwnContent` — but that variable used to be written *synchronously*,
    // the instant a 'sync'/'content-for-save' message was received, while the
    // WorkspaceEdit it describes was still only queued, not yet actually
    // applied. If a second queued edit updated `lastOwnContent` to its own
    // (newer) content before the *first* edit's applyEdit had actually landed,
    // the change event for that first (now-stale-relative-to-lastOwnContent)
    // edit no longer matched `lastOwnContent` — read as "an external change",
    // sent to the webview as external-update, and silently reverted whatever
    // newer content the user had already typed there. Reported as the last
    // word or two typed disappearing, with the cursor jumping back to wherever
    // it was when the save round-trip started. Setting `lastOwnContent` only
    // *after* `applyEdit` resolves — in the same serialized order edits are
    // queued and applied — keeps it from ever describing an edit that hasn't
    // landed yet; `applyingOwnEdit` additionally makes onDidChangeTextDocument
    // trust "this change came from our own queued edit" structurally instead
    // of re-deriving it from a content comparison at all.
    let applyingOwnEdit = false;
    let pendingApply: Thenable<unknown> = Promise.resolve();
    const queueReplace = (content: string): Thenable<unknown> => {
      const run = pendingApply.then(async () => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange(), content);
        applyingOwnEdit = true;
        try {
          await vscode.workspace.applyEdit(edit);
        } finally {
          applyingOwnEdit = false;
        }
        lastOwnContent = content;
      });
      pendingApply = run.then(() => undefined, () => undefined);
      return run;
    };

    const getAutoSaveDelay = (): number =>
      Math.max(0, vscode.workspace.getConfiguration('obsidianLike').get<number>('autoSaveDelay', 3000));

    let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAutoSave = () => {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        if (document.isDirty) {
          document.save().then(undefined, err =>
            vscode.window.showErrorMessage(`No se pudo autoguardar la nota: ${err}`));
        }
      }, getAutoSaveDelay());
    };

    const applySync = (content: string) => {
      queueReplace(content);
      // Own debounced autosave (obsidianLike.autoSaveDelay) instead of relying on
      // VS Code's native files.autoSave, which raced with this exact sync path.
      scheduleAutoSave();
    };

    const subs: vscode.Disposable[] = [
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('obsidianLike.markdownFont') ||
            e.affectsConfiguration('obsidianLike.codeFont') ||
            e.affectsConfiguration('obsidianLike.codeFontSize') ||
            e.affectsConfiguration('editor.fontSize')) {
          webviewPanel.webview.postMessage({
            type: 'font-update',
            font: getFont(),
            codeFont: getCodeFont(),
            codeFontSize: getCodeFontSize() + 'px',
            fontSize: getFontSize() + 'px',
          });
        }
        if (e.affectsConfiguration('obsidianLike.attachmentsLocation') ||
            e.affectsConfiguration('obsidianLike.attachmentsFolder')) {
          webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.joinPath(extensionUri, 'out'),
              ...getAttachmentRoots(document.uri),
              ...imageToolkitAssetRoots,
            ],
          };
        }
        if (e.affectsConfiguration('obsidianLike.obsidianTheme')) {
          webviewPanel.webview.postMessage({ type: 'theme-css', css: getThemeCss() });
        }
      }),

      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        // A queueReplace-driven edit (regular 'sync' or the save round-trip
        // below) landing — not an external change, regardless of what
        // lastOwnContent currently holds. See the comment above queueReplace.
        if (applyingOwnEdit) { return; }
        const newText = e.document.getText();
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
        if (normalize(newText) === normalize(lastOwnContent)) { return; }
        lastOwnContent = newText;
        webviewPanel.webview.postMessage({ type: 'external-update', content: newText });
      }),

      vscode.workspace.onWillSaveTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        // document.save() can now be triggered from more than one place at
        // once — this extension's own idle autosave timer, VS Code's native
        // files.autoSave (kept enabled, markdown-scoped, purely to suppress
        // its "save changes?" close-prompt — see syncMarkdownAutoSaveSettings
        // below), or a manual Ctrl+S landing in between either of those. Each
        // fires its own onWillSaveTextDocument. A single shared
        // `pendingSaveResolve` variable can't handle two overlapping firings:
        // the second one's assignment clobbers the first's callback, so the
        // first firing's webview reply (still correlated only by "whatever
        // pendingSaveResolve currently points to") ends up resolving the
        // *second* firing's promise instead of its own, and the first
        // firing's own 5s timeout can then null out pendingSaveResolve out
        // from under the second firing too. `pendingFlush` fixes this by
        // coalescing any overlapping firings onto the *same* in-flight
        // get-content round trip — they all want the same thing (the
        // webview's current content, applied to the document) and can safely
        // share one answer.
        if (!pendingFlush) {
          pendingFlush = new Promise<void>(resolveFlush => {
            let settled = false;
            const finish = () => {
              if (settled) { return; }
              settled = true;
              pendingSaveResolve = undefined;
              pendingFlush = undefined;
              resolveFlush();
            };
            // Applies the fetched content through queueReplace (the same
            // serialized path 'sync' uses) rather than returning a TextEdit to
            // e.waitUntil directly — see the comment above queueReplace for
            // why mixing the two application paths on the same document was
            // the source of an earlier race.
            pendingSaveResolve = (content: string) => { queueReplace(content).then(finish, finish); };
            webviewPanel.webview.postMessage({ type: 'get-content' });
            setTimeout(finish, 5000);
          });
        }
        // e.waitUntil only delays *this* firing's disk write until the shared
        // flush lands (always [] — the edit, if any, was already applied
        // through queueReplace above).
        e.waitUntil(pendingFlush.then(() => []));
      }),

      webviewPanel.onDidChangeViewState(ev => {
        if (!ev.webviewPanel.active) {
          webviewPanel.webview.postMessage({ type: 'trigger-sync' });
        }
      }),

      webviewPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'content-for-save') {
          pendingSaveResolve?.(msg.content as string);

        } else if (msg.type === 'cursor-position') {
          panelCursorLine.set(webviewPanel, msg.line as number);

        } else if (msg.type === 'scroll-position') {
          panelScrollTop.set(webviewPanel, msg.scrollTop as number);

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
              // [[OldName]] links across the vault are fixed up by the
              // onDidRenameFiles listener registered in activate() — renameFile()
              // above fires that event, so there's nothing else to do here.
            },
            err => {
              webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
              vscode.window.showErrorMessage(`No se pudo renombrar a "${newName}": ${err}`);
            }
          );

        } else if (msg.type === 'open-note') {
          const raw = (msg.name as string || '').trim();
          // `basePath` (see `data-wiki-base` in editor.js) is workspace-relative — e.g. a task's
          // own `t.path` from a tasks-query row — resolve it to the absolute directory `raw`
          // should actually be looked up/created relative to, instead of always defaulting to
          // the open document's own directory (wrong for a link that isn't part of this document
          // at all).
          const basePathRel = (msg.basePath as string | undefined)?.trim();
          const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const baseDirOverride =
            basePathRel && vaultRoot ? path.dirname(path.join(vaultRoot, basePathRel)) : undefined;
          if (raw) { void navigateToTarget(raw, document.uri, webviewPanel, true, baseDirOverride); }

        } else if (msg.type === 'open-external-file') {
          // Sent instead of open-note for a [[file.docx]]/[[file.xlsx]]/[[file.pdf]]
          // wiki-link or a ![[...]] embed of one (see EXTERNAL_FILE_EXT/
          // ExternalFileWidget in editor.js) — there's nothing to open *as a note*
          // here, so this hands the resolved file straight to the OS's own default
          // application (see openFileWithOsDefaultApp's own comment for why that's
          // a direct OS-shell spawn rather than vscode.env.openExternal) rather
          // than routing it through vscode.openWith/navigateToTarget's
          // markdown-editor machinery.
          (async () => {
            const raw = (msg.name as string || '').trim();
            if (!raw) { return; }
            const basePathRel = (msg.basePath as string | undefined)?.trim();
            const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const currentDir = basePathRel && vaultRoot
              ? path.dirname(path.join(vaultRoot, basePathRel))
              : path.dirname(document.uri.fsPath);
            const targetUri = await resolveExternalFileUri(raw, currentDir);
            if (!targetUri) {
              vscode.window.showWarningMessage(`No se encontró el fichero "${raw}" en la bóveda.`);
              return;
            }
            openFileWithOsDefaultApp(targetUri.fsPath);
          })();

        } else if (msg.type === 'open-transclusion') {
          // Same navigation as open-note, except a transclusion pointing at a note
          // that doesn't exist should report "not found" rather than create a blank one.
          const raw = (msg.target as string || '').trim();
          if (raw) { void navigateToTarget(raw, document.uri, webviewPanel, false); }

        } else if (msg.type === 'get-transclusion') {
          (async () => {
            const id = msg.id as string;
            const raw = (msg.target as string || '').trim();
            const { notePart, section } = splitTarget(raw);
            const currentDir = path.dirname(document.uri.fsPath);
            try {
              const targetUri = await resolveNoteUri(notePart, currentDir);
              if (!targetUri) {
                webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: 'not-found' });
                return;
              }
              const title = path.basename(targetUri.fsPath, '.md');
              const fullText = (await vscode.workspace.openTextDocument(targetUri)).getText();

              if (!section) {
                webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: null, content: fullText, title, line: 0 });
                return;
              }

              const headings = parseHeadings(fullText);
              const idx = headings.findIndex(h => h.text.toLowerCase() === section.toLowerCase());
              if (idx === -1) {
                webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: 'section-not-found', title });
                return;
              }
              const lines = fullText.split(/\r\n|\n/);
              const startLine = headings[idx].line;
              let endLine = lines.length;
              for (let j = idx + 1; j < headings.length; j++) {
                if (headings[j].level <= headings[idx].level) { endLine = headings[j].line; break; }
              }
              const sectionText = lines.slice(startLine, endLine).join('\n');
              webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: null, content: sectionText, title, line: startLine });
            } catch {
              webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: 'error' });
            }
          })();

        } else if (msg.type === 'get-headings') {
          (async () => {
            const id = msg.id as string;
            const raw = (msg.note as string || '').trim();
            const currentDir = path.dirname(document.uri.fsPath);
            try {
              const targetUri = await resolveNoteUri(raw, currentDir);
              if (!targetUri) { webviewPanel.webview.postMessage({ type: 'headings-result', id, headings: [] }); return; }
              const text = (await vscode.workspace.openTextDocument(targetUri)).getText();
              const headings = parseHeadings(text).map(h => ({ level: h.level, text: h.text }));
              webviewPanel.webview.postMessage({ type: 'headings-result', id, headings });
            } catch {
              webviewPanel.webview.postMessage({ type: 'headings-result', id, headings: [] });
            }
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
            // Workspace-relative path of *this* panel's own document — lets `{{query.file.path}}`
            // inside the query (typically `path does not include {{query.file.path}}`, to exclude
            // the query's own note from its results) actually expand instead of surviving as
            // literal text. Optional third arg, so this still degrades gracefully against an
            // older build of the sibling extension that doesn't accept it yet.
            const queryFilePath = vscode.workspace.asRelativePath(document.uri, false);
            const result: TasksQueryResultDTO = tasksApi?.renderTasksQuery
              ? tasksApi.renderTasksQuery(msg.query as string, queryFilePath)
              : { items: [], groups: null, unrecognizedLines: [] };
            webviewPanel.webview.postMessage({ type: 'tasks-query-result', query: msg.query, result });
          })();

        } else if (msg.type === 'run-dataview-query') {
          (async () => {
            const lang = msg.lang as string;
            const query = msg.query as string;
            const currentFilePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
            const result = await renderDataviewBlock(lang, query, currentFilePath);
            webviewPanel.webview.postMessage({ type: 'dataview-query-result', lang, query, result });
          })();

        // ── DataviewJsWidget's `dv.view(...)` support (editor.js) ──────────────
        // Separate from run-dataview-query above: a ```dataviewjs``` block that calls
        // dv.view(name, input) runs a *real* vault script (e.g. tasks-timeline.js,
        // unmodified) with a live DOM container and vault I/O — the sibling
        // obsidianlike-dataview extension's sandbox has no dv.container/dv.view/app at
        // all, so that case is handled entirely on this side instead. See the comment
        // above DataviewJsWidget in editor.js.
        } else if (msg.type === 'dataview-resolve-script') {
          (async () => {
            const name = (msg.name as string || '').trim();
            if (!name) {
              webviewPanel.webview.postMessage({ type: 'dataview-script-result', name, content: null, error: 'Nombre de script vacío.' });
              return;
            }
            try {
              // First match wins — same criterion resolveNoteUri already uses vault-wide.
              const found = await vscode.workspace.findFiles(`**/${name}.js`, '**/node_modules/**', 1);
              if (found.length === 0) {
                webviewPanel.webview.postMessage({ type: 'dataview-script-result', name, content: null, error: `No se encontró "${name}.js" en el vault.` });
                return;
              }
              const content = fs.readFileSync(found[0].fsPath, 'utf-8');
              webviewPanel.webview.postMessage({ type: 'dataview-script-result', name, content, error: null });
            } catch (err: any) {
              webviewPanel.webview.postMessage({ type: 'dataview-script-result', name, content: null, error: String(err?.message || err) });
            }
          })();

        } else if (msg.type === 'dataview-read-file') {
          // Always reads fresh from disk — unlike dataview-resolve-script's content, this is
          // deliberately never cached client-side: real Obsidian's app.vault.read() always
          // returns current content, and tasks-timeline.js's own "🔄 Refrescar" button relies
          // on that staying true without any extra plumbing on this side.
          (async () => {
            const id = msg.id as string;
            try {
              const folders = vscode.workspace.workspaceFolders;
              if (!folders || folders.length === 0) { throw new Error('No hay carpeta de vault abierta.'); }
              const uri = vscode.Uri.joinPath(folders[0].uri, msg.path as string);
              const content = fs.readFileSync(uri.fsPath, 'utf-8');
              webviewPanel.webview.postMessage({ type: 'dataview-read-file-result', id, content, error: null });
            } catch (err: any) {
              webviewPanel.webview.postMessage({ type: 'dataview-read-file-result', id, content: null, error: String(err?.message || err) });
            }
          })();

        } else if (msg.type === 'dataview-write-file') {
          (async () => {
            const id = msg.id as string;
            try {
              const folders = vscode.workspace.workspaceFolders;
              if (!folders || folders.length === 0) { throw new Error('No hay carpeta de vault abierta.'); }
              const uri = vscode.Uri.joinPath(folders[0].uri, msg.path as string);
              const doc = await vscode.workspace.openTextDocument(uri);
              const edit = new vscode.WorkspaceEdit();
              edit.replace(
                uri,
                new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
                msg.content as string
              );
              await vscode.workspace.applyEdit(edit);
              await doc.save();
              webviewPanel.webview.postMessage({ type: 'dataview-write-file-result', id, ok: true });
            } catch (err: any) {
              webviewPanel.webview.postMessage({
                type: 'dataview-write-file-result', id, ok: false, error: String(err?.message || err),
              });
            }
          })();

        } else if (msg.type === 'dataview-open-note') {
          // `msg.path` is already a resolved vault-relative path (from the loaded script's own
          // app.vault.getMarkdownFiles()/getFirstLinkpathDest, both backed by the client-side
          // noteIndex) — no further resolution needed here, and — unlike navigateToTarget, used
          // for wikilinks in the note's own prose — the note containing the dataviewjs block
          // must stay open, so this never disposes webviewPanel.
          (async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) { return; }
            const uri = vscode.Uri.joinPath(folders[0].uri, msg.path as string);
            try {
              await vscode.commands.executeCommand(
                'vscode.openWith', uri, MarkdownDocumentProvider.viewType, vscode.ViewColumn.Active
              );
            } catch {
              vscode.window.showWarningMessage(`Obsidian-like: no se pudo abrir "${msg.path}".`);
            }
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

        } else if (msg.type === 'edit-task-at-location') {
          // Sent by a ```tasks``` query row's edit button — unlike the single inline checkbox
          // widget (covered by the `vaultTool.editTaskAtCursor` keybinding instead), a query
          // result can point at any file in the vault, so there's no "current cursor" to fall
          // back on here; the row already carries the exact (path, line) to edit.
          (async () => {
            // See the comment on `panelScrollTop` above: this panel (the one showing the note
            // with the query block, which may or may not be the same note as the edited task)
            // loses focus for as long as the dialog is open and was observed to come back
            // scrolled to the top — save/restore around the call regardless of outcome.
            const scrollTop = panelScrollTop.get(webviewPanel);
            try {
              const tasksApi = await getTasksApi();
              if (!tasksApi?.editTaskAtLocation) {
                vscode.window.showInformationMessage(
                  'Editar tareas requiere la extensión "Obsidian-like Tasks" instalada y actualizada.',
                );
                return;
              }
              await tasksApi.editTaskAtLocation(msg.path as string, msg.line as number);
            } catch (err) {
              vscode.window.showErrorMessage(`No se pudo editar la tarea: ${err}`);
            } finally {
              if (scrollTop != null) {
                webviewPanel.webview.postMessage({ type: 'restore-scroll', scrollTop });
              }
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

        } else if (msg.type === 'drop-files') {
          // A file dragged from the OS (or from VS Code's own Explorer) onto the
          // webview's content, intercepted client-side before VS Code's own
          // "open the dropped file as a new editor" default gets a chance to run
          // (see the `dragover`/`drop` handlers in editor.js). Unlike paste-image
          // (clipboard image data has no real filename), a dropped file's original
          // name is known and worth keeping — only disambiguated on an actual
          // collision with something already in the attachments dir.
          (async () => {
            const saveDir = getSaveDir(document.uri.fsPath);
            if (!fs.existsSync(saveDir)) { fs.mkdirSync(saveDir, { recursive: true }); }
            const results: Array<{ filename: string; uri: string }> = [];
            for (const f of (msg.files as Array<{ name: string; data: string }>)) {
              try {
                const base64  = f.data.replace(/^data:[^;]*;base64,/, '');
                const buffer  = Buffer.from(base64, 'base64');
                const filename = uniqueAttachmentName(saveDir, f.name);
                fs.writeFileSync(path.join(saveDir, filename), buffer);
                const uri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(path.join(saveDir, filename))).toString();
                results.push({ filename, uri });
              } catch (err) {
                vscode.window.showErrorMessage(`No se pudo guardar el archivo arrastrado "${f.name}": ${err}`);
              }
            }
            webviewPanel.webview.postMessage({ type: 'files-dropped', files: results });
          })();
        }
      }),
    ];

    webviewPanel.onDidDispose(() => {
      clearTimeout(autoSaveTimer);
      // Closing the tab shouldn't have to wait for the idle autosave delay to
      // have already elapsed — flush whatever's already in the document model
      // (the webview is gone by this point, so this can only save what the
      // regular 'sync' debounce already applied, not anything typed in the
      // last instant before close; see CLAUDE.md for that residual gap). Awaits
      // pendingApply first so a 'sync' that was still in flight when the tab
      // closed actually lands before the isDirty check below reads it.
      pendingApply.then(() => {
        if (document.isDirty) {
          document.save().then(undefined, err =>
            vscode.window.showErrorMessage(`No se pudo guardar la nota al cerrar: ${err}`));
        }
      });
      subs.forEach(s => s.dispose());
    });
  }

  private buildHtml(
    content: string,
    font: string,
    codeFont: string,
    codeFontSize: number,
    fontSize: number,
    cspSource: string,
    scriptUri: string,
    title: string,
    imageMap:  Record<string, string> = {},
    breadcrumb: Array<{ name: string; fsPath: string }> = []
  ): string {
    const init = JSON.stringify({
      content, font, codeFont, codeFontSize, fontSize, noteIndex, title, imageMap, breadcrumb,
      recentNotes: recentNoteEntries(),
    });
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <!-- 'unsafe-eval' is required for DataviewJsWidget (editor.js) to run a dataviewjs
       block's own text via new Function(...) -- same trust level as Obsidian itself already
       gives that content, not a new exposure. -->
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${cspSource} data: blob:; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline';">
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

// VS Code's own "Do you want to save the changes you made to X?" prompt — shown
// when closing a dirty tab, and again for any still-dirty tab when closing the
// whole window — is suppressed by VS Code itself whenever files.autoSave is not
// "off"; that's the documented, sanctioned lever, not something this extension
// can override by intercepting the close command directly (there's no per-editor
// or per-provider API for that). Scoped to markdown only ([markdown] language
// override in the user's settings.json) so it doesn't change behavior for any
// other file type the user edits.
//
// files.autoSaveDelay is deliberately set very high (not synced to
// obsidianLike.autoSaveDelay) so VS Code's own "afterDelay" timer practically
// never fires on its own — it's enabled purely for the close-prompt-suppression
// side effect above, not to actually drive periodic saving (this extension's
// own idle timer already does that). The dialog is suppressed by files.autoSave
// simply *not being* "off", regardless of whether its own timer has ever
// actually fired, so a delay this long doesn't defeat the purpose. Letting it
// stay close to obsidianLike.autoSaveDelay (an earlier version of this synced
// the two) meant both fired at nearly the same moment on every idle pause,
// racing to trigger onWillSaveTextDocument concurrently — see pendingFlush in
// resolveCustomTextEditor for why overlapping saves needed their own fix
// regardless, but there's no reason to keep inviting the overlap here too.
//
// Only writes a setting if it doesn't already match, to avoid rewriting the
// user's settings.json (and firing onDidChangeConfiguration) on every
// activation.
const NATIVE_AUTOSAVE_DELAY_MS = 24 * 60 * 60 * 1000; // 24h — effectively "never" on its own
function syncMarkdownAutoSaveSettings() {
  const filesCfg = vscode.workspace.getConfiguration('files', { languageId: 'markdown' });
  if (filesCfg.get<string>('autoSave') !== 'afterDelay') {
    void filesCfg.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global, true);
  }
  if (filesCfg.get<number>('autoSaveDelay') !== NATIVE_AUTOSAVE_DELAY_MS) {
    void filesCfg.update('autoSaveDelay', NATIVE_AUTOSAVE_DELAY_MS, vscode.ConfigurationTarget.Global, true);
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  extensionContext = context;
  const outputChannel = vscode.window.createOutputChannel('Obsidian-like');

  syncMarkdownAutoSaveSettings();

  buildNoteIndex();
  const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  mdWatcher.onDidCreate(() => buildNoteIndex());
  mdWatcher.onDidDelete(() => buildNoteIndex());
  context.subscriptions.push(mdWatcher);

  // Fires for explorer drag/cut-paste/F2 renames and moves (including whole
  // folders), and also for the in-app title-edit rename (which itself applies via
  // WorkspaceEdit.renameFile()) — see the comment above fixUpLinksForMovedNote.
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(e => { void handleWorkspaceRename(e.files); })
  );

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
    vscode.window.showInformationMessage(`Obsidian-like: ${notes.length} notas encontradas.`);
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

  // Fallback for drag-and-drop: VS Code shows its own drag-tracking overlay above
  // every webview for the whole duration of any drag targeting the editor area, so
  // the `dragover`/`drop` listeners in editor.js never actually see an OS file
  // dropped from the Explorer/Finder — see the CLAUDE.md section on this. Invoked
  // from the Explorer's context menu instead: copies the right-clicked file(s) into
  // the *active* note's attachments dir and inserts one `![[filename]]` per file at
  // its cursor, reusing the exact same `files-dropped` reply the webview already
  // knows how to handle (falls back to inserting at the current selection when
  // `pendingDropPos` is null, which it always is here since no drop occurred).
  const insertAttachmentCmd = vscode.commands.registerCommand(
    'vaultTool.insertAttachment',
    async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const uris = selected && selected.length > 0 ? selected : (clicked ? [clicked] : []);
      if (uris.length === 0) {
        vscode.window.showWarningMessage('Selecciona uno o más archivos en el explorador primero.');
        return;
      }
      const panel = activePanels.find(p => p.active) ?? activePanels.find(p => p.visible) ??
        (activePanels.length === 1 ? activePanels[0] : undefined);
      if (!panel) {
        vscode.window.showWarningMessage('Abre primero la nota donde quieres insertar el adjunto.');
        return;
      }
      const docPath = [...panelsByPath.entries()].find(([, p]) => p === panel)?.[0];
      if (!docPath) { return; }

      const saveDir = getSaveDir(docPath);
      if (!fs.existsSync(saveDir)) { fs.mkdirSync(saveDir, { recursive: true }); }
      const results: Array<{ filename: string; uri: string }> = [];
      for (const src of uris) {
        try {
          const filename = uniqueAttachmentName(saveDir, path.basename(src.fsPath));
          const destPath = path.join(saveDir, filename);
          fs.copyFileSync(src.fsPath, destPath);
          results.push({ filename, uri: panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString() });
        } catch (err) {
          vscode.window.showErrorMessage(`No se pudo adjuntar "${src.fsPath}": ${err}`);
        }
      }
      if (results.length > 0) { panel.webview.postMessage({ type: 'files-dropped', files: results }); }
    }
  );

  // "Edit task at cursor" — a real `contributes.keybindings` entry (so it shows up, and can be
  // reassigned, in VS Code's own Keyboard Shortcuts UI), unlike the CM6-only keymap this
  // replaced. That first version worked but couldn't be discovered or rebound from the UI at
  // all, since it was never anything VS Code's keybinding system knew about — just a raw
  // key handler inside the webview's own JS. This command is a normal keybinding target
  // (`"when": "activeCustomEditorId == 'vaultTool.markdownEditor'"`, same pattern
  // `vaultTool.openNoteQuickPick` already uses), so it resolves the *last known* cursor line
  // from `panelCursorLine` (kept current by the `cursor-position` message editor.js posts on
  // every CM6 selection change) instead of `vscode.window.activeTextEditor`, which doesn't
  // exist for this custom editor.
  const editTaskAtCursorCmd = vscode.commands.registerCommand('vaultTool.editTaskAtCursor', async () => {
    const panel = activePanels.find(p => p.active) ?? activePanels.find(p => p.visible) ??
      (activePanels.length === 1 ? activePanels[0] : undefined);
    if (!panel) { return; }
    const docPath = [...panelsByPath.entries()].find(([, p]) => p === panel)?.[0];
    const line = panelCursorLine.get(panel);
    if (!docPath || line == null) { return; }

    // See the comment on `panelScrollTop` above: this panel loses focus for as long as the
    // dialog is open (`ViewColumn.Beside`, `preserveFocus: false`) and was observed to come back
    // scrolled to the top — save/restore around the call regardless of outcome (Apply/Cancel).
    const scrollTop = panelScrollTop.get(panel);
    try {
      const tasksApi = await getTasksApi();
      if (!tasksApi?.editTaskAtLocation) {
        vscode.window.showInformationMessage(
          'Editar tareas requiere la extensión "Obsidian-like Tasks" instalada y actualizada.',
        );
        return;
      }
      await tasksApi.editTaskAtLocation(vscode.workspace.asRelativePath(vscode.Uri.file(docPath), false), line);
    } catch (err) {
      vscode.window.showErrorMessage(`No se pudo editar la tarea: ${err}`);
    } finally {
      if (scrollTop != null) {
        panel.webview.postMessage({ type: 'restore-scroll', scrollTop });
      }
    }
  });

  // "Open note" quick switcher — a floating dialog (search box + list, same
  // widget the Command Palette itself uses) rather than a webview, since
  // webviews in VS Code always occupy a fixed editor tab; there's no API for a
  // floating/modal webview overlay the way Obsidian's own quick switcher is —
  // nor any way to move a QuickPick's on-screen position (it's always anchored
  // near the top, horizontally centered, entirely controlled by VS Code core).
  // Empty search shows recently-opened notes (NOTE_HISTORY_KEY, most-recent
  // first); typing switches to VS Code's own built-in fuzzy filtering over
  // every note in the vault (swapping `qp.items` is enough — QuickPick
  // refilters automatically against whatever pool is currently assigned), plus
  // an always-visible "create" item once the typed text doesn't match any
  // existing note's vault-relative path.
  //
  // Ctrl+Enter (new tab) / Ctrl+Alt+Enter (split right) can't be handled via
  // QuickPick's own onDidAccept — it fires identically regardless of modifier
  // keys, VS Code doesn't expose which were held. Instead, two extra commands
  // below are bound to those chords with `when: vaultToolQuickPickActive`, a
  // context flag this command sets for its own lifetime — they read the
  // currently-active item off `currentQuickPick` directly and hide it
  // themselves. Scoped to this one custom flag (not the built-in `inQuickOpen`)
  // so they can't ever fire while some unrelated quick pick is open elsewhere.
  const openNoteQuickPickCmd = vscode.commands.registerCommand('vaultTool.openNoteQuickPick', async () => {
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!vaultRoot) {
      vscode.window.showErrorMessage('Abre primero la carpeta de tu vault en VS Code.');
      return;
    }

    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    const relNoExt = (fsPath: string) =>
      path.relative(vaultRoot, fsPath).replace(/\.md$/i, '').replace(/\\/g, '/');
    const toItem = (fsPath: string): NoteQuickPickItem => {
      const dir = path.dirname(relNoExt(fsPath));
      return { label: path.basename(fsPath, '.md'), description: dir === '.' ? undefined : dir, fsPath };
    };

    const allItems = files.map(f => toItem(f.fsPath));
    const existingPaths = new Set(files.map(f => f.fsPath));
    const existingRelLower = new Set(files.map(f => relNoExt(f.fsPath).toLowerCase()));
    const recentItems = getNoteHistory().filter(p => existingPaths.has(p)).map(toItem);

    const qp = vscode.window.createQuickPick<NoteQuickPickItem>();
    qp.placeholder = 'Escriba el nombre de la nota para abrir o crear…';
    // QuickPick has no footer slot like Obsidian's own dialog does — `prompt`
    // (shown below the input box, above the list) is the closest equivalent
    // VS Code exposes, so the keybinding hints go there instead. Wording
    // reflects what's actually wired up here, not a verbatim copy of
    // Obsidian's own footer: there's no Shift+Enter here since "create" is a
    // regular, always-visible list item instead (see onDidChangeValue below).
    qp.prompt = '↑↓ navegar · ↵ abrir · Ctrl+↵ nueva pestaña · Ctrl+Alt+↵ dividir a la derecha · Esc descartar';
    qp.matchOnDescription = true;
    qp.items = recentItems.length > 0 ? recentItems : allItems;
    currentQuickPick = qp;
    void vscode.commands.executeCommand('setContext', 'vaultToolQuickPickActive', true);

    qp.onDidChangeValue(value => {
      const trimmed = value.trim();
      if (!trimmed) {
        qp.items = recentItems.length > 0 ? recentItems : allItems;
        return;
      }
      if (existingRelLower.has(trimmed.toLowerCase())) {
        qp.items = allItems;
      } else {
        const createItem: NoteQuickPickItem = {
          label: `$(new-file) Crear nota "${trimmed}"`,
          alwaysShow: true,
          fsPath: '',
          isCreate: true,
          createName: trimmed,
        };
        qp.items = [...allItems, createItem];
      }
    });

    qp.onDidAccept(() => { void acceptQuickPick(vaultRoot, 'replace'); });
    qp.onDidHide(() => {
      if (currentQuickPick === qp) {
        currentQuickPick = undefined;
        void vscode.commands.executeCommand('setContext', 'vaultToolQuickPickActive', false);
      }
      qp.dispose();
    });
    qp.show();
  });

  const openNoteQuickPickNewTabCmd = vscode.commands.registerCommand(
    'vaultTool._openNoteQuickPickInNewTab',
    () => {
      const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (vaultRoot) { void acceptQuickPick(vaultRoot, 'newtab'); }
    }
  );
  const openNoteQuickPickSideCmd = vscode.commands.registerCommand(
    'vaultTool._openNoteQuickPickToSide',
    () => {
      const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (vaultRoot) { void acceptQuickPick(vaultRoot, 'side'); }
    }
  );

  const openNoteAtLineCmd = vscode.commands.registerCommand(
    'vaultTool.openNoteAtLine',
    async (uri: vscode.Uri, line?: number) => { await openNoteAtLine(uri, line); }
  );

  context.subscriptions.push(
    listNotesCmd, openKanbanCmd, toggleSourceCmd, insertAttachmentCmd, editTaskAtCursorCmd,
    openNoteQuickPickCmd, openNoteQuickPickNewTabCmd, openNoteQuickPickSideCmd, openNoteAtLineCmd
  );
}

interface NoteQuickPickItem extends vscode.QuickPickItem {
  fsPath: string;
  isCreate?: boolean;
  createName?: string;
}

type OpenMode = 'replace' | 'newtab' | 'side';

// The one currently-shown "open note" QuickPick, if any — lets the modifier-key
// commands above reach its selection without QuickPick's own accept event
// telling them which chord fired it. See the comment above openNoteQuickPickCmd.
let currentQuickPick: vscode.QuickPick<NoteQuickPickItem> | undefined;

async function acceptQuickPick(vaultRoot: string, mode: OpenMode): Promise<void> {
  const qp = currentQuickPick;
  if (!qp) { return; }
  const sel = qp.activeItems[0];
  qp.hide();
  if (!sel) { return; }
  if (sel.isCreate && sel.createName) {
    await createAndOpenNote(sel.createName, vaultRoot, mode);
  } else if (sel.fsPath) {
    await openNoteFromQuickPick(sel.fsPath, mode);
  }
}

async function createAndOpenNote(name: string, vaultRoot: string, mode: OpenMode): Promise<void> {
  const trimmed = name.trim().replace(/\\/g, '/');
  if (!trimmed) { return; }
  if (/[:*?"<>|]/.test(trimmed)) {
    vscode.window.showErrorMessage('Nombre no válido: contiene caracteres no permitidos.');
    return;
  }
  const targetPath = path.join(vaultRoot, ...trimmed.split('/')) + '.md';
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '', 'utf-8');
  }
  await openNoteFromQuickPick(targetPath, mode);
}

// Opens the picked note the same way the rest of the app navigates between
// notes by default (`mode: 'replace'`): same column, then dispose whichever
// obsidian-like panel was active before — unless that panel already *is* the
// picked note, in which case there's nothing to replace. `'newtab'` opens
// alongside it in the same column without disposing anything; `'side'` opens
// in a new split column (`ViewColumn.Beside`) and likewise leaves the
// original panel untouched.
async function openNoteFromQuickPick(fsPath: string, mode: OpenMode = 'replace'): Promise<void> {
  const targetUri = vscode.Uri.file(fsPath);
  const sourcePanel = activePanels.find(p => p.active) ?? activePanels.find(p => p.visible);
  const sourcePath = sourcePanel
    ? [...panelsByPath.entries()].find(([, p]) => p === sourcePanel)?.[0]
    : undefined;

  const col = mode === 'side' ? vscode.ViewColumn.Beside : (sourcePanel?.viewColumn ?? vscode.ViewColumn.Active);
  await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownDocumentProvider.viewType, col);

  if (mode === 'replace' && sourcePanel && sourcePath !== fsPath) {
    setTimeout(() => { try { sourcePanel.dispose(); } catch {} }, 150);
  }
}

// Best-effort flush when VS Code itself is closing: saves every document that
// currently has an obsidian-like panel open and unsaved changes, instead of
// relying solely on each panel's own idle autosave timer having already fired.
// VS Code awaits the returned promise (up to its own shutdown timeout) before
// tearing down the extension host, but the webviews may already be gone by the
// time this runs — onWillSaveTextDocument's get-content round-trip will then
// just time out after 5s and fall back to whatever the last 'sync' had already
// applied, same residual gap as the onDidDispose flush above.
export function deactivate(): Thenable<void> {
  const openPaths = new Set(panelsByPath.keys());
  const saves = vscode.workspace.textDocuments
    .filter(doc => openPaths.has(doc.uri.fsPath) && doc.isDirty)
    .map(doc => doc.save());
  return Promise.all(saves).then(() => undefined);
}
