# mcp-tools

Cloudflare Workers that speak MCP, in one TypeScript repo.

```
core/mcp.ts                  shared plumbing: HTTP MCP endpoint + RPC surface + tool typing
core/web.ts                  what a worker touching the open web needs: stripHtml, a browser UA
core/egress.ts               plain fetch / unblocker / tunnel, in the order you pick; for mcp-fetch
core/proxy.ts                fetch through an HTTP proxy over a raw socket (CONNECT + startTls)
test/                        vitest, run against mocks rather than anyone's live service
workers/mcp-toolkit/         aggregator: its own tools + every worker bound under `services`
workers/mcp-wp/              WordPress REST API -> MCP, read and write
workers/mcp-fetch/           fetch one URL in the format you ask for, cache it, search the cache
workers/mcp-archives/        the Wayback Machine: TimeMap, CDX, Save Page Now
workers/mcp-un-docs/         UNISPAL, the UN Digital Library, ODS symbols, RightDocs
workers/mcp-abc-search/      ABC's Algolia index, transcripts included
workers/mcp-abc-ombudsman/   ABC Ombudsman complaint findings
workers/mcp-data-gov-au/     data.gov.au over CKAN, including raw SQL
workers/mcp-ghost/           Ghost publications, with member sign-in for paid posts
workers/mcp-apify/           what Apify is costing you, by service and by Actor
scripts/mock-wp.mjs          fake WordPress for local testing
scripts/mock-ghost.mjs       fake Ghost, including the magic-link sign-in
scripts/cf-tunnel-relay.mjs  runs on the Mac at the far end of the tunnel
scripts/install-cf-tunnel-relay-agent.sh
                             makes the Mac start cf-tunnel-relay at login and keep it running
scripts/mock-proxy.mjs       fake Apify Proxy, for the proxy tests
```

## A worker is a tools object

```ts
import cfg from "../wrangler.json";
import pkg from "../package.json";
import { mcpWorker, tool } from "../../../core/mcp";

export default mcpWorker({
  ...cfg, // name + services come straight from wrangler.json
  version: pkg.version,
  tools: {
    hello: tool({
      description: "Say hi",
      input: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      run: ({ name }) => `Hi ${name}`, // `name` is typed from `input`; nothing declared twice
    }),
  },
});
```

Rules the core enforces so nothing needs a mapping table:

- The object key is the tool name. Exposed as `<worker>_<key>`: worker `mcp-wp` -> `wp_search_posts`.
  A worker can set `prefix: ""` to drop that, as mcp-toolkit does for its own three tools.
- `run` may return a string, any JSON value, or a full MCP result (`{ content, isError }`).
- `tools` may be a function of the request context when tools depend on the connector URL.
- A worker with `services` in its wrangler.json re-exports those workers' tools and routes calls by
  prefix. The connector's query string is forwarded, so each worker reads its own params. A bound
  worker that is down loses its own tools and nothing else; the GET page lists what it could not
  reach.

## Connector URLs

| URL                                                 | You get                                             |
| --------------------------------------------------- | --------------------------------------------------- |
| `mcp-toolkit…/`                                     | everything                                          |
| `mcp-toolkit…/?tools=wp`                            | only the `wp_*` tools                               |
| `mcp-toolkit…/?tools=archives,un_docs`              | two whole toolsets                                  |
| `mcp-toolkit…/?tools=wp_get_content,acast_episodes` | exactly those two                                   |
| `mcp-toolkit…/?wp=apil.au`                          | tools generated from that site (posts, events, …)   |
| `mcp-toolkit…/?wp=apil.au,crikey.com.au`            | one set per site, named `wp_<site slug>_<tool>`     |
| `mcp-wp…/?wp=apil.au&title=APIL`                    | the wp worker alone (`?site=` still works as alias) |
| `mcp-wp…/https://apil.au?title=APIL`                | the same, with the site in the path                 |

Tools named `create_*`, `update_*` and `delete_*` change the live site. See **Editing a site**.

## Local development

```sh
npm install
npm run check                                   # wrangler types + tsc, every worker
npm test                                        # the suite, against the mock WordPress
npm run format                                  # prettier, 100 columns
node scripts/mock-wp.mjs 8799 &                 # a fake WordPress
cd workers/mcp-toolkit && npx wrangler dev -c wrangler.json -c ../mcp-wp/wrangler.json
curl 'http://localhost:8787/?wp=http://localhost:8799'   # lists the generated tools
```

Two `overrides` in `package.json` hold the test tooling together. The Vitest pool pins a Miniflare
whose runtime stops at an older compatibility date than the workers ask for, so it is pointed at
the Miniflare that the workers' own Wrangler uses; move that pin when Wrangler moves. `sharp` is
lifted to a patched release; only local image simulation uses it, never a deployed worker. npm 10
fails to resolve Vitest 4's optional peers from scratch, so regenerate `package-lock.json` with
`npx npm@11 install`; `npm ci` on npm 10 installs the result fine.

`worker-configuration.d.ts` is generated by `wrangler types` and committed so any editor
type-checks a fresh clone. Re-run `npm run check` after touching a `wrangler.json`.

## Deploying (GitHub Actions)

`.github/workflows/ci.yml` runs everything, from pull request to production:

- **Pull request:** the checks, and each changed worker is compiled. A worker whose
  `wrangler.json` changed is also uploaded to Cloudflare as a version that is not deployed, which
  catches what only Cloudflare can refuse (a setting the plan does not allow, a binding that does
  not resolve, a missing required secret) before anything merges. A code-only change uploads
  nothing, so a PR does not push unmerged versions to the top of a worker's version list. A
  worker that is not on Cloudflare yet is only compiled, because a worker's first upload has to
  be a deploy.
- **Push to `main`:** the checks, then a deploy of each changed worker. The deploys wait for the
  checks, so a red `main` never ships.
- **Run workflow** (Actions tab): the checks, then a deploy of every worker.

**"Changed" means the deployed code changed**, not the files. The `plan` job
(`core/ship.mjs`) builds every worker exactly as `wrangler deploy` would, and fingerprints each
bundle together with its `wrangler.json`. Every deploy stores that fingerprint on the new version
as its tag, so the next plan compares against what Cloudflare is actually serving. A `core/`
change reaches only the workers whose bundle it alters (a change to `core/egress.ts` ships
`mcp-fetch` alone), and a README, a test or a comment ships nothing. Workers import only `version` from their
`package.json` (`import { version } from "../package.json"`), never the whole file: a whole-file
import inlines `devDependencies` into the bundle, so bumping a dev tool would redeploy every worker. Each worker's summary is in
the run's summary page.

Each changed worker then gets **its own job, in parallel**. Only `check` installs the whole
workspace: no worker has npm dependencies of its own, so `plan` builds with wrangler alone, and
each worker's job restores wrangler from the cache `plan` filled and ships the bundle `plan`
built, byte for byte.

`mcp-toolkit` and `mcp-wp` set `"preview_urls": false`. Without it, every upload from a pull
request would get a live URL running unmerged code against production resources.

It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Editor on these workers, plus
Connectivity Directory Bind for `mcp-fetch`'s tunnel) and `CLOUDFLARE_ACCOUNT_ID`. The Worker name in the dashboard must equal `name` in that folder's
`wrangler.json`. Bindings live in `wrangler.json`; secrets stay in the dashboard (`keep_vars`
keeps plain variables too, so `WP_SITES` survives a deploy).

## Adding a worker

1. Copy `workers/mcp-wp` to `workers/mcp-<name>`; set `name` in `wrangler.json` and `package.json`.
2. Replace `tools` in `src/index.ts`.
3. Add `{ "binding": "<NAME>", "service": "mcp-<name>" }` to `workers/mcp-toolkit/wrangler.json`.
   The binding name is yours; the prefix comes from `service`, so `mcp-un-docs` gives `un_docs_`
   and a worker from another repo keeps its own name — `shop` gives `shop_`.

   That derivation is a guess, and a bound worker is free to disagree with it: one that sets its
   own `prefix`, or that is an aggregator re-exporting the prefixes of the workers bound to _it_,
   answers to names this repo cannot derive. Its tools are listed under their real names either
   way, and a call no prefix claims falls back to asking each bound worker which names it lists,
   so nothing is listed-but-uncallable. Add `"prefix"` — a string, or a list — to skip that
   lookup, which costs every bound worker a tool list — worth doing once you have confirmed what
   a worker really answers to, e.g. `"prefix": ["shop_", "stock_"]`. Declare it wrong and the
   fallback cannot save you: the call goes to the worker you named and stops there.

4. `npm run check`, commit, push to `main`; the deploy workflow picks the new folder up.

## Getting past blocks

`mcp-fetch` downloads through `core/egress.ts`, which tries the routes you name, in the order
you name them. It moves to the next when a route cannot connect, or when the answer is a block:
status 403, 429, 451 or 503, or a challenge header — Cloudflare's `cf-mitigated: challenge`, or
AWS WAF's `x-amzn-waf-action: challenge` (sent as a 202) or `captcha` (a 405). Only headers are
checked; the body is never read to decide. Any other answer, 404 included, is kept. If every route is blocked, the last blocked answer comes back.

1. **direct** — the worker's own `fetch`, from a Cloudflare colo. Free.
2. **unblocker** — Apify Proxy's `UNBLOCKER` group, through `core/proxy.ts`. It handles bot checks
   and CAPTCHAs and picks the country itself; none is pinned, since Apify says that weakens it. A
   Worker's `fetch` cannot use an HTTP proxy, so this opens a TCP socket to `proxy.apify.com:8000`,
   sends `CONNECT`, and starts TLS to the site inside it with
   `startTls({ expectedServerHostname })`. Needs `APIFY_PROXY_PASSWORD` on `mcp-fetch` — the
   password on Apify Console -> Proxy, not an API token — and a paid Apify plan. Billed per
   successful request. Any refusal (407, Apify's 590–599) moves on. Apify does not say whether
   Unblocker re-signs HTTPS; if it does, every https URL fails this route with a TLS error.
3. **tunnel** — a home connection in Australia, only while the Mac is on. `env.TUNNEL` is a VPC
   Service binding (`vpc_services` in `mcp-fetch/wrangler.json`) to the `wmac` service:
   `localhost:8811` on the Mac behind Cloudflare Tunnel `WMac`. Run
   `node scripts/cf-tunnel-relay.mjs` there; `ALLOW_DOMAINS=a.org,b.gov.au` limits it to those
   domains and their subdomains. Alongside each page the Worker asks the relay's `/health`, which
   answers at once. If it fails first (no answer within 2 seconds, or Cloudflare saying the tunnel
   is down), the page is dropped and the tunnel skipped for a minute; if the page answers first,
   the check is dropped. Either sign of a live Mac is remembered for 30 seconds, and a page that is
   merely slow costs only that request (the relay gives up on a site after 30 seconds).
4. **browser** — the same Mac and relay, with the page loaded in Google Chrome there: it waits out
   challenge pages that clear themselves and has whatever sign-ins you made with
   `node cf-tunnel-relay.mjs login <url>`. Chrome keeps its own profile in
   `~/.cf-tunnel-relay/profile`. Off unless the relay has `BROWSER_ALLOW_DOMAINS=a.org,b.gov.au`,
   and refused for every other domain, where the page starts and wherever it is redirected. Every
   connection Chrome makes goes through a proxy inside the relay with the same private-address
   check as plain mode. Needs
   `npm i playwright-core` next to the relay. Up to 60 seconds a page.

### Setting up the Mac

The tunnel `WMac` and the VPC Service `wmac` live in Cloudflare, so a wiped Mac only needs one
LaunchAgent back: the relay, which also runs `cloudflared` for `WMac`.

1. Install Node 18 or later and `brew install cloudflared` — the program only, with no
   `cloudflared service install`; the relay runs it. Clone this repo.
2. From the clone, `sh scripts/install-cf-tunnel-relay-agent.sh`, with `ALLOW_DOMAINS=…` and
   `BROWSER_ALLOW_DOMAINS=…` in front if you want them. The first time, it asks for the tunnel
   token: in the dashboard, Networking -> Tunnels -> `WMac` -> Add a replica, copy the install
   command, and paste only its long `eyJ…` part. It goes into the login Keychain as the item
   `cf-tunnel-relay`, and never into a file, a plist or a command line.
3. It writes `~/Library/LaunchAgents/local.cf-tunnel-relay.plist`, which starts the relay at login
   and restarts it if it dies, loads it, and checks that `/health` answers. The relay reads the
   token from the Keychain and starts `cloudflared`, restarting that too if it dies; the dashboard
   shows `WMac` as Healthy once it has connected.
4. `sh scripts/install-cf-tunnel-relay-agent.sh off` stops both until `on` or the next login;
   `--token` asks for a new token. After a `git pull`, restart with
   `launchctl kickstart -k gui/$(id -u)/local.cf-tunnel-relay`.
5. For browser mode, `npm i --no-save playwright-core` at the root of the clone (a plain
   `npm i` would add it to `package.json`), then `node scripts/cf-tunnel-relay.mjs login <url>` for
   any sign-ins.

A `cloudflared` service installed the usual way (`sudo cloudflared service install <token>`) would
connect the Mac to `WMac` a second time, and keeps the token in plain text in its plist; the
installer points it out, and `sudo cloudflared service uninstall` removes it.

Nothing here keeps the Mac awake. The tunnel goes down when the Mac sleeps and comes back when it
wakes: both programs carry on where they were, and `cloudflared` reconnects. While it is down,
`mcp-fetch` finds out from `/health` within 2 seconds and skips it for a minute.

The order is `via`: a list, `["tunnel", "unblocker", "direct"]`, or the same as a string,
`"tunnel,unblocker,direct"`. One route means no fallback, so `["tunnel"]` fails when the Mac is
off. Unset, it is `EGRESS_VIA` on `mcp-fetch` (a plain-text variable, same format), and failing
that `direct,unblocker`: free first, paid only when turned away. An unknown name is an error, not
skipped.

`fetch_url` records which route served each URL, and why earlier ones were skipped, in
`docs.meta_json`.

Any other worker can use the same routes without holding the tunnel or the password: bind
`{ "binding": "FETCH", "service": "mcp-fetch" }` and call
`await env.FETCH.egress(url, { headers, via })`. It returns the site's `Response` with
`x-egress-via` and `x-egress-skipped` headers.

Binding a VPC Service needs the **Connectivity Directory Bind** role on whoever deploys, so the
`CLOUDFLARE_API_TOKEN` in Actions needs it too, or the `mcp-fetch` deploy fails.

## One public door

Only `mcp-toolkit` has a `workers.dev` URL. Every other worker sets `"workers_dev": false` and is
reachable only through the toolkit's service binding, so Cloudflare Access needs to sit on the
toolkit alone — core resolves the signed-in email there and forwards it over RPC.

A bound worker still uses **its own** secrets: `APIFY_TOKEN` lives on `mcp-apify`, `WP_SITES` on
`mcp-wp`, the Ghost sessions on `mcp-ghost`. The toolkit holds none of them and never sees them.

**A service binding bypasses Access**, which matters for a worker bound from outside this repo.
It invokes the bound worker directly, so a worker with its own Access policy gets no second gate
here: whoever is on the **toolkit's** policy can call its tools. The forwarded email still drives
whatever authorisation the bound worker does for itself, but _reading_ is gated by the toolkit's
allowlist alone. Keep the two policies in step, or do not bind the worker.

`workers_dev: false` removes the `*.workers.dev` URL on deploy. A custom domain added in the
dashboard is not managed here and has to be removed there.

Point several connectors at the one worker to keep the grouping you want:

| Connector | URL                                                  |
| --------- | ---------------------------------------------------- |
| APIL      | `mcp-toolkit…/?wp=apil.au&tools=wp`                  |
| Research  | `mcp-toolkit…/?tools=archives,un_docs,fetch`         |
| Media     | `mcp-toolkit…/?tools=abc_search,abc_ombudsman,ghost` |

## Editing a site

Reads are open. Writing needs a login, and there are two ways to supply one.

### Either: a header on the connector

Claude connectors send only header names Anthropic has approved, and `X-Auth-Token` is one every
connector can use. Put a login in it as `user:application password` and `mcp-wp` uses it.
Nothing is stored on the worker, and the credential stays with whoever configured that
connector — so someone can be given write access without a Cloudflare account or an entry in
anything you maintain. Spaces in the password are fine — WordPress prints them in groups of four
and they are stripped before the request goes out.

One header is one login, so it is used only on a connector for exactly one site
(`?wp=apil.au`). On a connector for several sites there is no saying whose login it is, and in
generic mode it would go to whatever URL a tool call names, so there it is ignored; use
`WP_SITES` for those. `wp_login_status` says whether the header was used, and why not.

A header wins over `WP_SITES`. It also only exists while a person's connector is making the
request: anything unattended sends no headers, so `WP_SITES` is what a scheduled write would use.

### Or: `WP_SITES`, set in the dashboard on `mcp-wp` under Settings -> Variables and Secrets.

**1. `WP_SITES`, a plain variable** — who may edit what. Readable and editable, because none of it
is secret. Keyed by Cloudflare Access email, then hostname. `user` is the WordPress login, `pass`
is the _name of the secret_ holding that login's password:

```json
{
  "you@example.com": { "apil.au": { "user": "claude-mcp", "pass": "APIL_CLAUDE" } },
  "paul@example.com": { "apil.au": { "user": "paul-mcp", "pass": "APIL_PAUL" } }
}
```

**2. One secret per login**, named whatever you put in `pass` — here `APIL_CLAUDE` and
`APIL_PAUL`. The value is a WordPress **Application Password** (Users -> Profile -> Application
Passwords), not the account password.

Secret names are used exactly as written and never derived from the host or username: sanitising
those into one identifier would let different pairs collide (`apil.au` + `x_y` and `apil.au-x` +
`y` produce the same key). Naming them yourself also means the variable shows, at a glance, which
WordPress user and which secret each site is using.

There is no shared fallback. A site nobody is listed against is read-only, and so is everything if
Cloudflare Access is off, because then no identity reaches the worker. Access identity does not
cross service bindings, so the worker facing the browser resolves the email once and passes it on
with every RPC. Write tools simply do not appear when you have no login for a site, and every one
of them refuses to run until the caller passes `user_confirmed: true`.

Prefer a dedicated Editor-role WordPress user: application passwords inherit every capability the
account has and cannot be scoped.

A `get_*` tool returns the post body **exactly as WordPress stores it**, markup and all, because
reading one is usually the first half of editing it — stripping the HTML and writing it back
would replace the blocks, links and embeds with plain text. Search results still strip, since a
400-character preview of raw HTML is mostly angle brackets.

Sites running **The Events Calendar** are detected from their REST namespaces and get event, venue
and organiser tools that write through `tribe/events/v1`. The plain post tools stand aside for
those three types, because writing them through `wp/v2` silently drops the dates, venue and cost.

Sites running **WooCommerce** are detected the same way (`wc/v3`) and get `search_wc_*`,
`get_wc_*`, `create_wc_*`, `update_wc_*` and `delete_wc_*` tools for products, variations,
product categories, tags and reviews, orders, order notes, refunds, customers and coupons, plus
`get_wc_endpoint` to read any other route (reports, settings, shipping, system status). Their
arguments are read from the site's own `wc/v3` index, so a field an extension adds shows up
without a code change here, and a method a route does not offer gets no tool. The `wp/v2` write
tools stand aside for products, as they do for events. Generic mode has `search_wc`, `get_wc`,
`create_wc`, `update_wc`, `delete_wc` and `get_wc_endpoint`, each taking a `url`.

Two differences from `wp/v2`:

- **WooCommerce will not serve anything without a login, reads included**, so none of these tools
  appear until a login is configured. Use a Shop Manager or Administrator. Either an
  Application Password or a WooCommerce REST key pair works, in `WP_SITES` or `X-Auth-Token`
  (`ck_…:cs_…`); a key pair unlocks only the WooCommerce tools, not the `wp/v2` writes.
- A new product is a **draft** unless you pass a status, because WooCommerce itself publishes by
  default. Customers, categories, tags, notes and refunds cannot be trashed, so WooCommerce
  refuses to delete them unless `force` is `true`, which deletes them permanently.

## Reading paid Ghost posts

Ghost's Content API never serves gated content: a members-only or paid post comes back with an
empty `html` whatever key you present. The body only exists in the page Ghost renders for a
signed-in member, so `mcp-ghost` signs in and reads that.

Ghost members have no passwords, so signing in is a magic link, in two tool calls:

1. `ghost_login` — asks the site to email you a sign-in link.
2. `ghost_login_complete` — you paste that link back; the worker follows it **itself** and keeps
   the two cookies Ghost sets in reply.

The link works once. Clicking it first, or a mail scanner following it, spends it on that browser
instead, and `ghost_login_complete` will say so. Sessions are stored in KV against your Cloudflare
Access email, so each person reads paid posts on their own subscription. `ghost_session_status`
says who you are signed in as; `ghost_sign_out` forgets it.

`GHOST_SITES` holds each site's Content API key, which Ghost itself calls safe to expose, so it
can be a plain variable:

```json
{ "www.lamestream.com.au": { "key": "79b548ddd5142126203cac8f8f" } }
```

An entry may still carry `cookie` and `cookie_sig` for a shared session, used when the person has
none of their own. Prefer signing in.

## Auth (Cloudflare Access)

Access runs before the Worker, so unauthenticated hits cost nothing. Only `mcp-toolkit` needs it,
since it is the only worker with a URL:

1. Zero Trust -> Integrations -> Identity providers -> add **One-time PIN** (email code, no
   account needed).
2. Workers & Pages -> the Worker -> **Access** -> protect it; policy: Include -> Emails -> your list.
3. Zero Trust -> Access controls -> Applications -> edit that application -> Advanced settings ->
   turn on **Managed OAuth**, allow dynamic client registration.
4. In Claude.ai, add the connector URL. The browser login is the Access page.

Adding a person = adding their email to the policy.
