"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
// ── Helpers ───────────────────────────────────────────────────────────────────
function findMarkdownFiles(dir, fileList = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findMarkdownFiles(fullPath, fileList);
        }
        else if (entry.isFile() && entry.name.endsWith('.md')) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i;
function findImageFiles(dir, fileList = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return fileList;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
        }
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
            }
            catch {
                continue;
            }
        }
        if (isDir) {
            findImageFiles(fullPath, fileList);
        }
        else if (isFile && IMAGE_EXT_RE.test(entry.name)) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}
function getSaveDir(docFsPath) {
    const cfg = vscode.workspace.getConfiguration('vaultTool');
    const location = cfg.get('attachmentsLocation', 'vault');
    const folder = cfg.get('attachmentsFolder', 'attachments');
    const docDir = path.dirname(docFsPath);
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
    switch (location) {
        case 'samefolder': return docDir;
        case 'subfolder': return path.join(docDir, folder);
        case 'specificfolder':
            return path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder);
        default: return vaultRoot;
    }
}
// Keeps the original filename when possible (unlike paste-image's timestamped
// name, a dropped/attached file's real name is known and worth preserving),
// only disambiguating with a " N" suffix on an actual collision. Shared by the
// `drop-files` message handler and the `vaultTool.insertAttachment` command.
function uniqueAttachmentName(saveDir, filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let candidate = filename;
    for (let n = 1; fs.existsSync(path.join(saveDir, candidate)); n++) {
        candidate = `${base} ${n}${ext}`;
    }
    return candidate;
}
function getAttachmentRoots(docUri) {
    const cfg = vscode.workspace.getConfiguration('vaultTool');
    const location = cfg.get('attachmentsLocation', 'vault');
    const folder = cfg.get('attachmentsFolder', 'attachments');
    const docDir = path.dirname(docUri.fsPath);
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? docDir;
    const roots = [vaultRoot, docDir];
    if (location === 'subfolder') {
        roots.push(path.join(docDir, folder));
    }
    if (location === 'specificfolder') {
        roots.push(path.isAbsolute(folder) ? folder : path.join(vaultRoot, folder));
    }
    return [...new Set(roots)].map(r => vscode.Uri.file(r));
}
function getImageMap(webview, docUri) {
    const map = {};
    const addFile = (fullPath) => {
        const name = path.basename(fullPath);
        if (!(name in map)) {
            map[name] = webview.asWebviewUri(vscode.Uri.file(fullPath)).toString();
        }
    };
    // 1) The configured attachments location takes priority.
    const configuredDir = getSaveDir(docUri.fsPath);
    for (const fullPath of findImageFiles(configuredDir)) {
        addFile(fullPath);
    }
    // 2) Fall back to a recursive search of the whole vault for anything not found above.
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(docUri.fsPath);
    for (const fullPath of findImageFiles(vaultRoot)) {
        addFile(fullPath);
    }
    return map;
}
// Resolves the theme name case-insensitively before giving up: an exact-case
// lookup only works by accident on case-insensitive filesystems (default NTFS on
// Windows). On a case-sensitive one (common for a vault synced onto macOS via
// iCloud/Dropbox/git, or an explicitly case-sensitive APFS volume), a casing
// mismatch between the `vaultTool.obsidianTheme` setting and the theme's actual
// on-disk folder name makes the exact-case path silently miss, and the previous
// bare `catch { return ''; }` swallowed that with no feedback — every heading/etc.
// CSS var the theme defines (--h1-size, --h1-color, ...) then just never reaches
// the webview, so headings fall back to vsTheme's hardcoded defaults instead of
// the theme's actual styling (looks "off", not obviously broken).
function getThemeCss() {
    const vaultRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!vaultRoot) {
        return '';
    }
    const themeName = vscode.workspace.getConfiguration('vaultTool').get('obsidianTheme', '').trim();
    if (!themeName) {
        return '';
    }
    const themesDir = path.join(vaultRoot, '.obsidian', 'themes');
    const exactPath = path.join(themesDir, themeName, 'theme.css');
    try {
        return fs.readFileSync(exactPath, 'utf-8');
    }
    catch { /* fall through to case-insensitive lookup */ }
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
    let entries = [];
    try {
        entries = fs.readdirSync(themesDir);
    }
    catch { /* .obsidian/themes itself missing or unreadable */ }
    for (const name of entries) {
        if (name.toLowerCase() !== themeName.toLowerCase()) {
            continue;
        }
        try {
            return fs.readFileSync(path.join(themesDir, name, 'theme.css'), 'utf-8');
        }
        catch { /* keep looking */ }
    }
    vscode.window.showWarningMessage(`Vault Tool: no se encontró el tema "${themeName}" en "${themesDir}". ` +
        (entries.length > 0
            ? `Carpetas encontradas ahí: ${entries.join(', ')}.`
            : `No se pudo leer esa carpeta — comprueba que .obsidian/themes existe en el vault que tienes abierto como carpeta de workspace.`));
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
//     exact same-directory-first / directory-hint resolution rules against a
//     snapshot of the vault from just before the move (the current file list
//     with the moved file's new path swapped back to its old one) to check.
//   - Once a link is confirmed to target the moved file, its notePart is
//     rewritten using the *new* location: no directory hint if the linking note
//     and the moved note now share a directory, otherwise the moved note's new
//     immediate parent folder name — mirroring `splitDirHint`'s "only the
//     immediate parent segment is ever used as a hint" rule, so the rewritten
//     link stays resolvable through the exact same lookup path as any other.
// `#section`/`|alias` suffixes are left untouched; only the note/dir part changes.
function resolvesToOldTarget(notePart, linkingDir, oldFileList, oldFsPath) {
    const { noteName, dirHint } = splitDirHint(notePart);
    if (path.basename(oldFsPath, '.md').toLowerCase() !== noteName.toLowerCase()) {
        return false;
    }
    if (!dirHint) {
        const sameDirCandidate = path.join(linkingDir, noteName + '.md');
        if (oldFileList.some(f => f.toLowerCase() === sameDirCandidate.toLowerCase())) {
            return sameDirCandidate.toLowerCase() === oldFsPath.toLowerCase();
        }
        const candidates = oldFileList
            .filter(f => path.basename(f, '.md').toLowerCase() === noteName.toLowerCase())
            .sort();
        return candidates.length > 0 && candidates[0].toLowerCase() === oldFsPath.toLowerCase();
    }
    const candidates = oldFileList.filter(f => path.basename(f, '.md').toLowerCase() === noteName.toLowerCase() &&
        path.basename(path.dirname(f)).toLowerCase() === dirHint.toLowerCase());
    return candidates.some(f => f.toLowerCase() === oldFsPath.toLowerCase());
}
const WIKI_TARGET_RE = /(!?)\[\[([^\]]+)\]\]/g;
async function fixUpLinksForMovedNote(oldUri, newUri) {
    const oldName = path.basename(oldUri.fsPath, '.md');
    const newName = path.basename(newUri.fsPath, '.md');
    const newDir = path.dirname(newUri.fsPath);
    if (oldUri.fsPath === newUri.fsPath) {
        return;
    }
    const allMd = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    // The vault as it was just before the move: same file list, with the moved
    // file's new path swapped back to its old one (every other file's location is
    // unaffected by this single move).
    const oldFileList = allMd.map(u => u.fsPath === newUri.fsPath ? oldUri.fsPath : u.fsPath);
    const edit = new vscode.WorkspaceEdit();
    for (const docUri of allMd) {
        if (docUri.fsPath === newUri.fsPath) {
            continue;
        } // only incoming links from other notes are in scope
        const doc = await vscode.workspace.openTextDocument(docUri);
        const text = doc.getText();
        const linkingDir = path.dirname(docUri.fsPath);
        WIKI_TARGET_RE.lastIndex = 0;
        let m;
        while ((m = WIKI_TARGET_RE.exec(text)) !== null) {
            const bang = m[1];
            const inner = m[2];
            const pipeIdx = inner.indexOf('|');
            const targetRaw = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
            const aliasSuffix = pipeIdx >= 0 ? inner.slice(pipeIdx) : '';
            const hashIdx = targetRaw.indexOf('#');
            const notePart = hashIdx >= 0 ? targetRaw.slice(0, hashIdx) : targetRaw;
            const sectionSuffix = hashIdx >= 0 ? targetRaw.slice(hashIdx) : '';
            if (!resolvesToOldTarget(notePart, linkingDir, oldFileList, oldUri.fsPath)) {
                continue;
            }
            const newNotePart = newDir === linkingDir ? newName : `${path.basename(newDir)}/${newName}`;
            edit.replace(docUri, new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)), `${bang}[[${newNotePart}${sectionSuffix}${aliasSuffix}]]`);
        }
    }
    if (edit.size > 0) {
        await vscode.workspace.applyEdit(edit);
    }
}
// `onDidRenameFiles` fires for both files and folders — a folder move/rename gives
// only the folder's own old/new URI, not each markdown file inside it, so those
// need to be discovered under the *new* location and individually rebased onto
// their corresponding pre-move path before `fixUpLinksForMovedNote` can process them.
async function handleWorkspaceRename(files) {
    for (const { oldUri, newUri } of files) {
        let isDirectory = false;
        try {
            isDirectory = fs.statSync(newUri.fsPath).isDirectory();
        }
        catch {
            continue;
        } // moved again/deleted since; skip
        if (isDirectory) {
            for (const newFilePath of findMarkdownFiles(newUri.fsPath)) {
                const rel = path.relative(newUri.fsPath, newFilePath);
                await fixUpLinksForMovedNote(vscode.Uri.file(path.join(oldUri.fsPath, rel)), vscode.Uri.file(newFilePath));
            }
        }
        else if (path.extname(newUri.fsPath).toLowerCase() === '.md') {
            await fixUpLinksForMovedNote(oldUri, newUri);
        }
    }
}
function computeBreadcrumb(docUri) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const rel = path.relative(root, docUri.fsPath);
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.map((part, i) => ({
        name: i === parts.length - 1 ? path.basename(part, '.md') : part,
        fsPath: path.join(root, ...parts.slice(0, i + 1)),
    }));
}
// ── Wiki-link / transclusion target resolution ────────────────────────────────
// Shared by `open-note`, `open-transclusion`, `get-transclusion` and `get-headings`.
// A target may carry an optional "#section" suffix (heading text, any level — the
// notation doesn't imply level 1) and an optional directory hint segment
// (`folder/Note`) to disambiguate same-named notes elsewhere in the vault.
function splitTarget(raw) {
    const idx = raw.indexOf('#');
    if (idx === -1) {
        return { notePart: raw, section: null };
    }
    return { notePart: raw.slice(0, idx), section: raw.slice(idx + 1).trim() || null };
}
function splitDirHint(notePart) {
    const normalized = notePart.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const noteName = segments.pop() || normalized;
    const dirHint = segments.length > 0 ? segments[segments.length - 1] : null;
    return { noteName, dirHint };
}
async function resolveNoteUri(notePart, currentDir) {
    const { noteName, dirHint } = splitDirHint(notePart);
    if (!dirHint) {
        // No disambiguation: prefer a note in the same directory as the link.
        const sameDirCandidate = path.join(currentDir, noteName + '.md');
        if (fs.existsSync(sameDirCandidate)) {
            return vscode.Uri.file(sameDirCandidate);
        }
        const found = await vscode.workspace.findFiles(`**/${noteName}.md`, '**/node_modules/**');
        return found[0];
    }
    // Disambiguation path given: match by the target's parent directory name.
    const found = await vscode.workspace.findFiles(`**/${noteName}.md`, '**/node_modules/**');
    return found.find(u => path.basename(path.dirname(u.fsPath)).toLowerCase() === dirHint.toLowerCase());
}
// ATX headings only (# .. ######), skipping fenced code blocks so a "#" inside a
// code sample isn't mistaken for a heading. `line` is the 0-based document line
// number, directly usable with `TextDocument.lineAt()` / the webview's scroll-to-line.
function parseHeadings(text) {
    const lines = text.split(/\r\n|\n/);
    const headings = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            continue;
        }
        const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (m) {
            headings.push({ level: m[1].length, text: m[2].trim(), line: i });
        }
    }
    return headings;
}
// Resolves a wiki-link/transclusion target, opens it in the same column (creating
// an empty note when missing, mirroring the pre-existing open-note behavior — but
// only when `createIfMissing`, since a transclusion pointing nowhere should just
// report "not found" rather than silently creating a blank note), and — when the
// target carries a "#section" — scrolls the target panel to that heading's line.
async function navigateToTarget(raw, currentDocUri, sourcePanel, createIfMissing) {
    const { notePart, section } = splitTarget(raw);
    const currentDir = path.dirname(currentDocUri.fsPath);
    let targetUri = await resolveNoteUri(notePart, currentDir);
    if (!targetUri) {
        if (!createIfMissing) {
            vscode.window.showWarningMessage(`No se encontró la nota "${notePart}".`);
            return;
        }
        const { noteName, dirHint } = splitDirHint(notePart);
        const targetDir = dirHint ? path.join(currentDir, dirHint) : currentDir;
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        targetUri = vscode.Uri.file(path.join(targetDir, noteName + '.md'));
        fs.writeFileSync(targetUri.fsPath, '', 'utf-8');
    }
    let scrollLine;
    if (section) {
        try {
            const text = (await vscode.workspace.openTextDocument(targetUri)).getText();
            const match = parseHeadings(text).find(h => h.text.toLowerCase() === section.toLowerCase());
            if (match) {
                scrollLine = match.line;
            }
        }
        catch { /* target unreadable — just skip the scroll */ }
    }
    const col = sourcePanel.viewColumn ?? vscode.ViewColumn.Active;
    await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownDocumentProvider.viewType, col);
    if (scrollLine != null) {
        const targetPanel = panelsByPath.get(targetUri.fsPath);
        if (targetPanel) {
            setTimeout(() => { try {
                targetPanel.webview.postMessage({ type: 'scroll-to-line', line: scrollLine });
            }
            catch { } }, 350);
        }
    }
    setTimeout(() => { try {
        sourcePanel.dispose();
    }
    catch { } }, 150);
}
let tasksApiPromise;
// Once successfully resolved, the API is cached forever (an activated extension stays active
// for the rest of the session). But if resolution *fails* — the extension isn't found yet, or
// its `activate()` throws — the failure is NOT cached: `tasksApiPromise` is reset to `undefined`
// so the next call retries from scratch, instead of being stuck with a permanently-failed
// lookup for the rest of the session. This matters because `getExtension()` can return
// `undefined` in a narrow window at VS Code startup if this extension's own activation hasn't
// been registered yet relative to ours — a real, if uncommon, race.
function getTasksApi() {
    if (!tasksApiPromise) {
        tasksApiPromise = (async () => {
            const ext = vscode.extensions.getExtension('angelCastro.obsidian-like-tasks');
            if (!ext) {
                tasksApiPromise = undefined;
                return undefined;
            }
            try {
                return (await ext.activate());
            }
            catch {
                tasksApiPromise = undefined;
                return undefined;
            }
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
async function ensureSubscribedToTasksChanges(retriesLeft = 5) {
    if (subscribedToTasksChanges) {
        return;
    }
    const api = await getTasksApi();
    if (!api?.onDidChangeTasks) {
        if (retriesLeft > 0) {
            setTimeout(() => { void ensureSubscribedToTasksChanges(retriesLeft - 1); }, 1500);
        }
        return;
    }
    subscribedToTasksChanges = true;
    api.onDidChangeTasks(() => {
        activePanels.forEach(p => { try {
            p.webview.postMessage({ type: 'tasks-changed' });
        }
        catch { } });
    });
}
// Fallback used when the Tasks extension isn't installed/active: a plain [ ]/[x]
// flip with no recurrence handling.
function naiveToggleTaskLine(lineText) {
    if (/\[ \]/.test(lineText)) {
        return [lineText.replace('[ ]', '[x]')];
    }
    if (/\[[xX]\]/.test(lineText)) {
        return [lineText.replace(/\[[xX]\]/, '[ ]')];
    }
    return [lineText];
}
// ── Shared state ──────────────────────────────────────────────────────────────
let extensionUri;
let noteIndex = [];
const activePanels = [];
// Tracks the panel currently showing each document path, so navigateToTarget can
// find a just-opened (or already-open) target panel to send `scroll-to-line` to.
const panelsByPath = new Map();
async function buildNoteIndex() {
    try {
        const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
        noteIndex = files.map(f => path.basename(f.fsPath, '.md'));
    }
    catch {
        noteIndex = [];
    }
    activePanels.forEach(p => {
        try {
            p.webview.postMessage({ type: 'note-index', notes: noteIndex });
        }
        catch { }
    });
}
// ── Custom editor provider ────────────────────────────────────────────────────
class MarkdownDocumentProvider {
    resolveCustomTextEditor(document, webviewPanel, _token) {
        void ensureSubscribedToTasksChanges();
        const getFont = () => vscode.workspace.getConfiguration('vaultTool').get('markdownFont', '').trim() ||
            'var(--vscode-editor-font-family)';
        const getCodeFont = () => vscode.workspace.getConfiguration('vaultTool').get('codeFont', '').trim();
        const getFontSize = () => vscode.workspace.getConfiguration('editor').get('fontSize', 14);
        const scriptUri = webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'editor.bundle.js'));
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'out'),
                ...getAttachmentRoots(document.uri),
            ],
        };
        activePanels.push(webviewPanel);
        panelsByPath.set(document.uri.fsPath, webviewPanel);
        webviewPanel.onDidDispose(() => {
            const i = activePanels.indexOf(webviewPanel);
            if (i !== -1) {
                activePanels.splice(i, 1);
            }
            if (panelsByPath.get(document.uri.fsPath) === webviewPanel) {
                panelsByPath.delete(document.uri.fsPath);
            }
        });
        const imgMap = getImageMap(webviewPanel.webview, document.uri);
        const themeCss = getThemeCss();
        const breadcrumb = computeBreadcrumb(document.uri);
        webviewPanel.webview.html = this.buildHtml(document.getText(), getFont(), getCodeFont(), getFontSize(), webviewPanel.webview.cspSource, scriptUri.toString(), path.basename(document.uri.fsPath, '.md'), imgMap, breadcrumb);
        // Send initial data after webview is ready.
        // Theme CSS is sent as a message (not inlined in HTML) to avoid HTML-parser
        // issues with </style> sequences inside SVG data URLs in theme files.
        setTimeout(() => {
            webviewPanel.webview.postMessage({ type: 'note-index', notes: noteIndex });
            if (themeCss) {
                webviewPanel.webview.postMessage({ type: 'theme-css', css: themeCss });
            }
        }, 300);
        let pendingSaveResolve;
        let lastOwnContent = document.getText();
        const applySync = (content) => {
            lastOwnContent = content;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
            vscode.workspace.applyEdit(edit);
        };
        const subs = [
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('vaultTool.markdownFont') ||
                    e.affectsConfiguration('vaultTool.codeFont') ||
                    e.affectsConfiguration('editor.fontSize')) {
                    webviewPanel.webview.postMessage({
                        type: 'font-update',
                        font: getFont(),
                        codeFont: getCodeFont(),
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
                if (e.document.uri.toString() !== document.uri.toString()) {
                    return;
                }
                const newText = e.document.getText();
                const normalize = (s) => s.replace(/\r\n/g, '\n');
                if (normalize(newText) === normalize(lastOwnContent)) {
                    return;
                }
                lastOwnContent = newText;
                webviewPanel.webview.postMessage({ type: 'external-update', content: newText });
            }),
            vscode.workspace.onWillSaveTextDocument(e => {
                if (e.document.uri.toString() !== document.uri.toString()) {
                    return;
                }
                const contentPromise = new Promise(resolve => {
                    pendingSaveResolve = (content) => {
                        pendingSaveResolve = undefined;
                        lastOwnContent = content;
                        resolve([vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content)]);
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
            webviewPanel.onDidChangeViewState(ev => {
                if (!ev.webviewPanel.active) {
                    webviewPanel.webview.postMessage({ type: 'trigger-sync' });
                }
            }),
            webviewPanel.webview.onDidReceiveMessage(msg => {
                if (msg.type === 'content-for-save') {
                    pendingSaveResolve?.(msg.content);
                }
                else if (msg.type === 'sync') {
                    applySync(msg.content);
                }
                else if (msg.type === 'rename') {
                    const newName = (msg.newName || '').trim();
                    const oldName = path.basename(document.uri.fsPath, '.md');
                    if (!newName || newName === oldName) {
                        return;
                    }
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
                    }).then(success => {
                        if (!success) {
                            webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
                            vscode.window.showErrorMessage(`No se pudo renombrar a "${newName}".`);
                            return;
                        }
                        // [[OldName]] links across the vault are fixed up by the
                        // onDidRenameFiles listener registered in activate() — renameFile()
                        // above fires that event, so there's nothing else to do here.
                    }, err => {
                        webviewPanel.webview.postMessage({ type: 'title-revert', name: oldName });
                        vscode.window.showErrorMessage(`No se pudo renombrar a "${newName}": ${err}`);
                    });
                }
                else if (msg.type === 'open-note') {
                    const raw = (msg.name || '').trim();
                    if (raw) {
                        void navigateToTarget(raw, document.uri, webviewPanel, true);
                    }
                }
                else if (msg.type === 'open-transclusion') {
                    // Same navigation as open-note, except a transclusion pointing at a note
                    // that doesn't exist should report "not found" rather than create a blank one.
                    const raw = (msg.target || '').trim();
                    if (raw) {
                        void navigateToTarget(raw, document.uri, webviewPanel, false);
                    }
                }
                else if (msg.type === 'get-transclusion') {
                    (async () => {
                        const id = msg.id;
                        const raw = (msg.target || '').trim();
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
                                if (headings[j].level <= headings[idx].level) {
                                    endLine = headings[j].line;
                                    break;
                                }
                            }
                            const sectionText = lines.slice(startLine, endLine).join('\n');
                            webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: null, content: sectionText, title, line: startLine });
                        }
                        catch {
                            webviewPanel.webview.postMessage({ type: 'transclusion-result', id, error: 'error' });
                        }
                    })();
                }
                else if (msg.type === 'get-headings') {
                    (async () => {
                        const id = msg.id;
                        const raw = (msg.note || '').trim();
                        const currentDir = path.dirname(document.uri.fsPath);
                        try {
                            const targetUri = await resolveNoteUri(raw, currentDir);
                            if (!targetUri) {
                                webviewPanel.webview.postMessage({ type: 'headings-result', id, headings: [] });
                                return;
                            }
                            const text = (await vscode.workspace.openTextDocument(targetUri)).getText();
                            const headings = parseHeadings(text).map(h => ({ level: h.level, text: h.text }));
                            webviewPanel.webview.postMessage({ type: 'headings-result', id, headings });
                        }
                        catch {
                            webviewPanel.webview.postMessage({ type: 'headings-result', id, headings: [] });
                        }
                    })();
                }
                else if (msg.type === 'open-url') {
                    const url = (msg.url || '').trim();
                    if (url) {
                        vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                }
                else if (msg.type === 'reveal-path') {
                    const fsPath = (msg.fsPath || '').trim();
                    if (fsPath) {
                        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath));
                    }
                }
                else if (msg.type === 'toggle-task') {
                    (async () => {
                        try {
                            const line = msg.line;
                            const lineText = document.lineAt(line).text;
                            const tasksApi = await getTasksApi();
                            const replacementLines = tasksApi?.toggleTaskLine
                                ? tasksApi.toggleTaskLine(lineText)
                                : naiveToggleTaskLine(lineText);
                            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, document.lineAt(line).range, replacementLines.join(eol));
                            await vscode.workspace.applyEdit(edit);
                        }
                        catch (err) {
                            vscode.window.showErrorMessage(`No se pudo alternar la tarea: ${err}`);
                        }
                    })();
                }
                else if (msg.type === 'run-tasks-query') {
                    (async () => {
                        const tasksApi = await getTasksApi();
                        const result = tasksApi?.renderTasksQuery
                            ? tasksApi.renderTasksQuery(msg.query)
                            : { items: [], groups: null, unrecognizedLines: [] };
                        webviewPanel.webview.postMessage({ type: 'tasks-query-result', query: msg.query, result });
                    })();
                }
                else if (msg.type === 'toggle-task-at-location') {
                    (async () => {
                        try {
                            const tasksApi = await getTasksApi();
                            await tasksApi?.toggleTaskAtLocation?.(msg.path, msg.line);
                        }
                        catch (err) {
                            vscode.window.showErrorMessage(`No se pudo alternar la tarea: ${err}`);
                        }
                    })();
                }
                else if (msg.type === 'paste-image') {
                    try {
                        const base64 = msg.data.replace(/^data:image\/[a-z]+;base64,/, '');
                        const buffer = Buffer.from(base64, 'base64');
                        const now = new Date();
                        const p2 = (n) => String(n).padStart(2, '0');
                        const filename = `Pasted image ${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.png`;
                        const saveDir = getSaveDir(document.uri.fsPath);
                        if (!fs.existsSync(saveDir)) {
                            fs.mkdirSync(saveDir, { recursive: true });
                        }
                        fs.writeFileSync(path.join(saveDir, filename), buffer);
                        const fileUri = vscode.Uri.file(path.join(saveDir, filename));
                        const webviewUri = webviewPanel.webview.asWebviewUri(fileUri).toString();
                        webviewPanel.webview.postMessage({ type: 'image-pasted', filename, uri: webviewUri });
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(`Error al guardar imagen pegada: ${err}`);
                    }
                }
                else if (msg.type === 'drop-files') {
                    // A file dragged from the OS (or from VS Code's own Explorer) onto the
                    // webview's content, intercepted client-side before VS Code's own
                    // "open the dropped file as a new editor" default gets a chance to run
                    // (see the `dragover`/`drop` handlers in editor.js). Unlike paste-image
                    // (clipboard image data has no real filename), a dropped file's original
                    // name is known and worth keeping — only disambiguated on an actual
                    // collision with something already in the attachments dir.
                    (async () => {
                        const saveDir = getSaveDir(document.uri.fsPath);
                        if (!fs.existsSync(saveDir)) {
                            fs.mkdirSync(saveDir, { recursive: true });
                        }
                        const results = [];
                        for (const f of msg.files) {
                            try {
                                const base64 = f.data.replace(/^data:[^;]*;base64,/, '');
                                const buffer = Buffer.from(base64, 'base64');
                                const filename = uniqueAttachmentName(saveDir, f.name);
                                fs.writeFileSync(path.join(saveDir, filename), buffer);
                                const uri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(path.join(saveDir, filename))).toString();
                                results.push({ filename, uri });
                            }
                            catch (err) {
                                vscode.window.showErrorMessage(`No se pudo guardar el archivo arrastrado "${f.name}": ${err}`);
                            }
                        }
                        webviewPanel.webview.postMessage({ type: 'files-dropped', files: results });
                    })();
                }
            }),
        ];
        webviewPanel.onDidDispose(() => subs.forEach(s => s.dispose()));
    }
    buildHtml(content, font, codeFont, fontSize, cspSource, scriptUri, title, imageMap = {}, breadcrumb = []) {
        const init = JSON.stringify({ content, font, codeFont, fontSize, noteIndex, title, imageMap, breadcrumb });
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
MarkdownDocumentProvider.viewType = 'vaultTool.markdownEditor';
// ── Extension activation ──────────────────────────────────────────────────────
function activate(context) {
    extensionUri = context.extensionUri;
    const outputChannel = vscode.window.createOutputChannel('Vault Tool');
    buildNoteIndex();
    const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    mdWatcher.onDidCreate(() => buildNoteIndex());
    mdWatcher.onDidDelete(() => buildNoteIndex());
    context.subscriptions.push(mdWatcher);
    // Fires for explorer drag/cut-paste/F2 renames and moves (including whole
    // folders), and also for the in-app title-edit rename (which itself applies via
    // WorkspaceEdit.renameFile()) — see the comment above fixUpLinksForMovedNote.
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(e => { void handleWorkspaceRename(e.files); }));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(MarkdownDocumentProvider.viewType, new MarkdownDocumentProvider(), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
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
    const insertAttachmentCmd = vscode.commands.registerCommand('vaultTool.insertAttachment', async (clicked, selected) => {
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
        if (!docPath) {
            return;
        }
        const saveDir = getSaveDir(docPath);
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }
        const results = [];
        for (const src of uris) {
            try {
                const filename = uniqueAttachmentName(saveDir, path.basename(src.fsPath));
                const destPath = path.join(saveDir, filename);
                fs.copyFileSync(src.fsPath, destPath);
                results.push({ filename, uri: panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString() });
            }
            catch (err) {
                vscode.window.showErrorMessage(`No se pudo adjuntar "${src.fsPath}": ${err}`);
            }
        }
        if (results.length > 0) {
            panel.webview.postMessage({ type: 'files-dropped', files: results });
        }
    });
    context.subscriptions.push(listNotesCmd, openKanbanCmd, toggleSourceCmd, insertAttachmentCmd);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map