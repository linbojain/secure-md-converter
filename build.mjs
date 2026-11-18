import fs from 'node:fs';
import path from 'node:path';
const nm = 'node_modules';
const read = (p) => fs.readFileSync(p, 'utf8');
const safe = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\x21--');

const cmapDir = path.join(nm, 'pdfjs-dist/cmaps');
const cmaps = {};
for (const f of fs.readdirSync(cmapDir)) if (f.endsWith('.bcmap')) cmaps[f.replace(/\.bcmap$/, '')] = fs.readFileSync(path.join(cmapDir, f)).toString('base64');

const parts = {
  __CMAPS__: JSON.stringify(cmaps),
  __PDFWORKER__: fs.readFileSync(path.join(nm, 'pdfjs-dist/build/pdf.worker.min.mjs')).toString('base64'),
  __JSZIP__: safe(read(path.join(nm, 'jszip/dist/jszip.min.js'))),
  __MAMMOTH__: safe(read(path.join(nm, 'mammoth/mammoth.browser.min.js'))),
  __TURNDOWN__: safe(read(path.join(nm, 'turndown/lib/turndown.browser.umd.js'))),
  __GFM__: safe(read(path.join(nm, 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js'))),
  __PDFJS__: safe(read(path.join(nm, 'pdfjs-dist/build/pdf.min.mjs'))),
  __APP__: safe(read('src/app.js')),
};
let html = read('src/template.html');
for (const [k, v] of Object.entries(parts)) html = html.split(k).join(v);
fs.writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024 / 1024).toFixed(2), 'MB');
