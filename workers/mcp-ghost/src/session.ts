/**
 * Signing in to a Ghost site as a member, so paid posts can be read.
 *
 * Ghost members have no passwords: the only way in is a magic link emailed to the address. So
 * signing in is two steps, and the person has to visit their inbox in between.
 *
 *   1. send()     asks Ghost to email a sign-in link.
 *   2. capture()  takes that link, follows it *here* rather than in a browser, and keeps the
 *                 two cookies Ghost sets in reply.
 *
 * The cookies are what actually unlock paid content, and they are per person: they are stored
 * against the Cloudflare Access email of whoever signed in, so nobody reads a paid post on
 * somebody else's subscription.
 *
 * Every endpoint used here is Ghost's own members API, which is public by necessity — it is how
 * the sign-up form on any Ghost site works.
 */
import { BROWSER_UA } from "../../../core/web";

export type Session = {
  cookie: string;
  sig: string;
  /** The Ghost member this is, which need not be the Access email that stored it. */
  member?: string;
  at: number;
};

const members = (base: string, path: string) => `${base}/members/api/${path}`;
const ua = { "User-Agent": BROWSER_UA };

/**
 * Ghost wants an integrity token with a sign-in request, to make the endpoint less useful to
 * spammers. Older versions have no such endpoint and take the request without one.
 */
const integrityToken = async (base: string) => {
  const res = await fetch(members(base, "integrity-token/"), { headers: ua });
  if (!res.ok) return undefined;
  return (await res.text()).trim() || undefined;
};

/**
 * Ask Ghost to email a sign-in link. Ghost answers the same way whether or not the address is a
 * member — deliberately, so the endpoint cannot be used to test who has an account — so a 201
 * here means the request was accepted, not that an email is on its way.
 */
export const send = async (base: string, email: string) => {
  const integrityToken_ = await integrityToken(base);
  const res = await fetch(members(base, "send-magic-link"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ua },
    body: JSON.stringify({
      email,
      emailType: "signin",
      honeypot: "",
      ...(integrityToken_ ? { integrityToken: integrityToken_ } : {}),
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 300), hadToken: !!integrityToken_ };
};

/** Workers give each Set-Cookie its own entry; older runtimes fold them into one string. */
const setCookies = (res: Response): string[] => {
  const all = res.headers.getSetCookie?.();
  if (all?.length) return all;
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
};

const cookieValue = (headers: string[], name: string) => {
  // `name=value; Path=/; Max-Age=...` — the value runs to the first semicolon.
  const found = headers.find((h) => h.startsWith(`${name}=`));
  return (
    found
      ?.slice(name.length + 1)
      .split(";")[0]
      ?.trim() || undefined
  );
};

/** Ghost says how long the session lasts; honour that rather than guessing a TTL. */
const maxAge = (headers: string[], name: string) => {
  const found = headers.find((h) => h.startsWith(`${name}=`));
  const secs = Number(found?.match(/max-age=(\d+)/i)?.[1]);
  return Number.isFinite(secs) && secs > 60 ? secs : undefined;
};

/**
 * Follow a magic link and keep what Ghost sets in reply. Redirects are not followed: the cookies
 * are on the first response, and following the redirect would only fetch a web page.
 *
 * The link is single-use. Anything that opened it first — a mail scanner, a preview pane, the
 * person themselves — has already spent it, and Ghost will answer without setting cookies.
 */
export const capture = async (
  link: string,
): Promise<{ session: Session; ttl?: number | undefined } | { problem: string }> => {
  let res: Response;
  try {
    res = await fetch(link, { redirect: "manual", headers: ua });
  } catch (e) {
    return { problem: `Could not open the link: ${e instanceof Error ? e.message : String(e)}` };
  }
  const headers = setCookies(res);
  const cookie = cookieValue(headers, "ghost-members-ssr");
  const sig = cookieValue(headers, "ghost-members-ssr.sig");
  if (!cookie || !sig) {
    return {
      problem:
        `That link did not sign anyone in (Ghost answered ${res.status} and set no session ` +
        "cookies). Sign-in links are single-use and short-lived, so this one was most likely " +
        "already spent — by a mail scanner, a preview pane, or an earlier click — or it has " +
        "expired. Run ghost_login again and use the newest email without opening the link " +
        "first.",
    };
  }
  return { session: { cookie, sig, at: Date.now() }, ttl: maxAge(headers, "ghost-members-ssr") };
};

/** Confirm a captured session really works, and find out who it belongs to. */
export const whoami = async (base: string, s: Session) => {
  const res = await fetch(members(base, "member/"), {
    headers: { ...ua, Cookie: cookieHeader(s) },
  });
  if (!res.ok) return undefined;
  const me = (await res.json().catch(() => null)) as { email?: string } | null;
  return me?.email;
};

export const cookieHeader = (s: Session) =>
  `ghost-members-ssr=${s.cookie}; ghost-members-ssr.sig=${s.sig}`;

// ─── Storage ───────────────────────────────────────────────────────────────────────────────────

/** One session per person per site. The Access email keeps them apart. */
const key = (email: string, host: string) => `session:${email}:${host}`;
const YEAR = 60 * 60 * 24 * 365;

export const save = (kv: KVNamespace, email: string, host: string, s: Session, ttl?: number) =>
  // KV refuses anything under a minute, and a year is long enough for any member session.
  kv.put(key(email, host), JSON.stringify(s), {
    expirationTtl: Math.min(Math.max(ttl ?? YEAR, 60), YEAR),
  });

export const load = (kv: KVNamespace, email: string, host: string) =>
  kv.get(key(email, host), { type: "json" }).catch(() => null) as Promise<Session | null>;

export const forget = (kv: KVNamespace, email: string, host: string) => kv.delete(key(email, host));
