#!/usr/bin/env node
// SmartSurvey MCP server: lets Claude, ChatGPT and other MCP clients work with a SmartSurvey account.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SmartSurveyClient, SmartSurveyError, REGION_HOSTS } from "./client.js";
import * as fmt from "./format.js";

const apiToken = process.env.SMARTSURVEY_API_TOKEN?.trim();
const apiSecret = process.env.SMARTSURVEY_API_SECRET?.trim();
if (!apiToken || !apiSecret) {
  console.error("SMARTSURVEY_API_TOKEN and SMARTSURVEY_API_SECRET must both be set. Create a key in SmartSurvey under My Account > API Keys; the API token is the HTTP Basic username and the token secret the password.");
  process.exit(1);
}
// The region is validated even when SMARTSURVEY_BASE_URL overrides it, so a typo never goes unnoticed.
const region = (process.env.SMARTSURVEY_REGION?.trim() || "default").toLowerCase();
if (!REGION_HOSTS[region]) {
  console.error(`SMARTSURVEY_REGION must be one of default, uk, eu or us (got "${process.env.SMARTSURVEY_REGION}"). Use the region you sign in to: app.smartsurvey.co.uk or app.smartsurvey.com -> default, app-eu.smartsurvey.com -> eu, app-us.smartsurvey.com -> us.`);
  process.exit(1);
}
const baseUrl = process.env.SMARTSURVEY_BASE_URL || `https://${REGION_HOSTS[region]}/v2`;
const allowWrites = /^(1|true|yes)$/i.test(process.env.SMARTSURVEY_ALLOW_WRITES ?? "");
const api = new SmartSurveyClient(apiToken, apiSecret, baseUrl);

const server = new McpServer(
  { name: "smartsurvey", version: "0.1.0" },
  {
    instructions: [
      "Tools for a SmartSurvey account (surveys, survey designs, responses, exports, survey folders).",
      "Surveys, responses, exports, folders and invitations are identified by integer IDs.",
      "Typical flow for 'what did people say in the customer survey?': list_surveys, then get_survey with detail=true to see the pages and questions, then list_responses (with include_labels) for the answers.",
      "Timestamps are UTC ISO 8601. The since/until filters on list_responses take an ISO 8601 date (2026-09-01 or 2026-09-01T00:00:00Z) or a Unix timestamp in seconds.",
      "List tools return whole API pages up to max_results and say how to continue; a continuation call must keep the same max_results, because it sets the page size and page numbers only line up for one page size.",
      "Respondent identifiers (name, email, IP address, user agent, unique id, edit links) and contact data are only returned when explicitly requested with include_contact_details; emails and phone numbers in answers, survey titles and question text are redacted by default.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Every ID in the spec is an int32 path parameter.
const id = (what: string) => z.number().int().min(1).max(2147483647).describe(`${what} ID (a positive integer)`);
// since/until are documented as Unix timestamps in seconds ("Dates sent to the API must be Unix epoch
// timestamp", example 1451606400). Accept a Unix timestamp between 2000-01-01 and 2100-01-01, or an
// ISO 8601 date / date-time (a missing zone means UTC), and convert before the call. Anything else is
// refused rather than guessed: "2026" would be sent as 33 minutes past the epoch, a millisecond
// timestamp as a date thousands of years away, and "12/08/2026" reads differently on either side of
// the Atlantic.
const UNIX_MIN = 946684800; // 2000-01-01T00:00:00Z
const UNIX_MAX = 4102444800; // 2100-01-01T00:00:00Z
const ISO_8601 = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;
function toUnixTime(v: number | string): number | string {
  const how = "give a Unix timestamp in seconds (e.g. 1756684800) or an ISO 8601 date/time (e.g. 2026-09-01 or 2026-09-01T00:00:00Z; a missing zone means UTC)";
  const text = typeof v === "string" ? v.trim() : "";
  const asNumber = typeof v === "number" ? v : /^\d+$/.test(text) ? Number(text) : undefined;
  if (asNumber !== undefined) {
    if (!Number.isInteger(asNumber)) return `${v} is not a whole number of seconds; ${how}`;
    if (asNumber >= UNIX_MAX) return `${v} is too large for a Unix timestamp in seconds (it looks like milliseconds; the API takes seconds): ${how}`;
    if (asNumber < UNIX_MIN) return `${v} is too small for a Unix timestamp in seconds (it would mean a date before 2000; a bare year is not accepted): ${how}`;
    return asNumber;
  }
  const m = ISO_8601.exec(text);
  if (!m) return `"${v}" is not a Unix timestamp or an ISO 8601 date/time: ${how}`;
  const [, date, time, zone] = m;
  const ms = Date.parse(time ? `${date}T${time}${zone ?? "Z"}` : date);
  if (Number.isNaN(ms)) return `"${v}" is not a valid date/time: ${how}`;
  return Math.floor(ms / 1000);
}
const unixTime = z.union([z.number(), z.string().min(1)]).transform((v, ctx) => {
  const out = toUnixTime(v);
  if (typeof out === "string") {
    ctx.addIssue({ code: "custom", message: out });
    return z.NEVER;
  }
  return out;
});
const sortBy = z.array(z.string().min(1).max(100)).max(10).optional().describe("Properties to sort by, passed through as the documented sort_by parameter (the accepted property names are not documented; the API's default order is used when omitted)");
const startPage = z.number().int().min(1).default(1).describe("1-based page to start from (for continuing a previous call)");

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof SmartSurveyError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

// Whole API pages are returned, so max_results is a ceiling and the continuation is a page number. The
// page size is min(100, max_results), so the caller must keep max_results for page numbers to line up.
const pageNote = (r: { complete: boolean; next_page?: number }, maxResults: number) =>
  r.complete ? undefined : `More results exist; call again with page ${r.next_page} and the same max_results (${maxResults}) to continue. max_results sets the page size, so changing it would renumber the pages.`;
const listMeta = (r: { items: unknown[]; total?: number; pages?: number; page_size: number; complete: boolean; next_page?: number }, maxResults: number) => ({
  count: r.items.length,
  total: r.total,
  pages: r.pages,
  page_size: r.page_size,
  complete: r.complete,
  next_page: r.next_page,
  note: pageNote(r, maxResults),
});
const includeContact = (what: string) => z.boolean().default(false).describe(`Stop redacting email addresses and phone numbers in ${what}`);

server.registerTool(
  "whoami",
  {
    title: "Who owns this API key",
    description: "The SmartSurvey account user the API key belongs to (name, email, user type, number of surveys). Use it to confirm which account and region the server is talking to.",
    inputSchema: {},
    annotations: READ,
  },
  safe(async () => ({ account_user: fmt.accountUser(await api.get("/account-user")), base_url: baseUrl })),
);

server.registerTool(
  "list_surveys",
  {
    title: "List surveys",
    description:
      "Surveys on this account with title, nickname, status (open or closed), response count and dates, in the order the API returns them. Whole API pages of min(100, max_results) surveys are returned, so the count may be below max_results; the note says how to continue. Emails and phone numbers in titles are redacted unless include_contact_details is set.",
    inputSchema: {
      max_results: z.number().int().min(1).max(1000).default(100).describe("Maximum number of surveys to return; also sets the API page size (up to 100)"),
      page: startPage,
      sort_by: sortBy,
      include_contact_details: includeContact("survey titles and nicknames"),
    },
    annotations: READ,
  },
  safe(async ({ max_results, page, sort_by, include_contact_details }) => {
    const r = await api.list("/surveys", { maxItems: max_results, maxPages: 20, page, query: { sort_by } });
    return { ...listMeta(r, max_results), surveys: r.items.map((s) => fmt.survey(s, include_contact_details)) };
  }),
);

server.registerTool(
  "get_survey",
  {
    title: "Get a survey",
    description:
      "One survey with page and question counts, theme and settings. With detail=true the full design is returned: variables, translations, and every page with its questions, answer choices and logic flags (this is the survey design, not respondents' answers). Emails and phone numbers in the title and in page, question and choice text are redacted unless include_contact_details is set.",
    inputSchema: {
      survey_id: id("Survey"),
      detail: z.boolean().default(false).describe("Return the full design (pages, questions, choices) via the /detailed endpoint"),
      translation_id: z.number().int().min(0).optional().describe("Translation to return the survey text in; 0 or omitted for the default"),
      include_contact_details: includeContact("the survey title, nickname, page descriptions, question and choice text and variable labels"),
    },
    annotations: READ,
  },
  safe(async ({ survey_id, detail, translation_id, include_contact_details }) => {
    const query = { translation_id };
    if (detail) return { survey: fmt.surveyDetailed(await api.get(`/surveys/${survey_id}/detailed`, query), include_contact_details) };
    return { survey: fmt.surveySingle(await api.get(`/surveys/${survey_id}`, query), include_contact_details) };
  }),
);

server.registerTool(
  "list_responses",
  {
    title: "List responses to a survey",
    description:
      "Responses to one survey with every page, question and answer. Whole API pages of min(100, max_results) responses are returned, so the count may be below max_results; the note says how to continue. Filters (since, until, completed_only, filter_id, tracking_link_id, unique_id) are passed to the API as documented. Respondent identifiers are withheld and emails/phone numbers in answers redacted unless include_contact_details is set.",
    inputSchema: {
      survey_id: id("Survey"),
      since: unixTime.optional().describe("Only responses after this date/time (Unix timestamp in seconds, or ISO 8601 such as 2026-09-01 or 2026-09-01T00:00:00Z; UTC when no zone is given)"),
      until: unixTime.optional().describe("Only responses before this date/time (same forms as since)"),
      completed_only: z.boolean().default(true).describe("Only completed responses (the API's default). false also returns partial and disqualified responses"),
      filter_id: z.number().int().min(1).optional().describe("Apply a saved filter from the survey's filter groups"),
      tracking_link_id: z.number().int().min(1).optional().describe("Only responses collected through this tracking link"),
      unique_id: z.string().min(1).max(200).optional().describe("Only responses with this respondent unique id"),
      include_labels: z.boolean().default(true).describe("Ask the API for question and page labels (titles) so answers are readable; false returns IDs only, which is the API's default and a smaller payload"),
      translation_id: z.number().int().min(1).optional().describe("Translation for the labels; the API defaults to 1 (English)"),
      max_results: z.number().int().min(1).max(500).default(25).describe("Maximum number of responses to return; also sets the API page size (up to 100)"),
      page: startPage,
      sort_by: sortBy,
      include_contact_details: z.boolean().default(false).describe("Include respondent name, email, unique id, IP address, user agent, saved-response details and edit links, contact-list columns that look like contact data, and stop redacting emails and phone numbers in answers"),
    },
    annotations: READ,
  },
  safe(async ({ survey_id, since, until, completed_only, filter_id, tracking_link_id, unique_id, include_labels, translation_id, max_results, page, sort_by, include_contact_details }) => {
    const r = await api.list(`/surveys/${survey_id}/responses`, {
      maxItems: max_results,
      maxPages: 20,
      page,
      query: { since, until, completed: completed_only ? 1 : 0, filter_id, tracking_link_id, unique_id, include_labels, translation_id, sort_by },
    });
    return { ...listMeta(r, max_results), responses: r.items.map((x) => fmt.response(x, include_contact_details)) };
  }),
);

server.registerTool(
  "get_response",
  {
    title: "Get one response",
    description:
      "One response with every page, question and answer, plus the Organisation Hierarchy entity fields when the account uses that feature. Respondent identifiers are withheld and emails/phone numbers in answers redacted unless include_contact_details is set.",
    inputSchema: {
      survey_id: id("Survey"),
      response_id: id("Response"),
      include_labels: z.boolean().default(true).describe("Ask the API for question and page labels (the API's default for this endpoint)"),
      translation_id: z.number().int().min(1).optional().describe("Translation for the labels; the API defaults to 1 (English)"),
      include_contact_details: z.boolean().default(false).describe("Include respondent name, email, unique id, IP address, user agent, saved-response details and edit links, contact-list columns that look like contact data, and stop redacting emails and phone numbers in answers"),
    },
    annotations: READ,
  },
  safe(async ({ survey_id, response_id, include_labels, translation_id, include_contact_details }) => ({
    response: fmt.response(await api.get(`/surveys/${survey_id}/responses/${response_id}`, { include_labels, translation_id }), include_contact_details),
  })),
);

server.registerTool(
  "list_exports",
  {
    title: "List exports of a survey",
    description: "Exports (reports) generated for one survey: name, type, status (queued, completed or errored), file size and type, dates and the API download URL. Metadata only; this server never downloads the files.",
    inputSchema: { survey_id: id("Survey"), max_results: z.number().int().min(1).max(500).default(50), page: startPage, sort_by: sortBy },
    annotations: READ,
  },
  safe(async ({ survey_id, max_results, page, sort_by }) => {
    const r = await api.list(`/surveys/${survey_id}/exports`, { maxItems: max_results, maxPages: 10, page, query: { sort_by } });
    return { ...listMeta(r, max_results), exports: r.items.map(fmt.surveyExport) };
  }),
);

server.registerTool(
  "list_survey_folders",
  {
    title: "List survey folders",
    description: "The survey folders on the API key's account (id, type, title). Emails and phone numbers in titles are redacted unless include_contact_details is set.",
    inputSchema: { max_results: z.number().int().min(1).max(1000).default(100), page: startPage, sort_by: sortBy, include_contact_details: includeContact("folder titles") },
    annotations: READ,
  },
  safe(async ({ max_results, page, sort_by, include_contact_details }) => {
    const r = await api.list("/survey-folders", { maxItems: max_results, maxPages: 10, page, query: { sort_by } });
    return { ...listMeta(r, max_results), folders: r.items.map((f) => fmt.surveyFolder(f, include_contact_details)) };
  }),
);

if (allowWrites) {
  server.registerTool(
    "open_survey",
    {
      title: "Open a survey",
      description: "Open a survey for responses. The API opens only the default tracking link; if the survey is already open nothing is changed. Only available when SMARTSURVEY_ALLOW_WRITES=true.",
      inputSchema: { survey_id: id("Survey") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ survey_id }) => ({ result: fmt.basicResult(await api.request("PATCH", `/surveys/${survey_id}/open`)) })),
  );

  server.registerTool(
    "close_survey",
    {
      title: "Close a survey",
      description:
        "Close a survey to responses. The API closes ALL of the survey's tracking links, and open_survey afterwards reopens only the default one, so the other links stay closed until someone reopens them in SmartSurvey. If the survey is already closed nothing is changed. Only available when SMARTSURVEY_ALLOW_WRITES=true.",
      inputSchema: { survey_id: id("Survey") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ survey_id }) => ({ result: fmt.basicResult(await api.request("PATCH", `/surveys/${survey_id}/close`)) })),
  );

  server.registerTool(
    "send_invitation_to_one",
    {
      title: "Send a survey invitation to one person",
      description:
        "Email (or SMS) an existing survey invitation to a single recipient. This contacts a real person: give a name and an email address or a mobile number. SmartSurvey documents this as a premium endpoint that is not available on all plans (403 when it is not) and answers 402 when the account's email balance is too low. If SmartSurvey answers with a gateway error (502/503/504) the send is NOT retried, because it may already have gone out. Only available when SMARTSURVEY_ALLOW_WRITES=true.",
      inputSchema: {
        survey_id: id("Survey"),
        invitation_id: id("Invitation").describe("ID of an existing invitation on the survey (an email or SMS invitation set up in SmartSurvey)"),
        name: z.string().min(1).max(500).describe("Recipient's name (required by the API)"),
        email: z.string().email().optional().describe("Recipient's email address, for an email invitation"),
        mobile: z.string().regex(/^\+?[0-9 ()-]{6,20}$/, "Mobile numbers are digits with an optional leading +, e.g. +447700900123").optional().describe("Recipient's mobile number, for an SMS invitation"),
        custom_columns: z.array(z.object({ name: z.string().min(1).max(200), value: z.string().max(2000) })).max(50).optional().describe("Custom column values for this recipient (names as defined on the invitation's contact list)"),
        entity_id: z.number().int().min(1).optional().describe("Organisation Hierarchy entity to assign the recipient to (numeric id). Not with entity_unique_id."),
        entity_unique_id: z.string().min(1).max(200).optional().describe("Organisation Hierarchy entity to assign the recipient to (its unique code). Not with entity_id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ survey_id, invitation_id, name, email, mobile, custom_columns, entity_id, entity_unique_id }) => {
      // Spec InvitationRequestContact: email "if an email invitation", mobile "if an SMS invitation";
      // entity_id and entity_unique_id "Supply either this or ..., not both".
      const problems: string[] = [];
      if (!email && !mobile) problems.push("Give an email address (for an email invitation) or a mobile number (for an SMS invitation).");
      if (entity_id !== undefined && entity_unique_id !== undefined) problems.push("Give either entity_id or entity_unique_id, not both (the API refuses both).");
      if (problems.length) throw new SmartSurveyError(`Not sent. ${problems.join(" ")}`);
      // Body shape: spec InvitationRequestContact.
      const body = {
        name,
        ...(email ? { email } : {}),
        ...(mobile ? { mobile } : {}),
        ...(custom_columns?.length ? { custom_columns } : {}),
        ...(entity_id !== undefined ? { entity_id } : {}),
        ...(entity_unique_id !== undefined ? { entity_unique_id } : {}),
      };
      const res = await api.request("POST", `/surveys/${survey_id}/invitations/${invitation_id}/sendone`, { body });
      const out = fmt.sendResult(res);
      return { result: out.failed_contacts.length || out.validation_errors ? "not sent to every recipient; see details" : "sent", ...out };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`SmartSurvey MCP server running against ${baseUrl} (writes ${allowWrites ? "enabled" : "disabled"}).`);
