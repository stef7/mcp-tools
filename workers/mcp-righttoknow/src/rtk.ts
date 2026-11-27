// Right to Know runs Alaveteli. Requests, authorities, users and every feed have JSON forms,
// which the site serves without a challenge. Message bodies and attachments are only on the HTML
// request page, and the authority list only in a CSV, both behind a Cloudflare challenge.
// Everything here is plain string work so it can be tested outside a Worker.

export const ORIGIN = "https://www.righttoknow.org.au";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1),
      );
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Alaveteli shortens long URLs in message bodies to their first ~40 characters plus "...",
 * keeping the whole URL only in the href. Put the full URL back as the link text. Only when the
 * visible text is a cut-down copy of the href: any other link text (a name, a redaction) stays.
 */
export const expandLinks = (html: string): string =>
  html.replace(
    /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (m, href: string, inner: string) => {
      const full = decode(href);
      const shown = decode(inner.replace(/<[^>]+>/g, "")).trim();
      const stem = shown.replace(/(?:\.\.\.|…)$/, "");
      if (stem === shown || stem.length < 8 || !full.startsWith(stem)) return m;
      // Re-escape: the result goes back through decode() in htmlToText.
      return full.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    },
  );

/** HTML to readable text: paragraphs and line breaks kept, everything else dropped. */
export const htmlToText = (html: string): string =>
  decode(
    expandLinks(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      // Alaveteli writes "\n<br />", so take the source newline with it.
      .replace(/\s*<br\s*\/?>\s*/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const abs = (href: string) => new URL(decode(href), ORIGIN).href;
const first = (s: string, re: RegExp) => s.match(re)?.[1];

// ---------------------------------------------------------------- feeds

/** One event as Alaveteli's JSON feeds give it (InfoRequestEvent#json_for_api, deep). */
export type RawEvent = {
  id: number;
  event_type: string;
  created_at: string;
  described_state?: string | null;
  calculated_state?: string | null;
  display_status?: string;
  incoming_message_id?: number | null;
  outgoing_message_id?: number | null;
  comment_id?: number | null;
  snippet?: string;
  info_request?: { id: number; url_title: string; title: string; display_status?: string };
  public_body?: { url_name: string; name: string; short_name?: string };
  user?: { url_name: string; name: string };
};

/** `incoming-51880`, `outgoing-33079` or `comment-12`: the anchor on the request page. */
export const anchorOf = (e: RawEvent) =>
  e.incoming_message_id
    ? `incoming-${e.incoming_message_id}`
    : e.outgoing_message_id
      ? `outgoing-${e.outgoing_message_id}`
      : e.comment_id
        ? `comment-${e.comment_id}`
        : undefined;

/** Snippets come with search hits wrapped in <span class="highlight"> and entities left in. */
export const cleanSnippet = (s = "") =>
  htmlToText(s.replace(/<span class="highlight">([\s\S]*?)<\/span>/g, "$1"))
    .replace(/\s+/g, " ")
    .trim();

export const toEntry = (e: RawEvent) => {
  const r = e.info_request;
  const anchor = anchorOf(e);
  return {
    event_id: e.id,
    type: e.event_type,
    at: e.created_at,
    status: e.display_status ?? e.described_state ?? e.calculated_state ?? undefined,
    snippet: e.snippet ? cleanSnippet(e.snippet) : undefined,
    request: r && { slug: r.url_title, title: r.title, id: r.id, status: r.display_status },
    authority: e.public_body && {
      slug: e.public_body.url_name,
      name: e.public_body.name,
      short_name: e.public_body.short_name || undefined,
    },
    requester: e.user && { slug: e.user.url_name, name: e.user.name },
    url: r ? `${ORIGIN}/request/${r.url_title}${anchor ? `#${anchor}` : ""}` : undefined,
  };
};
export type FeedEntry = ReturnType<typeof toEntry>;

// ---------------------------------------------------------------- correspondence

export type Attachment = {
  name: string;
  size?: string | undefined;
  url: string;
  view_url?: string | undefined;
};
export type Message = {
  id: string;
  direction: "incoming" | "outgoing";
  author: string;
  date: string;
  text: string;
  truncated?: boolean | undefined;
  attachments: Attachment[];
  link: string;
};

const parseAttachments = (block: string): Attachment[] =>
  [...block.matchAll(/<li class="attachment"[\s\S]*?<\/li>/g)].map(([li = ""]) => ({
    name: htmlToText(first(li, /class="attachment__name">([\s\S]*?)<\/p>/) ?? ""),
    size: first(li, /class="attachment__meta">\s*([^<\s]+)/),
    url: abs(first(li, /href="([^"]*\/attach\/(?!html\/)[^"]*)"/) ?? ""),
    view_url: ((v) => v && abs(v))(first(li, /href="([^"]*\/attach\/html\/[^"]*)"/)),
  }));

/** Every message on a request page, oldest first. Annotations and the sidebar are ignored. */
export const parseCorrespondence = (html: string, pageUrl: string): Message[] =>
  html
    .split(/(?=<div class="(?:incoming|outgoing) correspondence)/)
    // A zero-width split at index 0 yields no empty first piece, so filter rather than slice.
    .filter((chunk) => chunk.startsWith("<div class="))
    .map((chunk) => {
      const [, direction, num] = chunk.match(/id="(incoming|outgoing)-(\d+)"/) ?? [];
      let body =
        first(chunk, /<div class="correspondence_text">([\s\S]*?)<p class="event_actions">/) ?? "";
      const attachBlock =
        first(
          body,
          /(<div class="attachments">[\s\S]*?attachments__show-more[^>]*><\/a>\s*<\/div>)/,
        ) ?? "";
      body = body
        .replace(attachBlock, "")
        .replace(/<span class="unfold_link">[\s\S]*?<\/span>/g, "");
      return {
        id: `${direction}-${num}`,
        direction: direction as Message["direction"],
        author: htmlToText(
          first(chunk, /correspondence__header__author[^>]*>([\s\S]*?)<\/span>/) ?? "",
        ).replace(/\s*\n\s*/g, " "),
        date: first(chunk, /<time datetime="([^"]+)"/) ?? "",
        text: htmlToText(body),
        attachments: parseAttachments(attachBlock),
        link: `${pageUrl.split(/[?#]/)[0]}#${direction}-${num}`,
      };
    })
    .filter((m) => m.direction);

// ---------------------------------------------------------------- references

/**
 * Accepts a slug, a numeric request id, or any Right to Know URL for a request or one of its
 * events. Returns the slug, or the numeric id, which `/request/<id>.json` redirects from.
 */
export const requestRef = (input: string): { slug: string } | { id: string } => {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { id: s };
  if (!/^https?:|^\//.test(s)) return { slug: s };
  const path = new URL(s, ORIGIN).pathname;
  const slug = first(path, /^\/request\/([^/]+)/);
  if (slug) return /^\d+$/.test(slug) ? { id: slug } : { slug };
  if (/^\/request_event\/\d+/.test(path))
    throw new Error(
      "An event link can only be resolved by loading a page Right to Know protects with a " +
        "challenge. Pass the request's slug instead: every search and feed result carries it.",
    );
  throw new Error(`Not a Right to Know request reference: ${input}`);
};

/** `anu`, `/body/anu` or a full URL to `anu`. Works for users too. */
export const slugOf = (input: string, kind: "body" | "user"): string => {
  const s = input.trim();
  return first(s, new RegExp(`/${kind}/([^/?#.]+)`)) ?? s;
};

// ---------------------------------------------------------------- authorities

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      (row.push(field), rows.push(row), (row = []), (field = ""));
    } else field += c;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((f) => f !== ""));
};

export type Authority = {
  slug: string;
  name: string;
  short_name?: string | undefined;
  /** `federal`, `foi_yes`… as `true`; `wikidata:Q123` as `"Q123"`. */
  tags: Record<string, string | true>;
  home_page?: string | undefined;
  publication_scheme?: string | undefined;
  disclosure_log?: string | undefined;
  notes?: string | undefined;
  updated_at?: string | undefined;
};

/**
 * /body/all-authorities.csv, as Alaveteli's PublicBodyCSV writes it: Internal ID, Name, Short
 * name, URL name, Tags, Home page, Publication scheme, Disclosure log, Notes, Created at,
 * Updated at, Version. Columns are found by header, so a reordering does not break this.
 */
export const parseAuthorities = (csv: string): Authority[] => {
  const [head = [], ...rows] = parseCsv(csv);
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const at = {
    name: col("name"),
    short: col("short name"),
    slug: col("url name"),
    tags: col("tags"),
    home: col("home page"),
    ips: col("publication scheme"),
    log: col("disclosure log"),
    notes: col("notes"),
    updated: col("updated at"),
  };
  if (at.name < 0 || at.slug < 0)
    throw new Error("The authorities CSV has no Name or URL name column.");
  const get = (r: string[], i: number) => (i >= 0 && r[i]?.trim()) || undefined;
  return rows.map((r) => ({
    slug: get(r, at.slug) ?? "",
    name: get(r, at.name) ?? "",
    short_name: get(r, at.short),
    tags: Object.fromEntries(
      (get(r, at.tags) ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => {
          const i = t.indexOf(":");
          return i < 0 ? [t, true] : [t.slice(0, i), t.slice(i + 1)];
        }),
    ),
    home_page: get(r, at.home),
    publication_scheme: get(r, at.ips),
    disclosure_log: get(r, at.log),
    notes: get(r, at.notes),
    updated_at: get(r, at.updated),
  }));
};

/**
 * Authorities whose name, short name or slug holds every word of `query`, and that carry every
 * tag in `tags`. Exact and leading matches on the short name or name rank first.
 */
export const findAuthorities = (all: Authority[], query = "", tags: string[] = []) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const q = words.join(" ");
  const hay = (a: Authority) => `${a.name} ${a.short_name ?? ""} ${a.slug}`.toLowerCase();
  const score = (a: Authority) => {
    const short = (a.short_name ?? "").toLowerCase();
    const name = a.name.toLowerCase();
    if (!q) return 0;
    if (short === q || name === q || a.slug === q) return 0;
    if (name.startsWith(q) || short.startsWith(q)) return 1;
    return 2;
  };
  return all
    .filter((a) => tags.every((t) => t in a.tags))
    .filter((a) => words.every((w) => hay(a).includes(w)))
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
};

/** How many authorities carry each tag, most first. */
export const tagCounts = (all: Authority[]) => {
  const n = new Map<string, number>();
  for (const a of all) for (const t of Object.keys(a.tags)) n.set(t, (n.get(t) ?? 0) + 1);
  return Object.fromEntries([...n].sort((a, b) => b[1] - a[1]));
};

// ---------------------------------------------------------------- repeats

/** Where omitted text first appeared: a message on the same request. */
export type Omission = { from: string; date: string; paragraphs: number; chars: number };

/** Paragraphs, and list items within them, with the separators kept so the text can be rebuilt. */
const UNIT_SPLIT = /(\n{2,}|\n(?=(?:\d{1,2}\.|\([a-z0-9]{1,3}\)|•)\s))/;
/** Shorter than this ("Dear Mr Amir", "Kind regards") is kept even when repeated. */
const MIN_REPEAT = 60;

/** Same words, whatever the line wrapping, case or curly quotes. */
const norm = (s: string) =>
  s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Each message's text with paragraphs that already appeared word for word in an earlier message
 * on the page taken out. Each stretch of them becomes one marker naming the messages it repeats,
 * and a short line caught between two repeats ("SCOPE:") goes with them. Agencies restate the
 * whole request at the top of most letters; this lets a preview reach what a letter says.
 * Messages are read in page order, oldest first.
 */
export const withoutRepeats = (msgs: Message[]) => {
  const seen = new Map<string, { id: string; date: string }>();
  const out = new Map<string, { text: string; omitted: Omission[] }>();
  for (const m of msgs) {
    const parts = m.text.split(UNIT_SPLIT);
    const units = [] as {
      text: string;
      sep: string;
      key: string;
      from?: { id: string; date: string } | undefined;
    }[];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? "";
      const key = norm(text);
      units.push({
        text,
        sep: parts[i + 1] ?? "",
        key,
        from: key.length >= MIN_REPEAT ? seen.get(key) : undefined,
      });
    }
    // A short line between two repeats (a heading such as "SCOPE:") is part of the repeat.
    units.forEach((u, i) => {
      if (u.from || u.key.length >= MIN_REPEAT) return;
      const before = units
        .slice(0, i)
        .reverse()
        .find((x) => x.key);
      const after = units.slice(i + 1).find((x) => x.key);
      if (before?.from && after?.from) u.from = before.from;
    });
    const omitted: Omission[] = [];
    let text = "";
    for (let i = 0; i < units.length;) {
      const u = units[i]!;
      if (!u.from) {
        text += u.text + u.sep;
        i++;
        continue;
      }
      const run: Omission[] = [];
      let paragraphs = 0;
      let chars = 0;
      for (; i < units.length && units[i]!.from; i++) {
        const { from, text: t } = units[i]!;
        const date = from!.date.slice(0, 10);
        const o = run.find((r) => r.from === from!.id);
        if (o) (o.paragraphs++, (o.chars += t.length));
        else run.push({ from: from!.id, date, paragraphs: 1, chars: t.length });
        paragraphs++;
        chars += t.length;
      }
      const sources = run.map((r) => `${r.from} (${r.date})`).join(", ");
      text += `[${paragraphs} para${paragraphs === 1 ? "" : "s"} (${chars} chars) repeated from ${sources}]\n\n`;
      for (const r of run) {
        const o = omitted.find((x) => x.from === r.from);
        if (o) ((o.paragraphs += r.paragraphs), (o.chars += r.chars));
        else omitted.push({ ...r });
      }
    }
    for (const u of units)
      if (u.key.length >= MIN_REPEAT && !seen.has(u.key))
        seen.set(u.key, { id: m.id, date: m.date });
    out.set(m.id, { text: text.trim(), omitted });
  }
  return out;
};
