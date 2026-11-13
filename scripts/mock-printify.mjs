/**
 * A fake Printify, enough of one to test mcp-printify against without touching a real account.
 *
 * It reproduces the parts that matter and the parts that bite:
 *   - every request needs the Bearer token and mcp-printify's User-Agent
 *   - the blueprint catalogue is a bare array far too long to hand to a model whole
 *   - products and orders come wrapped in { current_page, data, … }
 *   - a 429 carries Retry-After, and three "shops" exist only to misbehave:
 *       4291  rate-limits once, asking for a second's wait, then answers
 *       4292  rate-limits every time
 *       4293  asks for two minutes, which nobody should sit through
 *       500   fails, and echoes the Authorization header it was sent
 *
 * It also keeps a log of everything it was asked, at GET /__mock/requests, so a test can prove
 * that a refused call never left the worker. POST /__mock/reset clears the log and the state.
 *
 * Usage: node scripts/mock-printify.mjs [port] [token]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8795);
const TOKEN = process.argv[3] ?? "printify-test-token";
const SHOP = 101;

const BLUEPRINTS = [
  ...Array.from({ length: 400 }, (_, i) => ({
    id: 1000 + i,
    title: `Unisex Tee ${i}`,
    description: "A t-shirt. ".repeat(40),
    brand: "Generic Brand",
    model: `T-${i}`,
    images: [`https://images.example.com/tee-${i}.png`],
  })),
  {
    id: 1268,
    title: "Bumper Stickers",
    description: "Weatherproof vinyl stickers for the back of a car.",
    brand: "Generic Brand",
    model: "BS-1",
    images: ["https://images.example.com/bumper.png"],
  },
];
const PROVIDERS = [{ id: 215, title: "Sticker Printers Pty Ltd" }];
const VARIANTS = {
  id: 215,
  title: "Sticker Printers Pty Ltd",
  variants: [
    {
      id: 95743,
      title: '15" x 3.75" / Rectangle / White',
      options: { size: '15" x 3.75"', shape: "Rectangle", color: "White" },
      placeholders: [{ position: "front", height: 1125, width: 4500 }],
    },
    {
      id: 95744,
      title: '11" x 3" / Rectangle / White',
      options: { size: '11" x 3"', shape: "Rectangle", color: "White" },
      placeholders: [{ position: "front", height: 900, width: 3300 }],
    },
  ],
};
const SHIPPING = {
  handling_time: { value: 5, unit: "day" },
  profiles: [
    {
      variant_ids: [95743, 95744],
      first_item: { cost: 429, currency: "USD" },
      additional_items: { cost: 9, currency: "USD" },
      countries: ["AU", "US"],
    },
  ],
};
const ORDER = {
  id: "5a96f649b2439217d070f507",
  status: "fulfilled",
  total_price: 2200,
  address_to: { first_name: "A", last_name: "Customer", country: "AU" },
  line_items: [{ product_id: "p1", quantity: 1, variant_id: 95743, status: "fulfilled" }],
};

let products, uploads, log, limited;
const reset = () => {
  products = new Map();
  uploads = [];
  log = [];
  limited = 0;
};
reset();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const read = (req) =>
  new Promise((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b ? JSON.parse(b) : undefined));
  });
const page = (data) => ({ current_page: 1, data, last_page: 1, total: data.length });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const body = await read(req).catch(() => undefined);

  if (path === "/__mock/requests") return send(res, 200, log);
  if (path === "/__mock/reset") return send(res, 200, (reset(), {}));
  log.push({ method: req.method, path: path + url.search, body, ua: req.headers["user-agent"] });

  // Printify turns away a request with no User-Agent before it looks at anything else.
  if (!req.headers["user-agent"]?.startsWith("mcp-printify/"))
    return send(res, 400, { error: "A User-Agent header is required." });
  if (req.headers.authorization !== `Bearer ${TOKEN}`)
    return send(res, 401, { error: "Unauthenticated." });

  const [, shop] = path.match(/^\/v1\/shops\/(\d+)\//) ?? [];
  if (shop === "4291" && limited++ === 0)
    return send(res, 429, { error: "Too Many Attempts." }, { "Retry-After": "1" });
  if (shop === "4292")
    return send(res, 429, { error: "Too Many Attempts." }, { "Retry-After": "0" });
  if (shop === "4293")
    return send(res, 429, { error: "Too Many Attempts." }, { "Retry-After": "120" });
  if (shop === "500")
    return send(res, 500, { error: "boom", debug: `Authorization: ${req.headers.authorization}` });

  const is = (method, pattern) => req.method === method && path.match(pattern);
  let m;

  if (is("GET", /^\/v1\/shops\.json$/))
    return send(res, 200, [{ id: SHOP, title: "Test Shop", sales_channel: "etsy" }]);

  // ─── Catalogue ───
  if (is("GET", /^\/v1\/catalog\/blueprints\.json$/)) return send(res, 200, BLUEPRINTS);
  if ((m = is("GET", /^\/v1\/catalog\/blueprints\/(\d+)\/print_providers\.json$/)))
    return m[1] === "1268" ? send(res, 200, PROVIDERS) : send(res, 404, { error: "Not found" });
  if (is("GET", /^\/v1\/catalog\/blueprints\/1268\/print_providers\/215\/variants\.json$/))
    return send(res, 200, VARIANTS);
  if (is("GET", /^\/v1\/catalog\/blueprints\/1268\/print_providers\/215\/shipping\.json$/))
    return send(res, 200, SHIPPING);

  // ─── Uploads ───
  if (is("POST", /^\/v1\/uploads\/images\.json$/)) {
    if (!body?.file_name || !(body.url || body.contents))
      return send(res, 400, { status: "error", message: "Validation failed." });
    const image = {
      id: `img${uploads.length + 1}`,
      file_name: body.file_name,
      height: 1125,
      width: 4500,
      size: 1138575,
      mime_type: "image/png",
      preview_url: "https://images.example.com/preview.png",
      upload_time: "2026-11-13 02:00:00",
    };
    uploads.push(image);
    return send(res, 200, image);
  }

  // ─── Products ───
  if ((m = is("POST", /^\/v1\/shops\/(\d+)\/products\.json$/))) {
    if (!body?.title || !body.blueprint_id || !body.variants?.length)
      return send(res, 400, {
        status: "error",
        code: 8150,
        message: "Validation failed.",
        errors: { reason: "title, blueprint_id and variants are required" },
      });
    const product = { id: `prod${products.size + 1}`, shop_id: Number(m[1]), visible: false };
    products.set(product.id, Object.assign(product, body, { is_locked: false }));
    return send(res, 200, product);
  }
  if (is("GET", /^\/v1\/shops\/\d+\/products\.json$/))
    return send(res, 200, page([...products.values()]));
  if ((m = path.match(/^\/v1\/shops\/\d+\/products\/([^/]+)\.json$/))) {
    const product = products.get(m[1]);
    if (!product) return send(res, 404, { status: "error", code: 404, message: "Not found" });
    if (req.method === "GET") return send(res, 200, product);
    if (req.method === "PUT") return send(res, 200, Object.assign(product, body));
    if (req.method === "DELETE") return send(res, 200, (products.delete(m[1]), {}));
  }
  if ((m = is("POST", /^\/v1\/shops\/\d+\/products\/([^/]+)\/publish\.json$/))) {
    const product = products.get(m[1]);
    if (!product) return send(res, 404, { status: "error", code: 404, message: "Not found" });
    Object.assign(product, { visible: true, is_locked: true, published: body });
    return send(res, 200, {});
  }

  // ─── Orders ───
  if (is("GET", /^\/v1\/shops\/\d+\/orders\.json$/)) return send(res, 200, page([ORDER]));
  if ((m = is("GET", /^\/v1\/shops\/\d+\/orders\/([^/]+)\.json$/)))
    return m[1] === ORDER.id ? send(res, 200, ORDER) : send(res, 404, { error: "Not found" });
  // Reached only if a guard in the worker failed: an order was really placed.
  if (is("POST", /^\/v1\/shops\/\d+\/orders\.json$/)) return send(res, 200, { id: "new-order" });

  send(res, 404, { status: "error", code: 404, message: `No route for ${req.method} ${path}` });
}).listen(PORT, () => console.log(`mock printify on http://localhost:${PORT}`));
