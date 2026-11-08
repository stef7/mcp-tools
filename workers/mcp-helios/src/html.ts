/** Tiny HTML helpers — Helios pages are simple Django templates, regexes are enough. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    const lower = ent.toLowerCase();
    const known = ENTITIES[lower];
    if (known !== undefined) return known;
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return m;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function firstMatch(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m ? m[1] : undefined;
}

export function allMatches(html: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(html)) !== null) out.push(m);
  return out;
}

/** Extract the hidden csrf_token Helios renders into every admin form. */
export function extractCsrfToken(html: string): string | undefined {
  return (
    firstMatch(html, /name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i) ??
    firstMatch(html, /value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i) ??
    firstMatch(html, /CSRF_TOKEN\s*=\s*["']([^"']+)["']/)
  );
}

/** Pull Django form errors (<ul class="errorlist">) and Helios {{error}} blocks out of a page. */
export function extractFormErrors(html: string): string[] {
  const errors: string[] = [];
  for (const m of allMatches(
    html,
    /<ul[^>]*class=["'][^"']*errorlist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i,
  )) {
    for (const li of allMatches(m[1] ?? "", /<li>([\s\S]*?)<\/li>/i))
      errors.push(stripTags(li[1] ?? ""));
  }
  for (const m of allMatches(
    html,
    /<(?:div|p|span)[^>]*class=["'][^"']*\b(?:error|alert|warning)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|span)>/i,
  )) {
    const text = stripTags(m[1] ?? "");
    if (text) errors.push(text);
  }
  return [...new Set(errors)];
}

/** Parse the <table> rows of a simple Helios table into arrays of cell text. */
export function parseTableRows(tableHtml: string): string[][] {
  return allMatches(tableHtml, /<tr[^>]*>([\s\S]*?)<\/tr>/i).map((row) =>
    allMatches(row[1] ?? "", /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i).map((cell) =>
      stripTags(cell[1] ?? ""),
    ),
  );
}

/** Minimal CSV parser (RFC 4180-ish) for Helios CSV downloads. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * Read the current values of a Django-rendered form: text/hidden/number/datetime
 * inputs, checked checkboxes (as "on"), textareas and selects. Unchecked
 * checkboxes are omitted, which is what the browser would send.
 */
export function parseFormValues(html: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const m of allMatches(html, /<input\b([^>]*)>/i)) {
    const attrs = m[1] ?? "";
    const name = firstMatch(attrs, /\bname=["']([^"']+)["']/i);
    if (!name) continue;
    const type = (firstMatch(attrs, /\btype=["']([^"']+)["']/i) ?? "text").toLowerCase();
    const value = decodeEntities(firstMatch(attrs, /\bvalue=["']([^"']*)["']/i) ?? "");
    if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(attrs)) values[name] = value || "on";
      continue;
    }
    values[name] = value;
  }
  for (const m of allMatches(html, /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/i)) {
    const name = firstMatch(m[1] ?? "", /\bname=["']([^"']+)["']/i);
    if (name) values[name] = decodeEntities(m[2] ?? "").replace(/^\n/, "");
  }
  for (const m of allMatches(html, /<select\b([^>]*)>([\s\S]*?)<\/select>/i)) {
    const name = firstMatch(m[1] ?? "", /\bname=["']([^"']+)["']/i);
    if (!name) continue;
    const options = allMatches(m[2] ?? "", /<option\b([^>]*)>([\s\S]*?)<\/option>/i);
    const opt = options.find((o) => /\bselected\b/i.test(o[1] ?? "")) ?? options[0];
    if (opt)
      values[name] = decodeEntities(
        firstMatch(opt[1] ?? "", /\bvalue=["']([^"']*)["']/i) ?? stripTags(opt[2] ?? ""),
      );
  }
  delete values["csrf_token"];
  return values;
}
