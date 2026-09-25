// A fake WordPress for local testing: `node scripts/mock-wp.mjs [port]`.
// Serves wp/v2 (read + write) and stand-ins for The Events Calendar and WooCommerce, and demands
// HTTP Basic auth on writes — and on every WooCommerce request, reads included, as the real one
// does — so the credential path is exercised too. "/blog" is a second site with neither plugin.
import { createServer } from "node:http";

// Two valid logins: the one WP_SITES points at, and one only ever supplied by an X-WP-Auth
// header, so a test can tell which of the two paths actually sent the credential.
const LOGINS = ["wp-user:secretpass", "hdr-user:abcdEFGH1234"];
const AUTH = LOGINS.map((l) => "Basic " + Buffer.from(l).toString("base64"));
let lastAuth = "";
let nextId = 500;

const post = (id, title) => ({
  id,
  date: "2026-01-02T03:04:05",
  link: `https://mock.test/p/${id}`,
  status: "publish",
  class_list: ["post-1", "type-post", "category-news"],
  title: { rendered: title },
  excerpt: { rendered: `<p>Excerpt for &#8220;${title}&#8221;</p>` },
  content: { rendered: `<h1>${title}</h1><p>Body &amp; text</p>` },
});
const event = (id, title, extra = {}) => ({
  id,
  title,
  status: "publish",
  start_date: "2026-09-09 18:00:00",
  end_date: "2026-09-09 19:30:00",
  url: `https://mock.test/event/${id}`,
  website: "https://www.youtube.com/watch?v=abc&list=PL123",
  venue: { id: 98, venue: "Online" },
  ...extra,
});

const product = (id, name, extra = {}) => ({
  id,
  name,
  status: "publish",
  sku: `SKU-${id}`,
  price: "12.00",
  stock_status: "instock",
  permalink: `https://mock.test/product/${id}`,
  _links: { self: [{ href: `https://mock.test/wp-json/wc/v3/products/${id}` }] },
  ...extra,
});

const store = {
  posts: [post(1, "First post"), post(2, "Second post")],
  events: [event(110, "The Red Lines Package"), event(116, "'Settler colonialism'")],
  products: [product(201, "Mug"), product(202, "Tote bag")],
  orders: [
    {
      id: 301,
      number: "301",
      status: "processing",
      total: "24.00",
      currency: "AUD",
      billing: { first_name: "Ada", last_name: "L" },
    },
  ],
  notes: [{ id: 401, note: "Packed" }],
};

/**
 * The wc/v3 namespace index, shaped as WP_REST_Server::get_data_for_route shapes it: each
 * endpoint's args carry only schema keywords plus a boolean `required`. Nested properties are not
 * filtered by WordPress, so `readonly` and the invalid `mixed` type turn up in them, as here.
 */
const WC_PRODUCT_ARGS = {
  name: { type: "string", description: "Product name.", required: false },
  status: {
    type: "string",
    description: "Product status (post status).",
    enum: ["draft", "pending", "private", "publish", "future"],
    default: "publish",
    required: false,
  },
  regular_price: { type: "string", description: "Product regular price.", required: false },
  meta_data: {
    type: "array",
    description: "Meta data.",
    required: false,
    items: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Meta ID.", readonly: true },
        key: { type: "string", description: "Meta key." },
        value: { type: "mixed", description: "Meta value." },
      },
    },
  },
};
const ID = (d) => ({ id: { type: "integer", description: d, required: false } });
const wcIndex = {
  namespace: "wc/v3",
  routes: {
    "/wc/v3": { endpoints: [{ methods: ["GET"], args: {} }] },
    "/wc/v3/products": {
      endpoints: [
        {
          methods: ["GET"],
          args: {
            context: { type: "string", enum: ["view", "edit"], required: false },
            search: {
              type: "string",
              description: "Limit results to those matching a string.",
              required: false,
            },
            sku: {
              type: "string",
              description: "Limit result set to products with specific SKU(s).",
              required: false,
            },
            page: {
              type: "integer",
              description: "Current page of the collection.",
              required: false,
            },
          },
        },
        { methods: ["POST"], args: WC_PRODUCT_ARGS },
      ],
    },
    "/wc/v3/products/(?P<id>[\\d]+)": {
      endpoints: [
        { methods: ["GET"], args: ID("Unique identifier for the resource.") },
        {
          methods: ["POST", "PUT", "PATCH"],
          args: { ...ID("Unique identifier for the resource."), ...WC_PRODUCT_ARGS },
        },
        {
          methods: ["DELETE"],
          args: {
            ...ID("Unique identifier for the resource."),
            force: {
              type: "boolean",
              description: "Whether to bypass trash and force deletion.",
              required: false,
            },
          },
        },
      ],
    },
    "/wc/v3/orders": {
      endpoints: [
        {
          methods: ["GET"],
          args: { status: { type: "array", items: { type: "string" }, required: false } },
        },
      ],
    },
    "/wc/v3/orders/(?P<id>[\\d]+)": {
      endpoints: [{ methods: ["GET"], args: ID("Unique identifier for the resource.") }],
    },
    "/wc/v3/orders/(?P<order_id>[\\d]+)/notes": {
      endpoints: [
        { methods: ["GET"], args: { order_id: { type: "integer", required: false } } },
        {
          methods: ["POST"],
          args: {
            order_id: { type: "integer", required: false },
            note: { type: "string", description: "Order note content.", required: true },
          },
        },
      ],
    },
    "/wc/v3/reports/sales": { endpoints: [{ methods: ["GET"], args: {} }] },
  },
};

const types = {
  post: { name: "Posts", rest_base: "posts", rest_namespace: "wp/v2", taxonomies: ["category"] },
  // WooCommerce registers products with show_in_rest, so wp/v2 lists them at /product.
  product: { name: "Products", rest_base: "product", rest_namespace: "wp/v2", taxonomies: [] },
  page: { name: "Pages", rest_base: "pages", rest_namespace: "wp/v2", taxonomies: [] },
  tribe_events: {
    name: "Events",
    rest_base: "tribe_events",
    rest_namespace: "wp/v2",
    taxonomies: [],
  },
  attachment: { name: "Media", rest_base: "media", rest_namespace: "wp/v2" },
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

createServer(async (req, res) => {
  const { pathname: full, searchParams } = new URL(req.url, "http://x");
  const tecSite = !full.startsWith("/blog"); // the "/blog" site has no Events Calendar
  const path = full.replace(/^\/blog/, "");
  const wc = path.startsWith("/wp-json/wc/v3");
  const write = req.method !== "GET" || wc;
  const authed = AUTH.includes(req.headers.authorization ?? "");
  if (authed && write) lastAuth = Buffer.from(req.headers.authorization.slice(6), "base64") + "";
  console.log(req.method, path, write ? (authed ? "(authed)" : "(NO AUTH)") : "");

  if (write && !authed) {
    return send(res, 401, {
      code: "rest_not_logged_in",
      message: "You are not currently logged in.",
    });
  }

  // Which credential the last write arrived with. Test-only; a real WordPress has no such thing.
  if (path === "/__last-auth") return res.writeHead(200).end(lastAuth);

  if (path === "/wp-json/" || path === "/wp-json") {
    return send(res, 200, {
      namespaces: ["wp/v2", ...(tecSite ? ["tribe/events/v1", "wc/v3"] : [])],
    });
  }
  if (path === "/wp-json/wp/v2/types") {
    return send(res, 200, tecSite ? types : { post: types.post, page: types.page });
  }
  // The index itself is public on a real site; the auth check above is stricter, which is fine.
  if (tecSite && (path === "/wp-json/wc/v3" || path === "/wp-json/wc/v3/")) {
    return send(res, 200, wcIndex);
  }
  if (tecSite && path === "/wp-json/wc/v3/reports/sales") {
    return send(res, 200, [{ total_sales: "24.00", period: searchParams.get("period") }]);
  }

  // WooCommerce: products (full CRUD), orders (read), order notes (list + create)
  const woo = tecSite && path.match(/^\/wp-json\/wc\/v3\/(products|orders)(?:\/(\d+))?(\/notes)?$/);
  if (woo) {
    const [, kind, idStr, notes] = woo;
    const id = Number(idStr);
    if (notes) {
      if (req.method === "GET")
        return send(res, 200, store.notes, { "X-WP-Total": "1", "X-WP-TotalPages": "1" });
      const body = await readBody(req);
      return send(res, 201, { id: ++nextId, note: body.note, order: id, sent: body });
    }
    const list = store[kind];
    if (req.method === "GET" && !id) {
      const sku = searchParams.get("sku");
      const hits = sku ? list.filter((p) => p.sku === sku) : list;
      return send(res, 200, hits, { "X-WP-Total": String(hits.length), "X-WP-TotalPages": "2" });
    }
    const found = list.find((p) => p.id === id);
    if (id && !found)
      return send(res, 404, {
        code: "woocommerce_rest_product_invalid_id",
        message: "Invalid ID.",
      });
    if (req.method === "GET") return send(res, 200, found);
    if (req.method === "DELETE") {
      if (searchParams.get("force") !== "true" && kind !== "products")
        return send(res, 501, {
          code: "woocommerce_rest_trash_not_supported",
          message: "The object does not support trashing.",
        });
      return send(res, 200, { ...found, status: "trash", force: searchParams.get("force") });
    }
    const body = await readBody(req);
    if (!id) {
      const made = product(++nextId, body.name ?? "Untitled", { status: body.status ?? "publish" });
      list.push(made);
      return send(res, 201, { ...made, sent: body });
    }
    return send(res, 200, { ...found, ...body, sent: body });
  }
  if (path === "/wp-json/wp/v2/taxonomies") {
    return send(res, 200, {
      category: { name: "Categories", rest_base: "categories", hierarchical: true },
    });
  }
  if (path === "/wp-json/wp/v2/categories") {
    return send(res, 200, [{ id: 7, name: "News", slug: "news", count: 3 }], { "X-WP-Total": "1" });
  }

  // wp/v2 posts: list, create, read, update, delete
  const wp = path.match(/^\/wp-json\/wp\/v2\/(posts|pages)(?:\/(\d+))?$/);
  if (wp) {
    const [, , idStr] = wp;
    const id = Number(idStr);
    if (req.method === "GET" && !id) {
      return send(res, 200, store.posts, { "X-WP-Total": "2", "X-WP-TotalPages": "1" });
    }
    if (req.method === "GET") {
      const found = store.posts.find((p) => p.id === id);
      return found
        ? send(res, 200, found)
        : send(res, 404, { code: "rest_post_invalid_id", message: "Invalid post ID." });
    }
    if (req.method === "DELETE") {
      return send(res, 200, { deleted: true, previous: { id } });
    }
    const body = await readBody(req);
    if (!id) {
      const made = { ...post(++nextId, body.title ?? "Untitled"), status: body.status ?? "draft" };
      store.posts.push(made);
      return send(res, 201, { ...made, sent: body });
    }
    const found = store.posts.find((p) => p.id === id);
    if (!found)
      return send(res, 404, { code: "rest_post_invalid_id", message: "Invalid post ID." });
    if (body.title) found.title = { rendered: body.title };
    if (body.status) found.status = body.status;
    return send(res, 200, { ...found, sent: body });
  }

  // The Events Calendar
  const tec = path.match(/^\/wp-json\/tribe\/events\/v1\/(events|venues|organizers)(?:\/(\d+))?$/);
  if (tec && tecSite) {
    const [, kind, idStr] = tec;
    const id = Number(idStr);
    if (req.method === "GET" && !id) {
      const from = searchParams.get("start_date");
      return send(res, 200, {
        total: store.events.length,
        total_pages: 1,
        events: store.events,
        from,
      });
    }
    if (req.method === "DELETE") return send(res, 200, { id, status: "trash" });
    const body = await readBody(req);
    if (!id) {
      const made =
        kind === "events" ? event(++nextId, body.title ?? "Untitled") : { id: ++nextId, ...body };
      return send(res, 201, { ...made, sent: body });
    }
    const found = store.events.find((e) => e.id === id) ?? { id };
    return send(res, 200, { ...found, ...body, sent: body });
  }

  send(res, 404, { code: "rest_no_route", message: "No route was found matching the URL." });
}).listen(Number(process.argv[2] ?? 8799), () => console.log("mock wp up"));
