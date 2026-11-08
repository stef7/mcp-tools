/**
 * Who is acting on Helios, and where that is kept.
 *
 * Helios signs administrators in with Google or GitHub in a browser and gives them an HttpOnly
 * session cookie; there is no API token and no way for a worker to do that login for anyone.
 * So the cookie is handed over once, on this worker's own /login page, and kept in KV against
 * the Cloudflare Access email of the person who pasted it. Tools then act as whoever the
 * caller's Access email maps to. The cookie never passes through a tool call, so it never sits
 * in a model's context, and nobody acts on an election with anyone's session but their own.
 */
import { HeliosClient, HeliosError } from "./client";
import { firstMatch, stripTags } from "./html";

export type Session = {
  cookie: string;
  /** The Helios server this cookie is for. */
  url: string;
  /** Who Helios said this was when the cookie was checked. */
  user?: string | undefined;
  at: number;
};

/** One session per person per Helios server. */
const key = (email: string, url: string) => `session:${email}:${new URL(url).host}`;
/** Django's default SESSION_COOKIE_AGE, which heliosvoting.org keeps. */
const TWO_WEEKS = 60 * 60 * 24 * 14;

export const save = (kv: KVNamespace, email: string, s: Session) =>
  kv.put(key(email, s.url), JSON.stringify(s), { expirationTtl: TWO_WEEKS });

export const load = (kv: KVNamespace, email: string, url: string) =>
  kv.get(key(email, url), { type: "json" }).catch(() => null) as Promise<Session | null>;

export const forget = (kv: KVNamespace, email: string, url: string) => kv.delete(key(email, url));

/** Ask Helios who a cookie belongs to; undefined when it is not a live session. */
export const whoami = async (client: HeliosClient): Promise<string | undefined> => {
  const home = await client.getText("/");
  const who = firstMatch(home, /logged in as\s*<b>([\s\S]*?)<\/b>/i);
  return who ? stripTags(who) : undefined;
};

export const needsAccess = () =>
  new HeliosError(
    "Signing in needs to know who you are, and no identity arrived. This worker must sit " +
      "behind Cloudflare Access: the session is stored against your Access email so that it " +
      "stays yours.",
    401,
    "config",
  );

// ─── The /login page ──────────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export const loginPage = (o: {
  email: string;
  helios: string;
  cookieName: string;
  current?: Session | null;
  notice?: string | undefined;
  error?: string | undefined;
}) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helios sign-in</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  input[type=text] { width: 100%; font: inherit; padding: .5rem; box-sizing: border-box; }
  button { font: inherit; padding: .5rem 1rem; }
  .ok { background: #e7f6e7; padding: .75rem 1rem; border-radius: .5rem; }
  .err { background: #fde8e8; padding: .75rem 1rem; border-radius: .5rem; }
  ol li { margin: .4rem 0; }
  code { background: #f2f2f2; padding: 0 .3rem; }
  small { color: #555; }
</style>
<h1>Helios sign-in</h1>
<p>You are <b>${esc(o.email)}</b>. Tools on this connector will act on <a href="${esc(o.helios)}">${esc(o.helios)}</a> as the Helios user whose session you paste here.</p>
${o.notice ? `<p class="ok">${esc(o.notice)}</p>` : ""}
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
${
  o.current
    ? `<p class="ok">Currently signed in as <b>${esc(o.current.user ?? "(unknown)")}</b>, saved ${esc(new Date(o.current.at).toISOString().slice(0, 16).replace("T", " "))} UTC.</p>
<form method="post"><input type="hidden" name="action" value="sign_out"><button>Sign out (forget this session)</button></form>`
    : ""
}
<h2>Paste your Helios session</h2>
<ol>
  <li>Log in at <a href="${esc(o.helios)}/auth/" target="_blank" rel="noopener">${esc(o.helios)}/auth/</a> with Google or GitHub.</li>
  <li>Open the browser's developer tools (F12, or ⌥⌘I on a Mac), go to <b>Application</b> (Chrome/Brave/Edge) or <b>Storage</b> (Firefox) → <b>Cookies</b> → the Helios site, and find the cookie named <code>${esc(o.cookieName)}</code>. A cookie-manager extension shows the same thing in one click.</li>
  <li>Copy its <b>value</b> and paste it below.</li>
</ol>
<form method="post">
  <input type="hidden" name="action" value="sign_in">
  <p><input type="text" name="cookie" autocomplete="off" spellcheck="false" placeholder="${esc(o.cookieName)} value" required></p>
  <p><button>Check and save</button></p>
</form>
<p><small>The value is checked against Helios and kept for you alone, for as long as Helios keeps the session (two weeks of inactivity). Logging out of Helios in the browser ends it everywhere. It is never shown to the assistant.</small></p>`;
