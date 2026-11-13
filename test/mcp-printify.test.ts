/**
 * mcp-printify against the fake Printify in scripts/mock-printify.mjs.
 *
 * Two things are pinned down here. The first is the journey the worker exists for: shop, then
 * blueprint, provider, variants and shipping, then artwork, a product, its price, publishing,
 * and reading products and orders back. The second is everything that must NOT happen: a write
 * without confirm, a blocked operation, a call the spec rejects, a token in any output. For those
 * the mock's request log is the witness that nothing left the worker.
 *
 * What the mock cannot prove is that Printify itself still answers as its API description says.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import Worker from "../workers/mcp-printify/src/index";
import { buildIndex, loadSpec, resolve, search } from "../workers/mcp-printify/src/spec";
import { blocked, printifyTools, report, shape } from "../workers/mcp-printify/src/tools";
import type { Ctx } from "../core/mcp";

const base = inject("printifyBase");
const TOKEN = inject("printifyToken");
const SHOP = 101;
const BLUEPRINT = 1268;
const PROVIDER = 215;

type Spec = {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: { required?: string[]; properties: Record<string, unknown> };
};
type Res = { content: { text: string }[]; isError?: boolean };
type Logged = { method: string; path: string; body?: unknown; ua?: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const vars = env as unknown as Record<string, unknown>;
const printify = () => new Worker(createExecutionContext(), env);
const tools = () => printify().tools({}) as Promise<Spec[]>;
const call = (name: string, args: Record<string, unknown> = {}) =>
  printify().call(name, args, {}) as Promise<Res>;
/** A call that must work; its JSON answer. */
const ok = async (name: string, args: Record<string, unknown> = {}): Promise<Json> => {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Json;
};
/** A call that must be refused or fail; what it said. */
const fails = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  expect(r.isError, `${name} should have failed: ${r.content[0]?.text}`).toBe(true);
  return r.content[0]!.text;
};
const api = (method: string, path: string, more: Record<string, unknown> = {}) =>
  ok("printify_call", { method, path, ...more });
/** Everything the mock has been asked since the last reset. */
const requests = async () => (await (await fetch(`${base}/__mock/requests`)).json()) as Logged[];
const writes = async () => (await requests()).filter((r) => r.method !== "GET");

const PRODUCT = {
  title: "Free Palestine bumper sticker",
  description: "Weatherproof vinyl.",
  blueprint_id: BLUEPRINT,
  print_provider_id: PROVIDER,
  variants: [{ id: 95743, price: 900, is_enabled: true }],
  print_areas: [
    {
      variant_ids: [95743],
      placeholders: [
        { position: "front", images: [{ id: "img1", x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
      ],
    },
  ],
};
const products = `/v1/shops/${SHOP}/products.json`;
const createProduct = async () =>
  (await api("POST", products, { body: PRODUCT, confirm: true }))["response"]["id"] as string;

beforeAll(() => {
  vars["PRINTIFY_API_URL"] = base;
});
beforeEach(async () => {
  vars["PRINTIFY_TOKEN"] = TOKEN;
  delete vars["PRINTIFY_ALLOW_DESTRUCTIVE"];
  await fetch(`${base}/__mock/reset`, { method: "POST" });
});

describe("the tool list", () => {
  it("is three fixed tools, not one per endpoint", async () => {
    expect((await tools()).map((t) => t.name)).toEqual([
      "printify_search",
      "printify_call",
      "printify_upload_image",
    ]);
  });

  it("marks search as read-only and the other two as able to change things", async () => {
    const by = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(by["printify_search"]!.annotations.readOnlyHint).toBe(true);
    expect(by["printify_call"]!.annotations.readOnlyHint).toBe(false);
    expect(by["printify_upload_image"]!.annotations.readOnlyHint).toBe(false);
    expect(by["printify_call"]!.inputSchema.properties).toHaveProperty("confirm");
    expect(by["printify_call"]!.description).toContain("PRINTIFY_ALLOW_DESTRUCTIVE");
  });
});

describe("the vendored spec", () => {
  it("loads, and still covers the operations the journey needs", () => {
    const ix = loadSpec();
    if ("problem" in ix) throw new Error(ix.problem);
    const has = (method: string, path: string) =>
      ix.ops.some((o) => o.method === method && o.path === path);
    expect(ix.server).toBe("https://api.printify.com");
    expect(has("GET", "/v1/shops.json")).toBe(true);
    expect(has("GET", "/v1/catalog/blueprints.json")).toBe(true);
    expect(has("POST", "/v1/uploads/images.json")).toBe(true);
    expect(has("POST", "/v1/shops/{shop_id}/products.json")).toBe(true);
    expect(has("POST", "/v1/shops/{shop_id}/products/{product_id}/publish.json")).toBe(true);
    expect(has("GET", "/v1/shops/{shop_id}/orders.json")).toBe(true);
  });

  it("tells a filled-in path from its neighbours by method and by literal segments", () => {
    const ix = loadSpec();
    if ("problem" in ix) throw new Error(ix.problem);
    const at = (method: string, path: string) => {
      const r = resolve(ix, method, path);
      return "problem" in r ? r.problem : r.op.path;
    };
    expect(at("GET", "/v1/shops/101/orders/abc.json")).toBe(
      "/v1/shops/{shop_id}/orders/{order_id}.json",
    );
    expect(at("POST", "/v1/shops/101/orders/shipping.json")).toBe(
      "/v1/shops/{shop_id}/orders/shipping.json",
    );
    expect(at("PATCH", "/v1/shops.json")).toContain("it takes GET");
    expect(at("GET", "/v1/nonsense.json")).toContain("No operation");
  });
});

describe("printify_search", () => {
  const find = async (query: string) =>
    (await ok("printify_search", { query }))["matches"] as Json[];

  it("returns method, path, summary and parameters for a keyword", async () => {
    const [top] = await find("variants");
    expect(top!["method"]).toBe("GET");
    expect(top!["path"]).toBe(
      "/v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/variants.json",
    );
    expect(top!["summary"]).toBeTruthy();
    const names = (top!["parameters"] as Json[]).map((p) => `${p["in"]}:${p["name"]}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "path:blueprint_id",
        "path:print_provider_id",
        "query:show-out-of-stock",
      ]),
    );
  });

  it("writes the body schema out in full, with an example", async () => {
    const [top] = await find("create product");
    expect(top!["path"]).toBe(products.replace(String(SHOP), "{shop_id}"));
    const schema = top!["body"]["schema"] as Json;
    expect(schema["required"]).toContain("blueprint_id");
    // print_areas is a $ref in the spec; here it has to be readable on its own.
    expect(JSON.stringify(schema["properties"]["print_areas"])).toContain("placeholders");
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(top!["body"]["example"]["print_provider_id"]).toBe(1);
  });

  it("says up front which operations are blocked and which need confirming", async () => {
    const rule = async (q: string, method: string) =>
      (await find(q)).find((m) => m["method"] === method)!["rule"] as string;
    expect(await rule("shops", "GET")).toBe("runs freely");
    expect(await rule("publish product", "POST")).toBe("needs confirm: true");
    expect(await rule("delete product", "DELETE")).toContain("PRINTIFY_ALLOW_DESTRUCTIVE");
  });

  it("lists every operation for an empty query", async () => {
    const r = await call("printify_search", {});
    expect(r.content[0]!.text).toContain("GET /v1/shops.json");
    expect(r.content[0]!.text.split("\n").length).toBeGreaterThan(40);
  });

  it("says so when nothing matches", async () => {
    expect(await fails("printify_search", { query: "zebra" })).toContain("No operation matches");
  });
});

describe("reading the catalogue", () => {
  it("lists shops", async () => {
    const out = await api("GET", "/v1/shops.json");
    expect(out["response"]).toEqual([{ id: SHOP, title: "Test Shop", sales_channel: "etsy" }]);
    expect(out["sent"]).toEqual({ method: "GET", path: "/v1/shops.json" });
  });

  it("finds a blueprint by name instead of returning the whole catalogue", async () => {
    const out = await api("GET", "/v1/catalog/blueprints.json", {
      find: "bumper stickers",
      fields: ["id", "title"],
    });
    expect(out["response"]).toEqual([{ id: BLUEPRINT, title: "Bumper Stickers" }]);
    expect(out["notes"][0]).toContain("kept 1 of 401");
  });

  it("cuts an unfiltered catalogue short, and says it did", async () => {
    const out = await api("GET", "/v1/catalog/blueprints.json");
    expect((out["response"] as unknown[]).length).toBeLessThan(401);
    expect(out["notes"].join(" ")).toContain("of 401 items");
  });

  it("lists a blueprint's print providers", async () => {
    const out = await api("GET", "/v1/catalog/blueprints/{blueprint_id}/print_providers.json", {
      path_params: { blueprint_id: BLUEPRINT },
    });
    expect(out["response"][0]).toEqual({ id: PROVIDER, title: "Sticker Printers Pty Ltd" });
    expect(out["sent"]["path"]).toBe(`/v1/catalog/blueprints/${BLUEPRINT}/print_providers.json`);
  });

  it("lists a provider's variants, with the query parameter the spec defines", async () => {
    const out = await api(
      `/v1/catalog/blueprints/${BLUEPRINT}/print_providers/${PROVIDER}/variants.json`,
      "",
    ).catch(() => null);
    expect(out).toBeNull(); // method and path the wrong way round is an error, not a guess
    const good = await api(
      "GET",
      `/v1/catalog/blueprints/${BLUEPRINT}/print_providers/${PROVIDER}/variants.json`,
      { query: { "show-out-of-stock": 1 } },
    );
    expect(good["response"]["variants"].map((v: Json) => v["id"])).toEqual([95743, 95744]);
    expect(good["sent"]["query"]).toEqual({ "show-out-of-stock": "1" });
    expect((await requests()).at(-1)!.path).toContain("?show-out-of-stock=1");
  });

  it("reads shipping for a provider", async () => {
    const out = await api(
      "GET",
      "/v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/shipping.json",
      { path_params: { blueprint_id: String(BLUEPRINT), print_provider_id: PROVIDER } },
    );
    expect(out["response"]["profiles"][0]["first_item"]).toEqual({ cost: 429, currency: "USD" });
  });
});

describe("uploading artwork", () => {
  const url = "https://cdn.example.org/art/free-palestine.png";

  it("will not upload until confirmed, and shows what it would send", async () => {
    const out = await fails("printify_upload_image", { url });
    expect(out).toContain("confirm: true");
    expect(out).toContain("Nothing was sent");
    expect(out).toContain("free-palestine.png");
    expect(await writes()).toEqual([]);
  });

  it("uploads from a URL, naming the file after it", async () => {
    const out = await ok("printify_upload_image", { url, confirm: true });
    expect(out["response"]["id"]).toBe("img1");
    expect(out["sent"]).toEqual({
      method: "POST",
      path: "/v1/uploads/images.json",
      body: { file_name: "free-palestine.png", url },
    });
    expect((await writes())[0]!.body).toEqual({ file_name: "free-palestine.png", url });
  });

  it("refuses something that is not a web address", async () => {
    expect(await fails("printify_upload_image", { url: "art.png", confirm: true })).toContain(
      "not an absolute URL",
    );
    expect(
      await fails("printify_upload_image", { url: "file:///etc/passwd", confirm: true }),
    ).toContain("http or https");
  });
});

describe("making a product", () => {
  it("creates one from blueprint, provider, variant and image placement", async () => {
    const out = await api("POST", products, { body: PRODUCT, confirm: true });
    expect(out["response"]["id"]).toBe("prod1");
    expect(out["response"]["print_areas"][0]["placeholders"][0]["images"][0]["id"]).toBe("img1");
    // The result restates the method, the path and the body that went out.
    expect(out["sent"]).toEqual({ method: "POST", path: products, body: PRODUCT });
  });

  it("sets title, description and price", async () => {
    const id = await createProduct();
    const change = {
      title: "Free Palestine sticker (large)",
      description: "Weatherproof vinyl, 15 inches.",
      variants: [{ id: 95743, price: 1250 }],
    };
    const out = await api("PUT", "/v1/shops/{shop_id}/products/{product_id}.json", {
      path_params: { shop_id: SHOP, product_id: id },
      body: change,
      confirm: true,
    });
    expect(out["sent"]).toEqual({
      method: "PUT",
      path: `/v1/shops/${SHOP}/products/${id}.json`,
      body: change,
    });
    expect(out["response"]["title"]).toBe(change.title);
    expect(out["response"]["variants"][0]["price"]).toBe(1250);
  });

  it("publishes it to the connected shop", async () => {
    const id = await createProduct();
    const body = { title: true, description: true, images: true, variants: true, tags: true };
    const path = `/v1/shops/${SHOP}/products/${id}/publish.json`;
    const out = await api("POST", path, { body, confirm: true });
    expect(out["sent"]).toEqual({ method: "POST", path, body });
    expect(out["status"]).toBe(200);
    const back = await api("GET", `/v1/shops/${SHOP}/products/${id}.json`);
    expect(back["response"]["visible"]).toBe(true);
    expect(back["response"]["published"]).toEqual(body);
  });

  it("reads a product back, alone and in the shop's list", async () => {
    const id = await createProduct();
    const one = await api("GET", `/v1/shops/${SHOP}/products/${id}.json`, {
      fields: ["id", "title", "blueprint_id"],
    });
    expect(one["response"]).toEqual({ id, title: PRODUCT.title, blueprint_id: BLUEPRINT });
    const list = await api("GET", products, { query: { limit: 10 }, fields: ["id"] });
    expect(list["response"]["data"]).toEqual([{ id }]);
    expect(list["response"]["current_page"]).toBe(1);
  });

  it("reads orders, as a list and one at a time", async () => {
    const list = await api("GET", `/v1/shops/${SHOP}/orders.json`, { query: { page: 1 } });
    const id = list["response"]["data"][0]["id"] as string;
    expect(id).toBe("5a96f649b2439217d070f507");
    const one = await api("GET", "/v1/shops/{shop_id}/orders/{order_id}.json", {
      path_params: { shop_id: SHOP, order_id: id },
    });
    expect(one["response"]["status"]).toBe("fulfilled");
  });
});

describe("a write without confirm", () => {
  it("is refused, restating the request, and never reaches Printify", async () => {
    for (const confirm of [undefined, false, "true"]) {
      const out = await fails("printify_call", {
        method: "POST",
        path: products,
        body: PRODUCT,
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(out).toContain("needs confirm: true");
      expect(out).toContain(`"path": "${products}"`);
      expect(out).toContain(PRODUCT.title);
    }
    expect(await requests()).toEqual([]);
  });

  it("is not asked of a GET", async () => {
    await api("GET", "/v1/shops.json");
    expect((await requests()).length).toBe(1);
  });
});

describe("what is blocked", () => {
  const order = {
    line_items: [{ product_id: "prod1", variant_id: 95743, quantity: 1 }],
    address_to: { first_name: "A", last_name: "B", country: "AU", address1: "1 St", city: "X" },
  };
  const BLOCKED: [string, string, unknown?][] = [
    ["POST", `/v1/shops/${SHOP}/orders.json`, order],
    ["POST", `/v1/shops/${SHOP}/orders/express.json`, order],
    ["POST", `/v1/shops/${SHOP}/orders/abc/send_to_production.json`],
    ["DELETE", `/v1/shops/${SHOP}/connection.json`],
    ["DELETE", `/v1/shops/${SHOP}/products/prod1.json`],
    ["POST", `/v1/shops/${SHOP}/webhooks.json`, { topic: "order:created", url: "https://x.au/h" }],
    ["PUT", `/v1/shops/${SHOP}/webhooks/w1.json`, { url: "https://x.au/h" }],
    ["DELETE", `/v1/shops/${SHOP}/webhooks/w1.json`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/cancel.json`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/line_items/li1/cancel.json`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/support-requests/refund`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/support-requests/reprint`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/support-requests/address-change`],
    ["POST", `/v1/shops/${SHOP}/orders/abc/address_change.json`],
    ["POST", `/v1/shops/${SHOP}/products/prod1/unpublish.json`],
    ["POST", "/v1/uploads/img1/archive.json"],
  ];

  it("refuses each, confirmed or not, naming the variable, and sends nothing", async () => {
    for (const [method, path, body] of BLOCKED) {
      const out = await fails("printify_call", { method, path, body, confirm: true });
      expect(out, `${method} ${path}`).toContain("PRINTIFY_ALLOW_DESTRUCTIVE");
      expect(out).toContain("Nothing was sent");
    }
    expect(await requests()).toEqual([]);
  });

  it("stays blocked for any value of the variable but the string true", async () => {
    for (const v of ["TRUE", "1", "yes", true, " true"]) {
      vars["PRINTIFY_ALLOW_DESTRUCTIVE"] = v;
      expect(
        await fails("printify_call", {
          method: "POST",
          path: BLOCKED[0]![1],
          body: order,
          confirm: true,
        }),
      ).toContain("PRINTIFY_ALLOW_DESTRUCTIVE");
    }
    expect(await requests()).toEqual([]);
  });

  it("opens with the variable set, and still asks for confirm", async () => {
    vars["PRINTIFY_ALLOW_DESTRUCTIVE"] = "true";
    const path = BLOCKED[0]![1];
    expect(await fails("printify_call", { method: "POST", path, body: order })).toContain(
      "needs confirm: true",
    );
    expect(await requests()).toEqual([]);
    const out = await api("POST", path, { body: order, confirm: true });
    expect(out["response"]).toEqual({ id: "new-order" });
  });

  /** The writes that need only confirm: making and publishing products, uploads, and one
   *  POST that changes nothing (the shipping calculator). */
  const OPEN = [
    "POST /v1/shops/{shop_id}/orders/shipping.json",
    "POST /v1/shops/{shop_id}/products.json",
    "POST /v1/shops/{shop_id}/products/{product_id}/personalization.json",
    "POST /v1/shops/{shop_id}/products/{product_id}/personalization_previews.json",
    "POST /v1/shops/{shop_id}/products/{product_id}/publish.json",
    "POST /v1/shops/{shop_id}/products/{product_id}/publishing_failed.json",
    "POST /v1/shops/{shop_id}/products/{product_id}/publishing_succeeded.json",
    "POST /v1/uploads/images.json",
    "PUT /v1/shops/{shop_id}/products/{product_id}.json",
  ];

  it("is exactly this set of the spec's operations, and leaves exactly these writes open", () => {
    const ix = loadSpec();
    if ("problem" in ix) throw new Error(ix.problem);
    const off = ix.ops.filter((o) => blocked(o)).map((o) => `${o.method} ${o.path}`);
    expect(off.sort()).toEqual([
      "DELETE /v1/shops/{shop_id}/connection.json",
      "DELETE /v1/shops/{shop_id}/products/{product_id}.json",
      "DELETE /v1/shops/{shop_id}/webhooks/{webhook_id}.json",
      "POST /v1/shops/{shop_id}/orders.json",
      "POST /v1/shops/{shop_id}/orders/express.json",
      "POST /v1/shops/{shop_id}/orders/{order_id}/address_change.json",
      "POST /v1/shops/{shop_id}/orders/{order_id}/cancel.json",
      "POST /v1/shops/{shop_id}/orders/{order_id}/line_items/{line_item_id}/cancel.json",
      "POST /v1/shops/{shop_id}/orders/{order_id}/send_to_production.json",
      "POST /v1/shops/{shop_id}/orders/{order_id}/support-requests/address-change",
      "POST /v1/shops/{shop_id}/orders/{order_id}/support-requests/refund",
      "POST /v1/shops/{shop_id}/orders/{order_id}/support-requests/reprint",
      "POST /v1/shops/{shop_id}/products/{product_id}/unpublish.json",
      "POST /v1/shops/{shop_id}/webhooks.json",
      "POST /v1/shops/{shop_id}/webhooks/{webhook_id}/simulate",
      "POST /v1/uploads/{image_id}/archive.json",
      "PUT /v1/shops/{shop_id}/webhooks/{webhook_id}.json",
    ]);
    const open = ix.ops.filter((o) => o.method !== "GET" && !blocked(o));
    expect(open.map((o) => `${o.method} ${o.path}`).sort()).toEqual(OPEN);
    // Every DELETE is on that list: there is no way to delete that only needs confirm.
    expect(ix.ops.filter((o) => o.method === "DELETE").every((o) => blocked(o))).toBe(true);
  });
});

describe("validation against the spec", () => {
  const rejected = async (args: Record<string, unknown>) => {
    const out = await fails("printify_call", { confirm: true, ...args });
    expect(out).toContain("was not sent");
    return out;
  };

  it("names what a body is missing, and what has the wrong type", async () => {
    const out = await rejected({
      method: "POST",
      path: products,
      body: { ...PRODUCT, blueprint_id: "1268", variants: [{ id: 95743 }], title: undefined },
    });
    expect(out).toContain('body: is missing required "title"');
    expect(out).toContain("body.blueprint_id: must be integer, got string");
    expect(out).toContain('body.variants[0]: is missing required "price"');
  });

  it("names a forgotten body by what it needed", async () => {
    expect(await rejected({ method: "POST", path: products })).toContain(
      'body: is missing required "title"',
    );
  });

  it("rejects a query parameter the operation does not take, and one out of range", async () => {
    expect(await rejected({ method: "GET", path: products, query: { colour: "red" } })).toContain(
      "query.colour",
    );
    expect(await rejected({ method: "GET", path: products, query: { limit: 500 } })).toContain(
      "query.limit: must be at most 50",
    );
  });

  it("rejects a missing or malformed path parameter", async () => {
    const path = "/v1/shops/{shop_id}/products/{product_id}.json";
    expect(await rejected({ method: "GET", path, path_params: { shop_id: SHOP } })).toContain(
      "path_params.product_id: required",
    );
    expect(
      await rejected({ method: "GET", path, path_params: { shop_id: "abc", product_id: "p" } }),
    ).toContain("path_params.shop_id: must be integer");
    expect(
      await rejected({ method: "GET", path, path_params: { shop_id: SHOP, product_id: "../x" } }),
    ).toContain("must be a plain ID");
  });

  it("rejects a body on an operation that takes none", async () => {
    expect(await rejected({ method: "GET", path: "/v1/shops.json", body: { a: 1 } })).toContain(
      "takes no body",
    );
  });

  it("sends none of those", async () => {
    await rejected({ method: "POST", path: products, body: {} });
    expect(await requests()).toEqual([]);
  });

  it("passes on a field the spec does not describe, and points it out", async () => {
    const out = await api("POST", products, { body: { ...PRODUCT, titel: "typo" }, confirm: true });
    expect(out["notes"][0]).toContain("body.titel");
  });
});

describe("the token and the User-Agent", () => {
  it("sends a User-Agent that says what is calling", async () => {
    await api("GET", "/v1/shops.json");
    expect((await requests())[0]!.ua).toMatch(/^mcp-printify\/\d+\.\d+\.\d+ \(/);
  });

  it("keeps the token out of an error Printify echoes it in", async () => {
    const out = await fails("printify_call", { method: "GET", path: "/v1/shops/500/orders.json" });
    expect(out).toContain("HTTP 500");
    expect(out).toContain("boom");
    expect(out).toContain("[PRINTIFY_TOKEN]");
    expect(out).not.toContain(TOKEN);
  });

  it("says what to do when the secret is missing, without calling Printify", async () => {
    delete vars["PRINTIFY_TOKEN"];
    const out = await fails("printify_call", { method: "GET", path: "/v1/shops.json" });
    expect(out).toContain("PRINTIFY_TOKEN is not set");
    expect(out).toContain("wrangler secret put PRINTIFY_TOKEN");
    expect(await requests()).toEqual([]);
  });

  it("reports a token Printify refuses as a result, not an exception", async () => {
    vars["PRINTIFY_TOKEN"] = "wrong-token-value";
    const out = await fails("printify_call", { method: "GET", path: "/v1/shops.json" });
    expect(out).toContain("HTTP 401");
    expect(out).toContain("did not accept PRINTIFY_TOKEN");
    expect(out).not.toContain("wrong-token-value");
  });

  it("reports Printify's own validation error, with what was sent", async () => {
    const body = { ...PRODUCT, variants: [] };
    const out = await fails("printify_call", {
      method: "POST",
      path: products,
      body,
      confirm: true,
    });
    expect(out).toContain("HTTP 400");
    expect(out).toContain("title, blueprint_id and variants are required");
    expect(out).toContain(`Sent: {"method":"POST","path":"${products}"`);
  });

  it("reports an unreachable Printify as a result", async () => {
    vars["PRINTIFY_API_URL"] = "http://localhost:1";
    try {
      const out = await fails("printify_call", { method: "GET", path: "/v1/shops.json" });
      expect(out).toContain("Could not reach Printify");
      expect(out).not.toContain(TOKEN);
    } finally {
      vars["PRINTIFY_API_URL"] = base;
    }
  });
});

describe("rate limits", () => {
  const orders = (shop: number) => ({ method: "GET", path: `/v1/shops/${shop}/orders.json` });

  it("waits as long as Retry-After asks, then goes through", async () => {
    const began = Date.now();
    const out = await ok("printify_call", orders(4291));
    expect(Date.now() - began).toBeGreaterThanOrEqual(950);
    expect(out["response"]["data"]).toHaveLength(1);
    expect(out["notes"].join(" ")).toContain("rate-limited");
    expect(await requests()).toHaveLength(2);
  });

  it("gives up after four tries with an error that says what happened", async () => {
    const out = await fails("printify_call", orders(4292));
    expect(out).toContain("rate limit was hit (HTTP 429");
    expect(out).toContain("4 times");
    expect(out).toContain("600 requests a minute");
    expect(await requests()).toHaveLength(4);
  });

  it("does not sit through a long Retry-After: it passes the wait on", async () => {
    const began = Date.now();
    const out = await fails("printify_call", orders(4293));
    expect(out).toContain("Wait 120 seconds");
    expect(Date.now() - began).toBeLessThan(2000);
    expect(await requests()).toHaveLength(1);
  });
});

describe("a spec that will not load", () => {
  const broken = () => buildIndex({ openapi: "3.0.3", paths: {} });
  const ctx = { env } as unknown as Ctx;

  it("is a problem in words, whatever is wrong with the document", () => {
    for (const doc of [null, "nope", {}, { paths: {} }, { paths: { "/a": { get: {} } } }])
      expect(buildIndex(doc)).toHaveProperty("problem");
    const dangling = {
      servers: [{ url: "https://x" }],
      paths: { "/a": { get: { requestBody: { $ref: "#/components/requestBodies/gone" } } } },
    };
    expect((buildIndex(dangling) as { problem: string }).problem).toContain("nothing at");
  });

  it("comes back from every tool as an error result, not an exception", async () => {
    const t = printifyTools(broken);
    for (const [name, args] of [
      ["search", { query: "shops" }],
      ["call", { method: "GET", path: "/v1/shops.json" }],
      ["upload_image", { url: "https://x.example/a.png", confirm: true }],
    ] as const) {
      const r = (await t[name]!.run(args as never, ctx)) as Res;
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text).toContain("The vendored spec has no paths");
    }
    expect(await requests()).toEqual([]);
  });

  it("is what the status page leads with", async () => {
    expect((await report(ctx, broken))["spec"]).toBe("FAILED. The vendored spec has no paths.");
  });
});

describe("the status page", () => {
  const page = async () => {
    const res = await printify().fetch(new Request("https://printify.test/"));
    expect(res.status).toBe(200);
    return (await res.json()) as { tools: string[]; status: Record<string, string> };
  };

  it("says the spec loaded, the token works and destructive calls are off", async () => {
    const { tools: listed, status } = await page();
    expect(listed).toHaveLength(3);
    expect(status["spec"]).toMatch(/^53 operations\. OpenAPI 3\.0\.3 from https:\/\/developers/);
    expect(status["token"]).toBe("PRINTIFY_TOKEN is set.");
    expect(status["destructive"]).toContain("Blocked");
    expect(status["printify"]).toBe("Reachable. The token sees 1 shop(s).");
  });

  it("reports an upstream error rather than failing, and never shows the token", async () => {
    vars["PRINTIFY_TOKEN"] = "wrong-token-value";
    const res = await printify().fetch(new Request("https://printify.test/"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain("wrong-token-value");
  });

  it("says when the secret is missing, and when destructive calls are on", async () => {
    delete vars["PRINTIFY_TOKEN"];
    vars["PRINTIFY_ALLOW_DESTRUCTIVE"] = "true";
    const { status } = await page();
    expect(status["token"]).toContain("PRINTIFY_TOKEN is not set");
    expect(status["destructive"]).toContain("ALLOWED");
    expect(status).not.toHaveProperty("printify");
  });
});

describe("shaping a response", () => {
  it("leaves a short answer alone and says nothing", () => {
    expect(shape({ id: 1 }, {})).toEqual({ data: { id: 1 }, notes: [] });
  });

  it("keeps the wrapper of a paginated list while cutting its items", () => {
    const data = { current_page: 1, data: Array.from({ length: 64 }, (_, id) => ({ id })) };
    const out = shape(data, {}, 200);
    expect((out.data as typeof data).current_page).toBe(1);
    expect((out.data as typeof data).data.length).toBeLessThan(64);
    expect(out.notes[0]).toContain("of 64 items");
  });

  it("treats a product as one thing, though it has a variants array of its own", () => {
    const product = { id: "p", title: "T", tags: [], variants: [{ id: 1 }], images: [] };
    expect(shape(product, { fields: ["id", "title"] }).data).toEqual({ id: "p", title: "T" });
    const provider = { id: 215, title: "P", variants: [{ id: 1, title: "White" }, { id: 2 }] };
    expect(shape(provider, { find: "white" }).data).toEqual({
      id: 215,
      title: "P",
      variants: [{ id: 1, title: "White" }],
    });
  });

  it("searches the whole item, not only its title", () => {
    const out = shape(
      [
        { id: 1, brand: "Acme" },
        { id: 2, brand: "Other" },
      ],
      { find: "ACME" },
    );
    expect(out.data).toEqual([{ id: 1, brand: "Acme" }]);
  });
});

describe("search ranking", () => {
  it("prefers a word in the path or summary to one buried in a body", () => {
    const ix = loadSpec();
    if ("problem" in ix) throw new Error(ix.problem);
    const top = (q: string) => `${search(ix, q)[0]!.method} ${search(ix, q)[0]!.path}`;
    expect(top("shops")).toBe("GET /v1/shops.json");
    expect(top("blueprints")).toBe("GET /v1/catalog/blueprints.json");
    expect(top("upload an image")).toBe("POST /v1/uploads/images.json");
    expect(top("publish")).toContain("publish");
    expect(top("orders list")).toBe("GET /v1/shops/{shop_id}/orders.json");
  });
});
