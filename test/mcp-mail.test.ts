/**
 * mcp-mail against a local D1. Pinned down: a forwarded mail is filed under who really sent it
 * (inline forward, forward as attachment, or sent straight); an unlisted sender bounces and is
 * not kept; a reader not in MAIL_READERS reads nothing, and with it unset nobody does; triaging
 * only flags; raw messages and attachments of any size go to R2, and a document is read back as
 * Markdown, converted once and then cached. (Who is signed in when no email is passed is
 * miniflare's stand-in for Access. Workers AI is faked: it only exists once deployed.)
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-mail/src/index";
import {
  decodeWords,
  forwardedBlock,
  normaliseDate,
  parseMail,
} from "../workers/mcp-mail/src/mime";

type Res = { content: { text: string }[]; isError?: boolean };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ME = "me@example.com"; // MAIL_READERS in vitest.config.mts
const worker = () => new Worker(createExecutionContext(), env);
const call = (name: string, args: Json = {}, email: string | undefined = ME) =>
  worker().call(name, args, email ? { email } : {}) as Promise<Res>;
const ok = async (name: string, args: Json = {}) => {
  const r = await call(name, args);
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Json;
};

const enc = new TextEncoder();
/** What Email Routing hands the worker, with a record of any bounce. */
const deliver = async (from: string, raw: string) => {
  const bounced: string[] = [];
  const message = {
    from,
    to: "jobs@example.org",
    raw: new Response(enc.encode(raw)).body!,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: (why: string) => void bounced.push(why),
    forward: async () => ({}) as never,
    reply: async () => ({}) as never,
  } as unknown as ForwardableEmailMessage;
  await worker().email(message);
  return bounced;
};

const INLINE = [
  "From: Me <me@proton.me>",
  "To: jobs@example.org",
  "Subject: Fwd: Lead Front End role",
  "Message-ID: <fwd-1@proton.me>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Thought this one was worth filing.",
  "",
  "------- Forwarded Message -------",
  "From: Jane Recruiter <jane@agency.example>",
  "Date: On Friday, 20 November 2026 at 3:14 PM",
  "Subject: Lead Front End role",
  "To: me@proton.me",
  "",
  "Hi Stefano, are you open to a chat about a Lead Front End contract?",
].join("\r\n");

const ATTACHED = [
  "From: me@proton.me",
  "Subject: =?utf-8?B?RndkOiBJbnRlcnZpZXcg4oCTIG5leHQgc3RlcHM=?=",
  "Message-ID: <fwd-2@proton.me>",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See attached.",
  "--b1",
  "Content-Type: message/rfc822",
  'Content-Disposition: attachment; filename="original.eml"',
  "",
  "From: Sam Hiring <sam@company.example>",
  "Subject: Interview next steps",
  "Date: Thu, 19 Nov 2026 09:00:00 +1100",
  'Content-Type: multipart/alternative; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>We=E2=80=99d like to book a second interview.</p>",
  "--b2--",
  "--b1",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="pd.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--b1--",
].join("\r\n");

describe("parsing", () => {
  it("decodes encoded words", () => {
    expect(decodeWords("=?utf-8?B?RndkOiBJbnRlcnZpZXcg4oCTIG5leHQgc3RlcHM=?=")).toBe(
      "Fwd: Interview – next steps",
    );
    expect(decodeWords("=?iso-8859-1?Q?caf=E9_bar?=")).toBe("café bar");
  });
  it("reads Gmail's attribution line too", () => {
    expect(
      forwardedBlock(
        "fyi\n---------- Forwarded message ---------\nOn Wed, 4 Nov 2026 at 21:44, Sam Lee <sam@x.example> wrote:\n> hi",
      ),
    ).toMatchObject({ from: "Sam Lee <sam@x.example>", note: "fyi" });
  });
  it("makes dates unambiguous and readable", () => {
    const cases: [string, string, string | null][] = [
      ["Wednesday, 11/04/26 at 21:44", "4 Nov 2026", "21:44"], // Proton phone: month first
      ["Thursday, 05/11/26 at 09:00", "5 Nov 2026", "09:00"], // weekday says day first here
      ["13/11/2026", "13 Nov 2026", null], // a part over 12 decides
      ["Wednesday, November 4th, 2026 at 9:44 PM", "4 Nov 2026", "21:44"],
      ["Nov 4, 2026", "4 Nov 2026", null],
      ["4 November 2026 at 21:44", "4 Nov 2026", "21:44"],
      ["Sat, 21 Nov 2026 12:08:01 +0000", "21 Nov 2026", "23:08"], // shown in Melbourne time
    ];
    for (const [text, date, time] of cases)
      expect(normaliseDate(text), text).toMatchObject({ date, time });
    expect(normaliseDate("Wednesday, 11/04/26")?.iso).toBe("2026-11-04");
    expect(normaliseDate("no date here")).toBeUndefined();
  });
  it("reads an inline forward block", () => {
    expect(forwardedBlock(parseMail(enc.encode(INLINE)).text)).toMatchObject({
      from: "Jane Recruiter <jane@agency.example>",
      subject: "Lead Front End role",
    });
  });
  it("walks multipart, quoted-printable html and an attached message", () => {
    const p = parseMail(enc.encode(ATTACHED));
    expect(p.text).toContain("See attached.");
    expect(p.inner?.get("from")).toBe("Sam Hiring <sam@company.example>");
    expect(p.attachments).toContainEqual(
      expect.objectContaining({ filename: "pd.pdf", type: "application/pdf", size: 9 }),
    );
  });
});

describe("filing and reading", () => {
  it("bounces an unlisted sender and keeps nothing", async () => {
    const before = (await ok("mail_status"))["total"];
    const bounced = await deliver("stranger@example.net", INLINE.replace("fwd-1", "x-1"));
    expect(bounced[0]).toMatch(/not allowed/);
    expect((await ok("mail_status"))["total"]).toBe(before);
  });

  it("files an inline forward under the original sender", async () => {
    expect(await deliver("me@proton.me", INLINE)).toEqual([]);
    const { messages } = await ok("mail_list", { search: "Lead Front End" });
    expect(messages[0]).toMatchObject({
      original_from: "Jane Recruiter <jane@agency.example>",
      subject: "Lead Front End role",
      triaged: false,
    });
    const got = await ok("mail_get", { ids: [messages[0].id, 999999] });
    expect(got["missing"]).toEqual([999999]);
    const full = got["messages"][0];
    expect(full["envelope_from"]).toBe("me@proton.me");
    expect(full["text"]).toContain("open to a chat");
    expect(full["raw_kept"]).toBe(true);
  });

  it("files a forward-as-attachment under the attached message's sender", async () => {
    expect(await deliver("someone@proton.me", ATTACHED)).toEqual([]); // @proton.me is allowed
    const { messages } = await ok("mail_list", { search: "second interview" });
    expect(messages[0]).toMatchObject({
      original_from: "Sam Hiring <sam@company.example>",
      subject: "Interview next steps",
      attachment_count: 2,
    });
    const [mail] = (await ok("mail_get", { ids: [messages[0].id] }))["messages"];
    expect(mail.files).toEqual([
      { id: expect.any(Number), filename: "pd.pdf", type: "application/pdf", size: 9, kept: true },
    ]);
    const r = (await call("mail_get_attachment", { id: mail.files[0].id, as: "file" })) as Json;
    expect(r["isError"]).toBeFalsy();
    expect(r["content"][1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "application/pdf", blob: "JVBERi0xLjQK" },
    });
  });

  it("keeps a big attachment in R2 and reads a document back as Markdown, converting once", async () => {
    const big = new Uint8Array(2_500_000).fill(65); // over the old 1.9 MB D1 limit
    const raw = [
      "From: me@proton.me",
      "Message-ID: <fwd-big@proton.me>",
      "Subject: Big JD",
      'Content-Type: multipart/mixed; boundary="d"',
      "",
      "--d",
      "Content-Type: text/plain",
      "",
      "JD attached, it is a big one.",
      "--d",
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="jd.docx"',
      "Content-Transfer-Encoding: base64",
      "",
      "BODY",
      "--d--",
    ].join("\r\n");
    // Base64 in chunks whose size divides by 3, so the pieces join into one valid body.
    let b64 = "";
    for (let i = 0; i < big.length; i += 0x6000)
      b64 += btoa(String.fromCharCode(...big.subarray(i, i + 0x6000)));
    const body = b64.replace(/(.{76})/g, "$1\r\n");
    expect(await deliver("me@proton.me", raw.replace("BODY", body))).toEqual([]);

    const { messages } = await ok("mail_list", { search: "big one" });
    const [mail] = (await ok("mail_get", { ids: [messages[0].id] }))["messages"];
    expect(mail.raw_kept).toBe(true);
    expect(mail.files).toEqual([
      expect.objectContaining({ filename: "jd.docx", size: big.length, kept: true }),
    ]);
    const stored = await env.MAIL_FILES.list();
    expect(stored.objects.some((o) => o.key.endsWith("-jd.docx") && o.size === big.length)).toBe(
      true,
    );

    const asked: { name: string; type: string; size: number }[] = [];
    const ai = {
      toMarkdown: async (doc: { name: string; blob: Blob }) => {
        asked.push({ name: doc.name, type: doc.blob.type, size: doc.blob.size });
        return {
          id: "1",
          name: doc.name,
          mimeType: doc.blob.type,
          format: "markdown",
          tokens: 9,
          data: "# Senior AWS Software Engineer\n\n" + "x".repeat(150_000),
        };
      },
    };
    const read = async (args: Json) => {
      const ctx = createExecutionContext();
      const w = new Worker(ctx, { ...env, AI: ai as unknown as Ai });
      const r = (await w.call("mail_get_attachment", args, { email: ME })) as Res;
      await waitOnExecutionContext(ctx);
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      return r.content[0]!.text;
    };
    const first = await read({ id: mail.files[0].id });
    expect(first).toContain("# Senior AWS Software Engineer");
    expect(first).toMatch(/more: pass offset 100000/);
    expect(asked).toEqual([
      {
        name: "jd.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: big.length,
      },
    ]);
    const second = await read({ id: mail.files[0].id, offset: 100_000 });
    expect(second).toMatch(/characters 100000–\d+ of \d+:/);
    expect(second).not.toMatch(/more: pass offset/);
    expect(asked).toHaveLength(1); // the second page came from the cache
  });

  it("converts a Word file sent with its real type, not mistaking it for XML text", async () => {
    const raw = [
      "From: me@proton.me",
      "Message-ID: <fwd-docx@proton.me>",
      "Subject: Word JD",
      'Content-Type: multipart/mixed; boundary="w"',
      "",
      "--w",
      "Content-Type: text/plain",
      "",
      "Word JD attached.",
      "--w",
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="jd.docx"',
      'Content-Disposition: attachment; filename="jd.docx"',
      "Content-Transfer-Encoding: base64",
      "",
      "UEsDBBQAAAAIAA==",
      "--w--",
    ].join("\r\n");
    await deliver("me@proton.me", raw);
    const { messages } = await ok("mail_list", { search: "Word JD attached" });
    const [mail] = (await ok("mail_get", { ids: [messages[0].id] }))["messages"];
    let calls = 0;
    const ai = {
      toMarkdown: async (doc: { name: string; blob: Blob }) => {
        calls++;
        return {
          id: "1",
          name: doc.name,
          mimeType: doc.blob.type,
          format: "markdown",
          tokens: 3,
          data: "# Converted JD",
        };
      },
    };
    const ctx = createExecutionContext();
    const w = new Worker(ctx, { ...env, AI: ai as unknown as Ai });
    const r = (await w.call("mail_get_attachment", { id: mail.files[0].id }, { email: ME })) as Res;
    await waitOnExecutionContext(ctx);
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.content[0]!.text).toContain("# Converted JD");
    expect(r.content[0]!.text).not.toContain("PK");
    expect(calls).toBe(1);
  });

  it("opens a text attachment as text", async () => {
    const raw = [
      "From: me@proton.me",
      "Message-ID: <fwd-3@proton.me>",
      "Subject: Notes",
      'Content-Type: multipart/mixed; boundary="c"',
      "",
      "--c",
      "Content-Type: text/plain",
      "",
      "Notes attached.",
      "--c",
      'Content-Type: text/csv; name="roles.csv"',
      "Content-Disposition: attachment",
      "",
      "company,role\r\nZeller,Staff FE",
      "--c--",
    ].join("\r\n");
    await deliver("me@proton.me", raw);
    const { messages } = await ok("mail_list", { search: "Notes attached" });
    const [mail] = (await ok("mail_get", { ids: [messages[0].id] }))["messages"];
    const r = (await call("mail_get_attachment", { id: mail.files[0].id })) as Json;
    expect(r["content"][0].text).toContain("Zeller,Staff FE");
  });

  it("keeps any sender when MAIL_ALLOWED_FROM is unset", async () => {
    const open = new Worker(createExecutionContext(), { ...env, MAIL_ALLOWED_FROM: undefined });
    const raw = INLINE.replace("fwd-1", "star-1").replace(/Lead Front End/g, "Star sender");
    const bounced: string[] = [];
    await open.email({
      from: "anyone@example.net",
      to: "jobs@example.org",
      raw: new Response(enc.encode(raw)).body!,
      setReject: (why: string) => void bounced.push(why),
    } as unknown as ForwardableEmailMessage);
    expect(bounced).toEqual([]);
    expect((await ok("mail_list", { search: "Star sender" }))["messages"]).toHaveLength(1);
  });

  it("reads Proton's attribution-line forward, keeping the forwarder's note", async () => {
    const raw = [
      "From: Stefano Perfili <me@proton.me>",
      "Subject: Fw: Message replied: Principle Lead Engineer",
      "Message-ID: <fwd-proton@proton.me>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "I never got back to her",
      "",
      "-------- Original Message --------",
      "On Wednesday, 11/04/26 at 21:44 Courtney-Amber Paioni <hit-reply@linkedin.com> wrote:",
      "",
      "> Hey Stefano, it's absolutely not too late.",
    ].join("\r\n");
    await deliver("me@proton.me", raw);
    const { messages } = await ok("mail_list", { search: "absolutely not too late" });
    expect(messages[0]).toMatchObject({
      original_from: "Courtney-Amber Paioni <hit-reply@linkedin.com>",
      original_date: "4 Nov 2026",
      original_time: "21:44",
      original_date_iso: "2026-11-04",
      original_date_text: "Wednesday, 11/04/26 at 21:44",
      subject: "Message replied: Principle Lead Engineer",
      forwarder_note: "I never got back to her",
    });
    const [full] = (await ok("mail_get", { ids: [messages[0].id] }))["messages"];
    expect(full).toMatchObject({
      original_from: "Courtney-Amber Paioni <hit-reply@linkedin.com>",
      forwarder_note: "I never got back to her",
    });
    expect(full.text).toContain("I never got back to her"); // the note stays in the text too
  });

  it("does not file the same Message-ID twice", async () => {
    const before = (await ok("mail_status"))["total"];
    await deliver("me@proton.me", INLINE);
    expect((await ok("mail_status"))["total"]).toBe(before);
  });

  it("triaging flags, notes, and hides from the default list", async () => {
    const { messages } = await ok("mail_list", { search: "Lead Front End" });
    const id = messages[0].id;
    expect(await ok("mail_mark_triaged", { ids: [id], note: "Filed in Notion" })).toEqual({
      updated: 1,
    });
    expect((await ok("mail_list", { search: "Lead Front End" }))["messages"]).toEqual([]);
    const again = await ok("mail_list", { search: "Lead Front End", include_triaged: true });
    expect(again["messages"][0]).toMatchObject({ id, triaged: true, note: "Filed in Notion" });
  });

  it("reads nothing for someone not in MAIL_READERS", async () => {
    for (const name of [
      "mail_list",
      "mail_get",
      "mail_get_attachment",
      "mail_status",
      "mail_mark_triaged",
    ]) {
      const r = await call(name, { id: 1, ids: [1] }, "intruder@example.com");
      expect(r.isError, `${name}: ${r.content[0]!.text}`).toBe(true);
      expect(r.content[0]!.text).not.toContain("agency.example");
    }
  });

  it("reads nothing at all when MAIL_READERS is unset", async () => {
    const bare = new Worker(createExecutionContext(), { ...env, MAIL_READERS: undefined });
    const r = (await bare.call("mail_list", {}, { email: ME })) as Res;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/MAIL_READERS is not set/);
  });
});
