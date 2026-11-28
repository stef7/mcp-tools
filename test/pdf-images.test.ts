/**
 * core/pdf-images, against PDFs built here: the shapes scanners write, and the ones it should
 * report rather than convert.
 */
import { describe, expect, it } from "vitest";
import { pdfImages } from "../core/pdf-images";

const enc = new TextEncoder();
const join = (parts: (string | Uint8Array)[]) => {
  const bs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bs) (out.set(b, at), (at += b.length));
  return out;
};
const zlib = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
const unzlib = async (data: Uint8Array) =>
  new Uint8Array(
    await new Response(
      new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );

/** An image XObject. `length` "ref" writes /Length as an indirect object, as many writers do. */
const xobject = (n: number, dict: string, data: Uint8Array, length: "direct" | "ref" = "direct") =>
  length === "direct"
    ? [
        `${n} 0 obj\n<< /Type /XObject /Subtype /Image ${dict} /Length ${data.length} >>\nstream\n`,
        data,
        "\nendstream\nendobj\n",
      ]
    : [
        `${n} 0 obj\n<< /Type /XObject /Subtype /Image ${dict} /Length ${n + 100} 0 R >>\nstream\n`,
        data,
        `\nendstream\nendobj\n${n + 100} 0 obj\n${data.length}\nendobj\n`,
      ];
const pdf = (...objects: (string | Uint8Array)[][]) =>
  join(["%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", ...objects.flat(), "trailer\n<< /Root 1 0 R >>\n%%EOF\n"]);

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

/** IHDR's width, height, depth and colour type, and the inflated IDAT. */
const readPng = async (png: Uint8Array) => {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  const ihdr = {
    width: view.getUint32(16),
    height: view.getUint32(20),
    depth: png[24],
    colour: png[25],
  };
  const idatLen = view.getUint32(33);
  expect(new TextDecoder().decode(png.subarray(37, 41))).toBe("IDAT");
  return { ...ihdr, rows: await unzlib(png.subarray(41, 41 + idatLen)) };
};

describe("pdfImages", () => {
  it("passes a JPEG page through as it is", async () => {
    const got = await pdfImages(
      pdf(
        xobject(
          5,
          "/Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          FAKE_JPEG,
        ),
      ),
    );
    expect(got.found).toBe(1);
    expect(got.images).toHaveLength(1);
    expect(got.images[0]).toMatchObject({
      index: 1,
      mimeType: "image/jpeg",
      width: 1240,
      height: 1754,
    });
    expect([...got.images[0]!.data]).toEqual([...FAKE_JPEG]);
  });

  it("makes a PNG of raw grey pixels, with an indirect /Length", async () => {
    const w = 100;
    const h = 80;
    const raw = new Uint8Array(w * h).map((_, i) => i % 251);
    const got = await pdfImages(
      pdf(
        xobject(
          7,
          `/Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
          await zlib(raw),
          "ref",
        ),
      ),
    );
    expect(got.images[0]?.mimeType).toBe("image/png");
    const png = await readPng(got.images[0]!.data);
    expect(png).toMatchObject({ width: w, height: h, depth: 8, colour: 0 });
    expect(png.rows.length).toBe(h * (w + 1));
    expect(png.rows[0]).toBe(0); // filter byte
    expect([...png.rows.subarray(1, 6)]).toEqual([...raw.subarray(0, 5)]);
  });

  it("keeps a 1-bit black and white page at 1 bit", async () => {
    const w = 200;
    const h = 100;
    const raw = new Uint8Array((w / 8) * h).fill(0b10101010);
    const got = await pdfImages(
      pdf(
        xobject(
          3,
          `/Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode`,
          await zlib(raw),
        ),
      ),
    );
    const png = await readPng(got.images[0]!.data);
    expect(png).toMatchObject({ width: w, height: h, depth: 1 });
    expect(png.rows.length).toBe(h * (w / 8 + 1));
  });

  it("uses rows that already carry PNG predictors as they are", async () => {
    const w = 70;
    const h = 70;
    const rows = new Uint8Array(h * (w * 3 + 1)).map((_, i) => (i % (w * 3 + 1) === 0 ? 2 : i % 7));
    const got = await pdfImages(
      pdf(
        xobject(
          4,
          `/Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${w} >>`,
          await zlib(rows),
        ),
      ),
    );
    const png = await readPng(got.images[0]!.data);
    expect(png).toMatchObject({ width: w, height: h, colour: 2 });
    expect([...png.rows]).toEqual([...rows]);
  });

  it("shrinks a very wide raw page by a whole factor", async () => {
    const w = 4100;
    const h = 90;
    const got = await pdfImages(
      pdf(
        xobject(
          9,
          `/Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
          await zlib(new Uint8Array(w * h * 3)),
        ),
      ),
    );
    expect(got.images[0]).toMatchObject({ width: 1366, height: 30 });
  });

  it("reports what it cannot convert, skips logos, and keeps stored order", async () => {
    const got = await pdfImages(
      pdf(
        xobject(
          2,
          "/Width 2480 /Height 3508 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode",
          new Uint8Array([1, 2, 3]),
        ),
        xobject(
          3,
          "/Width 20 /Height 20 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          FAKE_JPEG,
        ),
        xobject(
          6,
          "/Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          FAKE_JPEG,
        ),
        xobject(
          8,
          "/Width 800 /Height 600 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode",
          new Uint8Array([120, 156, 3, 0, 0, 0, 0, 1]),
        ),
      ),
    );
    expect(got.found).toBe(4);
    expect(got.images.map((i) => i.index)).toEqual([3]);
    expect(got.skipped).toEqual([
      "image 1 (2480×3508): CCITT fax (black and white scan) is not converted here",
      "image 4 (800×600): colour space /DeviceCMYK is not converted here",
    ]);
  });

  it("finds nothing in a PDF drawn as text", async () => {
    const got = await pdfImages(
      pdf(["4 0 obj\n<< /Length 9 >>\nstream\nBT ET q Q\nendstream\nendobj\n"]),
    );
    expect(got).toEqual({ images: [], skipped: [], found: 0 });
  });

  it("says so for an encrypted PDF", async () => {
    const got = await pdfImages(
      join(["%PDF-1.7\n", "trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n"]),
    );
    expect(got.skipped[0]).toContain("encrypted");
  });
});
