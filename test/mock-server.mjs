// Local stand-in for api.smartsurvey.io/v2, serving the fixtures with the documented page/page_size
// pagination (body fields records/page_index/pages/page_size/total plus the X-SS-Pagination-* headers).
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_TOKEN = "ss-test-token-123";
export const API_SECRET = "ss-test-secret-456";
export const AUTH = "Basic " + Buffer.from(`${API_TOKEN}:${API_SECRET}`).toString("base64");

// Spec error bodies: ProblemDetails for 401/402/403/404, ValidationProblemDetails for a 400 on
// POST .../sendone. The 401 body is not documented (Getting Started only says "Failed authentication
// will return an HTTP 401 Unauthorized response"); ProblemDetails is used here because every other
// documented error uses it.
const problem = (status, title, detail) => ({ type: `https://tools.ietf.org/html/rfc7231#section-6.5.${status - 399}`, title, status, detail, instance: null });

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer. The suite starts with a single 429 on
  // GET /survey-folders so the retry path is exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/survey-folders", status: 429, times: 1, headers: { "Retry-After": "1" }, body: problem(429, "Too Many Requests", "Rate limit exceeded.") });
  let failures = [failure429()];
  // When false, list bodies carry only `records`: the client must then read X-SS-Pagination-* headers.
  let bodyPaging = true;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/v2(?=\/|$)/, "");
    let body = "";
    for await (const chunk of req) body += chunk;
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
    requests.push({ method: req.method, path, query, auth: req.headers.authorization, contentType: req.headers["content-type"], body: body ? JSON.parse(body) : undefined, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const notFound = (what = "resource") => send(404, problem(404, "Not Found", `The requested ${what} was not found.`));
    if (req.headers.authorization !== AUTH) return send(401, problem(401, "Unauthorized", "Authentication failed."));

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // Getting Started, Pagination: page defaults to 1; page_size defaults to 10, max 100. Surveys are
    // capped at 10 per page and responses at 3 whatever is asked, so the suite exercises several pages
    // ("the number of records is not guaranteed to be the number specified"); folders and exports
    // honour the requested size. The body's page_size is the size actually used, while the
    // X-SS-Pagination-PageSize header is, as documented, the "number of rows requested".
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const rawRequested = Number(url.searchParams.get("page_size") || 10);
    const requested = rawRequested >= 1 && rawRequested <= 100 ? Math.floor(rawRequested) : 10;
    const cap = path === "/surveys" ? 10 : /\/responses$/.test(path) ? 3 : 100;
    const pageSize = Math.min(cap, requested);
    const paged = (items) => {
      const records = items.slice((page - 1) * pageSize, page * pageSize);
      const pages = Math.max(1, Math.ceil(items.length / pageSize));
      const headers = { "X-SS-Pagination-Page": String(page), "X-SS-Pagination-PageSize": String(requested), "X-SS-Pagination-Total": String(items.length), "X-SS-Pagination-Returned": String(records.length) };
      return send(200, bodyPaging ? { records, page_index: page, pages, page_size: pageSize, total: items.length } : { records }, headers);
    };

    const p = path.split("/").filter(Boolean);
    const m = req.method;
    const int = (s) => (/^\d+$/.test(s) ? Number(s) : NaN);

    if (m === "GET" && path === "/account-user") return send(200, fx.accountUser);
    if (m === "GET" && path === "/survey-folders") return paged(fx.folders);

    if (p[0] === "surveys") {
      if (m === "GET" && p.length === 1) return paged(fx.surveys);
      const surveyId = int(p[1]);
      if (surveyId === fx.FORBIDDEN) return send(403, problem(403, "Forbidden", "You do not have permission to access this survey."));
      const survey = fx.surveySingles[surveyId];
      if (!survey) return notFound("survey");
      if (m === "GET" && p.length === 2) return send(200, survey);
      if (m === "GET" && p.length === 3 && p[2] === "detailed") return send(200, fx.surveyDetailed[surveyId]);
      if (m === "GET" && p.length === 3 && p[2] === "exports") return paged(fx.exportsBySurvey[surveyId] ?? []);
      if (m === "GET" && p.length === 3 && p[2] === "responses") {
        const q = url.searchParams;
        const since = Number(q.get("since") || 0);
        const until = Number(q.get("until") || 0);
        const completed = q.get("completed") === null ? 1 : Number(q.get("completed"));
        const tracking = Number(q.get("tracking_link_id") || 0);
        const uniqueId = q.get("unique_id") || "";
        const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
        const items = surveyId !== fx.CSAT ? [] : fx.responses.filter((r) =>
          (completed !== 1 || r.status === "completed") &&
          (!since || unix(r.date_started) >= since) &&
          (!until || unix(r.date_ended) <= until) &&
          (!tracking || r.tracking_link_id === tracking) &&
          (!uniqueId || r.unique_id === uniqueId),
        );
        return paged(items);
      }
      if (m === "GET" && p.length === 4 && p[2] === "responses") {
        const r = surveyId === fx.CSAT ? fx.detailedResponses[int(p[3])] : undefined;
        return r ? send(200, r) : notFound("response");
      }
      if (m === "PATCH" && p.length === 3 && (p[2] === "open" || p[2] === "close")) {
        return send(200, { status: 200, code: "success", message: p[2] === "open" ? "Survey opened." : "Survey closed." });
      }
      if (m === "POST" && p.length === 5 && p[2] === "invitations" && p[4] === "sendone") {
        const invitationId = int(p[3]);
        if (invitationId !== fx.INVITATION && invitationId !== fx.INVITATION_NO_BALANCE) return notFound("invitation");
        if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return send(415, problem(415, "Unsupported Media Type", "Use application/json, text/xml or application/xml."));
        const b = JSON.parse(body);
        const errors = {};
        if (typeof b.name !== "string" || b.name.length < 1) errors.name = ["The name field is required."];
        if (b.entity_id != null && b.entity_unique_id != null) errors.entity_id = ["Supply either entity_id or entity_unique_id, not both."];
        if (Object.keys(errors).length) return send(400, { ...problem(400, "One or more validation errors occurred.", null), errors });
        if (invitationId === fx.INVITATION_NO_BALANCE) return send(402, problem(402, "Payment Required", "Insufficient email balance to send the invitation."));
        return send(200, { message: "Invitation sent.", validation_errors: {}, failed_contacts: [] });
      }
    }
    return notFound();
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  const setBodyPaging = (on) => {
    bodyPaging = on;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, setBodyPaging })));
}
