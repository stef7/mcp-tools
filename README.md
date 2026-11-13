# mcp-tools

Cloudflare Workers that speak MCP, in one TypeScript repo.

```
core/mcp.ts                  shared plumbing: HTTP MCP endpoint + RPC surface + tool typing
core/web.ts                  what a worker touching the open web needs: stripHtml, a browser UA
core/egress.ts               smart / tunnel / browser in the order you pick, then a plain fetch
core/proxy.ts                fetch through an HTTP proxy over a raw socket (CONNECT + TLS)
core/apify-ca.ts             the key Apify's Unblocker re-signs HTTPS with, for core/proxy.ts
core/vendor/subtls.mjs       TLS 1.3 in JavaScript (jawj/subtls), built by scripts/vendor-subtls.mjs
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
workers/mcp-helios/          Helios Voting: read, verify and run elections. Its own door, not in the toolkit
workers/mcp-printify/        Printify: search its API, call it, upload artwork. Its own door too
scripts/mock-wp.mjs          fake WordPress for local testing
scripts/mock-ghost.mjs       fake Ghost, including the magic-link sign-in
scripts/cf-tunnel-relay.mjs  runs on the Mac at the far end of the tunnel
scripts/cf-tunnel-relay-menu.swift
                             CF Tunnel Relay.app: menu bar switch that runs the relay and cloudflared
scripts/build-cf-tunnel-relay-app.sh
                             builds that app into ~/Applications and opens it
scripts/mock-proxy.mjs       fake Apify Proxy, for the proxy tests, re-signing HTTPS as Apify does
scripts/mock-helios.mjs      fake Helios, for the election lifecycle tests
scripts/mock-printify.mjs    fake Printify: catalogue, uploads, products, orders, rate limits
scripts/vendor-printify-spec.mjs
                             trims Printify's OpenAPI document into workers/mcp-printify/src/spec.json
scripts/apify-tls-probe.mjs  checks HTTPS through the real Unblocker the way the Worker does it
scripts/apify-trust-anchor.py
                             rebuilds core/apify-ca.ts from certificates Unblocker presented
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
the run's summary page. Reading what is live survives a bad minute at Cloudflare: a 5xx, a 429 or
a dropped connection is tried again after 2, 4 then 8 seconds before the plan fails. Any other
error fails it at once, since guessing "changed" would hide a broken token.

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
checked; the body is never read to decide. Any other answer, 404 included, is kept.

After the named routes comes the **fallback**: the worker's own `fetch`, from a Cloudflare colo.
It is free, always there and has no name, and its answer stands, whatever it is. Only if it cannot
connect at all does the last blocked answer from a named route come back instead.

1. **smart** (the default) — Apify Proxy's `UNBLOCKER` group, through `core/proxy.ts`. It routes
   each request to get the page, usually through a proxy, dealing with bot checks and CAPTCHAs
   itself, and picks the country; none is pinned, since Apify says that weakens it. A
   Worker's `fetch` cannot use an HTTP proxy, so this opens a TCP socket to `proxy.apify.com:8000`
   and sends `CONNECT`. Needs `APIFY_PROXY_PASSWORD` on `mcp-fetch` — the password on Apify
   Console -> Proxy, not an API token — and a paid Apify plan. Billed per successful request. Any
   refusal (407, Apify's 590–599) moves on. Any error status (400 and up, 404 and 502 included) or
   failure code from Apify is tried once more, and the second answer stands; `skipped` says so. A
   407 is not retried, nor is a failure with no status (TLS, a timeout). A retry may be billed as a
   second request.

   Unblocker re-signs HTTPS with its own key ("Apify Proxy CA"), which the runtime's TLS will not
   accept and cannot be told to. So TLS inside the tunnel is done in JavaScript, by a vendored
   build of [subtls](https://github.com/jawj/subtls) (`core/vendor/subtls.mjs`), trusting that key
   alone: certificates are still checked, against Apify instead of the public authorities. Apify
   does not publish the key, so it was recovered from the signatures on two certificates
   Unblocker presented, and `test/apify-ca.test.ts` checks it against them. subtls speaks TLS 1.3
   only, which Unblocker accepts. Its author calls it a proof of concept, not for production use.

   If every https URL starts failing this route on the certificate, Apify has probably changed its
   key. To check, and to rebuild `core/apify-ca.ts`:

   ```sh
   read -rs APIFY_PROXY_PASSWORD; export APIFY_PROXY_PASSWORD
   node scripts/apify-tls-probe.mjs example.com      # last line: subtls OK or FAILED
   node scripts/apify-tls-probe.mjs www.wikipedia.org
   # save each certificate it prints to a .pem file, then:
   python3 scripts/apify-trust-anchor.py a.pem b.pem  # prints the new certificate
   ```

2. **tunnel** — a home connection in Australia, only while the Mac is on. `env.TUNNEL` is a VPC
   Service binding (`vpc_services` in `mcp-fetch/wrangler.json`) to the `wmac` service:
   `localhost:8811` on the Mac behind Cloudflare Tunnel `WMac`. Run
   `node scripts/cf-tunnel-relay.mjs` there; `ALLOW_DOMAINS=a.org,b.gov.au` limits it to those
   domains and their subdomains. Alongside each page the Worker asks the relay's `/health`, which
   answers at once. If it fails first (no answer within 2 seconds, or Cloudflare saying the tunnel
   is down), the page is dropped and the tunnel skipped for a minute; if the page answers first,
   the check is dropped. Either sign of a live Mac is remembered for 30 seconds, and a page that is
   merely slow costs only that request (the relay gives up on a site after 30 seconds).
3. **browser** — the same Mac and relay, with the page loaded in Brave there, always in a window
   you can see: it waits up to 45 seconds on a check page, for one that clears itself or for you
   to pass it in that window, and has whatever sign-ins and passed checks you made with Pass a
   check in Brave… in the app's menu. The browser keeps its own profile in
   `~/.cf-tunnel-relay/profile`. Off unless the relay has `BROWSER_ALLOW_DOMAINS=a.org,b.gov.au`,
   and refused for every other domain, where the page starts and wherever it is redirected. Every
   connection the browser makes goes through a proxy inside the relay with the same private-address
   check as plain mode. Needs
   playwright-core, which `npm install` at the root of the clone brings, and Node 20 or later. Up to
   60 seconds a page.

### Setting up the Mac

The tunnel `WMac` and the VPC Service `wmac` live in Cloudflare, so a wiped Mac only needs one
app back: CF Tunnel Relay, a menu bar switch that runs the relay, which runs `cloudflared` for
`WMac`. There is no LaunchAgent or other background item: the app sits in System Settings ->
General -> Login Items -> Open at Login like any other, and quitting it stops both.

1. Install Node 18 or later (20 for browser mode), `brew install cloudflared` (the program only,
   with no `cloudflared service install`; the app runs it) and the Command Line Tools
   (`xcode-select --install`). Clone this repo.
2. From the clone, `sh scripts/build-cf-tunnel-relay-app.sh`. It builds
   `~/Applications/CF Tunnel Relay.app` and opens it; macOS 13 or later. It also removes the
   LaunchAgent `local.cf-tunnel-relay` that earlier versions installed.
3. The first time, the app asks for the tunnel token: in the dashboard, Networking -> Tunnels ->
   `WMac` -> Add a replica, copy the install command, and paste only its long `eyJ…` part. It goes
   into the login Keychain as the item `cf-tunnel-relay`, and never into a file or a command line.
   The app also puts itself in Open at Login (a notification says so).
4. The cloud in the menu bar: filled when the relay answers `/health` and `cloudflared` reports a
   live connection to Cloudflare (its metrics, on `127.0.0.1:8812`); with a `!` while either is
   starting or failing; slashed when off. Its menu has the on/off switch (which stays as left,
   across logins), Restart, Allowed domains… (`ALLOW_DOMAINS` and `BROWSER_ALLOW_DOMAINS`),
   Pass a check in Brave…, Replace tunnel token…, Open at Login, and the error log,
   `/tmp/cf-tunnel-relay.err`.
   `CHROME_PATH` and `CF_TUNNEL_RELAY_PROFILE` are set with
   `defaults write local.cf-tunnel-relay CHROME_PATH /path/to/browser`.
5. If the relay stops, the app starts it again after 5 seconds, doubling up to a minute while it
   keeps failing; the relay does the same for `cloudflared`. If the app goes without stopping
   them (a crash, a force quit), the relay notices its standard input close and stops both.
6. After a `git pull`, Restart in the menu picks up a new relay; run the build again only if
   `cf-tunnel-relay-menu.swift` changed or the clone moved. To remove it all: Quit, turn off Open
   at Login first if you like, and delete the app.
7. For browser mode, `npm install` at the root of the clone (it brings playwright-core) and Brave in
   `/Applications` (or `CHROME_PATH` as above). Some sites' checks will not clear for a browser
   that is being automated; for those, Pass a check in Brave… pauses the relay and opens the page
   in browser mode's own profile with nothing automating it. Pass the check or sign in, quit that
   Brave (⌘Q), and the relay starts again, with browser mode reusing what you got there until the
   site lets it lapse. `node scripts/cf-tunnel-relay.mjs login <url>` does the same from Terminal,
   with the tunnel switched off, since the profile can only be open in one browser at a time.

A `cloudflared` service installed the usual way (`sudo cloudflared service install <token>`) would
connect the Mac to `WMac` a second time, and keeps the token in plain text in its plist; the
app points it out, and `sudo cloudflared service uninstall` removes it.

Nothing here keeps the Mac awake. The tunnel goes down when the Mac sleeps and comes back when it
wakes: both programs carry on where they were, and `cloudflared` reconnects. While it is down,
`mcp-fetch` finds out from `/health` within 2 seconds and skips it for a minute.

The order is `via`: a list, `["tunnel", "smart"]`, or the same as a string, `"tunnel,smart"`.
The fallback always follows, so `["tunnel"]` with the Mac off gets Cloudflare's own fetch. Unset,
it is `EGRESS_VIA` on `mcp-fetch` (a plain-text variable, same format), and failing that `smart`.
An unknown name is an error, not skipped.

`fetch_url` records which route served each URL, and why earlier ones were skipped, in
`docs.meta_json`.

Any other worker can use the same routes without holding the tunnel or the password: bind
`{ "binding": "FETCH", "service": "mcp-fetch" }` and call
`await env.FETCH.egress(url, { headers, via })`. It returns the site's `Response` with
`x-egress-via` (`fallback` for Cloudflare's own fetch) and `x-egress-skipped` headers.

Binding a VPC Service needs the **Connectivity Directory Bind** role on whoever deploys, so the
`CLOUDFLARE_API_TOKEN` in Actions needs it too, or the `mcp-fetch` deploy fails.

## One public door

Only `mcp-toolkit` has a `workers.dev` URL. Every other worker sets `"workers_dev": false` and is
reachable only through the toolkit's service binding, so Cloudflare Access needs to sit on the
toolkit alone — core resolves the signed-in email there and forwards it over RPC.

`mcp-helios` is the one exception, on purpose: it is **not** bound into the toolkit and keeps
its own URL. Its admin tools act with a Helios session cookie, which is the administrator
themselves on Helios, so its tools should not appear on the connector everyone else uses. It gets
its own Access policy (the same steps as under **Auth**), listing the people running the
election, and that policy is also what identifies them to its `/login` page. To put it on the toolkit after all, add it to `services` like any other worker — but
then everyone on the toolkit's policy can see those tools, and the warning above about bindings
bypassing Access applies.

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
`get_wc_endpoint` to read any other route (reports, settings, shipping, system status), and
`update_wc_endpoint` and `delete_wc_endpoint` to write to any route the site's index says takes
it: a setting, a shipping zone, a tax rate. Most of those have no trash or history, so a write
reads the record first and returns it beside the result. Their
arguments are read from the site's own `wc/v3` index, so a field an extension adds shows up
without a code change here, and a method a route does not offer gets no tool. The `wp/v2` write
tools stand aside for products, as they do for events. Generic mode has `search_wc`, `get_wc`,
`create_wc`, `update_wc`, `delete_wc`, `get_wc_endpoint`, `update_wc_endpoint` and
`delete_wc_endpoint`, each taking a `url`.

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

## Running an election on Helios

[Helios](https://vote.heliosvoting.org) has no API tokens. Public election data is JSON that
anyone can fetch; every administrative action is a Django form POST protected by the session
cookie of a browser that has logged in (Google or GitHub on heliosvoting.org) and a per-session
`csrf_token`, which `mcp-helios` scrapes from an admin page and submits the way the browser
would. There is no way for a worker to do that login for anyone, so each administrator does it
once in a browser and then opens the worker's own **`/login`** page, which is behind Cloudflare
Access: it names the cookie to copy (`sessionid`, under the browser's developer tools or a
cookie-manager extension), checks the pasted value against Helios, and keeps it in the
`SESSIONS` KV namespace against their Access email. From then on the tools act as that Helios
user for that person alone. The cookie never passes through a tool call, so it never sits in a
model's context; `helios_session_status` says who you are acting as without revealing it, and
`helios_sign_out` (or the page) forgets it. Logging out of Helios in the browser ends the session
everywhere; otherwise it lasts as long as Helios keeps it (two weeks of inactivity).

Access therefore has to be on `mcp-helios` — it is what tells the worker who is calling, as
well as who may. `?helios=https://…` on the connector URL points the worker at a self-hosted
Helios instead of heliosvoting.org (`HELIOS_URL` sets the default); sessions are kept per
server.

The tools follow the election through its life: `helios_create_election` → `helios_set_questions`
→ trustees → `helios_upload_voters` → `helios_freeze_election` → `helios_email_voters` →
`helios_compute_tally` → `helios_combine_decryptions` → `helios_release_result`, with
`helios_election_status` reading Helios's own "Next Step" box to say where things stand and
showing the tally to admins before release. Every change needs `user_confirmed`, and the
irreversible ones (freeze, tally, release, delete) say so in their descriptions.
`helios_freeze_election` runs Helios's readiness check and refuses with the list of issues.

Reading needs no login unless the election is private. `helios_verify_election_fingerprint` and
`helios_verify_ballot` recompute Helios's SHA-256 fingerprints from the published JSON
(`canonical.ts` reproduces Python's `json.dumps(sort_keys=True)` byte for byte) and compare them
with what the server displays, so a voter's tracker can be checked without trusting the server.
Full zero-knowledge verification stays with Helios's own JavaScript verifier, which the tools
link to.

Times on Helios are UTC. The tools take ISO 8601 with an offset (`2026-11-14T17:00+11:00`) and
convert; a value without an offset is taken as UTC.

## Selling on Printify

`mcp-printify` puts one Printify account behind three tools instead of one per endpoint:

- `printify_search` finds operations in Printify's API description by keyword and returns each
  one's method, path, summary, parameters and request-body schema, with an example.
- `printify_call` runs one operation by method and path. Path parameters, query and body are
  checked against the API description before anything is sent.
- `printify_upload_image` adds artwork to the media library from a public URL.

The API description is Printify's own OpenAPI document. `scripts/vendor-printify-spec.mjs` trims
it to operations, parameters and request bodies and writes `workers/mcp-printify/src/spec.json`,
which ships in the bundle; nothing fetches it at runtime. Re-run the script when Printify changes
its API, read the diff and commit it.

What may be sent:

- `GET` runs freely.
- Anything else needs `confirm: true` in the call, and the result restates the method, path and
  body that went out. Without it the call is refused and shows the request it would have made.
- Refused unless the variable `PRINTIFY_ALLOW_DESTRUCTIVE` is exactly `true`: every write to an
  order (creating one, standard or Express; sending it to production; cancelling it or a line
  item; refund and reprint requests; address changes), deleting or unpublishing a product,
  disconnecting a shop, archiving an upload, and any write to webhooks. It is unset by default;
  leave it that way unless you mean it. With it on, those calls still need `confirm: true`.

A `429` from Printify is waited out (for as long as `Retry-After` asks, up to ten seconds, three
times) and then reported with how long to wait. Lists are cut to a readable size: pass `find` to
keep the items containing some text and `fields` to keep only some keys, which is how one
blueprint is found by name in a catalogue of some three thousand.

To set it up:

1. **Create the token.** In Printify, open the account menu -> **Connections** -> **Personal
   access tokens** -> **Generate**. Name it, and choose custom scopes: reading shops, the
   catalogue, print providers, products, uploads and orders, plus writing products and uploads.
   Leave out writing orders and webhooks and managing shops, and Printify itself will refuse what
   this worker already blocks. Copy the token when it is shown; Printify shows it once, and it
   expires after a year.
2. **Store it as a secret**, once the worker exists on Cloudflare (its first deploy is the merge
   to `main`):

   ```sh
   cd workers/mcp-printify
   npx wrangler secret put PRINTIFY_TOKEN      # paste the token when asked
   ```

   The token goes to Printify as a Bearer header and nowhere else: no tool result, error or log
   line carries it.

3. **Put Cloudflare Access in front of it**, as under **Auth** below, on the `mcp-printify`
   worker: an Access policy listing who may use it, and Managed OAuth turned on. Like
   `mcp-helios` it is not bound into `mcp-toolkit`, because it acts on one person's shops.
4. **Add the connector in Claude.** Settings -> Connectors -> **Add custom connector**, and
   paste the worker's URL, `https://mcp-printify.<your-subdomain>.workers.dev/`. The sign-in that
   opens is the Access page.

Opening that URL in a browser shows whether the API description loaded, whether the token is
set, whether Printify accepts it, and whether destructive calls are on.

## Auth (Cloudflare Access)

Access runs before the Worker, so unauthenticated hits cost nothing. `mcp-toolkit` needs it, and so
do the workers that have a URL of their own rather than a binding in the toolkit (`mcp-helios`,
`mcp-printify`); repeat steps 2 to 4 for each:

1. Zero Trust -> Integrations -> Identity providers -> add **One-time PIN** (email code, no
   account needed).
2. Workers & Pages -> the Worker -> **Access** -> protect it; policy: Include -> Emails -> your list.
3. Zero Trust -> Access controls -> Applications -> edit that application -> Advanced settings ->
   turn on **Managed OAuth**, allow dynamic client registration.
4. In Claude.ai, add the connector URL. The browser login is the Access page.

Adding a person = adding their email to the policy.
