/**
 * HTTP client for a Helios server (benadida/helios-server).
 *
 * Helios has no token API: public election data is plain JSON, and every
 * administrative action is a Django form POST protected by (a) the session
 * cookie of a logged-in user and (b) a per-session `csrf_token` hidden field
 * (helios_auth/security.py: check_csrf). vote.heliosvoting.org only offers
 * Google/GitHub login, so the admin is expected to log in in a browser and
 * hand this client the session cookie. The client fetches a page containing a
 * form, scrapes the csrf_token, and submits forms the way the browser would.
 */
import { extractCsrfToken, extractFormErrors, stripTags } from "./html";

export const REQUEST_TIMEOUT_MS = 60_000;
export const USER_AGENT = "mcp-helios/1.0";

export type HeliosConfig = {
  /** Base URL of the Helios server, no trailing slash. */
  baseUrl: string;
  /** Value of the Django session cookie of a logged-in Helios user (admin tools only). */
  sessionCookie?: string | undefined;
  /** Name of the session cookie; Django's default is "sessionid". */
  cookieName: string;
  /** Where a cookie would come from, for the error when none was given. */
  howToAuth: string;
};

export class HeliosError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind:
      | "auth"
      | "forbidden"
      | "not_found"
      | "bad_request"
      | "upstream"
      | "config"
      | "form" = "upstream",
  ) {
    super(message);
    this.name = "HeliosError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostResult {
  status: number;
  /** Location header of the redirect Django sends on success, if any. */
  location?: string | undefined;
  /** Response body for 200 responses (e.g. "SUCCESS"/"FAILURE" or an HTML page with errors). */
  body: string;
}

export class HeliosClient {
  private csrf?: string;
  private shortNameCache = new Map<string, string>();

  constructor(readonly config: HeliosConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get hasSession(): boolean {
    return Boolean(this.config.sessionCookie);
  }

  requireSession(action: string): void {
    if (!this.hasSession) {
      throw new HeliosError(
        `${action} needs an administrator session, and none was given. Log in to ${this.baseUrl} in a browser (Google or GitHub), copy the value of the "${this.config.cookieName}" cookie from the browser's developer tools, then ${this.config.howToAuth} Public read tools work without it.`,
        401,
        "config",
      );
    }
  }

  url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return this.baseUrl + (path.startsWith("/") ? path : "/" + path);
  }

  electionPath(uuid: string, suffix = ""): string {
    return `/helios/elections/${encodeURIComponent(uuid)}${suffix}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": USER_AGENT, ...extra };
    if (this.config.sessionCookie)
      h["Cookie"] = `${this.config.cookieName}=${this.config.sessionCookie}`;
    return h;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.url(path), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HeliosError(
        `Could not reach ${this.url(path)}: ${msg}. Check HELIOS_URL and network access.`,
        undefined,
        "upstream",
      );
    }
  }

  /** Throw a helpful error for responses that mean "not logged in / not allowed / missing". */
  private checkCommon(res: Response, path: string, locationHint?: string): void {
    const location = res.headers.get("location") ?? "";
    if (
      (res.status === 301 || res.status === 302) &&
      /\/auth\/(\?|$)|password_voter_login/.test(location)
    ) {
      throw new HeliosError(
        this.hasSession
          ? `Helios redirected ${path} to the login page: the session cookie has expired or is for another server. Log in again in the browser and ${this.config.howToAuth}`
          : `${path} requires login (redirected to ${location}). ${this.config.howToAuth} For a private election you must be an admin or registered voter.`,
        401,
        "auth",
      );
    }
    if (res.status === 403) {
      throw new HeliosError(
        `Forbidden (403) on ${path}. Either this session is not an administrator of the election, or the election is in the wrong state for this action (e.g. editing a frozen election, tallying an unfrozen one, or reading a result that has not been released).${locationHint ? " " + locationHint : ""}`,
        403,
        "forbidden",
      );
    }
    if (res.status === 404) {
      throw new HeliosError(
        `Not found (404): ${path}. Check the election UUID/short name, voter UUID or trustee UUID.`,
        404,
        "not_found",
      );
    }
  }

  async getText(path: string, accept = "text/html,application/json"): Promise<string> {
    const res = await this.rawFetch(path, {
      method: "GET",
      headers: this.headers({ Accept: accept }),
    });
    this.checkCommon(res, path);
    if (res.status >= 300 && res.status < 400) {
      // follow one same-host redirect (e.g. short-name shortcut)
      const loc = res.headers.get("location");
      if (loc) return this.getText(loc, accept);
    }
    if (!res.ok)
      throw new HeliosError(
        `GET ${path} failed with HTTP ${res.status}: ${stripTags(await res.text()).slice(0, 300)}`,
        res.status,
      );
    return res.text();
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const text = await this.getText(path, "application/json");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HeliosError(
        `${path} did not return JSON. First bytes: ${stripTags(text).slice(0, 200)}`,
        undefined,
        "upstream",
      );
    }
  }

  /** GET with redirects *not* followed; returns the Location header (or undefined). */
  async getRedirectLocation(
    path: string,
  ): Promise<{ status: number; location?: string | undefined }> {
    const res = await this.rawFetch(path, { method: "GET", headers: this.headers() });
    this.checkCommon(res, path);
    return { status: res.status, location: res.headers.get("location") ?? undefined };
  }

  /** Resolve an election identifier (UUID or short name) to its UUID. */
  async resolveElectionUuid(idOrShortName: string): Promise<string> {
    const id = idOrShortName.trim();
    if (UUID_RE.test(id)) return id.toLowerCase();
    const cached = this.shortNameCache.get(id);
    if (cached) return cached;
    const { location } = await this.getRedirectLocation(`/helios/e/${encodeURIComponent(id)}`);
    const found = location
      ? /\/helios\/elections\/([0-9a-f-]{36})/i.exec(location)?.[1]
      : undefined;
    if (!found)
      throw new HeliosError(
        `Could not resolve election short name "${id}" (no redirect to an election UUID).`,
        404,
        "not_found",
      );
    this.shortNameCache.set(id, found.toLowerCase());
    return found.toLowerCase();
  }

  // ---------------- CSRF + form posts ----------------

  /** Fetch (and cache) the session's csrf_token by reading a page that renders a form. */
  async csrfToken(force = false): Promise<string> {
    this.requireSession("This action");
    if (this.csrf && !force) return this.csrf;
    // elections/new is login-protected and always renders a form with csrf_token for users allowed to create elections
    for (const page of ["/helios/elections/new", "/"]) {
      const html = await this.getText(page);
      const token = extractCsrfToken(html);
      if (token) {
        this.csrf = token;
        return token;
      }
    }
    throw new HeliosError(
      "Could not find a csrf_token on the Helios admin pages. The session cookie may belong to a user who cannot create elections, or the session has expired. Log in again and send the new cookie.",
      401,
      "auth",
    );
  }

  private async sendForm(path: string, body: BodyInit, contentType?: string): Promise<PostResult> {
    const headers = this.headers({ Accept: "text/html,*/*" });
    if (contentType) headers["Content-Type"] = contentType;
    const res = await this.rawFetch(path, { method: "POST", headers, body });
    this.checkCommon(res, path);
    const text = res.status >= 300 && res.status < 400 ? "" : await res.text();
    return { status: res.status, location: res.headers.get("location") ?? undefined, body: text };
  }

  /**
   * POST an application/x-www-form-urlencoded form with the csrf_token added.
   * Retries once with a fresh token when Helios answers 400 (CSRF mismatch).
   * Returns the redirect location on success; throws with form errors when the
   * page re-renders with errors.
   */
  async postForm(
    path: string,
    fields: Record<string, string | number | boolean | null | undefined>,
    opts: { expectBody?: boolean } = {},
  ): Promise<PostResult> {
    const attempt = async (force: boolean): Promise<PostResult> => {
      const token = await this.csrfToken(force);
      const params = new URLSearchParams();
      params.set("csrf_token", token);
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        params.set(k, typeof v === "boolean" ? (v ? "on" : "") : String(v));
      }
      // Django's BooleanField treats an absent/empty value as False; drop empties for booleans
      for (const [k, v] of Object.entries(fields)) if (v === false) params.delete(k);
      return this.sendForm(
        path,
        params.toString(),
        "application/x-www-form-urlencoded; charset=UTF-8",
      );
    };
    let result = await attempt(false);
    if (result.status === 400) result = await attempt(true);
    return this.interpretPost(path, result, opts.expectBody ?? false);
  }

  /** POST multipart/form-data (file uploads) with the csrf_token added. */
  async postMultipart(
    path: string,
    fields: Record<string, string>,
    file?: { field: string; filename: string; content: string; type?: string },
  ): Promise<PostResult> {
    const attempt = async (force: boolean): Promise<PostResult> => {
      const token = await this.csrfToken(force);
      const fd = new FormData();
      fd.set("csrf_token", token);
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      if (file)
        fd.set(
          file.field,
          new Blob([file.content], { type: file.type ?? "text/csv" }),
          file.filename,
        );
      return this.sendForm(path, fd);
    };
    let result = await attempt(false);
    if (result.status === 400) result = await attempt(true);
    return this.interpretPost(path, result, true);
  }

  private interpretPost(path: string, result: PostResult, expectBody: boolean): PostResult {
    if (result.status === 400) {
      throw new HeliosError(
        `Helios rejected the POST to ${path} (400): ${stripTags(result.body).slice(0, 300) || "CSRF check failed"}. The session may have been reset; log in again and send the new cookie.`,
        400,
        "bad_request",
      );
    }
    if (result.status >= 500) {
      throw new HeliosError(
        `Helios returned HTTP ${result.status} for POST ${path}: ${stripTags(result.body).slice(0, 300)}`,
        result.status,
      );
    }
    if (result.status === 200 && !expectBody) {
      // Helios redirects on success; a 200 means the form re-rendered, usually with an error
      const errors = extractFormErrors(result.body);
      const trimmed = result.body.trim();
      if (trimmed === "SUCCESS") return result;
      if (trimmed === "FAILURE")
        throw new HeliosError(`Helios answered FAILURE for POST ${path}.`, 200, "form");
      throw new HeliosError(
        errors.length
          ? `Helios did not accept the form (${path}): ${errors.join("; ")}`
          : `Helios re-rendered the form for ${path} instead of redirecting, which usually means a validation problem. Page text: ${stripTags(result.body).slice(0, 400)}`,
        200,
        "form",
      );
    }
    return result;
  }
}
