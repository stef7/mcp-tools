/**
 * Seals a Nextcloud address, login name and app password for mcp-nc.
 *
 * Run it on your own machine. It asks three questions, talks to nothing, writes no file, and
 * prints two values, each of which is useless without the other:
 *
 *   NC_SEALED   the three answers, encrypted. Goes on the worker:
 *                 cd workers/mcp-nc && npx wrangler secret put NC_SEALED
 *   X-Secret-Key     the key. Goes in the Claude connector's request headers as `x-secret-key`.
 *
 * The key is 32 random bytes made here, and the encryption is AES-256-GCM, so there is no
 * passphrase to guess. Run it again to rotate: it makes a new key and a new seal, and both have
 * to be replaced together. workers/mcp-nc/src/dav.ts holds the other half, `unseal`.
 *
 * Usage: node scripts/seal-nextcloud.mjs
 */
const AAD = new TextEncoder().encode("mcp-nc sealed login v1");
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** { url, login, password } -> { sealed, key }. Pure: no input, no output, no network. */
export const seal = async ({ url, login, password }) => {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    new TextEncoder().encode(JSON.stringify({ url, login, password })),
  );
  return { sealed: `v1.${b64url(iv)}.${b64url(data)}`, key: b64url(rawKey) };
};

const main = async () => {
  const { createInterface } = await import("node:readline");
  const tty = process.stdin.isTTY;
  // Questions go to stderr, so the two values can be piped or copied without them.
  const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const ask = async (question, secret = false) => {
    process.stderr.write(question);
    // Raw mode is what stops the terminal echoing the password as it is typed.
    if (secret && tty) process.stdin.setRawMode(true);
    const { value = "" } = await lines.next();
    if (secret && tty) {
      process.stdin.setRawMode(false);
      process.stderr.write("\n");
    }
    if (value.includes("\x03")) process.exit(130); // Ctrl-C, which raw mode hands over as a character
    // Raw mode also hands over backspaces, so apply them.
    let out = "";
    for (const ch of value) out = ch === "\x7f" || ch === "\b" ? out.slice(0, -1) : out + ch;
    return out.trim();
  };
  const url = await ask("Nextcloud address (https://cloud.example.com): ");
  const login = await ask("Login name: ");
  const password = await ask("App password (not shown as you type): ", true);
  process.stdin.pause();
  if (!url || !login || !password) throw new Error("All three are needed. Nothing was sealed.");
  const { sealed, key } = await seal({ url, login, password });
  console.log(`\nNC_SEALED (worker secret: npx wrangler secret put NC_SEALED)\n${sealed}\n`);
  console.log(`X-Secret-Key (Claude connector request header "x-secret-key")\n${key}\n`);
  console.error("Each is useless without the other. Neither is saved anywhere by this script.");
};

// Only when run as a program: the tests import `seal` from inside a Worker, with no terminal.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("seal-nextcloud.mjs"))
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
