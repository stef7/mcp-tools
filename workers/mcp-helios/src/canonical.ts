/**
 * Helios hashes objects as base64(sha256(json.dumps(obj, sort_keys=True)))
 * with the trailing "=" removed (helios/crypto/utils.py: hash_b64, helios_auth/utils.py: to_json).
 *
 * Python's json.dumps defaults: separators (", ", ": "), ensure_ascii=True,
 * sort_keys=True. This module reproduces that byte-for-byte for the JSON
 * value types Helios publishes (strings, ints as strings, booleans, null,
 * arrays, objects). Non-integer floats never appear in Helios data.
 */

function pyEscapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        if (code < 0x20 || code > 0x7e) {
          // ensure_ascii: \uXXXX, surrogate pairs stay as two escapes (same as Python)
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    // Python repr of floats; rarely relevant for Helios
    return String(value);
  }
  if (typeof value === "string") return pyEscapeString(value);
  if (Array.isArray(value)) return "[" + value.map(pythonJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // Python sorts by code point; JS default sort is UTF-16 code units, equal for BMP keys
    return (
      "{" + keys.map((k) => pyEscapeString(k) + ": " + pythonJsonDumps(obj[k])).join(", ") + "}"
    );
  }
  throw new Error(`Cannot canonicalise value of type ${typeof value}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Base64NoPad(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const b64 = bytesToBase64(new Uint8Array(digest));
  // hash_b64 strips exactly one trailing "=" ([:-1]); a 32-byte digest always ends in one "="
  return b64.endsWith("=") ? b64.slice(0, -1) : b64;
}

/** Helios object hash: hash_b64(to_json(obj)). */
export async function heliosHash(obj: unknown): Promise<string> {
  return sha256Base64NoPad(pythonJsonDumps(obj));
}
