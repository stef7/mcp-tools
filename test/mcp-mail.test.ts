/**
 * mcp-mail against a local D1. Pinned down: a forwarded mail is filed under who really sent it
 * (inline forward, forward as attachment, or sent straight); an unlisted sender bounces and is
 * not kept; a reader not in MAIL_READERS reads nothing, and with it unset nobody does; triaging
 * only flags. (Who is signed in when no email is passed is miniflare's stand-in for Access.)
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-mail/src/index";
import { decodeWords, forwardedBlock, parseMail } from "../workers/mcp-mail/src/mime";

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
    const r = (await call("mail_get_attachment", { id: mail.files[0].id })) as Json;
    expect(r["isError"]).toBeFalsy();
    expect(r["content"][1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "application/pdf", blob: "JVBERi0xLjQK" },
    });
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
