/**
 * mcp-helios — Helios Voting (vote.heliosvoting.org, or any helios-server) as MCP tools.
 *
 * Public, hash-verified data needs no login:
 *   helios_get_election, helios_list_trustees, helios_list_voters, helios_get_voter,
 *   helios_list_ballots, helios_get_result, helios_lookup_ballot, helios_list_audited_ballots,
 *   helios_get_crypto_params
 * Independent verification of what the server claims:
 *   helios_verify_election_fingerprint, helios_verify_ballot, helios_hash
 * Administration, as the signed-in Helios user:
 *   helios_whoami, helios_election_status, helios_create_election, helios_update_election,
 *   helios_extend_voting, helios_set_questions, trustees, administrators, voters, emails,
 *   helios_freeze_election, helios_compute_tally, helios_combine_decryptions,
 *   helios_release_result, archive / copy / delete, helios_get_election_log
 *
 * Helios has no API tokens: admin actions are Django form POSTs guarded by the session cookie of
 * a browser that logged in (Google or GitHub on heliosvoting.org) plus a per-session csrf_token
 * that client.ts scrapes from an admin page. Each administrator pastes their cookie once on this
 * worker's /login page (see session.ts); it is kept in KV against their Cloudflare Access email
 * and never passes through a tool call. helios_session_status says who you are acting as;
 * helios_sign_out forgets it.
 *
 *   GET  /login                              the sign-in page, behind Access
 *   POST /?helios=https://helios.example.org a Helios other than HELIOS_URL / heliosvoting.org
 *
 * This worker is deliberately not bound into mcp-toolkit: a session cookie is the administrator
 * themselves, so it gets its own URL and its own Cloudflare Access policy — which is also what
 * tells it who is calling.
 */
import cfg from "../wrangler.json";
import { version } from "../package.json";
import { mcpWorker, tool, type Ctx, type Tools } from "../../../core/mcp";
import { HeliosClient, HeliosError } from "./client";
import { heliosHash } from "./canonical";
import { forget, load, loginPage, needsAccess, save, whoami, type Session } from "./session";
import {
  allMatches,
  csvEscape,
  decodeEntities,
  extractFormErrors,
  firstMatch,
  parseCsv,
  parseFormValues,
  parseTableRows,
  stripTags,
} from "./html";
import {
  NEXT_STEP,
  describeQuestions,
  detectPhase,
  electionUrls,
  fetchElection,
  fetchRoll,
  fmtUtc,
  parseAdminTally,
  prettyResult,
  toHeliosQuestion,
  toHeliosUtc,
  type CastVote,
  type Meta,
  type QuestionInput,
  type ShortCastVote,
  type Trustee,
  type Voter,
} from "./model";

const DEFAULT_URL = "https://vote.heliosvoting.org";
const HOW_TO_AUTH = "open this connector's /login page and paste it there.";

const normaliseUrl = (raw: string) =>
  (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
const heliosUrl = (c: Ctx) =>
  normaliseUrl(c.params.get("helios") ?? c.env.HELIOS_URL ?? DEFAULT_URL);

const clientWith = (c: Ctx, baseUrl: string, cookie?: string) =>
  new HeliosClient({
    baseUrl,
    sessionCookie: cookie,
    cookieName: c.env.HELIOS_COOKIE_NAME ?? "sessionid",
    howToAuth: HOW_TO_AUTH,
  });

/** The caller's own stored session for this Helios, if they have one. */
const sessionFor = async (c: Ctx, baseUrl: string): Promise<Session | null> => {
  const email = await c.email();
  return email ? load(c.env.SESSIONS, email, baseUrl) : null;
};

/** One client per call: the cookie is per caller, and the csrf token is per session. */
const clientFor = async (c: Ctx): Promise<HeliosClient> => {
  const baseUrl = heliosUrl(c);
  const s = await sessionFor(c, baseUrl);
  return clientWith(c, baseUrl, s?.cookie);
};

const result = (text: string, data?: unknown) => ({
  content: [{ type: "text" as const, text }],
  ...(data !== undefined ? { structuredContent: data } : {}),
});
const md = (lines: (string | false | undefined)[]) =>
  lines.filter((l) => l !== false && l !== undefined).join("\n");

const ELECTION = {
  type: "string",
  description:
    "Election UUID, or its short name (the slug in https://vote.heliosvoting.org/helios/e/<short-name>).",
} as const;
const FORMAT = {
  type: "string",
  enum: ["markdown", "json"],
  description: "'markdown' (default) for readable text, 'json' for the raw structured data.",
} as const;
const UUID_IN_PATH = /\/helios\/elections\/([0-9a-f-]{36})/i;
const uuidFromLocation = (location: string | undefined) =>
  (location && UUID_IN_PATH.exec(location)?.[1]?.toLowerCase()) || "";

const QUESTION = {
  type: "object",
  required: ["question", "answers"],
  properties: {
    question: { type: "string", description: "Question text, e.g. 'Elect two members'." },
    answers: {
      type: "array",
      items: { type: "string" },
      description: "Answer options in ballot order (candidates, Yes/No, ...).",
    },
    answer_urls: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional 'more info' http(s) URL per answer, same length as answers; '' for none.",
    },
    min: {
      type: "integer",
      minimum: 0,
      description: "Minimum selections a voter must make (default 0, which lets voters abstain).",
    },
    max: {
      type: ["integer", "null"],
      description: "Maximum selections (default 1); null = no maximum. The top `max` answers win.",
    },
    result_type: {
      type: "string",
      enum: ["relative", "absolute"],
      description:
        "'relative' (default): most votes wins. 'absolute': a single-seat question also needs a majority of all ballots cast.",
    },
    randomize_answer_order: {
      type: "boolean",
      description: "Show this question's answers to each voter in a random order.",
    },
  },
} as const;

const tools: Tools = {
  // ───────────────────────────── public data ─────────────────────────────
  get_election: tool({
    description:
      "An election's public, hash-verified definition — name, description, questions and answers, voting window, public key, frozen state — plus its metadata (private flag, help email). Works by UUID or short name; use it first to learn an election's UUID. For admin-only state (tally progress, unreleased result, next step) use helios_election_status.",
    input: {
      type: "object",
      required: ["election"],
      properties: { election: ELECTION, response_format: FORMAT },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, response_format }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const meta = await client.getJson<Meta>(client.electionPath(uuid, "/meta"));
      const urls = electionUrls(client.baseUrl, uuid, election.short_name);
      const data = { ...election, meta, urls };
      if (response_format === "json") return data;
      return md([
        `# ${election.name}`,
        `- UUID: \`${uuid}\`  ·  short name: \`${election.short_name}\``,
        `- Private: ${meta.private_p ? "yes (only listed voters can see it)" : "no"}  ·  open registration: ${election.openreg ? "yes" : "no"}  ·  voter aliases: ${election.use_voter_aliases ? "yes" : "no"}  ·  randomise answers: ${meta.randomize_answer_order ? "yes" : "no"}`,
        `- Frozen: ${election.frozen_at ? fmtUtc(election.frozen_at) : "no (ballot still editable)"}`,
        `- Voting: ${election.voting_starts_at ? fmtUtc(election.voting_starts_at) : "opens at freeze"} → ${election.voting_ends_at ? fmtUtc(election.voting_ends_at) : "closed manually by computing the tally"}`,
        `- Help email: ${meta.help_email}`,
        "",
        election.description ? `## Description\n${election.description}\n` : undefined,
        `## Questions\n${describeQuestions(election.questions)}`,
        "",
        `## Links\n${Object.entries(urls)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")}`,
      ]);
    },
  }),

  list_trustees: tool({
    description:
      "An election's trustees and their key status: whether each has uploaded a public key (needed before freezing) and a partial decryption (needed after the tally). The Helios server's own trustee has email null.",
    input: {
      type: "object",
      required: ["election"],
      properties: { election: ELECTION, response_format: FORMAT },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, response_format }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const trustees = await client.getJson<Trustee[]>(client.electionPath(uuid, "/trustees/"));
      const summary = trustees.map((t) => ({
        uuid: t.uuid,
        email: t.email,
        is_helios_server: t.email === null,
        has_public_key: Boolean(t.public_key),
        public_key_hash: t.public_key_hash,
        has_decrypted: Boolean(t.decryption_factors),
      }));
      if (response_format === "json")
        return { election_uuid: uuid, count: trustees.length, trustees: summary };
      if (!summary.length)
        return "No trustees. Add one with helios_add_helios_trustee (server-held key) or helios_add_trustee (a person).";
      return summary
        .map(
          (t, i) =>
            `${i + 1}. ${t.is_helios_server ? "Helios server (automatic)" : t.email} — uuid \`${t.uuid}\` — public key: ${t.has_public_key ? "uploaded" : "MISSING"}${t.public_key_hash ? ` (${t.public_key_hash})` : ""} — partial decryption: ${t.has_decrypted ? "done" : "not yet"}`,
        )
        .join("\n");
    },
  }),

  list_voters: tool({
    description:
      "The public voter roll as published for verification: voter uuid plus name/voter_type/voter_id_hash, or just an alias when the election uses aliases. Paginated by uuid: pass `after` = the last uuid of the previous page. For emails, login ids and who has voted, administrators use helios_search_voters.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Voters per page (default 100, max 500).",
        },
        after: {
          type: "string",
          description: "Pagination cursor: return voters whose uuid sorts after this one.",
        },
        response_format: FORMAT,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, limit = 100, after, response_format }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const qs = new URLSearchParams({ limit: String(limit) });
      if (after) qs.set("after", after);
      const voters = await client.getJson<Voter[]>(client.electionPath(uuid, `/voters/?${qs}`));
      const last = voters[voters.length - 1];
      const nextAfter = voters.length === limit && last ? last.uuid : undefined;
      if (response_format === "json")
        return {
          election_uuid: uuid,
          count: voters.length,
          voters,
          has_more: Boolean(nextAfter),
          ...(nextAfter ? { next_after: nextAfter } : {}),
        };
      return md([
        `${voters.length} voter(s) on this page:`,
        ...voters.map(
          (v) =>
            `- ${v.alias ?? v.name ?? "(unnamed)"}${v.voter_type ? ` [${v.voter_type}]` : ""} — uuid \`${v.uuid}\``,
        ),
        nextAfter ? `More: call again with after="${nextAfter}".` : "End of list.",
      ]);
    },
  }),

  get_voter: tool({
    description:
      "The public record of one voter by voter uuid, optionally with their cast ballots: 'all' lists every ballot they cast (tracker and time), 'last' returns the full last ballot including the encrypted answers.",
    input: {
      type: "object",
      required: ["election", "voter_uuid"],
      properties: {
        election: ELECTION,
        voter_uuid: {
          type: "string",
          description: "Voter uuid from helios_list_voters or helios_list_ballots.",
        },
        ballots: {
          type: "string",
          enum: ["none", "all", "last"],
          description: "Also fetch this voter's ballots (default none).",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, voter_uuid, ballots = "none" }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const v = encodeURIComponent(voter_uuid);
      const data: Record<string, unknown> = {
        voter: await client.getJson(client.electionPath(uuid, `/voters/${v}`)),
      };
      if (ballots === "all")
        data["ballots"] = await client.getJson(client.electionPath(uuid, `/ballots/${v}/all`));
      if (ballots === "last")
        data["last_ballot"] = await client.getJson(client.electionPath(uuid, `/ballots/${v}/last`));
      return data;
    },
  }),

  list_ballots: tool({
    description:
      "The public bulletin board of cast ballots, most recent first: each voter's latest ballot tracker (vote_hash), voter_uuid, voter_hash and cast time. Only voters who have voted appear, so the count is the turnout so far. Paginate with `after` = cast_at of the last row.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        limit: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          description: "Maximum ballots (default 200; 0 = all).",
        },
        after: {
          type: "string",
          description:
            "Only ballots cast after this cast_at, exactly as returned, e.g. '2026-11-14 03:08:27.938681'.",
        },
        response_format: FORMAT,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, limit = 200, after, response_format }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const qs = new URLSearchParams();
      if (limit > 0) qs.set("limit", String(limit));
      if (after) qs.set("after", after);
      const ballots = await client.getJson<ShortCastVote[]>(
        client.electionPath(uuid, `/ballots/${qs.size ? "?" + qs : ""}`),
      );
      if (response_format === "json")
        return { election_uuid: uuid, count: ballots.length, ballots };
      return md([
        `${ballots.length} cast ballot(s)${limit > 0 && ballots.length === limit ? " (page full — there may be more)" : ""}:`,
        ...ballots.map(
          (b) =>
            `- ${fmtUtc(b.cast_at)} — tracker \`${b.vote_hash}\` — voter uuid \`${b.voter_uuid}\``,
        ),
      ]);
    },
  }),

  get_result: tool({
    description:
      "The released tally: per question, each answer's count and the winners/ties computed as Helios does (the top `max` answers; a tie for the last seat leaves it unfilled; an 'absolute' single-seat question also needs a majority of ballots cast). Forbidden until the administrator releases it — before then an admin sees the tally in helios_election_status.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        include_proof: {
          type: "boolean",
          description: "Also fetch the decryption factors and proofs (large).",
        },
        response_format: FORMAT,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, include_proof, response_format }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const raw = await client.getJson<number[][]>(client.electionPath(uuid, "/result"));
      const ballots = await client.getJson<ShortCastVote[]>(client.electionPath(uuid, "/ballots/"));
      const pretty = prettyResult(election.questions ?? [], raw, ballots.length);
      const data: Record<string, unknown> = {
        election_uuid: uuid,
        name: election.name,
        ballots_cast: ballots.length,
        result: pretty,
        raw_result: raw,
      };
      if (include_proof)
        data["result_proof"] = await client.getJson(client.electionPath(uuid, "/result_proof"));
      if (response_format === "json") return data;
      return md([
        `# Result: ${election.name}`,
        `Ballots cast: ${ballots.length}`,
        "",
        ...pretty.map(
          (q, i) =>
            `## Q${i + 1}. ${q.question}\n` +
            [...q.answers]
              .sort((a, b) => b.count - a.count)
              .map(
                (a) =>
                  `- ${a.winner ? "**" : ""}${a.answer}: ${a.count}${a.winner ? " ✔**" : ""}${a.tied ? " _(tied)_" : ""}`,
              )
              .join("\n") +
            (q.unfilled_seats
              ? `\n_${q.unfilled_seats} seat(s) left unfilled because of a tie._`
              : ""),
        ),
      ]);
    },
  }),

  lookup_ballot: tool({
    description:
      "Find a cast ballot from its smart ballot tracker — the full vote_hash, or the short hash in a receipt URL /helios/v/<tiny>. Returns the election, the voter's name or alias, the fingerprint and the encrypted vote. For 'did my vote get recorded?'.",
    input: {
      type: "object",
      required: ["tracker"],
      properties: {
        tracker: { type: "string", description: "Smart ballot tracker, full or tiny." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ tracker }, c) => {
      const client = await clientFor(c);
      const t = tracker.trim();
      const path =
        t.length >= 40
          ? `/helios/vh/${encodeURIComponent(t)}`
          : `/helios/v/${encodeURIComponent(t)}`;
      const html = await client.getText(path);
      const link = /cast in <a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(html);
      const voteText = firstMatch(html, /<textarea[^>]*>([\s\S]*?)<\/textarea>/i)?.trim();
      let vote: unknown = voteText;
      try {
        vote = voteText ? JSON.parse(decodeEntities(voteText)) : undefined;
      } catch {
        /* keep the raw text */
      }
      const data = {
        title: stripTags(firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i) ?? ""),
        election_uuid: link ? UUID_IN_PATH.exec(link[1] ?? "")?.[1] : undefined,
        election_name: link ? stripTags(link[2] ?? "") : undefined,
        voter: stripTags(firstMatch(html, /by <b><u>\s*([\s\S]*?)\s*<\/u><\/b>/i) ?? ""),
        fingerprint: firstMatch(html, /Fingerprint:\s*<tt>([^<]+)<\/tt>/i),
        vote,
      };
      if (!data.fingerprint)
        throw new HeliosError(`No ballot page could be read at ${path}.`, 404, "not_found");
      return data;
    },
  }),

  list_audited_ballots: tool({
    description:
      "Ballots voters chose to audit (open and discard) rather than cast, published so anyone can check the booth's encryption. Pass a vote_hash to fetch that audited ballot's plaintext and randomness. Only available once the election is frozen.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        vote_hash: {
          type: "string",
          description: "Fetch this one audited ballot instead of the list.",
        },
        after: {
          type: "string",
          description: "Pagination cursor: the last vote_hash of the previous page.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, vote_hash, after, limit = 50 }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      if (vote_hash)
        return client.getText(
          client.electionPath(uuid, `/audited-ballots/?vote_hash=${encodeURIComponent(vote_hash)}`),
          "text/plain",
        );
      const qs = new URLSearchParams({ limit: String(limit) });
      if (after) qs.set("after", after);
      const html = await client.getText(client.electionPath(uuid, `/audited-ballots/?${qs}`));
      const hashes = allMatches(html, /<tt[^>]*>([^<]+)<\/tt>\s*\[<a[^>]*href="\?vote_hash=/i).map(
        (m) => decodeEntities((m[1] ?? "").trim()),
      );
      const last = hashes[hashes.length - 1];
      return {
        election_uuid: uuid,
        count: hashes.length,
        audited_ballot_hashes: hashes,
        has_more: hashes.length === limit,
        ...(hashes.length === limit && last ? { next_after: last } : {}),
      };
    },
  }),

  get_crypto_params: tool({
    description:
      "The server-wide ElGamal group (p, q, g) every election's keys use. For independent verification.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async (_a, c) => (await clientFor(c)).getJson("/helios/elections/params"),
  }),

  // ─────────────────────────── verification ───────────────────────────
  verify_election_fingerprint: tool({
    description:
      "Recompute the election fingerprint (SHA-256 of the canonical election JSON, base64) from the published data and compare it with the one the election page displays and with the election_hash inside recent cast ballots. A match means ballots were encrypted against exactly this ballot and public key. Meaningful once frozen.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        sample_ballots: {
          type: "integer",
          minimum: 0,
          maximum: 50,
          description: "Recent ballots to check for a matching election_hash (default 5).",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, sample_ballots = 5 }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const computed = await heliosHash(election);
      const displayed = await client
        .getText(client.electionPath(uuid, "/view"))
        .then((h) =>
          firstMatch(h, /Election Fingerprint:\s*<br\s*\/?>\s*<tt[^>]*>([^<]+)<\/tt>/i)?.trim(),
        )
        .catch(() => undefined);
      const recent =
        sample_ballots > 0
          ? await client.getJson<ShortCastVote[]>(
              client.electionPath(uuid, `/ballots/?limit=${sample_ballots}`),
            )
          : [];
      const checks = await Promise.all(
        recent.map(async (b) => {
          const full = await client.getJson<CastVote>(
            client.electionPath(uuid, `/ballots/${b.voter_uuid}/last`),
          );
          return {
            vote_hash: b.vote_hash,
            election_hash_matches: full.vote?.election_hash === computed,
          };
        }),
      );
      const matches = displayed ? displayed === computed : null;
      const allMatch = checks.every((b) => b.election_hash_matches);
      const verdict = !election.frozen_at
        ? "Election is not frozen yet, so the fingerprint is not final."
        : matches === false
          ? "MISMATCH: the fingerprint computed from the published JSON differs from the one the page displays. Investigate before trusting this election."
          : matches
            ? "OK: computed fingerprint matches the one Helios displays."
            : "Computed the fingerprint; the page's displayed fingerprint could not be read (private election, or the page changed).";
      return result(
        md([
          verdict,
          `Computed: ${computed}`,
          `Displayed: ${displayed ?? "—"}`,
          checks.length
            ? `Ballots checked: ${checks.length} — ${allMatch ? "all" : "NOT all"} reference this fingerprint`
            : undefined,
          `Full cryptographic verification: ${electionUrls(client.baseUrl, uuid).verifier}`,
        ]),
        {
          election_uuid: uuid,
          frozen: Boolean(election.frozen_at),
          computed_fingerprint: computed,
          displayed_fingerprint: displayed ?? null,
          matches_displayed: matches,
          ballots_checked: checks.length,
          all_ballots_reference_this_fingerprint: allMatch,
          ballot_checks: checks,
        },
      );
    },
  }),

  verify_ballot: tool({
    description:
      "For one voter (by voter uuid) fetch their last cast ballot, recompute the smart ballot tracker from the encrypted vote, and check it matches the published vote_hash and references the election's current fingerprint. Pass the tracker from the voter's receipt to confirm it is the ballot the server recorded.",
    input: {
      type: "object",
      required: ["election", "voter_uuid"],
      properties: {
        election: ELECTION,
        voter_uuid: { type: "string" },
        expected_tracker: {
          type: "string",
          description: "Tracker from the voter's receipt, to compare with the recorded one.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, voter_uuid, expected_tracker }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const fingerprint = await heliosHash(election);
      const cast = await client.getJson<CastVote>(
        client.electionPath(uuid, `/ballots/${encodeURIComponent(voter_uuid)}/last`),
      );
      const recomputed = await heliosHash(cast.vote);
      const data = {
        election_uuid: uuid,
        voter_uuid,
        cast_at: cast.cast_at,
        recorded_vote_hash: cast.vote_hash,
        recomputed_vote_hash: recomputed,
        tracker_matches_recorded: recomputed === cast.vote_hash,
        ballot_matches_election:
          cast.vote?.election_hash === fingerprint && cast.vote?.election_uuid === uuid,
        expected_matches_recorded: expected_tracker
          ? expected_tracker.trim() === cast.vote_hash
          : null,
        receipt_url: `${client.baseUrl}/helios/vh/${encodeURIComponent(cast.vote_hash)}`,
      };
      return result(
        md([
          data.tracker_matches_recorded
            ? "OK: recomputed tracker matches the recorded vote_hash."
            : "MISMATCH: the recomputed tracker differs from the recorded vote_hash.",
          data.ballot_matches_election
            ? "OK: the ballot references this election's fingerprint."
            : "WARNING: the ballot's election_hash/uuid does not match the current election definition.",
          expected_tracker
            ? data.expected_matches_recorded
              ? "OK: the voter's receipt tracker matches the recorded ballot."
              : "MISMATCH: the receipt tracker is not the recorded ballot (they may have re-voted; the last ballot counts)."
            : undefined,
          `Recorded: ${cast.vote_hash}`,
          `Cast at: ${cast.cast_at}`,
          `Receipt: ${data.receipt_url}`,
        ]),
        data,
      );
    },
  }),

  hash: tool({
    description:
      "Helios's fingerprint of any JSON value: SHA-256 of Python-canonical JSON (sorted keys, ', ' and ': ' separators), base64 without padding. For checking a trustee's public_key_hash, an audited ballot, or an election JSON saved earlier.",
    input: {
      type: "object",
      required: ["json"],
      properties: { json: { type: "string", description: "A JSON document." } },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: async ({ json }) => {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch (e) {
        throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      return heliosHash(value);
    },
  }),

  // ────────────────────────────── session ──────────────────────────────
  session_status: tool({
    description:
      "Whether you have a Helios session on this connector, and which Helios user it is. Sessions are pasted once on the connector's /login page and kept against your Cloudflare Access email; this tool never returns the cookie itself. Call it when an admin tool says there is no session.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async (_a, c) => {
      const baseUrl = heliosUrl(c);
      const email = await c.email();
      if (!email) throw needsAccess();
      const s = await sessionFor(c, baseUrl);
      if (!s)
        return result(
          `${email} has no Helios session for ${baseUrl}. Open this connector's /login page to add one; public tools work regardless.`,
          { access_email: email, helios: baseUrl, signed_in: false },
        );
      const live = await whoami(clientWith(c, baseUrl, s.cookie));
      return result(
        live
          ? `${email} acts on ${baseUrl} as Helios user ${live} (session saved ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC).`
          : `${email} has a stored session for ${baseUrl} but Helios no longer accepts it (logged out or expired). Sign in again on the /login page.`,
        {
          access_email: email,
          helios: baseUrl,
          signed_in: Boolean(live),
          helios_user: live ?? null,
          saved_at: new Date(s.at).toISOString(),
        },
      );
    },
  }),

  sign_out: tool({
    description:
      "Forget your stored Helios session on this connector. Does not log you out of Helios itself — do that in the browser to end the session everywhere.",
    confirm: "Forgets your stored Helios session.",
    annotations: { destructiveHint: true },
    run: async (_a, c) => {
      const baseUrl = heliosUrl(c);
      const email = await c.email();
      if (!email) throw needsAccess();
      await forget(c.env.SESSIONS, email, baseUrl);
      return `Forgot ${email}'s Helios session for ${baseUrl}.`;
    },
  }),

  // ────────────────────────────── status ──────────────────────────────
  whoami: tool({
    description:
      "Check the administrator session: who Helios thinks you are, and the elections you administer (name, uuid, voters, votes cast). Call it first when an admin tool fails.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async (_a, c) => {
      const client = await clientFor(c);
      client.requireSession("helios_whoami");
      const home = await client.getText("/");
      const who = firstMatch(home, /logged in as\s*<b>([\s\S]*?)<\/b>/i);
      if (!who)
        throw new HeliosError(
          `The home page of ${client.baseUrl} shows nobody logged in: the stored session has expired or been logged out. Log in to Helios in the browser again and ${HOW_TO_AUTH}`,
          401,
          "auth",
        );
      const list = await client.getText("/helios/elections/administered");
      const elections = allMatches(
        list,
        /<li>\s*<a href="[^"]*\/elections\/([0-9a-f-]{36})\/view">([\s\S]*?)<\/a>\s*<em>\s*-\s*(\d+) voters \/ (\d+) cast votes<\/em>/i,
      ).map((m) => ({
        uuid: (m[1] ?? "").toLowerCase(),
        name: stripTags(m[2] ?? ""),
        num_voters: Number(m[3]),
        num_cast_votes: Number(m[4]),
      }));
      const user = stripTags(who);
      const user_type = firstMatch(who, /login-icons\/([a-z0-9_]+)\.png/i);
      return result(
        md([
          `Logged in to ${client.baseUrl} as ${user}${user_type ? ` (${user_type})` : ""}.`,
          elections.length ? "Elections you administer:" : "You administer no elections yet.",
          ...elections.map(
            (e) =>
              `- ${e.name} — uuid \`${e.uuid}\` — ${e.num_voters} voters / ${e.num_cast_votes} cast`,
          ),
        ]),
        { server: client.baseUrl, user, user_type, administered_elections: elections },
      );
    },
  }),

  election_status: tool({
    description:
      "One-call dashboard: lifecycle phase (setup → ready to freeze → voting → tallying → awaiting trustees → result unreleased → released), what Helios says the next step is, outstanding setup issues, trustee key/decryption status, voter count and turnout, voting window, and — for admins before release — the computed tally. Use it before any lifecycle action.",
    input: {
      type: "object",
      required: ["election"],
      properties: { election: ELECTION, response_format: FORMAT },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, response_format }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const [meta, trustees, ballots, view] = await Promise.all([
        client.getJson<Meta>(client.electionPath(uuid, "/meta")),
        client.getJson<Trustee[]>(client.electionPath(uuid, "/trustees/")),
        client.getJson<ShortCastVote[]>(client.electionPath(uuid, "/ballots/")),
        client.getText(client.electionPath(uuid, "/view")),
      ]);
      const nextHtml =
        firstMatch(view, /<b>Next Step:<\/b>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ?? "";
      const nextText = stripTags(nextHtml);
      const phase = detectPhase(nextText, view, election);
      const adminSession =
        Boolean(nextHtml) ||
        (/this election is complete/i.test(view) && /<h3[^>]*>Tally<\/h3>/i.test(view));
      const issues =
        phase === "setup"
          ? nextText
              .split(/,\s*and\s*/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const roll = await fetchRoll(client, uuid).catch(() => undefined);
      const voted = roll ? roll.rows.filter((r) => r.voted).length : ballots.length;
      const tally =
        phase === "result_computed_unreleased" || phase === "result_released"
          ? parseAdminTally(view)
          : [];
      const trusteeSummary = trustees.map((t) => ({
        uuid: t.uuid,
        email: t.email,
        is_helios_server: t.email === null,
        has_public_key: Boolean(t.public_key),
        has_decrypted: Boolean(t.decryption_factors),
      }));
      const urls = electionUrls(client.baseUrl, uuid, election.short_name);
      const data = {
        election_uuid: uuid,
        name: election.name,
        short_name: election.short_name,
        phase,
        next_step: NEXT_STEP[phase],
        helios_next_step_text: nextText || null,
        admin_session: adminSession,
        setup_issues: issues,
        private: meta.private_p,
        open_registration: election.openreg,
        frozen_at: election.frozen_at,
        voting_starts_at: election.voting_starts_at,
        voting_ends_at: election.voting_ends_at,
        questions: election.questions?.length ?? 0,
        trustees: trusteeSummary,
        voters: roll
          ? { total: roll.rows.length, voted, not_voted: roll.rows.length - voted }
          : { total: null, voted, not_voted: null },
        ballots_cast: ballots.length,
        tally,
        urls,
      };
      if (response_format === "json") return data;
      return md([
        `# ${election.name} — ${phase.replaceAll("_", " ")}`,
        `**Next:** ${NEXT_STEP[phase]}`,
        nextText
          ? `Helios says: _${nextText}_`
          : !adminSession && "_(Not an admin session: phase inferred from public data only.)_",
        "",
        `- Questions: ${data.questions}  ·  Private: ${meta.private_p ? "yes" : "no"}  ·  Open registration: ${election.openreg ? "yes" : "no"}`,
        `- Frozen: ${election.frozen_at ? fmtUtc(election.frozen_at) : "no"}  ·  Voting: ${election.voting_starts_at ? fmtUtc(election.voting_starts_at) : "at freeze"} → ${election.voting_ends_at ? fmtUtc(election.voting_ends_at) : "manual close"}`,
        `- Voters: ${roll ? `${voted}/${roll.rows.length} voted` : `${ballots.length} ballots cast`}`,
        `- Trustees: ${trusteeSummary.map((t) => `${t.is_helios_server ? "Helios server" : t.email} [key ${t.has_public_key ? "✓" : "✗"}, decrypted ${t.has_decrypted ? "✓" : "✗"}]`).join("; ") || "none"}`,
        tally.length
          ? `\n## Tally${phase === "result_computed_unreleased" ? " (UNRELEASED — admins only)" : ""}\n` +
            tally
              .map(
                (q, i) =>
                  `**Q${i + 1}. ${q.question}**\n` +
                  q.answers
                    .map(
                      (a) =>
                        `- ${a.winner ? "**" : ""}${a.answer}: ${a.count}${a.winner ? "**" : ""}${a.tied ? " (tied)" : ""}`,
                    )
                    .join("\n"),
              )
              .join("\n")
          : undefined,
        `\nAdmin page: ${urls.admin_view}`,
      ]);
    },
  }),

  // ───────────────────────── election lifecycle ─────────────────────────
  create_election: tool({
    description:
      "Create an election; you become its administrator and the Helios server its initial trustee. Returns the new UUID and admin URL. Then helios_set_questions, helios_upload_voters (or open registration), helios_freeze_election. Times are UTC on Helios: give ISO 8601 with an offset (2026-11-14T17:00+11:00) and they are converted.",
    input: {
      type: "object",
      required: ["short_name", "name"],
      properties: {
        short_name: {
          type: "string",
          description:
            "URL slug, unique on the server: letters, digits, hyphens, underscores. E.g. 'fpm-gg-2026'.",
        },
        name: { type: "string", description: "Display name (max 100 chars)." },
        description: {
          type: "string",
          description: "Shown to voters on the election page (max 4000 chars).",
        },
        election_type: { type: "string", enum: ["election", "referendum"] },
        private: {
          type: "boolean",
          description:
            "Only uploaded voters and admins can see the election (default true; recommended for membership votes).",
        },
        use_voter_aliases: {
          type: "boolean",
          description: "Show voters as V12 etc. in the public ballot tracking centre.",
        },
        randomize_answer_order: { type: "boolean" },
        help_email: { type: "string", description: "Address voters can contact for help." },
        voting_starts_at: {
          type: "string",
          description: "ISO 8601; omit to open voting as soon as the election is frozen.",
        },
        voting_ends_at: {
          type: "string",
          description: "ISO 8601; omit to close voting manually by computing the tally.",
        },
        election_info_url: {
          type: "string",
          description: "Only on servers that allow it: URL of a PDF with candidate statements.",
        },
      },
    },
    confirm: "Creates a new election on the Helios server.",
    annotations: { destructiveHint: false },
    run: async (a, c) => {
      const client = await clientFor(c);
      if (!/^[A-Za-z0-9_-]+$/.test(a.short_name))
        throw new Error("short_name may contain only letters, digits, hyphens and underscores.");
      const res = await client.postForm("/helios/elections/new", {
        short_name: a.short_name,
        name: a.name,
        description: a.description ?? "",
        election_type: a.election_type ?? "election",
        use_voter_aliases: a.use_voter_aliases ?? false,
        randomize_answer_order: a.randomize_answer_order ?? false,
        private_p: a.private ?? true,
        help_email: a.help_email ?? "",
        voting_starts_at: toHeliosUtc(a.voting_starts_at) ?? "",
        voting_ends_at: toHeliosUtc(a.voting_ends_at) ?? "",
        election_info_url: a.election_info_url,
      });
      const uuid = uuidFromLocation(res.location);
      if (!uuid)
        throw new HeliosError(
          `Election was not created; Helios answered: ${extractFormErrors(res.body).join("; ") || stripTags(res.body).slice(0, 300)}`,
          res.status,
          "form",
        );
      const urls = electionUrls(client.baseUrl, uuid, a.short_name);
      return result(
        `Created "${a.name}" — uuid ${uuid}\nAdmin page: ${urls.admin_view}\nNext: helios_set_questions, then voters, then helios_freeze_election.`,
        { uuid, short_name: a.short_name, name: a.name, urls },
      );
    },
  }),

  update_election: tool({
    description:
      "Change an unfrozen election's settings. Only the fields given change; the rest are read from the current edit form and resubmitted. Fails with 403 once frozen (use helios_extend_voting for the end time then).",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        short_name: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        election_type: { type: "string", enum: ["election", "referendum"] },
        private: { type: "boolean" },
        use_voter_aliases: { type: "boolean" },
        randomize_answer_order: { type: "boolean" },
        help_email: { type: "string" },
        voting_starts_at: { type: ["string", "null"], description: "ISO 8601; null clears it." },
        voting_ends_at: { type: ["string", "null"], description: "ISO 8601; null clears it." },
        election_info_url: { type: "string" },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, ...changes }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const current = parseFormValues(await client.getText(client.electionPath(uuid, "/edit")));
      if (!("short_name" in current))
        throw new HeliosError(
          "Could not read the edit form: is the election frozen, or are you not its administrator?",
          403,
          "forbidden",
        );
      const fields: Record<string, string | undefined> = { ...current };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined || k === "user_confirmed") continue;
        changed.push(k);
        const field = k === "private" ? "private_p" : k;
        if (k === "voting_starts_at" || k === "voting_ends_at")
          fields[field] = toHeliosUtc(v as string | null);
        else if (typeof v === "boolean") {
          if (v) fields[field] = "on";
          else delete fields[field];
        } else fields[field] = String(v);
      }
      await client.postForm(client.electionPath(uuid, "/edit"), fields);
      return `Updated ${changed.join(", ") || "nothing"} on election ${uuid}.`;
    },
  }),

  extend_voting: tool({
    description:
      "Set or change voting_extended_until on a frozen election that has an end time, pushing the close later. Works until the tally is computed.",
    input: {
      type: "object",
      required: ["election", "voting_extended_until"],
      properties: {
        election: ELECTION,
        voting_extended_until: {
          type: ["string", "null"],
          description: "ISO 8601 new closing time (with offset), or null to remove the extension.",
        },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, voting_extended_until }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const value = toHeliosUtc(voting_extended_until) ?? "";
      await client.postForm(client.electionPath(uuid, "/extend"), { voting_extended_until: value });
      return value
        ? `Voting on ${uuid} extended until ${value} UTC.`
        : `Voting extension removed on ${uuid}.`;
    },
  }),

  set_questions: tool({
    description:
      "Replace (or append to) the questions of an unfrozen election. Helios ballots are approval-style: a voter ticks between `min` and `max` answers and the `max` answers with most votes win. A 5-seat committee from 8 candidates: min 0, max 5. A Yes/No referendum: answers ['Yes','No'], max 1, result_type 'absolute'.",
    input: {
      type: "object",
      required: ["election", "questions"],
      properties: {
        election: ELECTION,
        questions: { type: "array", items: QUESTION },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description:
            "'replace' (default) overwrites the whole ballot; 'append' adds after the existing questions.",
        },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, questions, mode = "replace" }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      if (election.frozen_at)
        throw new HeliosError(
          "This election is frozen; its questions can no longer change.",
          403,
          "forbidden",
        );
      const fresh = (questions as QuestionInput[]).map(toHeliosQuestion);
      const all = mode === "append" ? [...(election.questions ?? []), ...fresh] : fresh;
      const res = await client.postForm(
        client.electionPath(uuid, "/save_questions"),
        { questions_json: JSON.stringify(all) },
        { expectBody: true },
      );
      if (res.body.trim() !== "SUCCESS")
        throw new HeliosError(
          `Helios did not save the questions (${res.body.trim().slice(0, 200) || "no body"}).`,
          res.status,
          "form",
        );
      return result(
        md([
          `Saved ${all.length} question(s) on ${uuid}:`,
          ...all.map(
            (q, i) =>
              `${i + 1}. ${q.question} (${q.answers.length} answers, select ${q.min}–${q.max ?? "∞"}, ${q.result_type})`,
          ),
        ]),
        { election_uuid: uuid, questions: all },
      );
    },
  }),

  // ─────────────────────────────── trustees ───────────────────────────────
  add_trustee: tool({
    description:
      "Add a person as trustee of an unfrozen election. They hold a share of the decryption key: after adding, helios_send_trustee_link emails them their dashboard, where they generate a keypair and upload the public key. Freezing waits for every trustee's public key, and if any trustee loses their secret key the result can never be decrypted.",
    input: {
      type: "object",
      required: ["election", "name", "email"],
      properties: { election: ELECTION, name: { type: "string" }, email: { type: "string" } },
    },
    confirm: true,
    annotations: { destructiveHint: false },
    run: async ({ election: id, name, email }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/trustees/new"), { name, email });
      const added = (await client.getJson<Trustee[]>(client.electionPath(uuid, "/trustees/"))).find(
        (t) => t.email === email,
      );
      return `Added trustee ${name} <${email}>${added ? ` (uuid ${added.uuid})` : ""}. Now helios_send_trustee_link so they can generate their key.`;
    },
  }),

  add_helios_trustee: tool({
    description:
      "Add (or re-add) the Helios server itself as a trustee with a server-held key, so the result can be decrypted without human trustees. New elections already have one.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: true,
    annotations: { destructiveHint: false },
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/trustees/add-helios"), {});
      return `Helios server trustee added to ${uuid}.`;
    },
  }),

  delete_trustee: tool({
    description:
      "Remove a trustee from an unfrozen election — e.g. the Helios server trustee, so only your human trustees can decrypt. Trustee uuids come from helios_list_trustees.",
    input: {
      type: "object",
      required: ["election", "trustee_uuid"],
      properties: { election: ELECTION, trustee_uuid: { type: "string" } },
    },
    confirm: "Removes the trustee and their key share from the election.",
    run: async ({ election: id, trustee_uuid }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/trustees/delete"), { uuid: trustee_uuid });
      return `Trustee ${trustee_uuid} removed from ${uuid}.`;
    },
  }),

  send_trustee_link: tool({
    description:
      "Have Helios email a trustee the secret link to their dashboard (key generation before freeze; partial decryption after the tally). Safe to repeat.",
    input: {
      type: "object",
      required: ["election", "trustee_uuid"],
      properties: { election: ELECTION, trustee_uuid: { type: "string" } },
    },
    confirm: "Sends an email to the trustee.",
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, trustee_uuid }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(
        client.electionPath(uuid, `/trustees/${encodeURIComponent(trustee_uuid)}/sendurl`),
        {},
      );
      return `Trustee link emailed for trustee ${trustee_uuid}.`;
    },
  }),

  // ──────────────────────── freeze / tally / release ────────────────────────
  freeze_election: tool({
    description:
      "Freeze the ballot: questions and trustees become final, the public key is combined, and voting opens at once (or at voting_starts_at). IRREVERSIBLE. Runs Helios's own readiness check first and refuses with the list of issues if any remain; without `user_confirmed` it only reports that check.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: "Irreversible: locks the ballot and opens voting.",
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const html = await client.getText(client.electionPath(uuid, "/freeze"));
      const block = firstMatch(
        html,
        /Before you can freeze the election, you will need to:\s*<ul>([\s\S]*?)<\/ul>/i,
      );
      const issues = block
        ? allMatches(block, /<li>([\s\S]*?)<\/li>/i).map((m) => stripTags(m[1] ?? ""))
        : [];
      if (issues.length || !/value=["']Freeze the ballot["']/i.test(html))
        return {
          content: [
            {
              type: "text" as const,
              text: md([
                "Not ready to freeze.",
                issues.length
                  ? "Helios lists these issues:"
                  : "The freeze form was not offered (already frozen, or not an administrator).",
                ...issues.map((i) => `- ${i}`),
              ]),
            },
          ],
          isError: true,
        };
      await client.postForm(client.electionPath(uuid, "/freeze"), {});
      return `Election ${uuid} is frozen; registration was ${/currently <b>open<\/b>/i.test(html) ? "OPEN (anyone who logs in may vote)" : "closed (listed voters only)"}. Voting is open, or opens at the scheduled start. Next: helios_email_voters with template 'vote'.`;
    },
  }),

  compute_tally: tool({
    description:
      "Close voting and homomorphically combine all cast ballots into the encrypted tally. IRREVERSIBLE: no ballots can be cast afterwards and the voter list is locked. Helios refuses while ballots are still being verified in the background. The Helios server trustee decrypts its share automatically; human trustees then use their dashboards.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: "Irreversible: closes voting for good and starts the tally.",
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const res = await client.postForm(
        client.electionPath(uuid, "/compute_tally"),
        {},
        { expectBody: true },
      );
      if (res.status === 200) {
        const pending = firstMatch(res.body, /(\d+)\s+votes?\s+still being processed/i);
        throw new HeliosError(
          pending
            ? `Helios is still verifying ${pending} cast ballot(s); wait a minute and try again.`
            : `Helios did not start the tally: ${stripTags(res.body).slice(0, 300)}`,
          200,
          "form",
        );
      }
      return `Tally computation started on ${uuid} (runs in the background). Poll helios_election_status; once the encrypted tally is ready and every trustee has decrypted, call helios_combine_decryptions.`;
    },
  }),

  combine_decryptions: tool({
    description:
      "Combine every trustee's partial decryption into the plaintext result. Needs the encrypted tally and all trustees' decryption factors. The result is then visible to administrators only, until helios_release_result.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: true,
    annotations: { destructiveHint: false },
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/combine_decryptions"), {});
      return `Result computed for ${uuid} (admins only). Review with helios_election_status, then helios_release_result.`;
    },
  }),

  release_result: tool({
    description:
      "Publish the computed result to everyone. IRREVERSIBLE. Optionally email voters Helios's 'Election Result' notice with your own message added.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        email_voters: { type: "boolean", description: "Also send the 'result' email." },
        email_subject: {
          type: "string",
          description: "Subject (max 80 chars; default the election name).",
        },
        email_body: {
          type: "string",
          description: "Your message in the result email (max 4000 chars).",
        },
        email_send_to: { type: "string", enum: ["all", "voted", "not-voted"] },
      },
    },
    confirm: "Irreversible: makes the result public.",
    run: async (
      { election: id, email_voters, email_subject, email_body, email_send_to = "all" },
      c,
    ) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      await client.postForm(client.electionPath(uuid, "/release_result"), {});
      let note = "";
      if (email_voters) {
        await client.postForm(client.electionPath(uuid, "/voters/email?template=result"), {
          subject: email_subject ?? election.name,
          body: email_body || " ",
          send_to: email_send_to,
        });
        note = ` Result email queued to ${email_send_to} voters.`;
      }
      return `Result released for ${uuid}: ${electionUrls(client.baseUrl, uuid, election.short_name).admin_view}.${note}`;
    },
  }),

  // ───────────────────────────── housekeeping ─────────────────────────────
  archive_election: tool({
    description:
      "Archive an election (hidden from the admin's active list) or restore it. Reversible.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        archived: { type: "boolean", description: "Default true; false restores." },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, archived = true }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/archive"), {
        archive_p: archived ? "1" : "0",
      });
      return `Election ${uuid} ${archived ? "archived" : "unarchived"}.`;
    },
  }),

  delete_election: tool({
    description:
      "Soft-delete an election: it disappears for everyone except Helios site administrators. Treat as irreversible.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: "Deletes the election for everyone but the site's own administrators.",
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      await client.postForm(client.electionPath(uuid, "/delete"), {});
      return `Election "${election.name}" (${uuid}) deleted.`;
    },
  }),

  copy_election: tool({
    description:
      "Create a new unfrozen election copying this one's settings and questions (not voters or ballots). The copy's short name is its uuid; rename it with helios_update_election.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: "Creates a new election.",
    annotations: { destructiveHint: false },
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const res = await client.postForm(client.electionPath(uuid, "/copy"), {});
      const copy = uuidFromLocation(res.location);
      return result(
        `Copied ${uuid} → new election ${copy || "(uuid not in redirect)"}: ${electionUrls(client.baseUrl, copy).admin_view}`,
        { source_uuid: uuid, new_uuid: copy },
      );
    },
  }),

  set_featured: tool({
    description:
      "Toggle the 'featured' flag that lists an election on the server's home page. Helios site administrators only; others get 403.",
    input: {
      type: "object",
      required: ["election", "featured"],
      properties: { election: ELECTION, featured: { type: "boolean" } },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, featured }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/set_featured"), {
        featured_p: featured ? "1" : "0",
      });
      return `Election ${uuid} ${featured ? "featured" : "unfeatured"}.`;
    },
  }),

  get_election_log: tool({
    description:
      "The administrator-only audit log of an election: timestamps and events (created, frozen, voters removed, admins added, tallied, result released...).",
    input: {
      type: "object",
      required: ["election"],
      properties: { election: ELECTION, response_format: FORMAT },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id, response_format }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const rows = parseCsv(
        await client.getText(client.electionPath(uuid, "/log/download-csv"), "text/csv"),
      );
      const entries = rows.slice(1).map((r) => ({ at: r[0] ?? "", event: r[1] ?? "" }));
      if (response_format === "json")
        return { election_uuid: uuid, count: entries.length, entries };
      return entries.length
        ? entries.map((e) => `- ${e.at} UTC — ${e.event}`).join("\n")
        : "The log is empty.";
    },
  }),

  // ──────────────────────────── administrators ────────────────────────────
  list_admins: tool({
    description:
      "The election's creator plus any additional administrators (login email and auth system).",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const html = await client.getText(client.electionPath(uuid, "/admins/"));
      const cm = /<strong>([\s\S]*?)<\/strong>\s*\(([^)]+)\)/i.exec(html);
      const creator = cm
        ? {
            user_id: decodeEntities((cm[2] ?? "").trim()),
            display: stripTags(cm[1] ?? ""),
            user_type: firstMatch(cm[1] ?? "", /login-icons\/([a-z0-9_]+)\.png/i),
          }
        : null;
      const additional_admins = allMatches(
        html,
        /<li>\s*([\s\S]*?)\(([^)]+)\)\s*([\s\S]*?)<\/li>/i,
      ).map((m) => ({
        user_id: decodeEntities((m[2] ?? "").trim()),
        user_type:
          firstMatch(m[3] ?? "", /user_type=([a-z0-9_]+)/i) ??
          firstMatch(m[1] ?? "", /login-icons\/([a-z0-9_]+)\.png/i) ??
          "unknown",
        is_you: /\(you\)/.test(m[3] ?? ""),
      }));
      return result(
        `Creator: ${creator?.user_id ?? "?"}\nAdditional admins: ${additional_admins.length ? additional_admins.map((a) => `${a.user_id} (${a.user_type})`).join(", ") : "none"}`,
        { election_uuid: uuid, creator, additional_admins },
      );
    },
  }),

  add_admin: tool({
    description:
      "Give another Helios user administrator rights on this election, by login email. They must have logged in to this Helios at least once. If the email exists under several auth systems, pass auth_type.",
    input: {
      type: "object",
      required: ["election", "email"],
      properties: {
        election: ELECTION,
        email: { type: "string" },
        auth_type: {
          type: "string",
          description: "'google', 'github', ... when the email is ambiguous.",
        },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false },
    run: async ({ election: id, email, auth_type }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const res = await client.postForm(
        client.electionPath(uuid, "/admins/add"),
        { email, auth_type },
        { expectBody: true },
      );
      if (res.status === 200) {
        const choices = allMatches(res.body, /name=["']auth_type["'] value=["']([^"']+)["']/i).map(
          (m) => m[1],
        );
        if (choices.length)
          throw new HeliosError(
            `Several accounts use ${email}: pass auth_type as one of ${choices.join(", ")}.`,
            200,
            "form",
          );
        throw new HeliosError(
          extractFormErrors(res.body)[0] ??
            `Helios did not add ${email}: ${stripTags(res.body).slice(0, 300)}`,
          200,
          "form",
        );
      }
      return `${email}${auth_type ? ` (${auth_type})` : ""} is now an administrator of ${uuid}.`;
    },
  }),

  remove_admin: tool({
    description:
      "Revoke an additional administrator (not the creator, not yourself). user_type is the auth system shown by helios_list_admins.",
    input: {
      type: "object",
      required: ["election", "email", "user_type"],
      properties: { election: ELECTION, email: { type: "string" }, user_type: { type: "string" } },
    },
    confirm: "Removes that person's administrator rights on the election.",
    run: async ({ election: id, email, user_type }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const qs = new URLSearchParams({ email, user_type });
      await client.postForm(client.electionPath(uuid, `/admins/remove?${qs}`), {
        email,
        user_type,
      });
      return `${email} (${user_type}) removed as administrator of ${uuid}.`;
    },
  }),

  // ─────────────────────────────── voters ───────────────────────────────
  search_voters: tool({
    description:
      "The voter roll with voting status, from the CSV export. Administrators see login id, email, name, type, tracker and cast time; others only the public columns. Filter by text (name, email, login, alias) and by voted / not-voted; returns turnout counts. For 'who hasn't voted?', 'is Jane on the roll?', 'how many have voted?'.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        query: {
          type: "string",
          description: "Case-insensitive substring of name, email, login id or alias.",
        },
        only: { type: "string", enum: ["all", "voted", "not-voted"] },
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Default 200." },
        offset: { type: "integer", minimum: 0 },
        response_format: FORMAT,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async (
      { election: id, query, only = "all", limit = 200, offset = 0, response_format },
      c,
    ) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const { rows, admin_view } = await fetchRoll(client, uuid, query);
      const voted = rows.filter((r) => r.voted).length;
      const filtered =
        only === "all" ? rows : rows.filter((r) => (only === "voted" ? r.voted : !r.voted));
      const page = filtered.slice(offset, offset + limit);
      const hasMore = offset + page.length < filtered.length;
      const summary = {
        total_voters: rows.length,
        voted,
        not_voted: rows.length - voted,
        turnout_percent: rows.length ? Math.round((voted / rows.length) * 1000) / 10 : 0,
        matched_filter: filtered.length,
      };
      if (response_format === "json")
        return {
          election_uuid: uuid,
          admin_view,
          summary,
          count: page.length,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + page.length } : {}),
          voters: page,
        };
      return md([
        `Turnout: ${voted}/${rows.length} voted (${summary.turnout_percent}%)${query ? ` — filter "${query}"` : ""}${only !== "all" ? ` — showing ${only}` : ""}${admin_view ? "" : " — public columns only (not an admin session)"}`,
        ...page.map(
          (v) =>
            `- ${v.name ?? v.alias ?? "?"}${v.login ? ` (${v.login}${v.email && v.email !== v.login ? `, ${v.email}` : ""})` : ""}${v.voter_type ? ` [${v.voter_type}]` : ""} — ${v.voted ? `voted ${v.cast_at} UTC, tracker ${v.tracker}` : "not voted"}`,
        ),
        hasMore
          ? `More: call again with offset=${offset + page.length}.`
          : `End of list (${filtered.length} match${filtered.length === 1 ? "" : "es"}).`,
      ]);
    },
  }),

  upload_voters: tool({
    description:
      "Add voters from a list or CSV. Each voter: voter_type (usually 'password' — Helios emails them a voter id and password), a unique voter_id/login, email and name. Helios previews the first rows; this uploads, checks the preview for problems, cancels on any, and otherwise confirms so processing starts in the background. dry_run previews and cancels. Allowed until the tally is computed, even during voting; an existing voter_id is updated, not duplicated.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        voters: {
          type: "array",
          description: "Structured voter list (preferred over csv_text).",
          items: {
            type: "object",
            required: ["voter_id", "email", "name"],
            properties: {
              voter_id: {
                type: "string",
                description: "Unique login id, e.g. 'jane.doe' or their email.",
              },
              email: { type: "string" },
              name: { type: "string" },
              voter_type: {
                type: "string",
                description: "'password' (default) or an auth system such as 'google', 'github'.",
              },
            },
          },
        },
        csv_text: {
          type: "string",
          description: "Alternatively raw CSV lines: voter_type,voter_id,email,name",
        },
        dry_run: { type: "boolean", description: "Upload for the preview only, then cancel." },
      },
    },
    confirm: "Adds voters to the election (and emails them nothing yet).",
    annotations: { destructiveHint: false },
    run: async ({ election: id, voters, csv_text, dry_run }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const csv = voters?.length
        ? voters
            .map((v) =>
              [v.voter_type ?? "password", v.voter_id, v.email, v.name].map(csvEscape).join(","),
            )
            .join("\n")
        : (csv_text?.trim() ?? "");
      if (!csv) throw new Error("Provide either `voters` or `csv_text`.");
      const res = await client.postMultipart(
        client.electionPath(uuid, "/voters/upload"),
        {},
        { field: "voters_file", filename: "voters.csv", content: csv + "\n" },
      );
      if (res.status !== 200) {
        const e = res.location && /[?&]e=([^&]+)/.exec(res.location)?.[1];
        throw new HeliosError(
          e
            ? decodeURIComponent(e.replace(/\+/g, " "))
            : `Unexpected response ${res.status} from the voter upload.`,
          res.status,
          "form",
        );
      }
      const preview = parseTableRows(firstMatch(res.body, /<table[^>]*>([\s\S]*?)<\/table>/i) ?? "")
        .filter((r) => r.length === 4 && r[0]?.toLowerCase() !== "voter type")
        .map((r) => ({ voter_type: r[0], voter_id: r[1], email: r[2], name: r[3] }));
      const problems = allMatches(res.body, /<li[^>]*>([\s\S]*?)<\/li>/i)
        .map((m) => stripTags(m[1] ?? ""))
        .filter((t) => /could not be processed|invalid|no valid/i.test(t));
      const lines = csv.split(/\r?\n/).filter((l) => l.trim()).length;
      const previewText = preview
        .map((p) => `- ${p.voter_type},${p.voter_id},${p.email},${p.name}`)
        .join("\n");
      if (problems.length || dry_run) {
        await client.postForm(client.electionPath(uuid, "/voters/upload-cancel"), {});
        if (problems.length)
          throw new HeliosError(
            `Upload cancelled — Helios reported: ${problems.join("; ")}. Fix the file (voter_type,voter_id,email,name) and retry.`,
            200,
            "form",
          );
        return result(
          `Dry run: ${lines} line(s) parsed fine; nothing was added. Preview:\n${previewText}`,
          { election_uuid: uuid, dry_run: true, lines, preview },
        );
      }
      await client.postForm(client.electionPath(uuid, "/voters/upload"), { confirm_p: "1" });
      return result(
        `Uploaded ${lines} voter line(s) to ${uuid}; Helios is processing them in the background (helios_voter_upload_status). Preview:\n${previewText}`,
        { election_uuid: uuid, lines, preview, confirmed: true },
      );
    },
  }),

  voter_upload_status: tool({
    description:
      "Prior bulk uploads of an election and whether each has finished processing (and how many voters it loaded), plus whether voters can currently be modified and emailed.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      const html = await client.getText(client.electionPath(uuid, "/voters/list"));
      const block = firstMatch(html, /Prior Bulk Uploads:\s*<ul>([\s\S]*?)<\/ul>/i) ?? "";
      const uploads = allMatches(block, /<li>([\s\S]*?)<\/li>/i).map((m) => {
        const t = stripTags(m[1] ?? "");
        const loaded = firstMatch(t, /done processing:\s*(\d+)\s+voters/i);
        return {
          bytes: Number(firstMatch(t, /(\d+)\s+bytes/) ?? 0),
          uploaded_at: firstMatch(t, /at\s+(.+?):\s/) ?? null,
          status:
            loaded !== undefined
              ? "done"
              : /currently processing/i.test(t)
                ? "processing"
                : "pending",
          voters_loaded: loaded !== undefined ? Number(loaded) : null,
        };
      });
      const modify = firstMatch(html, /bulk upload voters \(disabled: ([^)]+)\)/i);
      const email = firstMatch(html, /email voters \(disabled: ([^)]+)\)/i);
      return result(
        uploads.length
          ? uploads
              .map(
                (u) =>
                  `- ${u.uploaded_at ?? "?"}: ${u.bytes} bytes — ${u.status}${u.voters_loaded !== null ? ` (${u.voters_loaded} voters loaded)` : ""}`,
              )
              .join("\n")
          : "No bulk uploads yet.",
        {
          election_uuid: uuid,
          uploads,
          can_modify_voters: !modify,
          modify_disabled_reason: modify ?? null,
          can_email_voters: !email,
          email_disabled_reason: email ?? null,
        },
      );
    },
  }),

  delete_voter: tool({
    description:
      "Remove one voter (by voter uuid) from the roll. If they already voted, their ballot is removed too and Helios emails them. Blocked once tallying has started.",
    input: {
      type: "object",
      required: ["election", "voter_uuid"],
      properties: { election: ELECTION, voter_uuid: { type: "string" } },
    },
    confirm: "Removes the voter and any ballot they cast.",
    run: async ({ election: id, voter_uuid }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(
        client.electionPath(uuid, `/voters/${encodeURIComponent(voter_uuid)}/delete`),
        {},
      );
      return `Voter ${voter_uuid} removed from ${uuid}.`;
    },
  }),

  clear_voters: tool({
    description:
      "Delete every voter from an unfrozen election, e.g. to re-upload a corrected roll. Irreversible.",
    input: { type: "object", required: ["election"], properties: { election: ELECTION } },
    confirm: "Irreversible: deletes every voter on the roll.",
    run: async ({ election: id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      await client.postForm(client.electionPath(uuid, "/voters/clear"), {});
      return `All voters cleared from ${uuid}.`;
    },
  }),

  set_registration: tool({
    description:
      "Who may vote in an unfrozen, non-private election: 'closed' = only uploaded voters; 'open' = anyone who logs in to Helios may register and vote; 'limited' = anyone in a category of the admin's auth system (needs category_id). Private elections are always limited to listed voters.",
    input: {
      type: "object",
      required: ["election", "registration"],
      properties: {
        election: ELECTION,
        registration: { type: "string", enum: ["closed", "open", "limited"] },
        category_id: {
          type: "string",
          description: "For 'limited': the category id from the admin's auth system.",
        },
      },
    },
    confirm: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ election: id, registration, category_id }, c) => {
      const client = await clientFor(c);
      const uuid = await client.resolveElectionUuid(id);
      if (registration === "limited" && !category_id)
        throw new Error("category_id is required for limited registration.");
      const eligibility =
        registration === "open"
          ? "openreg"
          : registration === "limited"
            ? "limitedreg"
            : "closedreg";
      await client.postForm(client.electionPath(uuid, "/voters/eligibility"), {
        eligibility,
        category_id,
      });
      return `Registration on ${uuid} set to ${registration}.`;
    },
  }),

  email_voters: tool({
    description:
      "Send one of Helios's voter emails (frozen elections only): 'vote' = Time to Vote (voting link, and for password voters their voter id and password), 'simple' = your message only, 'info' = additional info, 'result' = the result. `body` goes where the template puts the custom message; Helios fills in each voter's details itself. Send to all / voted / not-voted, or to one voter by login id (to resend a lost password). preview=true returns the template text instead of sending.",
    input: {
      type: "object",
      required: ["election"],
      properties: {
        election: ELECTION,
        template: {
          type: "string",
          enum: ["vote", "simple", "info", "result"],
          description: "Default 'vote'.",
        },
        subject: { type: "string", description: "Max 80 chars; default the election name." },
        body: { type: "string", description: "Your message (max 4000 chars)." },
        send_to: {
          type: "string",
          enum: ["all", "voted", "not-voted"],
          description: "Default 'all'.",
        },
        voter_login_id: {
          type: "string",
          description: "Send only to this voter (their login id).",
        },
        preview: { type: "boolean", description: "Return the template preview; send nothing." },
      },
    },
    confirm: "Sends email to voters.",
    annotations: { destructiveHint: false },
    run: async (
      {
        election: id,
        template = "vote",
        subject,
        body = "",
        send_to = "all",
        voter_login_id,
        preview,
      },
      c,
    ) => {
      const client = await clientFor(c);
      const { uuid, election } = await fetchElection(client, id);
      const qs = new URLSearchParams({ template });
      if (voter_login_id) qs.set("voter_id", voter_login_id);
      const path = client.electionPath(uuid, `/voters/email?${qs}`);
      if (preview) {
        const pre = firstMatch(await client.getText(path), /<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (!pre)
          throw new HeliosError(
            "Could not load the email form: the election must be frozen and you must be an administrator.",
            403,
            "forbidden",
          );
        return `Preview of the '${template}' template (angle-bracket fields are filled per voter; <BODY> is your message):\n\n${decodeEntities(pre)}`;
      }
      if (/<(SUBJECT|BODY|VOTER_\w+|SMART_TRACKER)>/.test(`${subject ?? ""} ${body}`))
        throw new Error(
          "Leave <SUBJECT>, <BODY> and <VOTER_...> out of subject/body — Helios fills those in. Write only your own message.",
        );
      await client.postForm(path, {
        subject: subject ?? election.name,
        body: body || " ",
        send_to,
      });
      return voter_login_id
        ? `'${template}' email queued to voter ${voter_login_id}.`
        : `'${template}' email queued to ${send_to} voters of "${election.name}".`;
    },
  }),
};

const Base = mcpWorker({
  ...cfg,
  version,
  info: (c) => ({
    title: "Helios Voting",
    description:
      "Read, verify and administer elections on Helios (vote.heliosvoting.org or a self-hosted server).",
    instructions:
      `Helios at ${heliosUrl(c)}. Public and verification tools need no login. ` +
      "Admin tools act as the Helios user whose session the caller saved on this connector's /login page; helios_session_status says which, helios_whoami checks it against Helios. " +
      "Call helios_election_status before lifecycle actions. Times on Helios are UTC: give ISO 8601 with an offset and say both local and UTC when confirming. " +
      "Typical order: create_election → set_questions → trustees → upload_voters → freeze_election → email_voters('vote') → compute_tally → combine_decryptions → release_result.",
  }),
  confirmNote: "Changes the election on Helios.",
  tools,
  status: async (c) => {
    const baseUrl = heliosUrl(c);
    const email = await c.email();
    const s = email ? await sessionFor(c, baseUrl) : null;
    return {
      helios: baseUrl,
      you: email ?? "nobody (Cloudflare Access is not in front of this worker)",
      session: s ? `saved for ${s.user ?? "a Helios user"}` : "none — open /login",
      login: "/login",
    };
  },
});

type WithAccess = { access?: { getIdentity(): Promise<{ email?: string } | null> } };

/**
 * The /login page: the one place a session cookie is typed, by a person, in a browser, behind
 * Access. Everything else is the MCP endpoint core provides.
 */
export default class extends Base {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/login") return super.fetch(request);
    const email = (await (this.ctx as WithAccess).access?.getIdentity())?.email;
    if (!email) return new Response(needsAccess().message, { status: 401 });
    const env = this.env;
    const helios = normaliseUrl(url.searchParams.get("helios") ?? env.HELIOS_URL ?? DEFAULT_URL);
    const cookieName = env.HELIOS_COOKIE_NAME ?? "sessionid";
    const page = (o: { notice?: string; error?: string }, status = 200) =>
      load(env.SESSIONS, email, helios).then(
        (current) =>
          new Response(loginPage({ email, helios, cookieName, current, ...o }), {
            status,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          }),
      );
    if (request.method === "GET") return page({});
    if (request.method !== "POST") return new Response("GET or POST", { status: 405 });
    // The form only ever posts to itself: a cross-site POST could store someone else's cookie
    // against this person's email.
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return page({ error: "That form came from another site." }, 403);
    const form = await request.formData().catch(() => null);
    if (form?.get("action") === "sign_out") {
      await forget(env.SESSIONS, email, helios);
      return page({
        notice: "Session forgotten. Log out of Helios in the browser to end it there too.",
      });
    }
    const cookie = String(form?.get("cookie") ?? "")
      .trim()
      .replace(new RegExp(`^${cookieName}=`), "")
      .replace(/;.*$/, "");
    if (!cookie) return page({ error: "Paste the cookie value first." }, 400);
    const client = new HeliosClient({
      baseUrl: helios,
      sessionCookie: cookie,
      cookieName,
      howToAuth: HOW_TO_AUTH,
    });
    let user: string | undefined;
    try {
      user = await whoami(client);
    } catch (e) {
      return page(
        { error: `Could not reach ${helios}: ${e instanceof Error ? e.message : String(e)}` },
        502,
      );
    }
    if (!user)
      return page(
        {
          error: `${helios} does not recognise that value as a logged-in session. Check you copied the whole value of the "${cookieName}" cookie, from a browser that is logged in.`,
        },
        400,
      );
    await save(env.SESSIONS, email, { cookie, url: helios, user, at: Date.now() });
    return page({ notice: `Saved. Tools on this connector now act on ${helios} as ${user}.` });
  }
}
