// Deterministic image identification for governed evidence ingestion.
//
// This module never decodes pixels and never calls a model. It validates the
// file container (magic bytes + structural header fields) and reads only the
// immutable facts COGNOS records about every image original: format, byte
// size, pixel dimensions, and the SHA-256 of the raw bytes. Everything the
// model later "reads" in an image lives in a separately-labeled vision
// analysis, so observed facts and interpretations never share a record.

export const IMAGE_MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
});

export const IMAGE_FORMATS = Object.freeze(new Set(Object.keys(IMAGE_MEDIA_TYPES)));

/** Canonical base64 decode (the browser upload transport). */
export function decodeBase64(value) {
  const encoded = String(value || "").trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw Object.assign(new Error("Image body must be canonical base64"), { status: 400 });
  }
  return Buffer.from(encoded, "base64");
}

function u16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function u32be(buffer, offset) {
  return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function u32le(buffer, offset) {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}

function bad(reason) {
  return Object.assign(new Error(reason), { status: 422 });
}

function parsePng(buffer) {
  // Signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR as the first chunk.
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw bad("The file is labeled PNG but has no PNG signature");
  if (buffer.length < 33) throw bad("PNG file is truncated");
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") throw bad("PNG file has no IHDR header");
  if (u32be(buffer, 8) !== 13) throw bad("PNG IHDR chunk is malformed");
  // IEND must terminate the container; tolerate nothing between its header and EOF.
  const tail = buffer.subarray(Math.max(0, buffer.length - 12));
  if (tail.subarray(4, 8).toString("ascii") !== "IEND") throw bad("PNG file is truncated or corrupted (no IEND chunk)");
  return { format: "png", mediaType: IMAGE_MEDIA_TYPES.png, width: u32be(buffer, 16), height: u32be(buffer, 20) };
}

// JPEG dimension scan: walk APP/COM/DQT/DHT segments until an SOF marker
// (C0–CF except C4, C8, CC), bounded so a hostile header cannot make the scan
// walk the whole file.
function parseJpeg(buffer) {
  if (u16(buffer, 0) !== 0xffd8) throw bad("The file is labeled JPEG but has no JPEG signature");
  // EOI marker must exist within the final bytes of the container.
  const tailStart = Math.max(0, buffer.length - 4096);
  const tail = buffer.subarray(tailStart);
  let eoiAt = -1;
  for (let i = 0; i + 1 < tail.length; i++) {
    if (tail[i] === 0xff && tail[i + 1] === 0xd9) { eoiAt = tailStart + i; break; }
  }
  if (eoiAt < 0) throw bad("JPEG file is truncated or corrupted (no end-of-image marker)");

  let offset = 2;
  const limit = Math.min(buffer.length, 128 * 1024);
  while (offset + 4 <= limit) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan: dimensions must precede
    if (offset + 2 > limit) break;
    const length = u16(buffer, offset + 2);
    if (length < 2) throw bad("JPEG segment length is malformed");
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buffer.length) throw bad("JPEG frame header is truncated");
      return { format: "jpeg", mediaType: IMAGE_MEDIA_TYPES.jpeg, height: u16(buffer, offset + 5), width: u16(buffer, offset + 7) };
    }
    offset += 2 + length;
  }
  throw bad("JPEG file has no readable frame header");
}

function parseWebp(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw bad("The file is labeled WebP but has no RIFF/WEBP signature");
  }
  const declared = u32le(buffer, 4);
  if (declared > buffer.length - 8) throw bad("WebP RIFF size exceeds the uploaded bytes");
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    if (buffer.length < 30) throw bad("WebP VP8X header is truncated");
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { format: "webp", mediaType: IMAGE_MEDIA_TYPES.webp, width, height };
  }
  if (chunk === "VP8L") {
    if (buffer.length < 25) throw bad("WebP lossless header is truncated");
    const packed = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    return {
      format: "webp", mediaType: IMAGE_MEDIA_TYPES.webp,
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1
    };
  }
  if (chunk === "VP8 ") {
    if (buffer.length < 30) throw bad("WebP lossy header is truncated");
    const frameTag = u32le(buffer, 20);
    const keyFrame = frameTag & 0x01;
    if (!keyFrame) throw bad("WebP lossy file does not start with a key frame");
    const width = u16(buffer, 26) & 0x3fff;
    const height = u16(buffer, 28) & 0x3fff;
    if (!width || !height) throw bad("WebP frame header is malformed");
    return { format: "webp", mediaType: IMAGE_MEDIA_TYPES.webp, width, height };
  }
  throw bad("WebP container has no supported bitstream (VP8 / VP8L / VP8X)");
}

/**
 * Deterministic identification of PNG/JPEG/WebP originals.
 * @returns {{format, mediaType, width, height}} or throws 422 on rejection.
 */
export function parseImage(buffer, { mediaType = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("Image data is empty"), { status: 400 });
  }
  const declared = String(mediaType || "").split(";")[0].trim().toLowerCase();
  const bySignature =
    buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "png"
      : buffer.subarray(0, 2).toString("hex") === "ffd8" ? "jpeg"
        : buffer.subarray(0, 4).toString("ascii") === "RIFF" ? "webp" : null;
  // A signature always wins over a browser label, and a label cannot admit a
  // file whose signature is absent — the parser validates the container.
  const target = bySignature || (IMAGE_MEDIA_TYPES[declared] ? declared.replace("image/", "") : null);
  if (!target) {
    throw bad("Only PNG, JPEG, and WebP images are accepted (the file has none of those signatures)");
  }
  if (!IMAGE_FORMATS.has(target)) throw bad(`Unsupported image media type: ${declared || "unknown"}`);
  const parsed = target === "png" ? parsePng(buffer) : target === "jpeg" ? parseJpeg(buffer) : parseWebp(buffer);
  if (!Number.isInteger(parsed.width) || !Number.isInteger(parsed.height) || parsed.width < 1 || parsed.height < 1
    || parsed.width > 40000 || parsed.height > 40000) {
    throw bad("Image dimensions are unreadable or out of range");
  }
  return parsed;
}
