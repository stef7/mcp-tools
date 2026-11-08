/**
 * Helios data shapes and the arithmetic the tools repeat: winners and ties the way
 * helios.crypto.electionalgs.one_question_result does them, the voter roll from the CSV export,
 * UTC conversion for the datetime-local fields, and the lifecycle phase read off the admin page.
 */
import type { HeliosClient } from "./client";
import { allMatches, firstMatch, parseCsv, parseTableRows, stripTags } from "./html";

export type Question = {
  question: string;
  short_name?: string;
  answers: string[];
  answer_urls?: (string | null)[];
  min: number;
  max: number | null;
  choice_type: string;
  result_type: "absolute" | "relative";
  tally_type: string;
  randomize_answer_order?: boolean;
};

export type Election = {
  uuid: string;
  name: string;
  short_name: string;
  description: string;
  questions: Question[] | null;
  voters_hash: string | null;
  openreg: boolean;
  frozen_at: string | null;
  public_key: { y: string; p: string; g: string; q: string } | null;
  cast_url: string;
  use_voter_aliases: boolean;
  voting_starts_at: string | null;
  voting_ends_at: string | null;
};

export type Meta = {
  help_email: string;
  private_p: boolean;
  use_advanced_audit_features: boolean;
  randomize_answer_order: boolean;
};

export type Voter = {
  election_uuid: string;
  uuid: string;
  voter_type?: string;
  voter_id_hash?: string;
  name?: string;
  alias?: string;
};

export type ShortCastVote = {
  cast_at: string;
  voter_uuid: string;
  voter_hash: string;
  vote_hash: string;
};

export type CastVote = ShortCastVote & {
  vote: { answers: unknown[]; election_hash: string; election_uuid: string };
};

export type Trustee = {
  uuid: string;
  email: string | null;
  public_key: unknown | null;
  public_key_hash: string | null;
  pok: unknown | null;
  decryption_factors: unknown | null;
  decryption_proofs: unknown | null;
};

/** Winners and the answers tied for the last seat(s); tied answers do not win. */
export const questionWinners = (q: Question, counts: number[], numCastVotes: number) => {
  const theMax = q.max || 1;
  const ranked = counts.map((_, i) => i).sort((a, b) => counts[b]! - counts[a]! || a - b);
  let winners = ranked.slice(0, theMax);
  let tied: number[] = [];
  if (ranked.length > theMax) {
    const cutoff = counts[ranked[theMax - 1]!]!;
    if (counts[ranked[theMax]!] === cutoff) {
      winners = ranked.filter((i) => counts[i]! > cutoff);
      tied = ranked.filter((i) => counts[i] === cutoff);
    }
  }
  if (theMax === 1 && q.result_type === "absolute") {
    const first = winners[0];
    if (first === undefined || counts[first]! < Math.floor(numCastVotes / 2) + 1)
      return { winners: [], tied: [] };
  }
  return { winners, tied };
};

export const prettyResult = (questions: Question[], result: number[][], numCastVotes: number) =>
  questions.map((q, i) => {
    const counts = result[i] ?? [];
    const { winners, tied } = questionWinners(q, counts, numCastVotes);
    return {
      question: q.question,
      min: q.min,
      max: q.max,
      result_type: q.result_type,
      answers: q.answers.map((a, j) => ({
        answer: a,
        count: counts[j] ?? 0,
        winner: winners.includes(j),
        tied: tied.includes(j),
      })),
      unfilled_seats: tied.length ? (q.max || 1) - winners.length : 0,
    };
  });

export const describeQuestions = (questions: Question[] | null | undefined): string => {
  if (!questions || questions.length === 0) return "_No questions yet._";
  return questions
    .map((q, i) => {
      const range =
        q.max === null
          ? `at least ${q.min}, no maximum`
          : q.min === q.max
            ? `exactly ${q.min}`
            : `between ${q.min} and ${q.max}`;
      const answers = q.answers
        .map((a, j) => `   ${j + 1}. ${a}${q.answer_urls?.[j] ? ` (${q.answer_urls[j]})` : ""}`)
        .join("\n");
      return (
        `${i + 1}. **${q.question}** — select ${range}; result type: ${q.result_type}` +
        `${q.randomize_answer_order ? "; answers shown in random order" : ""}\n${answers}`
      );
    })
    .join("\n");
};

export const fetchElection = async (client: HeliosClient, idOrShort: string) => {
  const uuid = await client.resolveElectionUuid(idOrShort);
  const election = await client.getJson<Election>(client.electionPath(uuid));
  return { uuid, election };
};

export type RollRow = {
  login?: string;
  email?: string;
  name?: string;
  voter_type?: string;
  alias?: string;
  tracker: string;
  cast_at: string;
  voted: boolean;
};

/** The voter roll from the CSV export: admin columns when the session is an admin's. */
export const fetchRoll = async (
  client: HeliosClient,
  uuid: string,
  q?: string,
): Promise<{ rows: RollRow[]; admin_view: boolean }> => {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const csv = await client.getText(
    client.electionPath(uuid, `/voters/download-csv${qs}`),
    "text/csv",
  );
  const table = parseCsv(csv);
  const headers = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  if (!headers.length) return { rows: [], admin_view: false };
  const col = (name: string) => headers.indexOf(name);
  const c = {
    login: col("login"),
    email: col("email address"),
    name: col("name"),
    type: col("voter type"),
    alias: col("alias"),
    tracker: col("smart ballot tracker"),
    cast: col("vote cast at"),
  };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : undefined);
  const rows = table.slice(1).map((r): RollRow => {
    const tracker = cell(r, c.tracker) ?? "";
    const row: RollRow = { tracker, cast_at: cell(r, c.cast) ?? "", voted: tracker !== "" };
    const login = cell(r, c.login);
    const email = cell(r, c.email);
    const name = cell(r, c.name);
    const type = cell(r, c.type);
    const alias = cell(r, c.alias);
    if (login !== undefined) row.login = login;
    if (email !== undefined) row.email = email;
    if (name !== undefined) row.name = name;
    if (type !== undefined) row.voter_type = type;
    if (alias !== undefined) row.alias = alias;
    return row;
  });
  return { rows, admin_view: c.login >= 0 };
};

/**
 * ISO 8601 (with or without an offset) -> the UTC "YYYY-MM-DDTHH:MM" Helios's DateTimeLocalField
 * reads. A value without an offset is taken as UTC, as Helios itself would take it.
 */
export const toHeliosUtc = (input: string | null | undefined): string | undefined => {
  if (input === undefined) return undefined;
  if (input === null) return "";
  const s = input.trim();
  if (s === "") return "";
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasOffset ? s : s + "Z");
  if (Number.isNaN(d.getTime()))
    throw new Error(
      `Unparseable date/time "${input}". Use ISO 8601, e.g. 2026-11-14T09:00:00+11:00 ` +
        "(Melbourne) or 2026-11-13T22:00Z (UTC).",
    );
  return d.toISOString().slice(0, 16);
};

export const fmtUtc = (value: unknown): string => {
  if (!value || typeof value !== "string") return "—";
  const iso = value.includes("T")
    ? value
    : value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? value
    : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

const parseHeliosTime = (value: string | null) =>
  value ? Date.parse(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z")) : undefined;

export const electionUrls = (base: string, uuid: string, shortName?: string) => ({
  admin_view: `${base}/helios/elections/${uuid}/view`,
  public_json: `${base}/helios/elections/${uuid}`,
  voters_and_ballots: `${base}/helios/elections/${uuid}/voters/list`,
  trustees: `${base}/helios/elections/${uuid}/trustees/view`,
  verifier: `${base}/verifier/verify.html?election_url=/helios/elections/${uuid}`,
  ...(shortName
    ? { short_url: `${base}/helios/e/${shortName}`, vote_url: `${base}/helios/e/${shortName}/vote` }
    : {}),
});

export type QuestionInput = {
  question: string;
  answers: string[];
  answer_urls?: string[] | undefined;
  min?: number | undefined;
  max?: number | null | undefined;
  result_type?: "relative" | "absolute" | undefined;
  randomize_answer_order?: boolean | undefined;
};

/** What the questions editor's JavaScript builds (helios/templates/election_questions.html). */
export const toHeliosQuestion = (q: QuestionInput): Question => {
  const min = q.min ?? 0;
  const max = q.max === undefined ? 1 : q.max;
  if (max !== null && min > max)
    throw new Error(`Question "${q.question}": min (${min}) cannot exceed max (${max}).`);
  if (q.answer_urls && q.answer_urls.length !== q.answers.length)
    throw new Error(`Question "${q.question}": answer_urls must have one entry per answer.`);
  for (const u of q.answer_urls ?? [])
    if (u && !/^https?:\/\//.test(u))
      throw new Error(`Question "${q.question}": answer URLs must start with http:// or https://.`);
  return {
    question: q.question,
    short_name: q.question,
    answers: q.answers,
    answer_urls: q.answer_urls ?? q.answers.map(() => ""),
    min,
    max,
    choice_type: "approval",
    tally_type: "homomorphic",
    result_type: q.result_type ?? "relative",
    randomize_answer_order: q.randomize_answer_order ?? false,
  };
};

export type Phase =
  | "setup"
  | "ready_to_freeze"
  | "frozen_not_started"
  | "voting_open"
  | "voting_closed_awaiting_tally"
  | "tallying"
  | "awaiting_trustee_decryptions"
  | "awaiting_combination"
  | "result_computed_unreleased"
  | "result_released"
  | "unknown";

export const NEXT_STEP: Record<Phase, string> = {
  setup:
    "Finish setup: helios_set_questions, add voters (helios_upload_voters) or open registration, " +
    "and make sure every trustee has a key (helios_list_trustees).",
  ready_to_freeze: "Call helios_freeze_election to lock the ballot and open voting.",
  frozen_not_started:
    "Voting opens automatically at voting_starts_at. Voters cannot vote before then; plan the " +
    "'vote' email (helios_email_voters) for when it opens.",
  voting_open:
    "Voting is open. Send or remind with helios_email_voters (send_to 'not-voted'); watch turnout " +
    "with helios_search_voters; helios_extend_voting if needed. When done, helios_compute_tally.",
  voting_closed_awaiting_tally:
    "The voting window has ended. Call helios_compute_tally to close voting and tally.",
  tallying: "Helios is computing the encrypted tally in the background. Check again in a minute.",
  awaiting_trustee_decryptions:
    "Waiting for trustees' partial decryptions. helios_list_trustees shows who is missing; " +
    "helios_send_trustee_link nudges them.",
  awaiting_combination:
    "Every trustee has decrypted. Call helios_combine_decryptions to compute the result.",
  result_computed_unreleased:
    "The result is computed and visible to admins only (shown below). Check it, then " +
    "helios_release_result.",
  result_released: "Election complete. Share helios_get_result and the verifier link.",
  unknown: "Could not determine the phase; open the admin page.",
};

/** Reads the admin page's "Next Step" box the way a person would. */
export const detectPhase = (nextStepText: string, html: string, e: Election): Phase => {
  const t = nextStepText.toLowerCase();
  if (/this election is complete/i.test(html)) return "result_released";
  if (/release result/.test(t)) return "result_computed_unreleased";
  if (/tally computation is under way/.test(t)) return "tallying";
  if (/compute results|combine trustee decryptions/.test(t)) return "awaiting_combination";
  if (/trustees \(for decryption\)/.test(t)) return "awaiting_trustee_decryptions";
  if (/compute encrypted tally/.test(t)) {
    const now = Date.now();
    const start = parseHeliosTime(e.voting_starts_at);
    const end = parseHeliosTime(e.voting_ends_at);
    if (start && now < start) return "frozen_not_started";
    if (end && now > end) return "voting_closed_awaiting_tally";
    return "voting_open";
  }
  if (/freeze ballot and open election/.test(t)) return "ready_to_freeze";
  if (!e.frozen_at) return "setup";
  return "unknown";
};

export type TallyRow = { answer: string; count: number; winner: boolean; tied: boolean };

/** The Tally table the admin page shows before (and after) release. */
export const parseAdminTally = (html: string): { question: string; answers: TallyRow[] }[] => {
  const block = firstMatch(html, /<h3[^>]*>Tally<\/h3>([\s\S]*?)(?:<h3|<\/div>\s*<\/div>|$)/i);
  if (!block) return [];
  return allMatches(
    block,
    /<b><span[^>]*>Question #\d+<\/span><br\s*\/?>([\s\S]*?)<\/b>\s*<br\s*\/?>\s*<table[^>]*>([\s\S]*?)<\/table>/i,
  ).map((m) => ({
    question: stripTags(m[1] ?? ""),
    answers: allMatches(m[2] ?? "", /<tr>([\s\S]*?)<\/tr>/i).map((r): TallyRow => {
      const cells = parseTableRows(`<tr>${r[1]}</tr>`)[0] ?? [];
      return {
        answer: (cells[0] ?? "").replace(/\s*\(tied\)\s*$/i, ""),
        count: Number(cells[1] ?? 0),
        winner: /font-weight:\s*bold/i.test(r[1] ?? ""),
        tied: /\(tied\)/i.test(r[1] ?? ""),
      };
    }),
  }));
};
