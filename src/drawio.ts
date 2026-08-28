// Minimal draw.io / diagrams.net (`.drawio`, mxfile) → SVG renderer.
//
// Purpose: let `![[diagram.drawio]]` render as an image "just like a .png"
// without bundling draw.io's ~2.5 MB viewer into the webview. This is a
// deliberately small, host-side (Node) converter covering the common subset of
// mxGraph a hand-drawn diagram actually uses — rectangles / rounded rectangles /
// ellipses / diamonds / triangles / plain text nodes, straight & orthogonal
// edges with arrowheads, labels, and fill/stroke/font colors. It is NOT a
// faithful reproduction of draw.io's own renderer: gradients, custom stencils
// (`shape=mxgraph.*`), swimlanes, images, groups with relative geometry, curved
// edges, and exotic style keys are approximated or ignored. Good enough for the
// simple flow/box diagrams people embed in notes; anything elaborate should be
// exported from draw.io as `.drawio.svg`/`.drawio.png` (which already render
// via their trailing extension) or opened in the draw.io editor.
//
// An `.drawio` file whose content is already an SVG document (draw.io "Editable
// SVG" export saved with a `.drawio` name) is passed straight through.

import * as zlib from 'zlib';

// ── tiny XML parser (attributes only — mxGraph geometry/style all live in
//    attributes, never in text nodes, so text content is intentionally dropped) ─
interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[]; }

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseXml(src: string): XmlNode | null {
  src = src.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1], tag = m[2], rawAttrs = m[3] || '', selfClose = m[4];
    if (closing) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    const aRe = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(rawAttrs)) !== null) {
      const k = am[1] ?? am[3];
      const v = am[2] ?? am[4] ?? '';
      if (k) { attrs[k] = decodeEntities(v); }
    }
    const node: XmlNode = { tag, attrs, children: [] };
    if (stack.length) { stack[stack.length - 1].children.push(node); }
    else if (!root) { root = node; }
    if (!selfClose) { stack.push(node); }
  }
  return root;
}

function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (node.tag === tag) { out.push(node); }
  for (const c of node.children) { findAll(c, tag, out); }
  return out;
}
function findFirst(node: XmlNode, tag: string): XmlNode | null {
  if (node.tag === tag) { return node; }
  for (const c of node.children) { const r = findFirst(c, tag); if (r) { return r; } }
  return null;
}

// ── mxfile → mxGraphModel XML (handle the deflate+base64 `<diagram>` payload) ──
function extractGraphModelXml(fileText: string): string | null {
  const outer = parseXml(fileText);
  if (!outer) { return null; }
  // Uncompressed: an <mxGraphModel> is present verbatim somewhere in the tree.
  if (findFirst(outer, 'mxGraphModel')) { return fileText; }
  // Compressed: <diagram>BASE64(deflateRaw(urlencoded xml))</diagram>. The tiny
  // parser drops text content, so pull the diagram body out with a raw regex.
  const dm = /<diagram[^>]*>([\s\S]*?)<\/diagram>/i.exec(fileText);
  if (!dm) { return null; }
  const body = dm[1].trim();
  if (body.startsWith('<')) { return body; } // inline xml inside <diagram>
  try {
    const inflated = zlib.inflateRawSync(Buffer.from(body, 'base64')).toString('utf8');
    return decodeURIComponent(inflated);
  } catch { return null; }
}

// ── style / color helpers ────────────────────────────────────────────────────
function parseStyle(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of (s || '').split(';')) {
    if (!part) { continue; }
    const eq = part.indexOf('=');
    if (eq < 0) { o[part.trim()] = '1'; }
    else { o[part.slice(0, eq).trim()] = part.slice(eq + 1).trim(); }
  }
  return o;
}
function xmlEsc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function labelText(value: string): string[] {
  if (!value) { return []; }
  const plain = decodeEntities(
    value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, ''),
  );
  return plain.split('\n').map(l => l.trim()).filter((l, i, a) => !(l === '' && (i === 0 || i === a.length - 1)));
}

interface Rect { x: number; y: number; w: number; h: number; }
function num(v: string | undefined, dflt = 0): number { const n = parseFloat(v ?? ''); return isFinite(n) ? n : dflt; }

// line (from p1 towards p2) clipped to the border of rect r; returns the point
// on r's edge, or p1 unchanged if the segment doesn't cross it.
function clipToRect(p1: { x: number; y: number }, p2: { x: number; y: number }, r: Rect): { x: number; y: number } {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = p1.x - cx, dy = p1.y - cy;
  if (dx === 0 && dy === 0) { return p1; }
  const hw = r.w / 2, hh = r.h / 2;
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export interface DrawioRenderResult { svg: string; }

/**
 * Render mxfile/mxGraphModel text to a standalone SVG string. Returns null if the
 * text can't be parsed as a graph model.
 */
export function drawioXmlToSvg(fileText: string): string | null {
  const modelXml = extractGraphModelXml(fileText);
  if (!modelXml) { return null; }
  const root = parseXml(modelXml);
  if (!root) { return null; }
  const model = findFirst(root, 'mxGraphModel');
  if (!model) { return null; }

  const cells = findAll(model, 'mxCell').slice(0, 8000);
  const geomOf = (cell: XmlNode): XmlNode | null => cell.children.find(c => c.tag === 'mxGeometry') ?? null;

  // id -> absolute rect for every vertex with real geometry
  const rects = new Map<string, Rect>();
  for (const cell of cells) {
    if (cell.attrs.vertex !== '1') { continue; }
    const g = geomOf(cell);
    if (!g) { continue; }
    const w = num(g.attrs.width), h = num(g.attrs.height);
    if (w <= 0 || h <= 0) { continue; }
    rects.set(cell.attrs.id, { x: num(g.attrs.x), y: num(g.attrs.y), w, h });
  }

  const vshapes: string[] = [];
  const vlabels: string[] = [];
  const elayer: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) { minX = x; } if (y < minY) { minY = y; }
    if (x > maxX) { maxX = x; } if (y > maxY) { maxY = y; }
  };

  const emitLabel = (lines: string[], r: Rect, st: Record<string, string>, isEdge: boolean) => {
    if (!lines.length) { return; }
    const fs = num(st.fontSize, isEdge ? 11 : 12) || 12;
    const color = st.fontColor && st.fontColor !== 'none' ? st.fontColor : '#000000';
    const lh = fs * 1.2;
    const align = st.align || 'center';
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const tx = align === 'left' ? r.x + 4 : align === 'right' ? r.x + r.w - 4 : r.x + r.w / 2;
    const vAlign = st.verticalAlign || 'middle';
    let ty: number;
    const total = lines.length * lh;
    if (vAlign === 'top') { ty = r.y + fs; }
    else if (vAlign === 'bottom') { ty = r.y + r.h - total + fs; }
    else { ty = r.y + r.h / 2 - total / 2 + fs; }
    const bold = st.fontStyle === '1' || st.fontStyle === '3' ? ' font-weight="bold"' : '';
    const italic = st.fontStyle === '2' || st.fontStyle === '3' ? ' font-style="italic"' : '';
    const tspans = lines.map((l, i) =>
      `<tspan x="${tx.toFixed(1)}" y="${(ty + i * lh).toFixed(1)}">${xmlEsc(l)}</tspan>`).join('');
    const bg = isEdge
      ? ` style="paint-order:stroke;stroke:#ffffff;stroke-width:3px;stroke-linejoin:round"`
      : '';
    vlabels.push(
      `<text font-family="Helvetica, Arial, sans-serif" font-size="${fs}" fill="${xmlEsc(color)}" ` +
      `text-anchor="${anchor}"${bold}${italic}${bg}>${tspans}</text>`,
    );
  };

  // ---- edges (drawn under vertices, like draw.io) ----
  for (const cell of cells) {
    if (cell.attrs.edge !== '1') { continue; }
    const st = parseStyle(cell.attrs.style || '');
    const g = geomOf(cell);
    let p1: { x: number; y: number } | null = null;
    let p2: { x: number; y: number } | null = null;
    const src = cell.attrs.source ? rects.get(cell.attrs.source) : undefined;
    const tgt = cell.attrs.target ? rects.get(cell.attrs.target) : undefined;
    if (src) { p1 = { x: src.x + src.w / 2, y: src.y + src.h / 2 }; }
    if (tgt) { p2 = { x: tgt.x + tgt.w / 2, y: tgt.y + tgt.h / 2 }; }
    const wpts: { x: number; y: number }[] = [];
    if (g) {
      for (const pc of g.children) {
        if (pc.tag === 'mxPoint' && pc.attrs.as === 'sourcePoint' && !p1) { p1 = { x: num(pc.attrs.x), y: num(pc.attrs.y) }; }
        if (pc.tag === 'mxPoint' && pc.attrs.as === 'targetPoint' && !p2) { p2 = { x: num(pc.attrs.x), y: num(pc.attrs.y) }; }
        if (pc.tag === 'Array' && pc.attrs.as === 'points') {
          for (const q of pc.children) { if (q.tag === 'mxPoint') { wpts.push({ x: num(q.attrs.x), y: num(q.attrs.y) }); } }
        }
      }
    }
    if (!p1 || !p2) { continue; }
    // clip endpoints to the shape borders they attach to
    const firstAfter = wpts[0] ?? p2;
    const lastBefore = wpts[wpts.length - 1] ?? p1;
    if (src) { p1 = clipToRect(firstAfter, p1, src); }
    if (tgt) { p2 = clipToRect(lastBefore, p2, tgt); }

    const pathPts = [p1, ...wpts, p2];
    for (const p of pathPts) { grow(p.x, p.y); }
    const d = pathPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const stroke = st.strokeColor && st.strokeColor !== 'none' ? st.strokeColor : '#000000';
    const sw = num(st.strokeWidth, 1) || 1;
    const dash = st.dashed === '1' ? ` stroke-dasharray="${st.dashPattern || '3 3'}"` : '';
    const endArrow = (st.endArrow ?? 'classic') !== 'none';
    const startArrow = st.startArrow !== undefined && st.startArrow !== 'none';
    const me = endArrow ? ' marker-end="url(#dio-arrow)"' : '';
    const ms = startArrow ? ' marker-start="url(#dio-arrow-start)"' : '';
    elayer.push(`<path d="${d}" fill="none" stroke="${xmlEsc(stroke)}" stroke-width="${sw}"${dash}${me}${ms}/>`);

    const lines = labelText(cell.attrs.value || '');
    if (lines.length) {
      const mid = pathPts[Math.floor(pathPts.length / 2)] ?? p1;
      const mp = pathPts.length % 2 === 0
        ? { x: (pathPts[pathPts.length / 2 - 1].x + pathPts[pathPts.length / 2].x) / 2, y: (pathPts[pathPts.length / 2 - 1].y + pathPts[pathPts.length / 2].y) / 2 }
        : mid;
      emitLabel(lines, { x: mp.x - 40, y: mp.y - 10, w: 80, h: 20 }, st, true);
    }
  }

  // ---- vertices ----
  for (const cell of cells) {
    if (cell.attrs.vertex !== '1') { continue; }
    const r = rects.get(cell.attrs.id);
    if (!r) { continue; }
    grow(r.x, r.y); grow(r.x + r.w, r.y + r.h);
    const st = parseStyle(cell.attrs.style || '');

    const isTextOnly = (st.text !== undefined || st.shape === 'text') && !st.fillColor;
    const fill = st.fillColor && st.fillColor !== 'none'
      ? st.fillColor
      : (st.fillColor === 'none' || isTextOnly ? 'none' : '#ffffff');
    const stroke = st.strokeColor === 'none'
      ? 'none'
      : (st.strokeColor && st.strokeColor !== 'none' ? st.strokeColor : (isTextOnly ? 'none' : '#000000'));
    const sw = num(st.strokeWidth, 1) || 1;
    const dash = st.dashed === '1' ? ` stroke-dasharray="${st.dashPattern || '3 3'}"` : '';
    const common = `fill="${xmlEsc(fill)}" stroke="${xmlEsc(stroke)}" stroke-width="${sw}"${dash}`;
    const x = r.x, y = r.y, w = r.w, h = r.h;

    if (st.ellipse !== undefined || st.shape === 'ellipse') {
      vshapes.push(`<ellipse cx="${(x + w / 2).toFixed(1)}" cy="${(y + h / 2).toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" ${common}/>`);
    } else if (st.rhombus !== undefined || st.shape === 'rhombus') {
      const pts = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
      vshapes.push(`<polygon points="${pts}" ${common}/>`);
    } else if (st.triangle !== undefined || st.shape === 'triangle') {
      const dir = st.direction || 'east';
      let pts: string;
      if (dir === 'north') { pts = `${x},${y + h} ${x + w},${y + h} ${x + w / 2},${y}`; }
      else if (dir === 'south') { pts = `${x},${y} ${x + w},${y} ${x + w / 2},${y + h}`; }
      else if (dir === 'west') { pts = `${x + w},${y} ${x + w},${y + h} ${x},${y + h / 2}`; }
      else { pts = `${x},${y} ${x},${y + h} ${x + w},${y + h / 2}`; }
      vshapes.push(`<polygon points="${pts}" ${common}/>`);
    } else if (st.shape === 'parallelogram') {
      const o = Math.min(w * 0.2, 20);
      vshapes.push(`<polygon points="${x + o},${y} ${x + w},${y} ${x + w - o},${y + h} ${x},${y + h}" ${common}/>`);
    } else if (st.shape === 'hexagon') {
      const o = Math.min(w * 0.15, 20);
      vshapes.push(`<polygon points="${x + o},${y} ${x + w - o},${y} ${x + w},${y + h / 2} ${x + w - o},${y + h} ${x + o},${y + h} ${x},${y + h / 2}" ${common}/>`);
    } else if (st.shape === 'cylinder' || st.shape === 'cylinder3') {
      const ry = Math.min(h * 0.12, 12);
      vshapes.push(
        `<path d="M${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" ${common}/>` +
        `<path d="M${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none" stroke="${xmlEsc(stroke)}" stroke-width="${sw}"/>`,
      );
    } else if (!isTextOnly) {
      const rounded = st.rounded === '1' ? ` rx="${Math.min(w, h) * 0.12 + 2}"` : '';
      vshapes.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"${rounded} ${common}/>`);
    }

    emitLabel(labelText(cell.attrs.value || ''), r, st, false);
  }

  if (!isFinite(minX)) { return null; }
  const pad = 12;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  let width = Math.max(1, Math.ceil(maxX - minX));
  let height = Math.max(1, Math.ceil(maxY - minY));
  // guard against a pathological diagram producing a huge canvas
  const CAP = 6000;
  const scale = Math.min(1, CAP / width, CAP / height);
  if (scale < 1) { width = Math.ceil(width * scale); height = Math.ceil(height * scale); }

  const arrow =
    '<marker id="dio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
    '<path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker>' +
    '<marker id="dio-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
    '<path d="M10 0 L0 5 L10 10 z" fill="context-stroke"/></marker>';
  // `context-stroke` isn't universally supported; fall back to black fill too.
  const arrowFallback = arrow.replace(/context-stroke/g, '#000000');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${(maxX - minX).toFixed(1)} ${(maxY - minY).toFixed(1)}">` +
    `<defs>${arrowFallback}</defs>` +
    `<g>${elayer.join('')}${vshapes.join('')}${vlabels.join('')}</g>` +
    `</svg>`
  );
}

/**
 * Read a `.drawio` file and return a `data:image/svg+xml;base64,…` URI, or null
 * when it can't be turned into an image. Handles: already-SVG content
 * (pass-through), uncompressed mxGraphModel, and deflate+base64 `<diagram>`.
 */
export function drawioFileToDataUri(fileText: string): string | null {
  let svg: string | null;
  if (/<svg[\s>]/i.test(fileText)) {
    svg = fileText;
  } else {
    svg = drawioXmlToSvg(fileText);
  }
  if (!svg) { return null; }
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}
