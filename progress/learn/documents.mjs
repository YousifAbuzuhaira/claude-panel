// Documents a course can be built from: PDF, Word (.docx), Markdown, plain text and saved HTML.
// Each comes out as sections like a web page's ({ heading, anchor, level, text }), so the
// outline and the pages use them the same way and cite them as [sec: Heading].
//   PDF:   pypdf (deps.mjs fetches it) gives each page's text and the bookmarks; bookmarks
//          become sections ("Failover (p. 12)"), or runs of three pages without them. When many
//          pages have no usable text (a scan), Claude reads those pages (its Read tool), ten
//          pages at a time, from small PDFs pypdf cuts out.
//   .docx: a small zip reader (zlib is part of Node) opens word/document.xml; Heading styles
//          become sections, tables become rows of | cells |.
// The parsing is pure and exported for the tests; readDocument does the file work.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { askStructured } from './claude.mjs';
import { ensurePypdf, pythonArgv } from './deps.mjs';
import { decodeEntities, htmlToSections, textToSections } from './sources.mjs';

export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const SECTION_CHARS = 25_000; // a longer section is cut into parts, at paragraph or page ends
const CLAUDE_BATCH = 10; // pages per Read: whole small PDFs need no poppler
const CLAUDE_MAX_PAGES = 60;

const TYPES = { '.pdf': 'PDF', '.docx': 'Word', '.md': 'Markdown', '.markdown': 'Markdown', '.txt': 'Text', '.text': 'Text', '.html': 'HTML', '.htm': 'HTML' };
export const DOCUMENT_EXTENSIONS = Object.keys(TYPES);

/** 'PDF', 'Word', 'Markdown', 'Text' or 'HTML' for a file name; null for anything else. */
export const documentType = name => TYPES[extname(String(name || '')).toLowerCase()] || null;

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- Sections, whatever they came from ------------------------------------------------------------

/** Headings made unique (a citation names one section), anchors filled in. */
export function uniqueHeadings(sections) {
  const seen = new Map();
  return sections.map(section => {
    const base = String(section.heading || 'Section').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Section';
    const count = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), count);
    const heading = count > 1 ? `${base} (${count})` : base;
    return { heading, anchor: section.anchor || slug(heading), level: section.level || 1, text: section.text };
  });
}

/** A brief's sections with fixes in: a fix with a heading already there replaces that section's text; a new heading is added at the end. */
export function mergeSections(sections, fixes) {
  const key = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = sections.map(section => ({ ...section }));
  for (const fix of fixes || []) {
    const heading = String(fix?.heading ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const text = String(fix?.text ?? '').trim().slice(0, 40_000);
    if (!key(heading) || !text) continue;
    const found = out.find(section => key(section.heading) === key(heading));
    if (found) found.text = text;
    else out.push({ heading, level: 1, text });
  }
  return out;
}

/** Sections longer than `max` cut into parts at paragraph ends: "Heading (part 2)". */
export function cutLongSections(sections, max = SECTION_CHARS) {
  const out = [];
  for (const section of sections) {
    const text = String(section.text || '');
    if (text.length <= max) {
      out.push(section);
      continue;
    }
    const parts = [];
    let current = '';
    for (const paragraph of text.split(/\n(?=\s*\n)|\n/)) {
      if (current && current.length + paragraph.length + 1 > max) {
        parts.push(current);
        current = '';
      }
      // A single paragraph longer than the limit is cut where it must be.
      let rest = paragraph;
      while (rest.length > max) {
        if (current) { parts.push(current); current = ''; }
        parts.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      current = current ? `${current}\n${rest}` : rest;
    }
    if (current.trim()) parts.push(current);
    const alone = sections.length === 1 && section.heading === 'Introduction';
    parts.forEach((part, i) => out.push({ ...section, heading: alone ? `Part ${i + 1}` : `${section.heading} (part ${i + 1})`, anchor: '', text: part.trim() }));
  }
  return out;
}

const finish = sections => uniqueHeadings(cutLongSections(sections.filter(section => String(section.text || '').trim())));

// --- Zip and Word -------------------------------------------------------------------------------------

/** A zip's entries by name, each read (and inflated) when called. No zip64, no encryption. */
export function readZip(buffer) {
  const buf = Buffer.from(buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (at === 0xffffffff) throw new Error('this zip is too large (zip64)');
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip directory is broken');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`the zip entry ${name} is broken`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      // A cap, so a zip bomb can't fill the memory.
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 });
      throw new Error(`zip compression ${method} is not supported`);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const xmlText = text => decodeEntities(String(text));

/** The text of a run of Word XML: its <w:t>s, tabs and breaks. */
function runsText(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) out += xmlText(m[1]);
    else out += m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return out;
}

const paragraphsOf = xml => [...xml.matchAll(/<w:p\b(?:[^>]*\/>|[^>]*>([\s\S]*?)<\/w:p>)/g)].map(m => m[1] || '');

/** A .docx as `{ title, sections }`: Heading 1-6 (by style name or outline level) start sections. */
export function docxToSections(buffer, fallbackTitle = '') {
  const zip = readZip(buffer);
  const documentXml = zip.get('word/document.xml');
  if (!documentXml) throw new Error('this is not a Word document (it has no word/document.xml)');
  let xml = documentXml().toString('utf8');
  const stylesXml = zip.get('word/styles.xml') ? zip.get('word/styles.xml')().toString('utf8') : '';
  const levels = new Map(); // style id -> 0 (the title) or 1-6
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = (/<w:name w:val="([^"]+)"/.exec(m[2]) || [])[1] || '';
    const heading = /^heading\s*(\d)$/i.exec(name);
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[2]);
    if (/^title$/i.test(name)) levels.set(m[1], 0);
    else if (heading) levels.set(m[1], Math.min(6, Number(heading[1])));
    else if (outline && Number(outline[1]) < 6) levels.set(m[1], Number(outline[1]) + 1);
  }
  // A table row becomes one paragraph of | cells |.
  xml = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, row => {
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => paragraphsOf(cell[0]).map(runsText).join(' ').replace(/\s+/g, ' ').replace(/\|/g, '/').trim());
    const line = `| ${cells.join(' | ')} |`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`;
  });
  const core = zip.get('docProps/core.xml') ? zip.get('docProps/core.xml')().toString('utf8') : '';
  let title = xmlText((/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core) || [])[1] || '').trim();
  const sections = [{ heading: 'Introduction', level: 1, lines: [] }];
  for (const inner of paragraphsOf(xml)) {
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(inner) || [])[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(inner);
    let level = style && levels.has(style) ? levels.get(style) : style && /^Heading(\d)$/i.test(style) ? Number(/(\d)$/.exec(style)[1]) : style === 'Title' ? 0 : null;
    if (level === null && outline && Number(outline[1]) < 6) level = Number(outline[1]) + 1;
    const text = runsText(inner).replace(/[ \t]+$/gm, '').trim();
    if (!text) continue;
    if (level === 0) {
      if (!title) title = text.replace(/\s+/g, ' ');
      continue;
    }
    if (level) {
      sections.push({ heading: text.replace(/\s+/g, ' '), level, lines: [] });
      continue;
    }
    sections.at(-1).lines.push(/<w:numPr>/.test(inner) ? `- ${text}` : text);
  }
  const shaped = sections.map(section => ({ heading: section.heading, level: section.level, text: section.lines.join('\n') }));
  return { title: title || shaped.find((section, i) => i > 0 && section.heading)?.heading || fallbackTitle, sections: finish(shaped) };
}

// --- PDF -------------------------------------------------------------------------------------------

/** Run with `python3 -I -c PDF_SCRIPT <pypdf wheel> <pdf>`: prints the pages' text and the bookmarks as JSON. */
export const PDF_SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from pypdf import PdfReader
out = {"pages": [], "outline": [], "title": "", "error": None}
try:
    reader = PdfReader(sys.argv[2])
    if reader.is_encrypted:
        try:
            ok = reader.decrypt("")
        except Exception:
            ok = 0
        if not ok:
            sys.stdout.write(json.dumps({"error": "locked"}))
            sys.exit(0)
    try:
        meta = reader.metadata
        out["title"] = str(meta.title or "") if meta else ""
    except Exception:
        pass
    for page in reader.pages:
        try:
            out["pages"].append(page.extract_text() or "")
        except Exception:
            out["pages"].append("")
    def walk(items, level):
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
                continue
            try:
                out["outline"].append({"title": str(item.title), "page": reader.get_destination_page_number(item), "level": level})
            except Exception:
                pass
    try:
        walk(reader.outline, 0)
    except Exception:
        pass
except Exception as error:
    out = {"error": str(error)[:300]}
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`;

/** Run with `python3 -I -c SPLIT_SCRIPT <wheel> <pdf> <out.pdf> <page,page,...>` (0-based). */
export const SPLIT_SCRIPT = `
import sys
sys.path.insert(0, sys.argv[1])
from pypdf import PdfReader, PdfWriter
reader = PdfReader(sys.argv[2])
writer = PdfWriter()
for n in sys.argv[4].split(","):
    writer.add_page(reader.pages[int(n)])
writer.write(sys.argv[3])
`;

/** A page whose text layer is missing or broken: little text, mostly not words, or words run together. */
export function pageIsJunk(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length < 80) return true;
  const solid = flat.replace(/ /g, '').length;
  const letters = (flat.match(/\p{L}/gu) || []).length;
  const words = flat.match(/\p{L}{2,}/gu) || [];
  const runTogether = words.filter(word => word.length > 25).length;
  return letters / solid < 0.45 || runTogether > Math.max(2, words.length * 0.15);
}

/**
 * The pages to hand to Claude: none when only a few scattered pages are empty (a cover, a
 * figure, a blank page), the junk ones when they are a real share of the document.
 */
export function pagesForClaude(pages) {
  const junk = pages.map((text, i) => (pageIsJunk(text) ? i : -1)).filter(i => i >= 0);
  if (!junk.length) return [];
  if (pages.length <= CLAUDE_BATCH || junk.length / pages.length >= 0.15) return junk;
  return [];
}

const pageLabel = (from, to) => (from === to ? `p. ${from + 1}` : `pp. ${from + 1}-${to + 1}`);

/** A PDF's pages as sections: by its top two levels of bookmarks, else three pages at a time. */
export function pdfSections(pages, outline = []) {
  const total = pages.length;
  const marks = [];
  for (const item of [...(outline || [])].filter(item => item && item.level <= 1 && Number.isInteger(item.page) && item.page >= 0 && item.page < total && String(item.title || '').trim()).sort((p, q) => p.page - q.page || p.level - q.level)) {
    if (!marks.length || marks.at(-1).page !== item.page) marks.push(item);
  }
  const spans = [];
  if (marks.length >= 2 || (marks.length === 1 && marks[0].page > 0)) {
    if (marks[0].page > 0) spans.push({ heading: 'Front matter', from: 0, to: marks[0].page - 1, level: 1, front: true });
    marks.forEach((mark, i) => spans.push({ heading: String(mark.title).replace(/\s+/g, ' ').trim(), from: mark.page, to: (marks[i + 1]?.page ?? total) - 1, level: mark.level + 1 }));
  } else {
    for (let page = 0; page < total; page += 3) spans.push({ heading: null, from: page, to: Math.min(total, page + 3) - 1, level: 1 });
  }
  const sections = [];
  for (const span of spans) {
    let start = span.from;
    let texts = [];
    let size = 0;
    const emit = to => {
      const text = texts.join('\n\n').trim();
      if (!text || (span.front && text.length < 300)) return;
      const label = pageLabel(start, to);
      const pagesName = start === to ? `Page ${start + 1}` : `Pages ${start + 1}-${to + 1}`;
      sections.push({ heading: span.heading ? `${span.heading} (${label})` : pagesName, level: span.level, text });
    };
    for (let page = span.from; page <= span.to; page++) {
      const text = String(pages[page] || '').trim();
      if (size + text.length > SECTION_CHARS && texts.length) {
        emit(page - 1);
        start = page;
        texts = [];
        size = 0;
      }
      texts.push(text);
      size += text.length;
    }
    emit(span.to);
  }
  return uniqueHeadings(cutLongSections(sections));
}

const PAGES_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer', description: 'The page number given for it' }, text: { type: 'string', description: "The page's text" } },
        required: ['n', 'text'],
      },
    },
  },
  required: ['pages'],
};

function runPython(script, args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const [command, ...first] = pythonArgv() ?? ['python3'];
    execFile(command, [...first, '-I', '-c', script, ...args], { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split('\n').pop().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

export const documentIo = { ensurePypdf, runPython, askStructured };

/** The given pages (0-based) read by Claude, ten at a time, from small PDFs cut out by pypdf. */
async function readPagesWithClaude(file, wanted, wheel, { io, model, onProgress, onRateLimit }) {
  const work = mkdtempSync(join(tmpdir(), 'learn-pdf-'));
  const found = new Map();
  try {
    for (let i = 0; i < wanted.length; i += CLAUDE_BATCH) {
      const batch = wanted.slice(i, i + CLAUDE_BATCH);
      onProgress(`Reading pages without text ${i + 1}-${i + batch.length} of ${wanted.length} with Claude`);
      const part = join(work, `part-${i / CLAUDE_BATCH + 1}.pdf`);
      await io.runPython(SPLIT_SCRIPT, [wheel, file, part, batch.join(',')]);
      const numbers = batch.map(n => n + 1);
      const answer = await io.askStructured({
        prompt: [
          `Read the file ${basename(part)} with the Read tool: the whole file at once, without a page range.`,
          `It holds ${batch.length} pages of a longer document, in order: pages ${numbers.join(', ')} of the original.`,
          "Write out each page's text faithfully, in reading order. Keep headings, lists and code; tables as Markdown tables; a figure as one line [figure: what it shows]. Don't summarise or add anything.",
          'Give each page with n set to its original page number from the list above.',
        ].join('\n'),
        schema: PAGES_SCHEMA,
        tools: ['Read'],
        model,
        cwd: work,
        onRateLimit,
      });
      for (const page of answer.pages || []) {
        const n = Number(page.n) - 1;
        if (batch.includes(n) && typeof page.text === 'string') found.set(n, page.text);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return found;
}

async function readPdf(file, { io, model, onProgress, onRateLimit, fallbackTitle }) {
  const wheel = await io.ensurePypdf({ onProgress });
  onProgress('Reading the PDF');
  let data;
  try {
    data = JSON.parse(await io.runPython(PDF_SCRIPT, [wheel, file]));
  } catch (error) {
    throw new Error(`the PDF could not be read: ${error.message}`);
  }
  if (data.error === 'locked') throw new Error('this PDF is locked with a password');
  if (data.error) throw new Error(`the PDF could not be read: ${data.error}`);
  const pages = (data.pages || []).map(String);
  if (!pages.length) throw new Error('this PDF has no pages');
  const wanted = pagesForClaude(pages);
  if (wanted.length > CLAUDE_MAX_PAGES) {
    throw new Error(`${wanted.length} of its ${pages.length} pages have no text to read (a scan?), and Learn reads at most ${CLAUDE_MAX_PAGES} such pages with Claude. A version with a text layer, or a part of it, would work.`);
  }
  let byClaude = 0;
  if (wanted.length) {
    const found = await readPagesWithClaude(file, wanted, wheel, { io, model, onProgress, onRateLimit });
    for (const [n, text] of found) pages[n] = text;
    byClaude = found.size;
  }
  const sections = pdfSections(pages, data.outline || []);
  if (!sections.length) throw new Error('no text could be read from this PDF');
  const title = String(data.title || '').trim();
  return { type: 'PDF', title: title && !/^untitled|^microsoft word/i.test(title) ? title : fallbackTitle, pages: pages.length, byClaude, sections };
}

/**
 * Reads a document into `{ type, title, pages?, byClaude?, sections }`, or throws an error that
 * says plainly why not. `name` is the file's own name (an upload's path has none).
 */
export async function readDocument(file, { name = basename(file), io = documentIo, model = 'sonnet', onProgress = () => {}, onRateLimit } = {}) {
  const type = documentType(name);
  if (!type) throw new Error(`Learn reads PDF, Word (.docx), Markdown, text and HTML files, not ${extname(name) || 'a file with no extension'}`);
  const size = statSync(file).size;
  if (!size) throw new Error('the file is empty');
  if (size > MAX_DOCUMENT_BYTES) throw new Error(`the file is ${Math.round(size / 1048576)} MB; Learn reads documents up to ${MAX_DOCUMENT_BYTES / 1048576} MB`);
  const fallbackTitle = basename(name, extname(name)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
  let result;
  if (type === 'PDF') {
    result = await readPdf(file, { io, model, onProgress, onRateLimit, fallbackTitle });
  } else if (type === 'Word') {
    const read = docxToSections(readFileSync(file), fallbackTitle);
    result = { type, title: read.title || fallbackTitle, sections: read.sections };
  } else if (type === 'HTML') {
    const read = htmlToSections(readFileSync(file, 'utf8'));
    result = { type, title: read.title || fallbackTitle, sections: finish(read.sections) };
  } else {
    const read = textToSections(readFileSync(file, 'utf8'), fallbackTitle, Infinity);
    result = { type, title: read.title || fallbackTitle, sections: finish(read.sections) };
  }
  const chars = result.sections.reduce((total, section) => total + section.text.length, 0);
  if (chars < 300) throw new Error('the document has almost no text to build a course from');
  return { ...result, chars };
}
