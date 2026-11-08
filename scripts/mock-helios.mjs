/**
 * A fake Helios (benadida/helios-server) for the tests: an in-memory imitation of the views in
 * helios/views.py as the HTTP client sees them — redirect on success, csrf_token in every POST,
 * session cookie, 403 PermissionDenied for the wrong state, SUCCESS/FAILURE bodies. One frozen
 * election with two cast ballots is seeded as "demo-2026". Not a substitute for the real thing.
 *
 *   node scripts/mock-helios.mjs 8796 mock-session
 */
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";

const PORT = Number(process.argv[2] ?? 8796);
const SESSION = process.argv[3] ?? "mock-session";
const CSRF = "csrf-" + randomUUID();
const HOST = `http://127.0.0.1:${PORT}`;
const elections = new Map();
const hashB64 = (s) => createHash("sha256").update(s).digest("base64").replace(/=$/, "");
// csv.reader-like line split (handles double-quoted fields)
const csvLine = (line) => {
  const out = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(f);
      f = "";
    } else f += c;
  }
  out.push(f);
  return out.map((s) => s.trim());
};
// Python json.dumps(sort_keys=True) for the simple values we emit, so hashes match the real server
const pyDumps = (v) =>
  v === null
    ? "null"
    : typeof v === "boolean"
      ? String(v)
      : typeof v === "number"
        ? String(v)
        : typeof v === "string"
          ? JSON.stringify(v)
          : Array.isArray(v)
            ? "[" + v.map(pyDumps).join(", ") + "]"
            : "{" +
              Object.keys(v)
                .sort()
                .map((k) => JSON.stringify(k) + ": " + pyDumps(v[k]))
                .join(", ") +
              "}";
function publicJson(e) {
  return {
    uuid: e.uuid,
    questions: e.questions,
    name: e.name,
    short_name: e.short_name,
    description: e.description,
    voters_hash: null,
    openreg: e.openreg,
    frozen_at: e.frozen_at,
    public_key: e.frozen_at ? { y: "123", p: "7", g: "3", q: "5" } : null,
    cast_url: `${HOST}/helios/elections/${e.uuid}/cast`,
    use_voter_aliases: e.use_voter_aliases,
    voting_starts_at: e.voting_starts_at,
    voting_ends_at: e.voting_ends_at,
  };
}
function seed() {
  const e = {
    uuid: "11111111-2222-3333-4444-555555555555",
    short_name: "demo-2026",
    name: "Demo Club Committee 2026",
    description: "Elect two members.",
    election_type: "election",
    private_p: false,
    use_voter_aliases: false,
    randomize_answer_order: false,
    help_email: "help@example.org",
    voting_starts_at: null,
    voting_ends_at: null,
    voting_extended_until: null,
    openreg: false,
    frozen_at: "2026-11-01 00:00:00",
    questions: [
      {
        question: "Elect two members",
        short_name: "Elect two members",
        answers: ["Ada", "Grace", "Linus"],
        answer_urls: ["", "", ""],
        min: 0,
        max: 2,
        choice_type: "approval",
        tally_type: "homomorphic",
        result_type: "relative",
        randomize_answer_order: false,
      },
    ],
    trustees: [
      {
        uuid: "t-helios",
        email: null,
        public_key: { y: "1" },
        public_key_hash: "h",
        decryption_factors: null,
      },
    ],
    voters: [],
    tallying_started_at: null,
    encrypted_tally: false,
    result: null,
    result_released_at: null,
    archived_at: null,
    deleted: false,
    log: [{ at: "2026-11-01 00:00:00", log: "Election created" }],
    admins: [],
    featured_p: false,
  };
  for (const [i, n] of ["Dana Lee", "Sam Ortiz", "Priya Shah"].entries()) {
    const v = {
      uuid: `v${i + 1}`.padEnd(36, "0"),
      voter_type: "password",
      voter_login_id: n.split(" ")[0].toLowerCase(),
      voter_email: `${n.split(" ")[0].toLowerCase()}@example.org`,
      name: n,
    };
    if (i < 2) {
      const vote = {
        answers: [
          { choices: [{ alpha: "1", beta: "2" }], individual_proofs: [], overall_proof: null },
        ],
        election_hash: hashB64(pyDumps(publicJson(e))),
        election_uuid: e.uuid,
      };
      v.vote = vote;
      v.vote_hash = hashB64(pyDumps(vote));
      v.cast_at = `2026-11-0${i + 2} 10:00:00`;
    }
    e.voters.push(v);
  }
  elections.set(e.uuid, e);
}
seed();
const page = (body, user = true) =>
  `<html><body>${user ? 'logged in as <b><img class="small-logo" src="/static/auth/login-icons/google.png" alt="google" /> admin@example.org</b>' : ""}${body}</body></html>`;
const csrfInput = `<input type="hidden" name="csrf_token" value="${CSRF}" />`;
function redirect(res, to) {
  res.writeHead(302, { Location: HOST + to });
  res.end();
}
function json(res, v) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
}
function html(res, s, status = 200) {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(s);
}
function deny(res) {
  res.writeHead(403);
  res.end("<h1>403 Forbidden</h1>");
}
function notFound(res) {
  res.writeHead(404);
  res.end("<h1>Not Found</h1>");
}
function parseMultipart(buf, ct) {
  const boundary = /boundary=(.+)$/.exec(ct)?.[1];
  const fields = {};
  const files = {};
  if (!boundary) return { fields, files };
  for (const part of buf.toString("utf8").split("--" + boundary)) {
    const m = /name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:[^\r\n]*\r\n)*\r\n([\s\S]*)\r\n$/.exec(
      part,
    );
    if (!m) continue;
    if (m[2] !== undefined) files[m[1]] = m[3];
    else fields[m[1]] = m[3];
  }
  return { fields, files };
}
function viewPage(e, admin) {
  let next = "";
  if (!e.result_released_at && admin) {
    if (!e.frozen_at) {
      const issues = [];
      if (!e.questions?.length) issues.push("add questions to the ballot");
      if (!e.trustees.length) issues.push("add at least one trustee");
      for (const t of e.trustees)
        if (!t.public_key) issues.push(`have trustee ${t.email ?? "Helios"} generate a keypair`);
      if (!e.voters.length && !e.openreg)
        issues.push("enter your voter list (or open registration to the public)");
      next = issues.length
        ? issues.join(", and<br />")
        : `<a href="/helios/elections/${e.uuid}/freeze">freeze ballot and open election.</a>`;
    } else if (!e.encrypted_tally)
      next = e.tallying_started_at
        ? "Tally computation is under way.<br />Reload this page in a couple of minutes."
        : `<a href="/helios/elections/${e.uuid}/compute_tally">compute encrypted tally</a><br />The encrypted votes will be combined`;
    else if (e.result)
      next = `<a href="/helios/elections/${e.uuid}/release_result">release result</a><br />The result displayed below is visible only to you.`;
    else if (e.trustees.every((t) => t.decryption_factors))
      next = `<a href="/helios/elections/${e.uuid}/combine_decryptions">\ncompute results\n</a><br />`;
    else next = `<a href="/helios/elections/${e.uuid}/trustees/view">trustees (for decryption)</a>`;
  }
  let tally = "";
  if (e.result && (admin || e.result_released_at)) {
    tally =
      `${e.result_released_at ? '<span class="highlight-box round">\n    This election is complete.\n</span>' : ""}<h3 class="highlight-box">Tally</h3>` +
      e.questions
        .map(
          (q, i) =>
            `<b><span style="font-size:0.8em;">Question #${i + 1}</span><br />${q.question}</b><br /><table class="pretty">${q.answers.map((a, j) => `<tr><td style="padding-right:80px;${j === 0 ? "font-weight:bold;" : ""}">${a}</td><td align="right" style="${j === 0 ? "font-weight:bold;" : ""}">${e.result[i][j]}</td></tr>`).join("")}</table>`,
        )
        .join("");
  }
  const fp = e.frozen_at
    ? `<br />Election Fingerprint:<br />\n<tt style="font-size: 1.3em; font-weight: bold;">${hashB64(pyDumps(publicJson(e)))}</tt>`
    : "";
  return page(
    `<h2>${e.name}</h2>${admin ? csrfInput : ""}${next ? `<p><b>Next Step:</b>\n<span style="font-size: 1.3em;">${next}</span></p>` : ""}${tally}${fp}`,
    admin,
  );
}
function utcNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", HOST);
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((c) => c[0]),
  );
  const loggedIn = cookies["sessionid"] === SESSION;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const ct = req.headers["content-type"] ?? "";
  let post = {};
  let files = {};
  if (req.method === "POST") {
    if (ct.startsWith("multipart/form-data")) ({ fields: post, files } = parseMultipart(raw, ct));
    else post = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
  }
  const checkCsrf = () => {
    if (req.method !== "POST" || post.csrf_token !== CSRF) {
      html(res, "<h1>400 CSRF</h1>", 400);
      return false;
    }
    return true;
  };
  const p = url.pathname;
  console.error(`${req.method} ${p}${url.search} ${loggedIn ? "[session]" : ""}`);
  if (p === "/") return html(res, page("<h1>Helios</h1>", loggedIn));
  if (p === "/auth/") return html(res, page("login page", false));
  if (p === "/helios/elections/params") return json(res, { g: "3", p: "7", q: "5" });
  if (p === "/helios/elections/new") {
    if (!loggedIn) return redirect(res, "/auth/?return_url=" + encodeURIComponent(p));
    if (req.method === "GET")
      return html(res, page(`<form>${csrfInput}<input name="short_name" /></form>`));
    if (!checkCsrf()) return;
    if (!/^[-\w]+$/.test(post.short_name ?? ""))
      return html(res, page("<p>No special characters allowed in the short name.</p>"));
    if ([...elections.values()].some((e) => e.short_name === post.short_name))
      return html(
        res,
        page(`<p class="error">An election with short name ${post.short_name} already exists</p>`),
      );
    const e = {
      uuid: randomUUID(),
      short_name: post.short_name,
      name: post.name,
      description: post.description ?? "",
      election_type: post.election_type ?? "election",
      private_p: post.private_p === "on",
      use_voter_aliases: post.use_voter_aliases === "on",
      randomize_answer_order: post.randomize_answer_order === "on",
      help_email: post.help_email ?? "",
      voting_starts_at: post.voting_starts_at
        ? post.voting_starts_at.replace("T", " ") + ":00"
        : null,
      voting_ends_at: post.voting_ends_at ? post.voting_ends_at.replace("T", " ") + ":00" : null,
      voting_extended_until: null,
      openreg: false,
      frozen_at: null,
      questions: null,
      trustees: [
        {
          uuid: randomUUID(),
          email: null,
          public_key: { y: "1" },
          public_key_hash: "h",
          decryption_factors: null,
        },
      ],
      voters: [],
      tallying_started_at: null,
      encrypted_tally: false,
      result: null,
      result_released_at: null,
      archived_at: null,
      deleted: false,
      log: [{ at: utcNow(), log: "Election created" }],
      admins: [],
      featured_p: false,
    };
    elections.set(e.uuid, e);
    return redirect(res, `/helios/elections/${e.uuid}/view`);
  }
  if (p === "/helios/elections/administered") {
    if (!loggedIn) return redirect(res, "/auth/?return_url=" + encodeURIComponent(p));
    return html(
      res,
      page(
        `<ul>${[...elections.values()]
          .filter((e) => !e.deleted)
          .map(
            (e) =>
              `<li> <a href="/helios/elections/${e.uuid}/view">${e.name}</a><em> - ${e.voters.length} voters / ${e.voters.filter((v) => v.vote_hash).length} cast votes</em></li>`,
          )
          .join("\n")}</ul>`,
      ),
    );
  }
  let m = /^\/helios\/e\/([^/]+)$/.exec(p);
  if (m) {
    const e = [...elections.values()].find((x) => x.short_name === m[1] && !x.deleted);
    return e ? redirect(res, `/helios/elections/${e.uuid}/view`) : notFound(res);
  }
  m = /^\/helios\/vh\/(.+)$/.exec(p);
  if (m) {
    for (const e of elections.values()) {
      const v = e.voters.find((v) => v.vote_hash === decodeURIComponent(m[1]));
      if (v)
        return html(
          res,
          page(
            `<h2 class="title">Cast Vote ${v.vote_hash.slice(0, 8)}</h2>\ncast in <a href="/helios/elections/${e.uuid}/view">${e.name}</a><br />\nFingerprint: <tt>${v.vote_hash}</tt><br />\nby <b><u>\n${v.name}\n</u></b><textarea cols="100" rows="10">\n${JSON.stringify(v.vote)}\n</textarea>`,
            loggedIn,
          ),
        );
    }
    return notFound(res);
  }
  m = /^\/helios\/elections\/([0-9a-f-]{36})(\/.*)?$/.exec(p);
  if (!m) return notFound(res);
  const e = elections.get(m[1]);
  if (!e || e.deleted) return notFound(res);
  const sub = m[2] ?? "";
  const admin = loggedIn;
  const needAdmin = () => {
    if (!admin) {
      deny(res);
      return false;
    }
    return true;
  };
  const frozen = (want) => {
    if (Boolean(e.frozen_at) !== want) {
      deny(res);
      return false;
    }
    return true;
  };
  switch (true) {
    case sub === "":
      return json(res, publicJson(e));
    case sub === "/meta":
      return json(res, {
        help_email: e.help_email,
        private_p: e.private_p,
        use_advanced_audit_features: true,
        randomize_answer_order: e.randomize_answer_order,
      });
    case sub === "/view":
      return html(res, viewPage(e, admin));
    case sub === "/trustees/":
      return json(
        res,
        e.trustees.map((t) => ({ ...t, pok: null, decryption_proofs: null })),
      );
    case sub === "/voters/": {
      const lim = Number(url.searchParams.get("limit") ?? 500);
      const after = url.searchParams.get("after");
      const vs = e.voters
        .filter((v) => !after || v.uuid > after)
        .sort((a, b) => a.uuid.localeCompare(b.uuid))
        .slice(0, lim);
      return json(
        res,
        vs.map((v) => ({
          election_uuid: e.uuid,
          uuid: v.uuid,
          voter_type: v.voter_type,
          voter_id_hash: hashB64(v.voter_login_id),
          name: v.name,
        })),
      );
    }
    case sub === "/ballots/": {
      const lim = Number(url.searchParams.get("limit") ?? 0);
      const vs = e.voters
        .filter((v) => v.vote_hash)
        .sort((a, b) => (b.cast_at > a.cast_at ? 1 : -1));
      return json(
        res,
        (lim ? vs.slice(0, lim) : vs).map((v) => ({
          cast_at: v.cast_at,
          voter_uuid: v.uuid,
          voter_hash: hashB64(v.uuid),
          vote_hash: v.vote_hash,
        })),
      );
    }
    case /^\/ballots\/[^/]+\/last$/.test(sub): {
      const v = e.voters.find((v) => v.uuid === sub.split("/")[2]);
      if (!v?.vote) return notFound(res);
      return json(res, {
        vote: v.vote,
        cast_at: v.cast_at,
        voter_uuid: v.uuid,
        voter_hash: hashB64(v.uuid),
        vote_hash: v.vote_hash,
      });
    }
    case /^\/voters\/[^/]+$/.test(sub) &&
      !sub.startsWith("/voters/download-csv") &&
      !sub.startsWith("/voters/list") &&
      !sub.startsWith("/voters/upload") &&
      !sub.startsWith("/voters/email") &&
      !sub.startsWith("/voters/clear") &&
      !sub.startsWith("/voters/eligibility"): {
      const v = e.voters.find((v) => v.uuid === sub.split("/")[2]);
      return v
        ? json(res, { election_uuid: e.uuid, uuid: v.uuid, voter_type: v.voter_type, name: v.name })
        : notFound(res);
    }
    case sub === "/result":
      if (!e.result_released_at) return deny(res);
      return json(res, e.result);
    case sub === "/result_proof":
      if (!e.result_released_at) return deny(res);
      return json(res, [[{ proof: 1 }]]);
    case sub === "/voters/download-csv": {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const vs = e.voters.filter(
        (v) =>
          !q ||
          v.name.toLowerCase().includes(q) ||
          v.voter_email.includes(q) ||
          v.voter_login_id.includes(q),
      );
      const rows = admin
        ? [
            [
              "Login",
              "Email Address",
              "Name",
              "Voter Type",
              "Smart Ballot Tracker",
              "Vote Cast At",
            ],
            ...vs.map((v) => [
              v.voter_login_id,
              v.voter_email,
              v.name,
              v.voter_type,
              v.vote_hash ?? "",
              v.cast_at ?? "",
            ]),
          ]
        : [
            ["Name", "Voter Type", "Smart Ballot Tracker", "Vote Cast At"],
            ...vs.map((v) => [v.name, v.voter_type, v.vote_hash ?? "", v.cast_at ?? ""]),
          ];
      res.writeHead(200, { "content-type": "text/csv" });
      return res.end(
        rows
          .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
          .join("\r\n") + "\r\n",
      );
    }
    case sub === "/voters/list":
      return html(
        res,
        page(
          `<p>voters</p>${e.pendingVoterFile === undefined ? "" : ""}Prior Bulk Uploads:\n<ul>\n<li>\n123\n bytes, at 2026-11-08 07:00:00 UTC:\n<em>done processing: ${e.voters.length} voters loaded</em>\n</li>\n</ul>`,
          loggedIn,
        ),
      );
    case sub === "/edit": {
      if (!needAdmin() || !frozen(false)) return;
      if (req.method === "GET")
        return html(
          res,
          page(
            `<form method="POST">${csrfInput}<table><tr><td><input type="text" name="short_name" value="${e.short_name}" /></td></tr><tr><td><input type="text" name="name" value="${e.name.replace(/"/g, "&quot;")}" /></td></tr><tr><td><textarea name="description">\n${e.description}</textarea></td></tr><tr><td><select name="election_type"><option value="election"${e.election_type === "election" ? " selected" : ""}>Election</option><option value="referendum"${e.election_type === "referendum" ? " selected" : ""}>Referendum</option></select></td></tr><tr><td><input type="checkbox" name="use_voter_aliases"${e.use_voter_aliases ? " checked" : ""} /></td></tr><tr><td><input type="checkbox" name="randomize_answer_order"${e.randomize_answer_order ? " checked" : ""} /></td></tr><tr><td><input type="checkbox" name="private_p"${e.private_p ? " checked" : ""} /></td></tr><tr><td><input type="text" name="help_email" value="${e.help_email}" /></td></tr><tr><td><input type="datetime-local" name="voting_starts_at" value="${e.voting_starts_at ? e.voting_starts_at.replace(" ", "T").slice(0, 16) : ""}" /></td></tr><tr><td><input type="datetime-local" name="voting_ends_at" value="${e.voting_ends_at ? e.voting_ends_at.replace(" ", "T").slice(0, 16) : ""}" /></td></tr></table></form>`,
          ),
        );
      if (!checkCsrf()) return;
      if (!post.name || !post.short_name)
        return html(res, page('<ul class="errorlist"><li>This field is required.</li></ul>'));
      Object.assign(e, {
        short_name: post.short_name,
        name: post.name,
        description: post.description ?? "",
        election_type: post.election_type,
        private_p: post.private_p === "on",
        use_voter_aliases: post.use_voter_aliases === "on",
        randomize_answer_order: post.randomize_answer_order === "on",
        help_email: post.help_email ?? "",
        voting_starts_at: post.voting_starts_at
          ? post.voting_starts_at.replace("T", " ") + ":00"
          : null,
        voting_ends_at: post.voting_ends_at ? post.voting_ends_at.replace("T", " ") + ":00" : null,
      });
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    }
    case sub === "/extend":
      if (!needAdmin() || !checkCsrf()) return;
      e.voting_extended_until = post.voting_extended_until || null;
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    case sub === "/save_questions": {
      if (!needAdmin() || !frozen(false) || !checkCsrf()) return;
      const qs = JSON.parse(post.questions_json);
      for (const q of qs)
        for (const u of q.answer_urls)
          if (u && !/^https?:\/\//.test(u)) {
            res.writeHead(200);
            return res.end("FAILURE");
          }
      e.questions = qs;
      res.writeHead(200);
      return res.end("SUCCESS");
    }
    case sub === "/freeze": {
      if (!needAdmin() || !frozen(false)) return;
      const issues = [];
      if (!e.questions?.length) issues.push("add questions to the ballot");
      if (!e.voters.length && !e.openreg)
        issues.push("enter your voter list (or open registration to the public)");
      if (req.method === "GET")
        return html(
          res,
          page(
            `<p>Registration for your election is currently <b>${e.openreg ? "open" : "closed"}</b></p>${issues.length ? `<p>Before you can freeze the election, you will need to:\n<ul>${issues.map((i) => `<li>${i}</li>`).join("")}</ul></p>` : `<form method="post">${csrfInput}<input class="button" type="submit" value="Freeze the ballot" /></form>`}`,
          ),
        );
      if (!checkCsrf()) return;
      if (issues.length) return html(res, "<h1>500</h1>", 500);
      e.frozen_at = utcNow();
      e.log.push({ at: utcNow(), log: "Election frozen" });
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    }
    case sub === "/compute_tally": {
      if (!needAdmin() || !frozen(true)) return;
      if (req.method === "GET") return html(res, page("tally page"));
      if (!checkCsrf()) return;
      e.tallying_started_at = utcNow();
      setTimeout(() => {
        e.encrypted_tally = true;
        e.trustees.forEach((t) => {
          if (t.email === null) t.decryption_factors = [[1]];
        });
      }, 300);
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    }
    case sub === "/combine_decryptions": {
      if (!needAdmin() || !frozen(true) || !checkCsrf()) return;
      e.result = e.questions.map((q) => q.answers.map((_, j) => q.answers.length - j));
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    }
    case sub === "/release_result": {
      if (!needAdmin() || !frozen(true) || !checkCsrf()) return;
      e.result_released_at = utcNow();
      return redirect(
        res,
        post.send_email
          ? `/helios/elections/${e.uuid}/voters/email?template=result`
          : `/helios/elections/${e.uuid}/view`,
      );
    }
    case sub === "/archive":
      if (!needAdmin() || !checkCsrf()) return;
      e.archived_at = post.archive_p === "1" ? utcNow() : null;
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    case sub === "/delete":
      if (!needAdmin() || !checkCsrf()) return;
      e.deleted = true;
      return redirect(res, `/helios/elections/administered`);
    case sub === "/copy": {
      if (!needAdmin() || !checkCsrf()) return;
      const n = {
        ...structuredClone(e),
        uuid: randomUUID(),
        name: "Copy of " + e.name,
        frozen_at: null,
        voters: [],
        result: null,
        result_released_at: null,
        encrypted_tally: false,
        tallying_started_at: null,
      };
      n.short_name = n.uuid;
      elections.set(n.uuid, n);
      return redirect(res, `/helios/elections/${n.uuid}/view`);
    }
    case sub === "/set_featured":
      if (!needAdmin() || !checkCsrf()) return;
      e.featured_p = post.featured_p === "1";
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    case sub === "/trustees/new": {
      if (!needAdmin() || !frozen(false)) return;
      if (req.method === "GET") return html(res, page(csrfInput));
      if (!checkCsrf()) return;
      e.trustees.push({
        uuid: randomUUID(),
        email: post.email,
        public_key: null,
        public_key_hash: null,
        decryption_factors: null,
      });
      return redirect(res, `/helios/elections/${e.uuid}/trustees/view`);
    }
    case sub === "/trustees/add-helios":
      if (!needAdmin() || !frozen(false) || !checkCsrf()) return;
      e.trustees.push({
        uuid: randomUUID(),
        email: null,
        public_key: { y: "2" },
        public_key_hash: "h2",
        decryption_factors: null,
      });
      return redirect(res, `/helios/elections/${e.uuid}/trustees/view`);
    case sub === "/trustees/delete":
      if (!needAdmin() || !frozen(false) || !checkCsrf()) return;
      e.trustees = e.trustees.filter((t) => t.uuid !== post.uuid);
      return redirect(res, `/helios/elections/${e.uuid}/trustees/view`);
    case /^\/trustees\/[^/]+\/sendurl$/.test(sub):
      if (!needAdmin() || !checkCsrf()) return;
      return redirect(res, `/helios/elections/${e.uuid}/trustees/view`);
    case sub === "/admins/":
      if (!needAdmin()) return;
      return html(
        res,
        page(
          `<h4>Election Creator</h4><p><strong><img class="small-logo" src="/static/auth/login-icons/google.png" alt="google" /> admin@example.org</strong> (admin@example.org)<br /></p>${e.admins.length ? `<ul>${e.admins.map((a) => `<li>\n  <img class="small-logo" src="/static/auth/login-icons/${a.user_type}.png" alt="${a.user_type}" /> ${a.user_id} (${a.user_id})\n  [<a href="/helios/elections/${e.uuid}/admins/remove?email=${a.user_id}&user_type=${a.user_type}">remove</a>]\n</li>`).join("")}</ul>` : "<p><em>No additional administrators have been added.</em></p>"}`,
        ),
      );
    case sub === "/admins/add": {
      if (!needAdmin()) return;
      if (req.method === "GET") return html(res, page(csrfInput));
      if (!checkCsrf()) return;
      if (post.email === "nobody@example.org")
        return html(
          res,
          page(
            '<div class="error">No user found with that email. They must log in to Helios at least once before being added as an administrator.</div>',
          ),
        );
      if (post.email === "dual@example.org" && !post.auth_type)
        return html(
          res,
          page(
            `<input type="radio" name="auth_type" value="google" checked /><input type="radio" name="auth_type" value="github" />`,
          ),
        );
      e.admins.push({ user_id: post.email, user_type: post.auth_type || "google" });
      return redirect(res, `/helios/elections/${e.uuid}/admins/`);
    }
    case sub === "/admins/remove": {
      if (!needAdmin()) return;
      const email = url.searchParams.get("email") ?? post.email;
      if (!e.admins.some((a) => a.user_id === email)) return notFound(res);
      if (req.method === "GET") return html(res, page(csrfInput));
      if (!checkCsrf()) return;
      e.admins = e.admins.filter((a) => a.user_id !== email);
      return redirect(res, `/helios/elections/${e.uuid}/admins/`);
    }
    case sub === "/log/download-csv":
      if (!needAdmin()) return;
      res.writeHead(200, { "content-type": "text/csv" });
      return res.end(
        "Timestamp,Event\r\n" + e.log.map((l) => `${l.at},${l.log}`).join("\r\n") + "\r\n",
      );
    case sub === "/voters/eligibility":
      if (!needAdmin() || !frozen(false) || !checkCsrf()) return;
      e.openreg = post.eligibility !== "closedreg";
      return redirect(res, `/helios/elections/${e.uuid}/voters/list`);
    case sub === "/voters/upload": {
      if (!needAdmin()) return;
      if (e.encrypted_tally || e.tallying_started_at) return deny(res);
      if (req.method === "GET") return html(res, page(csrfInput));
      if (!checkCsrf()) return;
      if (post.confirm_p) {
        const content = e.pendingVoterFile;
        e.pendingVoterFile = undefined;
        if (content)
          for (const line of content.split(/\r?\n/)) {
            const f = csvLine(line);
            if (f.length < 2) continue;
            const existing = e.voters.find((v) => v.voter_login_id === f[1]);
            const v = existing ?? {
              uuid: randomUUID(),
              voter_type: f[0],
              voter_login_id: f[1],
              voter_email: f[2] ?? f[1],
              name: f[3] ?? f[2] ?? f[1],
            };
            if (!existing) e.voters.push(v);
          }
        return redirect(res, `/helios/elections/${e.uuid}/voters/list`);
      }
      const content = files.voters_file;
      if (content === undefined)
        return redirect(
          res,
          `/helios/elections/${e.uuid}/voters/upload?e=no+voter+file+specified%2C+try+again`,
        );
      const rows = content
        .split(/\r?\n/)
        .map(csvLine)
        .filter((f) => f.length >= 2);
      const bad = rows.find((f) => !["password", "google", "github"].includes(f[0]));
      const problems = bad
        ? [
            `your CSV file could not be processed because invalid voter type '${bad[0]}' for voter id '${bad[1]}', available voter types are password,google,github`,
          ]
        : rows.length
          ? []
          : ["your CSV file could not be processed because no valid lines found in voter file"];
      e.pendingVoterFile = content;
      return html(
        res,
        page(
          `<p>You have uploaded a file of voters. The first few rows of this file are:</p><table class="pretty"><tr><th>Voter Type</th><th>Voter Login</th><th>Email Address</th><th>Name</th></tr>${rows
            .slice(0, 5)
            .map(
              (f) =>
                `<tr><td>${f[0]}</td><td>${f[1]}</td><td>${f[2] ?? ""}</td><td>${f[3] ?? ""}</td></tr>`,
            )
            .join(
              "",
            )}</table>${problems.length ? `<ul>${problems.map((p) => `<li>${p}</li>`).join("")}</ul>` : ""}<form method="post" action="/helios/elections/${e.uuid}/voters/upload-cancel">${csrfInput}</form><form method="post">${csrfInput}<input type="hidden" name="confirm_p" value="1" /></form>`,
        ),
      );
    }
    case sub === "/voters/upload-cancel":
      if (!needAdmin() || !checkCsrf()) return;
      e.pendingVoterFile = undefined;
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    case sub === "/voters/clear":
      if (!needAdmin() || !frozen(false) || !checkCsrf()) return;
      e.voters = [];
      return redirect(res, `/helios/elections/${e.uuid}/voters/list`);
    case /^\/voters\/[^/]+\/delete$/.test(sub):
      if (!needAdmin() || !checkCsrf()) return;
      if (e.tallying_started_at) return deny(res);
      e.voters = e.voters.filter((v) => v.uuid !== sub.split("/")[2]);
      return redirect(res, `/helios/elections/${e.uuid}/voters/list`);
    case sub === "/voters/email": {
      if (!needAdmin() || !frozen(true)) return;
      if (req.method === "GET")
        return html(
          res,
          page(
            `${csrfInput}<pre style="x">\nSubject: &lt;SUBJECT&gt;\n\nDear &lt;VOTER_NAME&gt;,\n\n&lt;BODY&gt;\n\nYour voter ID: &lt;VOTER_LOGIN_ID&gt;\n</pre>`,
          ),
        );
      if (!checkCsrf()) return;
      if (
        !post.subject ||
        post.subject.length > 80 ||
        !["all", "voted", "not-voted"].includes(post.send_to)
      )
        return html(res, page('<ul class="errorlist"><li>This field is required.</li></ul>'));
      if (/<BODY>|<SUBJECT>/.test(post.body + post.subject))
        return html(
          res,
          page(
            '<ul class="errorlist"><li>Remove &lt;BODY&gt;: it is only shown in the preview</li></ul>',
          ),
        );
      e.log.push({
        at: utcNow(),
        log: `Email '${url.searchParams.get("template")}' sent to ${url.searchParams.get("voter_id") ?? post.send_to}`,
      });
      return redirect(res, `/helios/elections/${e.uuid}/view`);
    }
    default:
      return notFound(res);
  }
});
server.listen(PORT, "127.0.0.1", () =>
  console.error(`mock helios on ${HOST} (session cookie value: ${SESSION})`),
);
