// Minimal SmartSurvey API client used by the MCP tools.
// Docs: https://docs.smartsurvey.io  Spec: one OpenAPI definition per reference page on docs.smartsurvey.io
// (assembled into spec.json by test/assemble-spec.mjs).
import { redactContacts } from "./format.js";

export class SmartSurveyError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SmartSurveyError";
  }
}

// Spec: every list endpoint answers with a PaginatedList* object of this shape.
export interface PaginatedList<T> {
  records?: T[] | null;
  page_index?: number;
  pages?: number;
  page_size?: number;
  total?: number;
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET: repeating a POST .../sendone could email the same person twice, and repeating a PATCH
// .../close is harmless but is not retried either, so the rule stays simple.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// Getting Started, Pagination: page_size "defaults to 10, max is 100".
export const PAGE_SIZE = 100;

// Spec servers: https://{host}/v2 with host one of these three. Getting Started maps them to the
// sign-in hostname: app.smartsurvey.co.uk / app.smartsurvey.com -> UK (api.smartsurvey.io),
// app-eu.smartsurvey.com -> EU, app-us.smartsurvey.com -> US.
export const REGION_HOSTS: Record<string, string> = {
  default: "api.smartsurvey.io",
  uk: "api.smartsurvey.io",
  eu: "api-eu.smartsurvey.io",
  us: "api-us.smartsurvey.io",
};

export type QueryValue = string | number | boolean | string[] | undefined;

export class SmartSurveyClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  // SmartSurvey does not document a rate limit. Space requests at about four per second so a tool
  // call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(apiToken: string, apiSecret: string, baseUrl = `https://${REGION_HOSTS.default}/v2`) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // Getting Started, Authentication: HTTP Basic; "Username" is the API Token, "Password" is the
    // Token Secret (not the SmartSurvey login).
    this.authHeader = "Basic " + Buffer.from(`${apiToken}:${apiSecret}`, "utf8").toString("base64");
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** Like request(), but also returns the response headers (the pagination fallback reads them). */
  async requestWithHeaders<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<{ data: T; headers: Headers }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      // sort_by is typed as an array of strings; OpenAPI 3 query arrays default to style form,
      // explode true, i.e. the key repeated once per value.
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            // Getting Started: POST/PUT bodies must be application/json, text/xml or application/xml, else 415.
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        throw new SmartSurveyError(`Could not reach SmartSurvey at ${this.baseUrl}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new SmartSurveyError(
            `SmartSurvey asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`,
            res.status,
          );
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return { data: undefined as T, headers: res.headers };

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 2xx body is a JSON object. A 200 with HTML (a proxy, a captive portal, a
        // login page) must not be mistaken for an empty list or an empty survey.
        if (!json || typeof json !== "object") {
          throw new SmartSurveyError(
            `SmartSurvey returned ${res.status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(text.slice(0, 60))}). Check SMARTSURVEY_BASE_URL / SMARTSURVEY_REGION and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return { data: json as T, headers: res.headers };
      }

      // SmartSurvey's ProblemDetails title/detail and ApiBasicResponse message are free text; redact
      // anything that looks like a contact detail in case the live API echoes a recipient's email back.
      const detail = redactContacts(describeError(json) ?? text.slice(0, 300), false);
      const suffix = detail ? " " + detail : "";
      if (res.status === 401) {
        throw new SmartSurveyError(
          `SmartSurvey rejected the API credentials (401). Check SMARTSURVEY_API_TOKEN and SMARTSURVEY_API_SECRET: the API token is sent as the HTTP Basic username and the token secret as the password (not your SmartSurvey login). Keys are under My Account > API Keys in SmartSurvey, and the API needs a plan that includes it.${suffix}`,
          401,
        );
      }
      if (res.status === 403) {
        throw new SmartSurveyError(
          `SmartSurvey refused ${method} ${path} (403 Forbidden). Either this API key's account is not permitted to access that survey or resource, or the endpoint is not included in the account's plan (the API is a paid-plan feature and invitation sending is documented as a premium endpoint).${suffix}`,
          403,
        );
      }
      if (res.status === 404) throw new SmartSurveyError(`Not found: ${path}. Check the ID.${suffix}`, 404);
      if (res.status === 402) throw new SmartSurveyError(`SmartSurvey answered 402 for ${method} ${path}: the account's email invitation balance is insufficient to send this invitation. Top up the balance in SmartSurvey and try again.${suffix}`, 402);
      if (res.status === 429) throw new SmartSurveyError("SmartSurvey rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400) throw new SmartSurveyError(`SmartSurvey rejected ${method} ${path} (400).${suffix}`, 400);
      if (res.status === 415) throw new SmartSurveyError(`SmartSurvey answered 415 for ${method} ${path}: the request body must be sent as application/json (this server does). Check for a proxy rewriting the Content-Type header.${suffix}`, 415);
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        const how = path.includes("/invitations/") ? "the invitation's contact list in SmartSurvey" : "get_survey";
        throw new SmartSurveyError(
          `SmartSurvey returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with ${how} before repeating it.${suffix}`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a JSON
        // title/detail/message is passed on.
        const jsonDetail = redactContacts(describeError(json), false);
        throw new SmartSurveyError(
          `SmartSurvey returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`,
          res.status,
        );
      }
      throw new SmartSurveyError(`SmartSurvey returned ${res.status} for ${method} ${path}.${suffix}`, res.status);
    }
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch a page/page_size paginated collection (Getting Started, Pagination: page is 1-based and
   * defaults to 1; page_size defaults to 10, max 100). Each page is a PaginatedList* object with
   * `records`, `page_index`, `pages`, `page_size` and `total`; the same numbers are also sent as
   * X-SS-Pagination-* headers, which are read when the body lacks them.
   *
   * Whole pages only. The page size sent is min(100, maxItems), and the loop stops BEFORE a page that
   * could take the total past `maxItems`, so a page is never cut in the middle: cutting a page and
   * pointing the caller at the page after it would silently skip the records beyond the cut. The
   * result therefore holds at most `maxItems` records, possibly fewer than a caller asked for, and
   * `next_page` is the first page not fetched. Because page numbers only line up for one page size,
   * `page_size` is returned too and a continuation call must send the same size.
   *
   * Stops at an empty page, once the page just fetched is the last one according to `pages`, once
   * `total` records have been collected (when the walk began at page 1), or at `maxPages`. A page
   * shorter than page_size is NOT taken as the end: the docs say "the number of records is not
   * guaranteed to be the number specified as visibility rules may filter out items". `pages` is only
   * taken from the body; X-SS-Pagination-PageSize is documented as the number of rows *requested*,
   * so a page count derived from it would be wrong whenever the API returns fewer rows per page.
   */
  async list<T = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, page = 1, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; total?: number; pages?: number; page_size: number; complete: boolean; next_page?: number }> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, maxItems));
    const items: T[] = [];
    let total: number | undefined;
    let pages: number | undefined;
    let current = page;
    for (let n = 0; n < maxPages; n++) {
      const { data: res, headers } = await this.requestWithHeaders<PaginatedList<T>>("GET", path, { query: { ...query, page: current, page_size: pageSize } });
      const data = Array.isArray(res?.records) ? res.records : [];
      total = intOrUndefined(res?.total) ?? intOrUndefined(headers.get("x-ss-pagination-total")) ?? total;
      pages = intOrUndefined(res?.pages) ?? pages;
      items.push(...data);
      current++;
      const exhausted =
        data.length === 0 || (pages !== undefined && current > pages) || (page === 1 && total !== undefined && items.length >= total);
      if (exhausted) return { items, total, pages, page_size: pageSize, complete: true };
      // The next page may hold up to the size the API reports for this one (its own page_size, if
      // given, else what was asked for). Stop here if that could exceed the budget.
      const nextPageMax = intOrUndefined(res?.page_size) || pageSize;
      if (items.length + nextPageMax > maxItems) break;
    }
    return { items, total, pages, page_size: pageSize, complete: false, next_page: current };
  }
}

function intOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Spec error bodies: Microsoft.AspNetCore.Mvc.ProblemDetails {type, title, status, detail, instance},
// ValidationProblemDetails (the same plus errors: {field: [messages]}) and, on some endpoints,
// ApiBasicResponse {status, code, message}.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  for (const k of ["title", "detail", "message"]) if (typeof json[k] === "string" && json[k].trim()) parts.push(json[k].trim());
  if (json.errors && typeof json.errors === "object") {
    const errs = Object.entries(json.errors as Record<string, unknown>)
      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join("; ") : String(msgs)}`)
      .join(" | ");
    if (errs) parts.push(`Validation errors: ${errs}`);
  }
  if (typeof json.code === "string" && json.code.trim() && !parts.includes(json.code)) parts.push(`(code ${json.code})`);
  return parts.length ? parts.join(" ") : undefined;
}
