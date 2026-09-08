// Deterministic document and webpage extraction. Extractors never call a model,
// execute macros/scripts, or trust embedded instructions. The exact extracted
// snapshot is hashed and stored before the council can cite it.

import crypto from "node:crypto";
import mammoth from "mammoth";
import { load as loadHtml } from "cheerio";

export const DOCUMENT_TYPES = Object.freeze({
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "text/plain",
  markdown: "text/markdown",
  csv: "text/csv"
});

const MAX_TEXT_CHARS = Math.max(50_000, Math.min(2_000_000, Number(process.env.COGNOS_SOURCE_MAX_TEXT_CHARS || 750_000)));
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function cleanText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function assertTextSize(text) {
  if (!text) throw Object.assign(new Error("No readable text was found in this source"), { status: 422 });
  if (text.length > MAX_TEXT_CHARS) {
    throw Object.assign(new Error(`Extracted text exceeds the ${MAX_TEXT_CHARS.toLocaleString()} character safety limit`), { status: 413 });
  }
  return text;
}

function decodeUtf8(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 16_384));
  let controls = 0;
  for (const byte of probe) if (byte === 0 || (byte < 9 || (byte > 13 && byte < 32))) controls++;
  if (probe.includes(0) || (probe.length && controls / probe.length > 0.01)) {
    throw Object.assign(new Error("Document appears to be binary rather than UTF-8 text"), { status: 422 });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw Object.assign(new Error("Text document is not valid UTF-8"), { status: 422 });
  }
}

function extension(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function detectType(name, mediaType, buffer) {
  const ext = extension(name);
  const type = String(mediaType || "").split(";")[0].trim().toLowerCase();
  const pdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]);
  if (pdf || type === DOCUMENT_TYPES.pdf || ext === "pdf") {
    if (!pdf) throw Object.assign(new Error("The file is labeled PDF but does not have a PDF signature"), { status: 422 });
    return { kind: "pdf", mediaType: DOCUMENT_TYPES.pdf };
  }
  if (zip || type === DOCUMENT_TYPES.docx || ext === "docx") {
    if (!zip) throw Object.assign(new Error("The file is labeled DOCX but is not an Office ZIP container"), { status: 422 });
    return { kind: "docx", mediaType: DOCUMENT_TYPES.docx };
  }
  const byExtension = ext === "md" || ext === "markdown" ? "markdown" : ext === "csv" ? "csv" : "text";
  const byType = type === DOCUMENT_TYPES.markdown ? "markdown" : type === DOCUMENT_TYPES.csv ? "csv" : "text";
  const kind = byExtension !== "text" ? byExtension : byType;
  if (!["", "text/plain", "text/markdown", "text/csv", "application/csv", "application/octet-stream"].includes(type)) {
    throw Object.assign(new Error(`Unsupported document media type: ${type || "unknown"}`), { status: 415 });
  }
  return { kind, mediaType: DOCUMENT_TYPES[kind] || DOCUMENT_TYPES.text };
}

async function extractPdf(buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true
  });
  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  const sections = [];
  try {
    for (let page = 1; page <= pageCount; page++) {
      const pdfPage = await document.getPage(page);
      const content = await pdfPage.getTextContent();
      let previousY = null;
      const parts = [];
      for (const item of content.items || []) {
        const value = cleanText(item?.str || "");
        if (!value) continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        if (previousY !== null && y !== null && Math.abs(y - previousY) > 2) parts.push("\n");
        else if (parts.length && parts[parts.length - 1] !== "\n") parts.push(" ");
        parts.push(value);
        previousY = y;
      }
      const text = cleanText(parts.join(""));
      if (text) sections.push({ locator: { page }, text });
      pdfPage.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return { sections, metadata: { pages: pageCount, extractor: "pdfjs-dist" } };
}

function inspectDocxContainer(buffer) {
  let offset = 0;
  let totalUncompressed = 0;
  const names = [];
  while (offset + 46 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) {
      offset++;
      continue;
    }
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw Object.assign(new Error("DOCX central directory is malformed"), { status: 422 });
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    names.push(name);
    totalUncompressed += uncompressed;
    if (uncompressed > 15_000_000 || totalUncompressed > 30_000_000) {
      throw Object.assign(new Error("DOCX expanded contents exceed the archive safety limit"), { status: 413 });
    }
    offset = end;
  }
  if (!names.includes("[Content_Types].xml") || !names.includes("word/document.xml")) {
    throw Object.assign(new Error("Office ZIP is not a valid DOCX document"), { status: 422 });
  }
  if (names.some(name => /(^|\/)vbaProject\.bin$/i.test(name))) {
    throw Object.assign(new Error("Macro-enabled Office content is not accepted"), { status: 415 });
  }
  return { entries: names.length, expandedBytes: totalUncompressed };
}

async function extractDocx(buffer) {
  const archive = inspectDocxContainer(buffer);
  const result = await mammoth.extractRawText({ buffer });
  const text = cleanText(result.value);
  const warnings = (result.messages || []).slice(0, 20).map(message => String(message.message || message).slice(0, 240));
  return {
    sections: text ? [{ locator: { section: 1 }, text }] : [],
    metadata: { extractor: "mammoth", warnings, ...archive }
  };
}

export async function extractDocument({ name, mediaType, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("Document data is empty"), { status: 400 });
  }
  const detected = detectType(name, mediaType, buffer);
  let extracted;
  if (detected.kind === "pdf") extracted = await extractPdf(buffer);
  else if (detected.kind === "docx") extracted = await extractDocx(buffer);
  else {
    const text = cleanText(decodeUtf8(buffer));
    extracted = {
      sections: text ? [{ locator: { section: 1, line: 1 }, text }] : [],
      metadata: { extractor: "utf8", format: detected.kind }
    };
  }
  const text = assertTextSize(cleanText(extracted.sections.map(section => section.text).join("\n\n")));
  return {
    text,
    sections: extracted.sections,
    mediaType: detected.mediaType,
    extraction: { ...extracted.metadata, characters: text.length }
  };
}

export function extractHtml(buffer, mediaType = "text/html") {
  const html = decodeUtf8(buffer);
  const $ = loadHtml(html, { xmlMode: /xhtml|xml/.test(mediaType) });
  $("script,style,noscript,template,svg,canvas,iframe,object,embed,form").remove();
  const title = cleanText($("title").first().text()) || null;
  const description = cleanText($("meta[name='description']").attr("content") || "") || null;
  const root = $("main").first().length ? $("main").first()
    : $("article").first().length ? $("article").first()
      : $("body").first();
  root.find("br").replaceWith("\n");
  root.find("p,div,section,article,header,footer,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre").each((_, element) => {
    $(element).prepend("\n").append("\n");
  });
  const text = assertTextSize(cleanText(root.text()));
  return {
    text,
    sections: [{ locator: { section: 1 }, text }],
    title,
    description,
    extraction: { extractor: "cheerio", characters: text.length }
  };
}

export function detectPromptInjection(text) {
  const checks = [
    ["instruction_override", /\b(ignore|disregard|forget)\b.{0,50}\b(previous|prior|system|developer|above)\b.{0,30}\binstructions?\b/is],
    ["system_prompt_request", /\b(reveal|print|show|repeat|expose)\b.{0,40}\b(system|developer)\s+prompt\b/is],
    ["role_impersonation", /\b(system|assistant|developer)\s*:\s*(you|ignore|must|execute)\b/is],
    ["tool_coercion", /\b(call|invoke|execute|run)\b.{0,40}\b(tool|shell|command|function)\b/is],
    ["credential_request", /\b(send|upload|exfiltrate|reveal|return)\b.{0,60}\b(secret|credential|api key|token|password)\b/is]
  ];
  return checks.filter(([, pattern]) => pattern.test(String(text || ""))).map(([name]) => name);
}
