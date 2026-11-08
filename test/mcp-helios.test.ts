/**
 * mcp-helios against the fake Helios in scripts/mock-helios.mjs.
 *
 * Helios's real cryptography is not exercised here; what is pinned down is everything the worker
 * does on its own: Python-compatible hashing, the form flows (csrf token, redirect-on-success,
 * the two-step voter upload), the admin page parsing that election_status depends on, winner and
 * tie arithmetic, UTC conversion, and the /login page that is the one way a session arrives.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";
import Worker from "../workers/mcp-helios/src/index";
import { heliosHash, pythonJsonDumps } from "../workers/mcp-helios/src/canonical";
import { questionWinners, toHeliosUtc } from "../workers/mcp-helios/src/model";
import { forget, save } from "../workers/mcp-helios/src/session";

const base = inject("heliosBase");
const SESSION = inject("heliosSession");
const ME = "me@example.com";
const search = `?helios=${encodeURIComponent(base)}`;
const DEMO = "11111111-2222-3333-4444-555555555555";

type Spec = {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};
type Res = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };

const helios = () => new Worker(createExecutionContext(), env);
const tools = () => helios().tools({ search }) as Promise<Spec[]>;
/** A call as ME, whose session (if any) is whatever /login or signIn() put in KV. */
const call = (name: string, args: Record<string, unknown> = {}, email: string | undefined = ME) =>
  helios().call(name, args, { search, email }) as Promise<Res>;
/** What /login does once a cookie has been checked. KV rolls back between tests. */
const signIn = (cookie = SESSION) =>
  save(env.SESSIONS, ME, { cookie, url: base, user: "admin@example.org", at: Date.now() });
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
  return r;
};
/** A tool's structured answer: structuredContent where the tool gave one, else the JSON text. */
const payload = <T>(r: Res): T =>
  (r.structuredContent ?? JSON.parse(r.content[0]?.text ?? "null")) as T;
const data = async <T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
) => payload<T>(await ok(name, { ...args, response_format: "json" }));
const fails = async (
  name: string,
  args: Record<string, unknown> = {},
  email: string | undefined = ME,
) => {
  const r = await call(name, args, email);
  expect(r.isError, `${name} should have failed`).toBe(true);
  return r.content[0]!.text;
};
/** A browser request to the worker as ME, the way Cloudflare Access would present it. */
const browse = (path: string, init: RequestInit = {}) => {
  const ctx = createExecutionContext() as ExecutionContext & { access?: unknown };
  ctx.access = { getIdentity: async () => ({ email: ME }) };
  return new Worker(ctx, env).fetch(new Request(`https://mcp-helios.example${path}`, init));
};
const post = (path: string, fields: Record<string, string>) =>
  browse(path, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin: "https://mcp-helios.example" },
  });
const confirmed = { user_confirmed: true };

// Sessions outlive a test within this file, so each starts signed out.
beforeEach(() => forget(env.SESSIONS, ME, base));

describe("the tool list", () => {
  it("carries the worker's prefix and covers the whole election lifecycle", async () => {
    const names = (await tools()).map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(names.every((n) => n.startsWith("helios_"))).toBe(true);
    for (const n of [
      "helios_get_election",
      "helios_election_status",
      "helios_create_election",
      "helios_freeze_election",
      "helios_compute_tally",
      "helios_release_result",
      "helios_verify_ballot",
    ])
      expect(names).toContain(n);
  });

  it("marks reads read-only and every change as needing user_confirmed", async () => {
    for (const t of await tools()) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      const write = t.inputSchema.required?.includes("user_confirmed") ?? false;
      expect(t.annotations["readOnlyHint"], t.name).toBe(!write);
    }
    const by = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(by["helios_freeze_election"]!.annotations["destructiveHint"]).toBe(true);
    expect(by["helios_freeze_election"]!.description).toContain("Irreversible");
    expect(by["helios_add_trustee"]!.annotations["destructiveHint"]).toBe(false);
  });
});

describe("hashing matches Python's json.dumps(sort_keys=True)", () => {
  it("sorts keys, uses ', ' and ': ', and escapes non-ASCII", () => {
    expect(pythonJsonDumps({ b: [1, "2", null, true], a: { z: "é" } })).toBe(
      '{"a": {"z": "\\u00e9"}, "b": [1, "2", null, true]}',
    );
  });
  it("gives the base64 SHA-256 without the trailing '='", async () => {
    // python3 -c 'import json,hashlib,base64;print(base64.b64encode(hashlib.sha256(json.dumps({"b":1,"a":"é"},sort_keys=True).encode()).digest())[:-1].decode())'
    expect(await heliosHash({ b: 1, a: "é" })).toBe("1zkT77MJtZhs3JWS7IaXxaAkwiQM4yF893fTlsTjg60");
  });
});

describe("winners and ties, the way Helios decides them", () => {
  const q = (max: number | null, result_type: "relative" | "absolute" = "relative") =>
    ({
      question: "q",
      answers: ["a", "b", "c", "d"],
      min: 0,
      max,
      choice_type: "approval",
      tally_type: "homomorphic",
      result_type,
    }) as const;
  it("takes the top max", () => {
    expect(questionWinners(q(2), [5, 9, 1, 3], 10)).toEqual({ winners: [1, 0], tied: [] });
  });
  it("leaves a seat unfilled on a tie for it", () => {
    expect(questionWinners(q(2), [5, 9, 5, 1], 10)).toEqual({ winners: [1], tied: [0, 2] });
  });
  it("needs a majority of ballots for an absolute single seat", () => {
    expect(questionWinners(q(1, "absolute"), [4, 3, 2, 1], 10)).toEqual({ winners: [], tied: [] });
    expect(questionWinners(q(1, "absolute"), [6, 3, 1, 0], 10)).toEqual({ winners: [0], tied: [] });
  });
});

describe("times", () => {
  it("turns an offset time into Helios's UTC datetime-local value", () => {
    expect(toHeliosUtc("2026-11-14T17:00:00+11:00")).toBe("2026-11-14T06:00");
    expect(toHeliosUtc("2026-11-13T22:00Z")).toBe("2026-11-13T22:00");
    expect(toHeliosUtc("2026-11-13T22:00")).toBe("2026-11-13T22:00");
    expect(toHeliosUtc(null)).toBe("");
    expect(toHeliosUtc(undefined)).toBeUndefined();
    expect(() => toHeliosUtc("tomorrow")).toThrow(/ISO 8601/);
  });
});

describe("public data, no session", () => {
  it("resolves a short name and reads the election", async () => {
    const r = await call("helios_get_election", { election: "demo-2026", response_format: "json" });
    expect(r.isError).toBeFalsy();
    expect(payload<{ uuid: string }>(r).uuid).toBe(DEMO);
  });
  it("lists ballots and verifies the fingerprint and a tracker from the published JSON", async () => {
    const ballots = payload<{ ballots: { voter_uuid: string; vote_hash: string }[] }>(
      await call("helios_list_ballots", { election: DEMO, response_format: "json" }),
    );
    expect(ballots.ballots).toHaveLength(2);
    const fp = payload<Record<string, unknown>>(
      await call("helios_verify_election_fingerprint", { election: DEMO }),
    );
    expect(fp["matches_displayed"]).toBe(true);
    expect(fp["all_ballots_reference_this_fingerprint"]).toBe(true);
    const b = ballots.ballots[0]!;
    const vb = payload<Record<string, unknown>>(
      await call("helios_verify_ballot", {
        election: DEMO,
        voter_uuid: b.voter_uuid,
        expected_tracker: b.vote_hash,
      }),
    );
    expect(vb["tracker_matches_recorded"]).toBe(true);
    expect(vb["expected_matches_recorded"]).toBe(true);
    const found = payload<Record<string, unknown>>(
      await call("helios_lookup_ballot", { tracker: b.vote_hash }),
    );
    expect(found["election_uuid"]).toBe(DEMO);
  });
  it("explains a result that is not released yet", async () => {
    expect(await fails("helios_get_result", { election: DEMO })).toMatch(/not been released/);
  });
  it("tells an admin tool's caller where a session comes from", async () => {
    expect(await fails("helios_whoami")).toMatch(/\/login/);
  });
  it("sees only the public columns of the roll", async () => {
    const roll = payload<{ admin_view: boolean; summary: { voted: number } }>(
      await call("helios_search_voters", { election: DEMO, response_format: "json" }),
    );
    expect(roll.admin_view).toBe(false);
    expect(roll.summary.voted).toBe(2);
  });
});

describe("the /login page", () => {
  it("needs Cloudflare Access to say who is signing in", async () => {
    const res = await new Worker(createExecutionContext(), env).fetch(
      new Request("https://mcp-helios.example/login"),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Cloudflare Access/);
  });
  it("shows the instructions, naming the cookie and the Helios server", async () => {
    const res = await browse(`/login?helios=${encodeURIComponent(base)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(ME);
    expect(html).toContain("sessionid");
    expect(html).toContain(`${base}/auth/`);
    expect(html).not.toContain("Currently signed in");
  });
  it("checks a pasted cookie against Helios and keeps it for the person", async () => {
    const res = await post(`/login?helios=${encodeURIComponent(base)}`, {
      action: "sign_in",
      cookie: `sessionid=${SESSION}; Path=/`, // pasted with its name and attributes, as happens
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("as admin@example.org");
    const r = await ok("helios_whoami");
    expect(r.content[0]!.text).toContain("admin@example.org");
    const status = payload<Record<string, unknown>>(await ok("helios_session_status"));
    expect(status["signed_in"]).toBe(true);
    expect(status["helios_user"]).toBe("admin@example.org");
    expect(JSON.stringify(status)).not.toContain(SESSION); // the cookie never comes back out
  });
  it("refuses a value Helios does not recognise", async () => {
    const res = await post(`/login?helios=${encodeURIComponent(base)}`, {
      action: "sign_in",
      cookie: "expired",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does not recognise/);
    expect(payload<Record<string, unknown>>(await ok("helios_session_status"))["signed_in"]).toBe(
      false,
    );
  });
  it("refuses a form posted from another site", async () => {
    const res = await browse(`/login?helios=${encodeURIComponent(base)}`, {
      method: "POST",
      body: new URLSearchParams({ action: "sign_in", cookie: SESSION }),
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
  it("signs out from the page or from the tool", async () => {
    await signIn();
    const res = await post(`/login?helios=${encodeURIComponent(base)}`, { action: "sign_out" });
    expect(await res.text()).toContain("Session forgotten");
    expect(payload<Record<string, unknown>>(await ok("helios_session_status"))["signed_in"]).toBe(
      false,
    );
    await signIn();
    await ok("helios_sign_out", { user_confirmed: true });
    expect(await fails("helios_whoami")).toMatch(/\/login/);
  });
  it("says when a stored session has gone stale", async () => {
    await signIn("expired");
    expect(await fails("helios_whoami")).toMatch(/expired or been logged out/);
    expect(payload<Record<string, unknown>>(await ok("helios_session_status"))["signed_in"]).toBe(
      false,
    );
  });
  it("keeps sessions per person", async () => {
    await signIn();
    expect(await fails("helios_whoami", {}, "someone-else@example.com")).toMatch(/\/login/);
  });
});

describe("a whole election, as its administrator", () => {
  it("runs from creation to a released result", async () => {
    await signIn();
    const created = await data("helios_create_election", {
      ...confirmed,
      short_name: "gg-2026",
      name: "Governance Group 2026",
      private: true,
      voting_ends_at: "2026-11-14T17:00:00+11:00",
    });
    const uuid = created["uuid"] as string;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const e1 = await data("helios_get_election", { election: uuid });
    expect(e1["voting_ends_at"]).toBe("2026-11-14 06:00:00"); // 5 pm Melbourne, as UTC

    let st = await data("helios_election_status", { election: uuid });
    expect(st["phase"]).toBe("setup");
    expect((st["setup_issues"] as string[]).length).toBeGreaterThanOrEqual(2);

    await ok("helios_update_election", {
      ...confirmed,
      election: uuid,
      description: "Elect five.",
    });
    const e2 = await data("helios_get_election", { election: uuid });
    expect(e2["name"]).toBe("Governance Group 2026"); // untouched fields survive the resubmit
    expect(e2["voting_ends_at"]).toBe("2026-11-14 06:00:00");

    await ok("helios_set_questions", {
      ...confirmed,
      election: uuid,
      questions: [
        { question: "Elect five", answers: ["A", "B", "C", "D", "E", "F", "G", "H"], max: 5 },
      ],
    });
    await ok("helios_set_questions", {
      ...confirmed,
      election: uuid,
      mode: "append",
      questions: [
        { question: "Adopt the code of conduct?", answers: ["Yes", "No"], result_type: "absolute" },
      ],
    });
    expect((await data("helios_get_election", { election: uuid }))["questions"]).toHaveLength(2);
    expect(
      await fails("helios_set_questions", {
        ...confirmed,
        election: uuid,
        questions: [{ question: "x", answers: ["y"], answer_urls: ["ftp://no"] }],
      }),
    ).toMatch(/http/);

    await ok("helios_add_trustee", {
      ...confirmed,
      election: uuid,
      name: "Brian",
      email: "brian@example.org",
    });
    const tr = await data<{ trustees: { uuid: string; email: string | null }[] }>(
      "helios_list_trustees",
      { election: uuid },
    );
    const brian = tr.trustees.find((t) => t.email === "brian@example.org")!;
    await ok("helios_send_trustee_link", {
      ...confirmed,
      election: uuid,
      trustee_uuid: brian.uuid,
    });
    expect(await fails("helios_freeze_election", { ...confirmed, election: uuid })).toMatch(
      /voter list/,
    );
    await ok("helios_delete_trustee", { ...confirmed, election: uuid, trustee_uuid: brian.uuid });

    expect(
      await fails("helios_upload_voters", {
        ...confirmed,
        election: uuid,
        csv_text: "wizard,gandalf,g@example.org,Gandalf",
      }),
    ).toMatch(/cancelled.*invalid voter type/);
    const dry = await data("helios_upload_voters", {
      ...confirmed,
      election: uuid,
      dry_run: true,
      voters: [{ voter_id: "jane", email: "jane@example.org", name: "Jane Doe" }],
    });
    expect(dry["dry_run"]).toBe(true);
    await ok("helios_upload_voters", {
      ...confirmed,
      election: uuid,
      voters: [
        { voter_id: "jane", email: "jane@example.org", name: "Jane Doe" },
        { voter_id: "ali", email: "ali@example.org", name: "Ali, Jr." },
      ],
    });
    const roll = await data<{ summary: { total_voters: number }; voters: { name: string }[] }>(
      "helios_search_voters",
      { election: uuid, query: "ali" },
    );
    expect(roll.summary.total_voters).toBe(1);
    expect(roll.voters[0]!.name).toBe("Ali, Jr."); // CSV quoting survives both directions
    expect(await fails("helios_email_voters", { ...confirmed, election: uuid })).toMatch(/403/); // not frozen

    expect(
      await fails("helios_add_admin", { ...confirmed, election: uuid, email: "dual@example.org" }),
    ).toMatch(/auth_type/);
    await ok("helios_add_admin", {
      ...confirmed,
      election: uuid,
      email: "dual@example.org",
      auth_type: "github",
    });
    expect(
      (await data("helios_list_admins", { election: uuid }))["additional_admins"],
    ).toHaveLength(1);
    await ok("helios_remove_admin", {
      ...confirmed,
      election: uuid,
      email: "dual@example.org",
      user_type: "github",
    });

    expect(await fails("helios_freeze_election", { election: uuid })).toMatch(/user_confirmed/);
    await ok("helios_freeze_election", { ...confirmed, election: uuid });
    st = await data("helios_election_status", { election: uuid });
    expect(st["phase"]).toBe("voting_open");
    expect(
      await fails("helios_update_election", { ...confirmed, election: uuid, name: "x" }),
    ).toMatch(/403/);
    await ok("helios_extend_voting", {
      ...confirmed,
      election: uuid,
      voting_extended_until: "2026-11-15T17:00+11:00",
    });

    expect(
      (await ok("helios_email_voters", { ...confirmed, election: uuid, preview: true })).content[0]!
        .text,
    ).toContain("<VOTER_NAME>");
    await ok("helios_email_voters", {
      ...confirmed,
      election: uuid,
      body: "Closes Saturday 5 pm.",
    });
    await ok("helios_email_voters", { ...confirmed, election: uuid, voter_login_id: "jane" });
    expect(
      await fails("helios_email_voters", {
        ...confirmed,
        election: uuid,
        template: "simple",
        body: "Hi <VOTER_NAME>",
      }),
    ).toMatch(/Helios fills/);

    await ok("helios_compute_tally", { ...confirmed, election: uuid });
    expect((await data("helios_election_status", { election: uuid }))["phase"]).toBe("tallying");
    await new Promise((r) => setTimeout(r, 500)); // the mock's background tally
    expect((await data("helios_election_status", { election: uuid }))["phase"]).toBe(
      "awaiting_combination",
    );
    expect(
      await fails("helios_upload_voters", {
        ...confirmed,
        election: uuid,
        voters: [{ voter_id: "late", email: "l@example.org", name: "Late" }],
      }),
    ).toMatch(/403/);
    await ok("helios_combine_decryptions", { ...confirmed, election: uuid });
    st = await data("helios_election_status", { election: uuid });
    expect(st["phase"]).toBe("result_computed_unreleased");
    expect(st["tally"]).toHaveLength(2); // the admin-only table, parsed
    await ok("helios_release_result", {
      ...confirmed,
      election: uuid,
      email_voters: true,
      email_body: "Thanks.",
    });
    expect((await data("helios_election_status", { election: uuid }))["phase"]).toBe(
      "result_released",
    );
    const result = await data<{ result: { answers: { winner: boolean }[] }[] }>(
      "helios_get_result",
      { election: uuid },
    );
    expect(result.result[0]!.answers.filter((a) => a.winner)).toHaveLength(5);
    expect(
      (await data("helios_get_election_log", { election: uuid }))["count"],
    ).toBeGreaterThanOrEqual(3);

    await ok("helios_archive_election", { ...confirmed, election: uuid });
    const copy = (await data("helios_copy_election", { ...confirmed, election: uuid }))[
      "new_uuid"
    ] as string;
    expect(copy).toMatch(/^[0-9a-f-]{36}$/);
    await ok("helios_delete_election", { ...confirmed, election: copy });
    expect(await fails("helios_get_election", { election: copy })).toMatch(/404/);
  });
});
