// 安全版文件轉 Markdown 工具 — 主程式
// 所有轉換都在本機瀏覽器內完成；頁面的 CSP 設定 connect-src 'none'，任何對外連線都會被瀏覽器拒絕。
'use strict';

const LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,      // 單檔上限 100 MB
  maxZipUncompressed: 600 * 1024 * 1024, // 壓縮檔解開後總量上限（防 zip bomb）
  maxZipEntries: 20000,
  maxZipRatio: 200,                      // 解壓縮比上限
  maxPdfPages: 2000,
};

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.append(c);
  return n;
};

/* ---------------- 安全狀態監控 ---------------- */
let violationCount = 0;
document.addEventListener('securitypolicyviolation', (e) => {
  violationCount++;
  $('#violations').textContent = String(violationCount);
  logSec(`已攔截：${e.violatedDirective} → ${e.blockedURI || '(inline)'}`);
});
function logSec(msg) {
  const box = $('#seclog');
  box.hidden = false;
  box.append(el('div', { text: `${new Date().toLocaleTimeString('zh-TW', { hour12: false })}  ${msg}` }));
}

async function selfTest() {
  const out = $('#selftest-result');
  out.textContent = '測試中…';
  const targets = ['https://example.com/', location.origin + '/__probe__'];
  const results = [];
  for (const url of targets) {
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store' });
      results.push(`✗ ${url} 竟然可以連線`);
    } catch {
      results.push(`✓ ${url} 已被封鎖`);
    }
  }
  const before = violationCount;
  try { navigator.sendBeacon('https://example.com/', 'x'); } catch { /* 被封鎖 */ }
  await new Promise((r) => setTimeout(r, 400));
  results.push(violationCount > before ? '✓ sendBeacon 已被封鎖' : '✗ sendBeacon 未被封鎖');
  const ok = results.every((r) => r.startsWith('✓'));
  out.textContent = (ok ? '通過：' : '注意：') + results.join('　');
  out.className = ok ? 'ok' : 'bad';
}

/* ---------------- 共用工具 ---------------- */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 台灣常見的 Excel 匯出 CSV 為 Big5
    try { return new TextDecoder('big5').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

function mdCell(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function mdTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => Array.from({ length: width }, (_, i) => mdCell(r[i])));
  const head = norm[0].map((c, i) => c || ` `);
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of norm.slice(1)) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

function parseXml(text, label) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`無法解析 ${label}`);
  return doc;
}
const byLocal = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const firstLocal = (node, name) => node.getElementsByTagNameNS('*', name)[0] || null;
const childrenLocal = (node, name) => Array.from(node.children).filter((c) => c.localName === name);
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relId = (node) => {
  const v = node.getAttributeNS(REL_NS, 'id');
  if (v) return v;
  for (const a of node.attributes) if (a.localName === 'id' && a.prefix) return a.value;
  return null;
};

function resolvePath(base, rel) {
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

async function openZip(buf) {
  const zip = await JSZip.loadAsync(buf, { checkCRC32: false, createFolders: false });
  let total = 0, count = 0;
  zip.forEach((path, f) => {
    count++;
    const size = f._data && typeof f._data.uncompressedSize === 'number' ? f._data.uncompressedSize : 0;
    total += size;
  });
  if (count > LIMITS.maxZipEntries) throw new Error(`壓縮檔內含 ${count} 個項目，超過安全上限`);
  if (total > LIMITS.maxZipUncompressed) throw new Error('解壓縮後體積過大（疑似 zip bomb），已中止');
  if (buf.byteLength > 0 && total / buf.byteLength > LIMITS.maxZipRatio) throw new Error('壓縮比異常（疑似 zip bomb），已中止');
  return zip;
}
async function zipText(zip, path) {
  const f = zip.file(path);
  return f ? f.async('string') : null;
}

/* ---------------- HTML → Markdown（turndown） ---------------- */
function makeTurndown(keepImages) {
  const td = new TurndownService({
    headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---',
  });
  td.use([turndownPluginGfm.strikethrough, turndownPluginGfm.taskListItems, turndownPluginGfm.highlightedCodeBlock]);
  // 所有表格一律轉成 Markdown 表格（含沒有表頭的 Word 表格）
  const cellTd = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  td.addRule('anyTable', {
    filter: 'table',
    replacement: (_c, table) => {
      const rows = Array.from(table.rows || []).map((tr) => Array.from(tr.cells).map((cell) => {
        const html = cell.innerHTML.replace(/<img[^>]*>/gi, '');
        return cellTd.turndown(html).replace(/\n+/g, ' ').trim();
      }));
      return '\n\n' + mdTable(rows) + '\n\n';
    },
  });
  td.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template', 'canvas', 'svg', 'form', 'link', 'meta']);
  td.addRule('safeImages', {
    filter: 'img',
    replacement: (_c, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '') || '圖片';
      const src = node.getAttribute('src') || '';
      if (keepImages && /^data:image\//i.test(src)) return `![${alt}](${src})`;
      return `![${alt}]()`;
    },
  });
  // 只保留安全的連結協定，避免 javascript: 之類的連結被帶進輸出
  td.addRule('safeLinks', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href'),
    replacement: (content, node) => {
      const href = node.getAttribute('href').trim();
      if (!/^(https?:|mailto:|#)/i.test(href)) return content;
      return `[${content}](${href.replace(/\)/g, '%29')})`;
    },
  });
  return td;
}

function htmlDocToMd(doc, keepImages) {
  for (const n of doc.querySelectorAll('script,style,noscript,iframe,object,embed,template')) n.remove();
  const body = doc.body || doc.documentElement;
  return makeTurndown(keepImages).turndown(body)
    .replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, '$1$2 ');
}

/* ---------------- 各格式轉換器 ---------------- */
async function convertHtml(buf, opts) {
  const doc = new DOMParser().parseFromString(decodeText(buf), 'text/html'); // DOMParser 產生的文件不執行腳本、不載入資源
  let md = htmlDocToMd(doc, opts.keepImages);
  const title = doc.title && doc.title.trim();
  if (title && !/^#\s/m.test(md)) md = `# ${title}\n\n${md}`;
  return { md };
}

async function convertDocx(buf, opts) {
  const zip = await openZip(buf);
  if (!zip.file('word/document.xml')) throw new Error('不是有效的 DOCX 檔案');
  const options = {};
  if (!opts.keepImages) {
    options.convertImage = mammoth.images.imgElement(async (img) => ({ src: '', alt: img.altText || '圖片' }));
  }
  const res = await mammoth.convertToHtml({ arrayBuffer: buf }, options);
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${res.value}</body></html>`, 'text/html');
  const warnings = res.messages.filter((m) => m.type === 'warning').map((m) => m.message);
  return { md: htmlDocToMd(doc, opts.keepImages), warnings: [...new Set(warnings)].slice(0, 5) };
}

// ---- XLSX：自行解析（不使用有已知漏洞的舊版 SheetJS） ----
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function isDateFormat(code) {
  if (!code) return false;
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped) && !/^[#0.,%\s]+$/.test(stripped);
}
function serialToDate(serial, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d)) return String(serial);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
  return hasTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function siText(si) {
  // 合併 <t>，略過注音/拼音標註 <rPh>
  const inPhonetic = (t) => { for (let p = t.parentElement; p && p !== si; p = p.parentElement) if (p.localName === 'rPh') return true; return false; };
  return byLocal(si, 't').filter((t) => !inPhonetic(t)).map((t) => t.textContent).join('');
}

async function convertXlsx(buf) {
  const zip = await openZip(buf);
  const wbXml = await zipText(zip, 'xl/workbook.xml');
  if (!wbXml) throw new Error('不是有效的 XLSX 檔案');
  const wb = parseXml(wbXml, 'workbook.xml');
  const date1904 = byLocal(wb, 'workbookPr').some((p) => /^(1|true)$/.test(p.getAttribute('date1904') || ''));
  const rels = parseXml((await zipText(zip, 'xl/_rels/workbook.xml.rels')) || '<Relationships/>', 'rels');
  const relMap = Object.fromEntries(byLocal(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));

  const ssXml = await zipText(zip, 'xl/sharedStrings.xml');
  const shared = ssXml ? byLocal(parseXml(ssXml, 'sharedStrings.xml'), 'si').map(siText) : [];

  const dateStyles = new Set();
  const stXml = await zipText(zip, 'xl/styles.xml');
  if (stXml) {
    const st = parseXml(stXml, 'styles.xml');
    const custom = Object.fromEntries(byLocal(st, 'numFmt').map((n) => [Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode')]));
    const xfsParent = firstLocal(st, 'cellXfs');
    if (xfsParent) childrenLocal(xfsParent, 'xf').forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      if (BUILTIN_DATE_FMTS.has(id) || isDateFormat(custom[id])) dateStyles.add(i);
    });
  }

  const parts = [];
  const sheets = byLocal(wb, 'sheet');
  for (const sh of sheets) {
    const name = sh.getAttribute('name') || '工作表';
    const rid = relId(sh);
    const target = relMap[rid];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : resolvePath('xl/workbook.xml', target);
    const xml = await zipText(zip, path);
    if (!xml) continue;
    const doc = parseXml(xml, path);
    const grid = [];
    byLocal(doc, 'row').forEach((row, ri) => {
      const r = Number(row.getAttribute('r') || ri + 1) - 1;
      let nextCol = 0;
      for (const c of childrenLocal(row, 'c')) {
        let ci = colIndex(c.getAttribute('r'));
        if (ci < 0) ci = nextCol;
        nextCol = ci + 1;
        const t = c.getAttribute('t');
        const vEl = firstLocal(c, 'v');
        const v = vEl ? vEl.textContent : '';
        let val;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') { const is = firstLocal(c, 'is'); val = is ? siText(is) : ''; }
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') val = v;
        else if (v !== '' && dateStyles.has(Number(c.getAttribute('s') || 0)) && !isNaN(Number(v))) val = serialToDate(Number(v), date1904);
        else val = v;
        if (val === '') continue;
        (grid[r] ||= [])[ci] = val;
      }
    });
    const rows = grid.filter((r) => r && r.some((v) => v !== undefined && v !== ''));
    parts.push(`## ${name}`);
    if (!rows.length) { parts.push('_（空白工作表）_'); continue; }
    let maxCol = 0, minCol = Infinity;
    for (const r of rows) r.forEach((v, i) => { if (v !== undefined && v !== '') { maxCol = Math.max(maxCol, i); minCol = Math.min(minCol, i); } });
    parts.push(mdTable(rows.map((r) => Array.from({ length: maxCol - minCol + 1 }, (_, i) => r[i + minCol] ?? ''))));
  }
  return { md: parts.join('\n\n') };
}

// ---- PPTX ----
function paraText(p) {
  let s = '';
  for (const n of p.childNodes) {
    if (n.nodeType !== 1) continue;
    if (n.localName === 'r' || n.localName === 'fld') s += (firstLocal(n, 't') || { textContent: '' }).textContent;
    else if (n.localName === 'br') s += '\n';
  }
  return s;
}
function shapeParagraphs(sp) {
  const body = firstLocal(sp, 'txBody');
  if (!body) return [];
  return childrenLocal(body, 'p').map((p) => {
    const pPr = firstLocal(p, 'pPr');
    return { text: paraText(p).trim(), lvl: Number(pPr && pPr.getAttribute('lvl')) || 0 };
  }).filter((x) => x.text);
}
function placeholderType(sp) {
  const ph = firstLocal(sp, 'ph');
  if (!ph) return null;
  return ph.getAttribute('type') || 'body';
}
function walkShapes(tree, out) {
  for (const n of tree.children) {
    if (n.localName === 'sp') out.push({ kind: 'sp', node: n });
    else if (n.localName === 'grpSp') walkShapes(n, out);
    else if (n.localName === 'graphicFrame') out.push({ kind: 'frame', node: n });
    else if (n.localName === 'pic') out.push({ kind: 'pic', node: n });
  }
}

async function convertPptx(buf) {
  const zip = await openZip(buf);
  const presXml = await zipText(zip, 'ppt/presentation.xml');
  if (!presXml) throw new Error('不是有效的 PPTX 檔案');
  const pres = parseXml(presXml, 'presentation.xml');
  const rels = parseXml((await zipText(zip, 'ppt/_rels/presentation.xml.rels')) || '<Relationships/>', 'rels');
  const relMap = Object.fromEntries(byLocal(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const slidePaths = byLocal(pres, 'sldId').map((s) => relMap[relId(s)]).filter(Boolean).map((t) => resolvePath('ppt/presentation.xml', t));

  const out = [];
  let idx = 0;
  for (const path of slidePaths) {
    idx++;
    const xml = await zipText(zip, path);
    if (!xml) continue;
    const doc = parseXml(xml, path);
    const tree = firstLocal(doc, 'spTree');
    const shapes = [];
    if (tree) walkShapes(tree, shapes);
    let title = '';
    const body = [];
    for (const s of shapes) {
      if (s.kind === 'sp') {
        const type = placeholderType(s.node);
        const paras = shapeParagraphs(s.node);
        if (!paras.length) continue;
        if ((type === 'title' || type === 'ctrTitle') && !title) { title = paras.map((p) => p.text).join(' ').replace(/\n/g, ' '); continue; }
        const bullets = type === 'body' || type === 'obj' || paras.length > 1;
        for (const p of paras) {
          const txt = p.text.replace(/\n/g, '  \n' + '  '.repeat(p.lvl + 1));
          body.push(bullets ? `${'  '.repeat(p.lvl)}- ${txt}` : txt);
        }
        body.push('');
      } else if (s.kind === 'frame') {
        const tbl = firstLocal(s.node, 'tbl');
        if (tbl) {
          const rows = byLocal(tbl, 'tr').map((tr) => childrenLocal(tr, 'tc').map((tc) => byLocal(tc, 'p').map(paraText).join('\n')));
          body.push(mdTable(rows), '');
        }
      } else if (s.kind === 'pic') {
        const nv = firstLocal(s.node, 'cNvPr');
        const alt = (nv && (nv.getAttribute('descr') || nv.getAttribute('name'))) || '圖片';
        body.push(`![${alt.replace(/[\[\]]/g, '')}]()`, '');
      }
    }
    // 講者備註
    const relPath = path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const sRelXml = await zipText(zip, relPath);
    if (sRelXml) {
      const sRel = parseXml(sRelXml, relPath);
      const notesRel = byLocal(sRel, 'Relationship').find((r) => /notesSlide$/.test(r.getAttribute('Type') || ''));
      if (notesRel) {
        const nPath = resolvePath(path, notesRel.getAttribute('Target'));
        const nXml = await zipText(zip, nPath);
        if (nXml) {
          const nDoc = parseXml(nXml, nPath);
          const notes = byLocal(nDoc, 'sp').filter((sp) => placeholderType(sp) === 'body').flatMap(shapeParagraphs).map((p) => p.text);
          if (notes.length) body.push('> **講者備註（Speaker notes）**', ...notes.map((n) => `> ${n.replace(/\n/g, '\n> ')}`), '');
        }
      }
    }
    out.push(`<!-- 投影片 ${idx} -->\n## ${title || `投影片 ${idx}`}\n\n${body.join('\n').trim()}`);
  }
  return { md: out.join('\n\n') };
}

// ---- EPUB ----
async function convertEpub(buf, opts) {
  const zip = await openZip(buf);
  const container = await zipText(zip, 'META-INF/container.xml');
  if (!container) throw new Error('不是有效的 EPUB 檔案');
  const rootfile = firstLocal(parseXml(container, 'container.xml'), 'rootfile');
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  const opf = parseXml(await zipText(zip, opfPath), opfPath);
  const titleEl = firstLocal(opf, 'title');
  const manifest = Object.fromEntries(byLocal(opf, 'item').map((i) => [i.getAttribute('id'), i.getAttribute('href')]));
  const spine = byLocal(opf, 'itemref').map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const parts = [];
  if (titleEl) parts.push(`# ${titleEl.textContent.trim()}`);
  for (const href of spine) {
    const path = resolvePath(opfPath, decodeURIComponent(href.split('#')[0]));
    const xhtml = await zipText(zip, path);
    if (!xhtml) continue;
    let doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(xhtml, 'text/html');
    const md = htmlDocToMd(doc, false).trim();
    if (md) parts.push(md);
  }
  return { md: parts.join('\n\n---\n\n') };
}

// ---- CSV / TSV ----
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
async function convertCsv(buf, opts, ext) {
  const text = decodeText(buf);
  let delim = ext === 'tsv' ? '\t' : ',';
  if (ext !== 'tsv') {
    const first = text.split(/\r?\n/, 1)[0];
    const counts = { ',': first.split(',').length, ';': first.split(';').length, '\t': first.split('\t').length };
    delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return { md: mdTable(parseDelimited(text, delim)) };
}

async function convertPlain(buf, opts, ext) {
  const text = decodeText(buf);
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return { md: text };
  if (ext === 'json') {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 保留原文 */ }
    return { md: '```json\n' + pretty + '\n```' };
  }
  return { md: '```' + ext + '\n' + text + '\n```' };
}

// ---- PDF（pdf.js，停用 eval、字型載入、XFA、腳本） ----
const CMAP_DATA = JSON.parse(document.getElementById('cmap-data').textContent);
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
class InlineCMapFactory {
  constructor() {}
  async fetch({ name }) {
    const b64 = CMAP_DATA[name];
    if (!b64) throw new Error(`缺少 CMap：${name}`);
    return { cMapData: b64ToBytes(b64), isCompressed: true };
  }
}
class NoStandardFontFactory {
  constructor() {}
  async fetch() { throw new Error('standard fonts disabled'); }
}

let pdfWorkerPort = null;
function getPdfWorker() {
  if (pdfWorkerPort) return pdfWorkerPort;
  const code = new TextDecoder().decode(b64ToBytes(document.getElementById('pdf-worker').textContent.trim()));
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  pdfWorkerPort = new Worker(url, { type: 'module' });
  return pdfWorkerPort;
}

// PDF 常把「人」「工」等字對應成康熙部首（U+2F00–U+2FDF）或部首補充字元，這裡只針對這些字元還原成一般漢字
function fixRadicals(s) {
  return s.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (ch) => ch.normalize('NFKC'));
}

function joinFragments(a, b) {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1], first = b[0];
  if (CJK.test(last) || CJK.test(first)) return a + b;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  return a + ' ' + b;
}

async function convertPdf(buf, opts) {
  const pdfjsLib = globalThis.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerPort = getPdfWorker();
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,     // 防範 CVE-2024-4367 類型的字型 eval 攻擊
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    CMapReaderFactory: InlineCMapFactory,
    StandardFontDataFactory: NoStandardFontFactory,
    cMapUrl: 'inline/',
    cMapPacked: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  try {
    const n = Math.min(pdf.numPages, LIMITS.maxPdfPages);
    const pages = [];
    const sizeHist = new Map();
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => typeof it.str === 'string').map((it) => ({
        str: fixRadicals(it.str), x: it.transform[4], y: it.transform[5], w: it.width,
        size: Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10 || it.height || 10, eol: it.hasEOL,
      }));
      for (const it of items) if (it.str.trim()) sizeHist.set(it.size, (sizeHist.get(it.size) || 0) + it.str.length);
      pages.push(items);
      page.cleanup();
    }
    const bodySize = [...sizeHist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

    const out = [];
    let emptyPages = 0;
    pages.forEach((items, pi) => {
      // 依座標組成行
      const lines = [];
      for (const it of items) {
        if (!it.str) continue;
        let line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.5);
        if (!line) { line = { y: it.y, size: it.size, items: [] }; lines.push(line); }
        line.items.push(it);
        line.size = Math.max(line.size, it.size);
      }
      lines.sort((a, b) => b.y - a.y);
      const textLines = [];
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
        let s = '', prevEnd = null;
        for (const it of l.items) {
          if (prevEnd !== null && it.x - prevEnd > it.size * 0.25 && !/\s$/.test(s) && !(CJK.test(s.slice(-1)) && CJK.test(it.str[0] || ''))) s += ' ';
          s += it.str;
          prevEnd = it.x + it.w;
        }
        s = s.replace(/\s+/g, ' ').trim();
        if (s) textLines.push({ text: s, y: l.y, size: l.size });
      }
      if (!textLines.length) { emptyPages++; out.push(`<!-- 第 ${pi + 1} 頁：無可擷取文字（可能為掃描影像） -->`); return; }
      if (opts.pageMarkers) out.push(`<!-- 第 ${pi + 1} 頁 -->`);

      let para = '';
      const flush = () => { if (para) { out.push(para); para = ''; } };
      textLines.forEach((ln, i) => {
        const prev = textLines[i - 1];
        const ratio = ln.size / bodySize;
        let heading = 0;
        if (ln.text.length < 120) {
          if (ratio >= 1.6) heading = 1; else if (ratio >= 1.3) heading = 2; else if (ratio >= 1.12) heading = 3;
        }
        if (heading) { flush(); out.push(`${'#'.repeat(heading)} ${ln.text}`); return; }
        const bullet = /^([•●▪■◆◦‣∙·]|[-–*])\s*/.exec(ln.text);
        const numbered = /^(\d{1,2}[.)、]|[(（]\d{1,2}[)）]|[一二三四五六七八九十]+[、.])\s*/.test(ln.text);
        const gap = prev ? prev.y - ln.y : 0;
        if (bullet) { flush(); para = `- ${ln.text.slice(bullet[0].length)}`; return; }
        if (numbered) { flush(); para = ln.text; return; }
        if (!para || gap > ln.size * 1.8 || (prev && Math.abs(prev.size - ln.size) > 0.5)) { flush(); para = ln.text; return; }
        para = para.endsWith('-') && /[a-z]$/i.test(para.slice(-2, -1)) ? para.slice(0, -1) + ln.text : joinFragments(para, ln.text);
      });
      flush();
    });
    const warnings = [];
    if (pdf.numPages > n) warnings.push(`僅轉換前 ${n} 頁（共 ${pdf.numPages} 頁）`);
    if (emptyPages) warnings.push(`${emptyPages} 頁沒有文字層，可能是掃描影像，需要另外做 OCR`);
    return { md: out.join('\n\n'), warnings };
  } finally {
    await pdf.destroy();
  }
}

/* ---------------- 分派 ---------------- */
const CONVERTERS = {
  pdf: convertPdf, docx: convertDocx, xlsx: convertXlsx, xlsm: convertXlsx, pptx: convertPptx,
  html: convertHtml, htm: convertHtml, xhtml: convertHtml, epub: convertEpub,
  csv: convertCsv, tsv: convertCsv,
  txt: convertPlain, md: convertPlain, markdown: convertPlain, json: convertPlain, xml: convertPlain,
};
const MAGIC_ZIP = [0x50, 0x4b, 0x03, 0x04];

function sniffMismatch(ext, bytes) {
  const isZip = MAGIC_ZIP.every((b, i) => bytes[i] === b);
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (['docx', 'xlsx', 'xlsm', 'pptx', 'epub'].includes(ext) && !isZip) {
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return '這是舊版 Office 格式（.doc/.xls/.ppt）或已加密的檔案，請先另存為新版格式';
    return '副檔名與實際內容不符';
  }
  if (ext === 'pdf' && !isPdf) return '檔案不是 PDF 格式（副檔名與內容不符）';
  return null;
}

const results = [];

async function handleFiles(fileList) {
  const opts = { keepImages: $('#opt-images').checked, pageMarkers: $('#opt-pages').checked };
  for (const file of fileList) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const card = addCard(file);
    try {
      if (!CONVERTERS[ext]) throw new Error(`不支援 .${ext} 格式`);
      if (file.size > LIMITS.maxFileBytes) throw new Error('檔案超過 100 MB 上限');
      const buf = await file.arrayBuffer();
      const problem = sniffMismatch(ext, new Uint8Array(buf, 0, Math.min(8, buf.byteLength)));
      if (problem) throw new Error(problem);
      const t0 = performance.now();
      const res = await CONVERTERS[ext](buf, opts, ext);
      const md = (res.md || '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      fillCard(card, file, md, res.warnings || [], performance.now() - t0);
    } catch (err) {
      failCard(card, err);
    }
  }
}

function mdName(name) { return name.replace(/\.[^.]+$/, '') + '.md'; }

function addCard(file) {
  $('#empty').hidden = true;
  $('#bulk').hidden = false;
  const card = el('article', { class: 'card' },
    el('header', {},
      el('div', { class: 'fname', text: file.name }),
      el('div', { class: 'meta', text: `${(file.size / 1024).toFixed(1)} KB · 轉換中…` })));
  $('#results').prepend(card);
  return card;
}

function fillCard(card, file, md, warnings, ms) {
  const entry = { name: mdName(file.name), md };
  results.push(entry);
  card.querySelector('.meta').textContent = `${(file.size / 1024).toFixed(1)} KB → ${md.length.toLocaleString()} 字元 · ${Math.round(ms)} ms`;
  const ta = el('textarea', { spellcheck: 'false', 'aria-label': `${file.name} 的 Markdown 結果` });
  ta.value = md; // 只當純文字顯示，不會執行文件內容中的任何 HTML/腳本
  ta.addEventListener('input', () => { entry.md = ta.value; });
  const actions = el('div', { class: 'actions' },
    el('button', { class: 'btn', text: '複製', onclick: (e) => copyText(ta.value, e.currentTarget) }),
    el('button', { class: 'btn save', text: '下載 .md', onclick: (e) => saveFile(entry.name, ta.value, e.currentTarget) }),
    el('button', { class: 'btn ghost', text: '移除', onclick: () => { results.splice(results.indexOf(entry), 1); ta.value = ''; card.remove(); refreshEmpty(); } }));
  card.querySelector('header').append(actions);
  if (warnings.length) card.append(el('div', { class: 'warn', text: '⚠ ' + warnings.join('；') }));
  card.append(ta);
  updateSaveButtons();
}

function failCard(card, err) {
  card.classList.add('error');
  card.querySelector('.meta').textContent = '轉換失敗';
  const msg = String((err && err.message) || err).replace(/^Error:\s*/, '');
  card.append(el('div', { class: 'warn', text: '✗ ' + (/password|encrypt/i.test(msg) ? '檔案受密碼保護，請先解除加密' : msg) }));
  card.append(el('button', { class: 'btn ghost small', text: '移除', onclick: () => { card.remove(); refreshEmpty(); } }));
}

function refreshEmpty() {
  const none = !$('#results').children.length;
  $('#empty').hidden = !none;
  $('#bulk').hidden = none;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, '已複製 ✓');
  } catch {
    flash(btn, '請手動選取複製');
  }
}
function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1600);
}

/* 下載：在 claude.ai 內使用平台的 downloads 能力；離線開啟本檔時改用瀏覽器原生下載 */
let downloadsApi = null;
const inClaudeFrame = (() => { try { return window.top !== window.self; } catch { return true; } })();
function updateSaveButtons() {
  const usable = !!downloadsApi || !inClaudeFrame;
  for (const b of document.querySelectorAll('.save')) b.hidden = !usable;
}
async function saveFile(name, text, btn) {
  if (downloadsApi) {
    try { await downloadsApi.save({ filename: name, data: text }); flash(btn, '已下載 ✓'); }
    catch (e) { flash(btn, e && e.code === 'declined' ? '已取消' : '無法下載，請用複製'); }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
if (window.claude && typeof window.claude.use === 'function') {
  window.claude.use('downloads').then((api) => { downloadsApi = api; updateSaveButtons(); }).catch(() => {});
}

function combined() {
  return results.map((r) => `<!-- 來源：${r.name} -->\n\n${r.md.trim()}`).join('\n\n---\n\n') + '\n';
}

function clearAll() {
  for (const ta of document.querySelectorAll('#results textarea')) ta.value = '';
  results.length = 0;
  $('#results').replaceChildren();
  $('#file').value = '';
  refreshEmpty();
}

/* ---------------- 介面事件 ---------------- */
const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
$('#file').addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));
// 防止檔案拖到頁面其他地方時被瀏覽器直接開啟
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#selftest').addEventListener('click', selfTest);
$('#copy-all').addEventListener('click', (e) => copyText(combined(), e.currentTarget));
$('#save-all').addEventListener('click', (e) => saveFile('合併輸出.md', combined(), e.currentTarget));
$('#clear').addEventListener('click', clearAll);
window.addEventListener('pagehide', clearAll);
updateSaveButtons();
$('#ready').textContent = '就緒';
