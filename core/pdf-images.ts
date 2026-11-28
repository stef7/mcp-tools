/**
 * The pictures inside a PDF, as images a model can look at.
 *
 * A scanned document has no text layer: each page is one picture, and text extraction finds
 * nothing. Those pictures are usually stored as plain JPEG (DCTDecode), which is passed through
 * as it is, or as raw pixels compressed with Flate, which become a PNG. Nothing is rendered, so
 * a page drawn with text and vector graphics is not an image here; only embedded pictures are.
 *
 * Deliberately small: it reads image XObjects the way they are written in almost every scanner's
 * output, without a full PDF parser. What it cannot turn into JPEG or PNG (JPEG 2000, CCITT fax,
 * JBIG2, CMYK, indexed colour, encrypted files) is reported, not guessed at.
 */

export type PdfImage = {
  /** 1-based, in the order the images are stored, which for a scan is page order. */
  index: number;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
  width: number;
  height: number;
};

export type PdfImages = {
  images: PdfImage[];
  /** One line per image that could not be turned into JPEG or PNG, and why. */
  skipped: string[];
  /** Image XObjects found, including the skipped and the too small. */
  found: number;
};

export type PdfImageOptions = {
  /** Ignore images smaller than this on either side: logos, rules, signature crops. Default 64. */
  minSide?: number;
  /** Shrink raw-pixel images wider than this, by a whole factor. Default 2000. JPEGs pass as is. */
  maxWidth?: number;
};

const latin1 = new TextDecoder("latin1");

/** The value of `/Key` in a dictionary: a name, number, array, nested dictionary or reference. */
const entry = (dict: string, key: string): string | undefined => {
  const at = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(dict);
  if (!at) return undefined;
  const rest = dict.slice(at.index + at[0].length);
  if (rest.startsWith("<<")) {
    let depth = 0;
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest.startsWith("<<", i)) (depth++, i++);
      else if (rest.startsWith(">>", i)) {
        depth--;
        i++;
        if (depth === 0) return rest.slice(0, i + 1);
      }
    }
    return rest;
  }
  if (rest.startsWith("[")) return rest.slice(0, rest.indexOf("]") + 1);
  const ref = /^(\d+)\s+(\d+)\s+R/.exec(rest);
  if (ref) return ref[0];
  return /^[^\s/<>[\]()]+|^\/[^\s/<>[\]()]+/.exec(rest)?.[0];
};

/** What a `12 0 R` reference points at, when it is a plain number or name. */
const resolver = (text: string) => (v: string | undefined) => {
  const ref = v && /^(\d+)\s+(\d+)\s+R$/.exec(v);
  if (!ref) return v;
  const obj = new RegExp(
    `(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\s*([^\\s][\\s\\S]*?)\\s*endobj`,
  ).exec(text);
  return obj?.[1]?.trim();
};

/** Each stream's dictionary and where its bytes start. */
const streams = function* (text: string) {
  const keyword = /stream(\r\n|\n|\r)/g;
  for (let m = keyword.exec(text); m; m = keyword.exec(text)) {
    if (text.slice(m.index - 3, m.index).endsWith("end")) continue;
    // Walk back from the `>>` before `stream` to its matching `<<`, a pair at a time.
    let end = text.lastIndexOf(">>", m.index);
    if (end < 0 || /\S/.test(text.slice(end + 2, m.index))) continue;
    let depth = 0;
    let start = -1;
    for (let j = end; j >= 0;) {
      if (text.startsWith(">>", j)) {
        depth++;
        j -= 2;
      } else if (text.startsWith("<<", j)) {
        depth--;
        if (depth === 0) {
          start = j;
          break;
        }
        j -= 2;
      } else j -= 1;
    }
    if (start < 0) continue;
    end += 2;
    yield { dict: text.slice(start, end), dataStart: m.index + m[0].length };
  }
};

const inflate = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
const deflate = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (parts: Uint8Array[]) => {
  let c = 0xffffffff;
  for (const p of parts) for (const b of p) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, body: Uint8Array) => {
  const t = new TextEncoder().encode(type);
  return [u32(body.length), t, body, u32(crc32([t, body]))];
};
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

/** A PNG from rows that already carry PNG's filter byte, zlib-compressed. */
export const png = (
  width: number,
  height: number,
  depth: number,
  colour: 0 | 2,
  idat: Uint8Array,
) =>
  concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunk("IHDR", concat([u32(width), u32(height), new Uint8Array([depth, colour, 0, 0, 0])])),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array()),
  ]);

/** Raw pixel rows, without filter bytes, as PNG scanlines; shrunk by `step` when 8-bit. */
const scanlines = (
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bpc: number,
  step: number,
) => {
  const rowBytes = Math.ceil((width * channels * bpc) / 8);
  const w = step > 1 ? Math.floor(width / step) : width;
  const h = step > 1 ? Math.floor(height / step) : height;
  const outRow = Math.ceil((w * channels * bpc) / 8);
  const out = new Uint8Array(h * (outRow + 1));
  for (let y = 0; y < h; y++) {
    const src = y * step * rowBytes;
    const dst = y * (outRow + 1);
    out[dst] = 0;
    if (step === 1) out.set(raw.subarray(src, src + rowBytes), dst + 1);
    else
      for (let x = 0; x < w; x++)
        for (let c = 0; c < channels; c++)
          out[dst + 1 + x * channels + c] = raw[src + x * step * channels + c] ?? 0;
  }
  return { rows: out, width: w, height: h };
};

const COLOURS: Record<string, { channels: number; png: 0 | 2 }> = {
  "/DeviceGray": { channels: 1, png: 0 },
  "/CalGray": { channels: 1, png: 0 },
  "/DeviceRGB": { channels: 3, png: 2 },
  "/CalRGB": { channels: 3, png: 2 },
};

/** The embedded pictures of `pdf`, as JPEG and PNG, in stored order. */
export const pdfImages = async (pdf: Uint8Array, o: PdfImageOptions = {}): Promise<PdfImages> => {
  const minSide = o.minSide ?? 64;
  const maxWidth = o.maxWidth ?? 2000;
  const text = latin1.decode(pdf);
  if (/\/Encrypt\s/.test(text.slice(-4096)) || /trailer[\s\S]{0,400}\/Encrypt/.test(text))
    return { images: [], skipped: ["The PDF is encrypted; its images cannot be read."], found: 0 };
  const resolve = resolver(text);
  const images: PdfImage[] = [];
  const skipped: string[] = [];
  let found = 0;
  for (const { dict, dataStart } of streams(text)) {
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    found += 1;
    const n = found;
    const width = Number(resolve(entry(dict, "Width")));
    const height = Number(resolve(entry(dict, "Height")));
    if (!(width > 0 && height > 0)) {
      skipped.push(`image ${n}: no usable size`);
      continue;
    }
    if (width < minSide || height < minSide) continue;
    const length = Number(resolve(entry(dict, "Length")));
    const end =
      Number.isFinite(length) &&
      length > 0 &&
      text.startsWith("endstream", skipWs(text, dataStart + length))
        ? dataStart + length
        : text.indexOf("endstream", dataStart);
    if (end < 0) {
      skipped.push(`image ${n}: its data has no end`);
      continue;
    }
    let data = pdf.subarray(dataStart, end);
    const filterValue = resolve(entry(dict, "Filter")) ?? "";
    const filters = filterValue.match(/\/[A-Za-z0-9]+/g) ?? [];
    try {
      // A Flate wrapper around a JPEG, or around raw pixels, comes off first.
      if (filters[0] === "/FlateDecode" || filters[0] === "/Fl") {
        data = await inflate(data);
        filters.shift();
      }
      const last = filters[0];
      if (last === "/DCTDecode" || last === "/DCT") {
        const soi = indexOf(data, [0xff, 0xd8]);
        if (soi < 0) throw new Error("not a JPEG");
        images.push({ index: n, mimeType: "image/jpeg", data: data.subarray(soi), width, height });
        continue;
      }
      if (last) {
        const why: Record<string, string> = {
          "/JPXDecode": "JPEG 2000",
          "/CCITTFaxDecode": "CCITT fax (black and white scan)",
          "/JBIG2Decode": "JBIG2 (black and white scan)",
          "/LZWDecode": "LZW",
          "/RunLengthDecode": "run-length",
        };
        skipped.push(
          `image ${n} (${width}×${height}): ${why[last] ?? last.slice(1)} is not converted here`,
        );
        continue;
      }
      // Raw pixels, now inflated.
      const space = resolve(entry(dict, "ColorSpace")) ?? "";
      const colour = COLOURS[space.trim()];
      const bpc = Number(resolve(entry(dict, "BitsPerComponent")) ?? 8);
      if (/\/ImageMask\s*true/.test(dict)) {
        skipped.push(`image ${n}: a stencil mask, not a picture`);
        continue;
      }
      if (!colour) {
        skipped.push(
          `image ${n} (${width}×${height}): colour space ${space || "unknown"} is not converted here`,
        );
        continue;
      }
      if (!(bpc === 8 || (colour.channels === 1 && [1, 2, 4].includes(bpc)))) {
        skipped.push(`image ${n}: ${bpc} bits per component is not converted here`);
        continue;
      }
      const parms = resolve(entry(dict, "DecodeParms")) ?? "";
      const predictor = Number(entry(parms, "Predictor") ?? 1);
      let rows: Uint8Array;
      let w = width;
      let h = height;
      if (predictor >= 10) {
        // PNG predictors: the rows already are PNG scanlines, filter bytes and all.
        rows = data;
      } else if (predictor > 1) {
        skipped.push(`image ${n}: TIFF predictor is not converted here`);
        continue;
      } else {
        const step = bpc === 8 && width > maxWidth ? Math.ceil(width / maxWidth) : 1;
        const s = scanlines(data, width, height, colour.channels, bpc, step);
        ((rows = s.rows), (w = s.width), (h = s.height));
      }
      images.push({
        index: n,
        mimeType: "image/png",
        data: png(w, h, bpc, colour.png, await deflate(rows)),
        width: w,
        height: h,
      });
    } catch (e) {
      skipped.push(`image ${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { images, skipped, found };
};

const skipWs = (text: string, at: number) => {
  let i = at;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
};

const indexOf = (data: Uint8Array, needle: number[]) => {
  for (let i = 0; i + needle.length <= data.length; i++)
    if (needle.every((b, k) => data[i + k] === b)) return i;
  return -1;
};

/** Base64 for an image content block. */
export const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
