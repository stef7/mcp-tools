// A fake WordPress REST API for local testing: `node scripts/mock-wp.mjs [port]`.
import { createServer } from "node:http";

const post = (id, title) => ({
  id,
  date: "2026-01-02T03:04:05",
  link: `https://mock.test/p/${id}`,
  class_list: ["post-1", "type-post", "category-news", "tag-palestine"],
  title: { rendered: title },
  excerpt: { rendered: `<p>Excerpt for &#8220;${title}&#8221;</p>` },
  content: { rendered: `<h1>${title}</h1><p>Body &amp; text</p>` },
});
const routes = {
  "/wp-json/wp/v2/types": {
    post: { name: "Posts", rest_base: "posts", rest_namespace: "wp/v2", taxonomies: ["category"] },
    page: { name: "Pages", rest_base: "pages", rest_namespace: "wp/v2", taxonomies: [] },
    attachment: { name: "Media", rest_base: "media", rest_namespace: "wp/v2" },
  },
  "/wp-json/wp/v2/taxonomies": {
    category: { name: "Categories", rest_base: "categories", hierarchical: true },
  },
  "/wp-json/wp/v2/categories": [{ id: 7, name: "News", slug: "news", count: 3 }],
  "/wp-json/wp/v2/posts": [post(1, "First post"), post(2, "Second post")],
  "/wp-json/wp/v2/posts/1": post(1, "First post"),
};

createServer((req, res) => {
  const { pathname: path, search } = new URL(req.url, "http://x");
  const pathname = path.replace(/^\/blog/, ""); // "/blog" is a second fake site
  const body = routes[pathname];
  console.log(req.method, pathname + search, body ? 200 : 404);
  res.writeHead(body ? 200 : 404, {
    "Content-Type": "application/json",
    "X-WP-Total": "2",
    "X-WP-TotalPages": "1",
  });
  res.end(JSON.stringify(body ?? { error: "not found" }));
}).listen(Number(process.argv[2] ?? 8799), () => console.log("mock wp up"));
