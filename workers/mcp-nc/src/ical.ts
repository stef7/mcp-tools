/**
 * iCalendar, read and written without losing anything.
 *
 * An event is edited by changing the properties that were asked about and writing everything
 * else back as it came: attendees, alarms, a phone's X- properties, another client's VTIMEZONE.
 * So a property keeps its parameters as the raw text they arrived in, and a component keeps its
 * properties and children in order.
 */
export type Prop = { name: string; params: string; value: string };
export type Comp = { name: string; props: Prop[]; comps: Comp[] };

/** Splits `NAME;PARAM=x;PARAM="a:b":value` at the first `;` or `:` outside quotes. */
const parseLine = (line: string): Prop | null => {
  let quoted = false;
  let nameEnd = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ";" && nameEnd < 0) nameEnd = i;
    else if (!quoted && ch === ":") {
      const end = nameEnd < 0 ? i : nameEnd;
      return {
        name: line.slice(0, end).toUpperCase(),
        params: line.slice(end, i),
        value: line.slice(i + 1),
      };
    }
  }
  return null;
};

/** The text of a calendar object -> its components. Lines that are not properties are dropped. */
export const parse = (text: string): Comp[] => {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const root: Comp = { name: "", props: [], comps: [] };
  const stack = [root];
  for (const line of lines) {
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    const top = stack[stack.length - 1]!;
    if (p.name === "BEGIN") {
      const comp: Comp = { name: p.value.trim().toUpperCase(), props: [], comps: [] };
      top.comps.push(comp);
      stack.push(comp);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.props.push(p);
  }
  return root.comps;
};

const encoder = new TextEncoder();

/** Folds at 75 octets, as the format asks, without cutting a character in half. */
const fold = (line: string) => {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const width = encoder.encode(ch).length;
    // Continuation lines start with a space, which counts towards their 75.
    if (size + width > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += width;
  }
  out.push(current);
  return out.join("\r\n ");
};

const lines = (c: Comp): string[] => [
  `BEGIN:${c.name}`,
  ...c.props.map((p) => fold(`${p.name}${p.params}:${p.value}`)),
  ...c.comps.flatMap(lines),
  `END:${c.name}`,
];

export const serialise = (c: Comp) => lines(c).join("\r\n") + "\r\n";

/** TEXT values escape backslash, semicolon, comma and newline. */
export const escapeText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
export const unescapeText = (s: string) =>
  s.replace(/\\([\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));

/** A comma-separated TEXT list (CATEGORIES), split only at commas that are not escaped. */
export const splitList = (s: string) =>
  s
    .split(/(?<!\\),/)
    .map((x) => unescapeText(x).trim())
    .filter(Boolean);

export const get = (c: Comp, name: string) => c.props.find((p) => p.name === name);
export const all = (c: Comp, name: string) => c.props.filter((p) => p.name === name);
export const text = (c: Comp, name: string) => {
  const p = get(c, name);
  return p ? unescapeText(p.value) : undefined;
};

/** One parameter of a property, unquoted: param(dtstart, "TZID"). */
export const param = (p: Prop, name: string) => {
  const m = new RegExp(`;${name}=("([^"]*)"|[^;]*)`, "i").exec(p.params);
  return m ? (m[2] ?? m[1]) : undefined;
};

export const remove = (c: Comp, ...names: string[]) => {
  c.props = c.props.filter((p) => !names.includes(p.name));
};

/** Replaces a property where it stands, or adds it. An undefined value removes it. */
export const set = (c: Comp, name: string, value: string | undefined, params = "") => {
  const at = c.props.findIndex((p) => p.name === name);
  if (value === undefined) return remove(c, name);
  const prop = { name, params, value };
  if (at < 0) c.props.push(prop);
  else {
    c.props[at] = prop;
    c.props = c.props.filter((p, i) => p.name !== name || i === at);
  }
};

export const clone = (c: Comp): Comp => ({
  name: c.name,
  props: c.props.map((p) => ({ ...p })),
  comps: c.comps.map(clone),
});
