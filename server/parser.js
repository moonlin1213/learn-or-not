// 文档解析：pdf / epub / docx / md / txt → 纯文本（带结构标记）
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export function detectFormat(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  const map = { pdf: 'pdf', epub: 'epub', docx: 'docx', md: 'md', markdown: 'md', txt: 'txt' };
  if (!map[ext]) throw new Error(`不支持的格式: .${ext}（支持 pdf/epub/docx/md/txt）`);
  return map[ext];
}

export async function parseDocument(filePath, format) {
  switch (format) {
    case 'pdf': return parsePdf(filePath);
    case 'epub': return parseEpub(filePath);
    case 'docx': return parseDocx(filePath);
    case 'md':
    case 'txt': return fs.readFileSync(filePath, 'utf8');
    default: throw new Error(`未知格式: ${format}`);
  }
}

async function parsePdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const res = await pdfParse(buf);
  return cleanText(res.text || '');
}

async function parseDocx(filePath) {
  const res = await mammoth.extractRawText({ path: filePath });
  return cleanText(res.value || '');
}

function parseEpub(filePath) {
  const zip = new AdmZip(filePath);
  const readEntry = (name) => {
    const e = zip.getEntry(name);
    return e ? e.getData().toString('utf8') : null;
  };
  // 1. container.xml → opf 路径
  const container = readEntry('META-INF/container.xml');
  if (!container) throw new Error('EPUB 缺少 container.xml');
  const c = xml.parse(container);
  const rootfiles = c?.container?.rootfiles?.rootfile;
  const rf = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const opfPath = rf?.['@_full-path'];
  if (!opfPath) throw new Error('EPUB 无法定位 OPF');
  const opfDir = path.posix.dirname(opfPath);
  const opf = xml.parse(readEntry(opfPath));
  const pkg = opf?.package;
  if (!pkg) throw new Error('EPUB OPF 解析失败');

  // 2. manifest: id → href
  const manifestItems = Array.isArray(pkg.manifest?.item) ? pkg.manifest.item : [pkg.manifest?.item].filter(Boolean);
  const idToHref = {};
  for (const it of manifestItems) if (it?.['@_id'] && it?.['@_href']) idToHref[it['@_id']] = it['@_href'];

  // 3. spine 顺序
  const spineRefs = Array.isArray(pkg.spine?.itemref) ? pkg.spine.itemref : [pkg.spine?.itemref].filter(Boolean);
  const parts = [];
  for (const ref of spineRefs) {
    const href = idToHref[ref?.['@_idref']];
    if (!href) continue;
    const full = opfDir === '.' ? href : `${opfDir}/${href}`;
    const html = readEntry(decodeURIComponent(full));
    if (!html) continue;
    const text = htmlToText(html);
    if (text.trim().length > 30) parts.push(text);
  }
  if (!parts.length) throw new Error('EPUB 未提取到正文');
  return cleanText(parts.join('\n\n'));
}

function htmlToText(html) {
  // 提取标题做结构标记，再 strip 标签
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, t) => `\n\n${'#'.repeat(Number(lv))} ${stripTags(t)}\n\n`)
    .replace(/<\/(p|div|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return stripTags(s);
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function cleanText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
