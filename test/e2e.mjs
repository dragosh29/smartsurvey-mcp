// End-to-end test: fixtures are validated against SmartSurvey's published OpenAPI schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_TOKEN, API_SECRET, AUTH } from "./mock-server.mjs";
import { assembleSpec, LLMS_URL } from "./assemble-spec.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
// SmartSurvey publishes one OpenAPI definition per reference page; spec.json is assembled from them.
if (!existsSync(`${root}spec.json`)) {
  try {
    const r = await assembleSpec(`${root}spec.json`);
    console.log(`Assembled spec.json from ${LLMS_URL}: ${r.pages} pages, ${r.operations} operations, ${r.schemas} schemas.`);
  } catch (err) {
    console.error(`Could not assemble the SmartSurvey spec (${err?.cause?.code ?? err.message}). Build it manually:\n  node test/assemble-spec.mjs`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "ss", components: spec.components });
const S = (short) => `SmartSurvey.${short}`;
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`ss#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `ss#/components/schemas/${schema}` }) : ajv.compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (schemaName, obj, id = "") => validateWith(schemaName, obj, `${schemaName} ${id}`);
const responseSchema = (method, path, status) => {
  const ref = spec.paths[path][method].responses[status].content["application/json"].schema.$ref;
  return ref.replace("#/components/schemas/", "");
};

console.log("fixtures vs OpenAPI spec");
await check("account user, surveys (list, single, detailed), responses (list, detailed), exports, folders", async () => {
  validate(S("Public.API.Models.AccountUsers.AccountUserResponse"), fx.accountUser);
  fx.surveys.forEach((s) => validate(S("Public.API.Models.Surveys.SurveyResponse"), s, s.id));
  Object.values(fx.surveySingles).forEach((s) => validate(S("Public.API.Models.Surveys.SurveySingleResponse"), s, s.id));
  Object.values(fx.surveyDetailed).forEach((s) => validate(S("Public.API.Models.Surveys.SurveyDetailedResponse"), s, s.id));
  assert.equal(Object.keys(fx.surveyDetailed).length, fx.surveys.length);
  fx.responses.forEach((r) => validate(S("Shared.Models.API.Response"), r, r.id));
  Object.values(fx.detailedResponses).forEach((r) => validate(S("Public.API.Models.Responses.DetailedResponse"), r, r.id));
  Object.values(fx.exportsBySurvey).flat().forEach((e) => validate(S("Public.API.Models.SurveyExports.SurveyExportResponse"), e, e.id));
  fx.folders.forEach((f) => validate(S("Public.API.Models.SurveyFolders.SurveyFolderResponse"), f, f.id));
});

// 2. The mock's responses (lists, single records, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, setBodyPaging } = await startMock();
const base = `http://127.0.0.1:${port}/v2`;
const raw = async (method, path, init = {}) => {
  const res = await fetch(base + path, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, ...init });
  return { status: res.status, headers: res.headers, json: await res.json() };
};
await check("mock responses match the documented list, detail, action and error schemas, with the X-SS-Pagination headers", async () => {
  // The PaginatedList* schemas mark nothing as required, so assert the documented keys explicitly.
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  const listKeys = (obj) => keys(obj, "records", "page_index", "pages", "page_size", "total");
  validate(responseSchema("get", "/account-user", "200"), (await raw("GET", "/account-user")).json);
  const surveys = await raw("GET", "/surveys?page=1&page_size=100");
  validate(responseSchema("get", "/surveys", "200"), surveys.json);
  listKeys(surveys.json);
  assert.deepEqual([surveys.json.page_index, surveys.json.pages, surveys.json.page_size, surveys.json.total], [1, 3, 10, 25], "the mock caps surveys at 10 per page");
  assert.deepEqual(
    ["x-ss-pagination-page", "x-ss-pagination-pagesize", "x-ss-pagination-total", "x-ss-pagination-returned"].map((h) => surveys.headers.get(h)),
    ["1", "100", "25", "10"],
    "Getting Started documents these four headers; PageSize is the number of rows requested, Returned the number sent",
  );
  validate(responseSchema("get", "/surveys/{surveyId}", "200"), (await raw("GET", `/surveys/${fx.CSAT}`)).json);
  validate(responseSchema("get", "/surveys/{surveyId}/detailed", "200"), (await raw("GET", `/surveys/${fx.CSAT}/detailed`)).json);
  const responses = await raw("GET", `/surveys/${fx.CSAT}/responses?completed=0&page_size=100`);
  validate(responseSchema("get", "/surveys/{surveyId}/responses", "200"), responses.json);
  listKeys(responses.json);
  assert.deepEqual([responses.json.pages, responses.json.total, responses.json.records.length], [3, 7, 3], "the mock caps responses at 3 per page");
  validate(responseSchema("get", "/surveys/{surveyId}/responses/{responseId}", "200"), (await raw("GET", `/surveys/${fx.CSAT}/responses/305`)).json);
  const exportsList = (await raw("GET", `/surveys/${fx.CSAT}/exports`)).json;
  validate(responseSchema("get", "/surveys/{surveyId}/exports", "200"), exportsList);
  listKeys(exportsList);
  const limited = await raw("GET", "/survey-folders"); // the mock answers the first survey-folders call with a 429
  assert.equal(limited.status, 429);
  const folders = (await raw("GET", "/survey-folders")).json;
  validate(responseSchema("get", "/survey-folders", "200"), folders);
  listKeys(folders);
  validate(responseSchema("patch", "/surveys/{surveyId}/open", "200"), (await raw("PATCH", `/surveys/${fx.CSAT}/open`)).json);
  validate(responseSchema("patch", "/surveys/{surveyId}/close", "200"), (await raw("PATCH", `/surveys/${fx.CSAT}/close`)).json);
  const sendPath = "/surveys/{surveyId}/invitations/{invitationId}/sendone";
  const sent = await raw("POST", `/surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`, { body: JSON.stringify({ name: "Sam Evans", email: "sam.evans@example.com" }) });
  assert.equal(sent.status, 200);
  validate(responseSchema("post", sendPath, "200"), sent.json);
  const badSend = await raw("POST", `/surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`, { body: JSON.stringify({ email: "x@example.com" }) });
  assert.equal(badSend.status, 400);
  validate(responseSchema("post", sendPath, "400"), badSend.json);
  const noBalance = await raw("POST", `/surveys/${fx.CSAT}/invitations/${fx.INVITATION_NO_BALANCE}/sendone`, { body: JSON.stringify({ name: "Sam Evans", email: "sam.evans@example.com" }) });
  assert.equal(noBalance.status, 402);
  validate(responseSchema("post", sendPath, "402"), noBalance.json);
  const forbidden = await raw("GET", `/surveys/${fx.FORBIDDEN}`);
  assert.equal(forbidden.status, 403);
  validate(responseSchema("get", "/surveys/{surveyId}", "403"), forbidden.json);
  const missing = await raw("GET", "/surveys/1");
  assert.equal(missing.status, 404);
  validate(responseSchema("get", "/surveys/{surveyId}", "404"), missing.json);
  validate(responseSchema("get", "/surveys/{surveyId}/responses/{responseId}", "404"), (await raw("GET", `/surveys/${fx.CSAT}/responses/1`)).json);
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal SMARTSURVEY_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ token = API_TOKEN, secret = API_SECRET, writes = "true", extra = {} } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, SMARTSURVEY_API_TOKEN: token, SMARTSURVEY_API_SECRET: secret, SMARTSURVEY_BASE_URL: base, ...extra };
  delete env.SMARTSURVEY_ALLOW_WRITES;
  if (writes !== null) env.SMARTSURVEY_ALLOW_WRITES = writes;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [`${root}dist/index.js`],
      env,
      stderr: "ignore",
    }),
  );
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const WRITES = ["close_survey", "open_survey", "send_invitation_to_one"];
const READS = ["get_response", "get_survey", "list_exports", "list_responses", "list_survey_folders", "list_surveys", "whoami"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 10 tools; reads are read-only, close_survey destructive, open and send not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...WRITES, ...READS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITES.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "close_survey", `${t.name} destructiveHint`);
  }
  const open = tools.find((t) => t.name === "open_survey");
  assert.equal(open.annotations.idempotentHint, true, "the spec says opening an already open survey changes nothing");
});

await check("whoami returns the key owner's account user", async () => {
  const { data } = await call(client, "whoami");
  assert.deepEqual(data.account_user, { id: 90210, type: "master", name: "Alex Example", email: "alex@example.com", surveys: 25, date_created: fx.accountUser.date_created });
  assert.equal(data.base_url, base);
  assert.equal(requests.at(-1).path, "/account-user");
});

await check("list_surveys pages 1, 2, 3 with page_size 100 and stops at the documented page count", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_surveys", { max_results: 1000 });
  assert.deepEqual([data.count, data.total, data.pages, data.page_size, data.complete, data.next_page, data.note], [25, 25, 3, 100, true, undefined, undefined]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page, r.query.page_size]), [["/surveys", "1", "100"], ["/surveys", "2", "100"], ["/surveys", "3", "100"]], "three pages, no fourth call once pages is reached");
  assert.equal(data.surveys[0].id, fx.CSAT);
  assert.deepEqual(data.surveys[0], { id: fx.CSAT, title: "Customer satisfaction 2026", nickname: "CSAT Q3", type: "survey", status: "open", responses: 7, date_created: fx.surveys[0].date_created, date_modified: fx.surveys[0].date_modified, survey_url: `https://www.smartsurvey.co.uk/s/${fx.CSAT}/` });
  assert.equal(data.surveys[2].title, "Staff pulse (queries to [email redacted] or [phone redacted])", "emails and phone numbers in survey titles are redacted by default");
  const asStored = await call(client, "list_surveys", { max_results: 1000, include_contact_details: true });
  assert.equal(asStored.data.surveys[2].title, fx.surveys[2].title, "returned as stored with include_contact_details");
});

// Follow a list tool's own continuation notes from `page` until it reports complete, collecting the ids.
const walk = async (tool, args, key) => {
  const ids = [];
  const calls = [];
  for (let page = args.page ?? 1; ; ) {
    const { data, text } = await call(client, tool, { ...args, page });
    assert.ok(data, text);
    calls.push({ data, request: requests.at(-1) });
    assert.ok(data.count <= args.max_results, `count ${data.count} exceeds max_results ${args.max_results}`);
    ids.push(...data[key].map((x) => x.id));
    if (data.complete) {
      assert.deepEqual([data.next_page, data.note], [undefined, undefined], "a complete list carries no continuation");
      return { ids, calls };
    }
    assert.equal(typeof data.next_page, "number");
    assert.match(data.note, new RegExp(`call again with page ${data.next_page} and the same max_results \\(${args.max_results}\\)`));
    page = data.next_page;
  }
};

await check("list_surveys with max_results returns whole pages only, and following its notes yields every survey exactly once", async () => {
  // page_size = max_results (15); the mock serves 10 per page regardless, so a 15-record cut would have
  // to split a page. The client must instead stop after the whole page and point at the next one.
  const n = requests.length;
  const { ids, calls } = await walk("list_surveys", { max_results: 15 }, "surveys");
  assert.deepEqual(ids, fx.surveys.map((s) => s.id), "every survey once, in order, no gaps and no repeats");
  assert.deepEqual(since(n).map((r) => [r.query.page, r.query.page_size]), [["1", "15"], ["2", "15"], ["3", "15"]], "one request per tool call, page_size = max_results");
  assert.deepEqual(calls.map((c) => [c.data.count, c.data.page_size, c.data.next_page, c.data.complete]), [[10, 15, 2, false], [10, 15, 3, false], [5, 15, undefined, true]], "each call returns the API's whole page and names the first page not fetched");
  // Starting from a later page works the same way.
  const fromTwo = await walk("list_surveys", { max_results: 15, page: 2 }, "surveys");
  assert.deepEqual(fromTwo.ids, fx.surveys.slice(10).map((s) => s.id));
  // max_results above 100 sends the maximum page size and stops before a page that could exceed the budget.
  const twoPages = await call(client, "list_surveys", { max_results: 20 });
  assert.deepEqual([twoPages.data.count, twoPages.data.next_page, requests.at(-1).query.page_size], [20, 3, "20"], "two whole pages of 10 fit in 20; a third could not");
  await call(client, "list_surveys", { max_results: 5, sort_by: ["title", "date_created"] });
  assert.deepEqual(requests.at(-1).query.sort_by, ["title", "date_created"], "sort_by is an array in the spec: form style, exploded");
  const plain = await call(client, "list_surveys", { max_results: 5 });
  assert.equal(requests.at(-1).query.sort_by, undefined, "no sort_by unless asked");
  assert.deepEqual([plain.data.count, requests.at(-1).query.page_size], [5, "5"]);
});

await check("get_survey returns the single record by default and the full design (pages, questions, choices) with detail=true", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_survey", { survey_id: fx.CSAT });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.translation_id]), [[`/surveys/${fx.CSAT}`, undefined]]);
  assert.deepEqual([data.survey.page_count, data.survey.question_count, data.survey.theme_id, data.survey.properties], [2, 4, 4242, { scoring: true, presentation_mode: 0 }]);
  assert.equal(data.survey.pages, undefined);
  const detailed = await call(client, "get_survey", { survey_id: fx.CSAT, detail: true, translation_id: 2 });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).query.translation_id], [`/surveys/${fx.CSAT}/detailed`, "2"]);
  const s = detailed.data.survey;
  assert.deepEqual(s.variables, [{ id: 701, name: "email", label: "Respondent email" }, { id: 702, name: "campaign", label: "Campaign" }, { id: 703, name: "phoneNumber", label: "Phone number" }]);
  assert.deepEqual(s.translations.map((t) => [t.id, t.name, t.default]), [[1, "English", true], [2, "Cymraeg", undefined]]);
  assert.deepEqual(s.pages.map((p) => [p.id, p.title, p.questions.length]), [[9001, "About your visit", 2], [9002, "Recommendation", 2]]);
  const q1 = s.pages[0].questions[0];
  assert.deepEqual([q1.id, q1.number, q1.type, q1.sub_type, q1.title, q1.required], [fx.Q_RATING, 1, "single_choice", "radio", "How satisfied were you with your visit?", true]);
  assert.deepEqual(q1.choices.map((c) => [c.id, c.title, c.score_value]), [[61, "Very satisfied", 5], [62, "Satisfied", 4], [63, "Neutral", 3], [64, "Dissatisfied", 2], [65, "Very dissatisfied", 1]]);
  assert.equal(s.pages[0].questions[1].skip_logic_count, 1);
  assert.deepEqual(s.pages[0].logic, { completion_action: { action: 0 }, terminal: { thank_you: false, response_status: 0 }, question_randomisation: { randomisation: 0 } });
  assert.deepEqual(s.pages[1].questions[1].choices.map((c) => c.type), ["matrix_row", "matrix_row", "matrix_col", "matrix_col"]);
  // Design text (title, page description, question and choice titles, variable labels) is redacted by default.
  const staff = await call(client, "get_survey", { survey_id: fx.STAFF, detail: true });
  const d = staff.data.survey;
  assert.equal(d.title, "Staff pulse (queries to [email redacted] or [phone redacted])");
  assert.equal(d.pages[0].description, "Questions? Call HR on [phone redacted] or email [email redacted].");
  assert.equal(d.pages[0].questions[0].title, "Your thoughts (or write to [email redacted])");
  assert.equal(d.pages[0].questions[0].choices[0].title, "Other: text [phone redacted]");
  assert.deepEqual(d.variables, [{ id: 704, name: "dept", label: "Department (ask [email redacted])" }]);
  assert.ok(!JSON.stringify(staff.data).includes("example.com") && !JSON.stringify(staff.data).includes("0117"), "no contact detail in the default design output");
  const staffAsStored = await call(client, "get_survey", { survey_id: fx.STAFF, detail: true, include_contact_details: true });
  assert.deepEqual([staffAsStored.data.survey.title, staffAsStored.data.survey.pages[0].description], [fx.surveys[2].title, fx.surveyDetailed[fx.STAFF].pages[0].description]);
  const single = await call(client, "get_survey", { survey_id: fx.STAFF });
  assert.equal(single.data.survey.title, "Staff pulse (queries to [email redacted] or [phone redacted])");
});

await check("list_responses passes the documented filters through exactly: since/until as Unix timestamps, completed, filter_id, tracking_link_id, unique_id, include_labels, translation_id", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_responses", { survey_id: fx.CSAT });
  let q = since(n)[0].query;
  assert.deepEqual([q.completed, q.include_labels, q.since, q.until, q.filter_id, q.tracking_link_id, q.unique_id, q.translation_id, q.page, q.page_size], ["1", "true", undefined, undefined, undefined, undefined, undefined, undefined, "1", "25"], "defaults: completed=1 and include_labels=true, page_size = the default max_results, nothing else");
  assert.deepEqual(data.responses.map((r) => r.id), [301, 302, 305, 306, 307], "completed only by default");
  const all = await call(client, "list_responses", { survey_id: fx.CSAT, completed_only: false, include_labels: false, translation_id: 2, filter_id: 77 });
  q = requests.at(-1).query;
  assert.deepEqual([q.completed, q.include_labels, q.translation_id, q.filter_id], ["0", "false", "2", "77"]);
  assert.equal(all.data.count, 7);
  const window = await call(client, "list_responses", { survey_id: fx.CSAT, since: fx.SINCE_ISO, until: fx.UNTIL_ISO, completed_only: false });
  q = requests.at(-1).query;
  assert.deepEqual([q.since, q.until], [String(fx.SINCE_UNIX), String(fx.UNTIL_UNIX)], "ISO 8601 input is converted to the documented Unix timestamps");
  assert.deepEqual(window.data.responses.map((r) => r.id), [303, 304, 305]);
  const unixIn = await call(client, "list_responses", { survey_id: fx.CSAT, since: fx.SINCE_UNIX, completed_only: false });
  assert.equal(requests.at(-1).query.since, String(fx.SINCE_UNIX), "a Unix timestamp is passed as is");
  assert.deepEqual(unixIn.data.responses.map((r) => r.id), [303, 304, 305, 306, 307]);
  const dateOnly = await call(client, "list_responses", { survey_id: fx.CSAT, since: "2026-08-12" });
  assert.equal(requests.at(-1).query.since, String(fx.SINCE_UNIX), "a date without a time means midnight UTC");
  assert.deepEqual(dateOnly.data.responses.map((r) => r.id), [305, 306, 307]);
  for (const [input, expected] of [
    ["2026-08-12T00:00:00", fx.SINCE_UNIX], // no zone: UTC, never the machine's local time
    ["2026-08-12T00:00", fx.SINCE_UNIX],
    ["2026-08-12 01:00:00+01:00", fx.SINCE_UNIX],
    ["2026-08-12T00:00:00.000Z", fx.SINCE_UNIX],
    [String(fx.SINCE_UNIX), fx.SINCE_UNIX], // a Unix timestamp as a string
  ]) {
    await call(client, "list_responses", { survey_id: fx.CSAT, since: input });
    assert.equal(requests.at(-1).query.since, String(expected), `since ${JSON.stringify(input)}`);
  }
  const byLink = await call(client, "list_responses", { survey_id: fx.CSAT, tracking_link_id: 2, unique_id: "cust-0001" });
  q = requests.at(-1).query;
  assert.deepEqual([q.tracking_link_id, q.unique_id], ["2", "cust-0001"]);
  assert.equal(byLink.data.count, 0);
  const byUnique = await call(client, "list_responses", { survey_id: fx.CSAT, unique_id: "cust-0002" });
  assert.deepEqual(byUnique.data.responses.map((r) => r.id), [307]);
  // Ambiguous or wrongly scaled input is refused rather than turned into a silently wrong filter.
  const before = requests.length;
  for (const [input, why] of [
    ["next tuesday", /not a Unix timestamp or an ISO 8601 date\/time/],
    ["12/08/2026", /not a Unix timestamp or an ISO 8601 date\/time/], // 8 December or 12 August?
    ["2026-08", /not a Unix timestamp or an ISO 8601 date\/time/],
    ["2026-13-45", /not a valid date\/time/],
    ["2026", /too small for a Unix timestamp in seconds.*a bare year is not accepted/], // would be sent as 1970-01-01T00:33:46Z
    [2026, /too small for a Unix timestamp/],
    [1756000000000, /too large for a Unix timestamp in seconds \(it looks like milliseconds; the API takes seconds\)/],
    ["1756000000000", /looks like milliseconds/],
    [1756000000.5, /not a whole number of seconds/],
  ]) {
    const bad = await client.callTool({ name: "list_responses", arguments: { survey_id: fx.CSAT, since: input } });
    assert.ok(bad.isError, `since ${JSON.stringify(input)} must be refused`);
    assert.match(bad.content[0].text, why, `since ${JSON.stringify(input)}`);
  }
  assert.equal(requests.length, before, "no request was made for a refused date");
});

await check("list_responses pages 1, 2, 3 of responses and stops at the documented page count; following max_results continuations yields every response exactly once", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_responses", { survey_id: fx.CSAT, completed_only: false, max_results: 100 });
  assert.deepEqual([data.count, data.total, data.pages, data.page_size, data.complete], [7, 7, 3, 100, true]);
  assert.deepEqual(since(n).map((r) => [r.query.page, r.query.page_size]), [["1", "100"], ["2", "100"], ["3", "100"]]);
  // page_size 4 asked, 3 served per page: a cut at 4 would drop 305 and 306. Whole pages instead.
  const m = requests.length;
  const { ids, calls } = await walk("list_responses", { survey_id: fx.CSAT, completed_only: false, max_results: 4 }, "responses");
  assert.deepEqual(ids, fx.responses.map((r) => r.id), "every response once, in order");
  assert.deepEqual(since(m).map((r) => [r.query.page, r.query.page_size]), [["1", "4"], ["2", "4"], ["3", "4"]]);
  assert.deepEqual(calls.map((c) => [c.data.count, c.data.next_page]), [[3, 2], [3, 3], [1, undefined]]);
  const defaults = await walk("list_responses", { survey_id: fx.CSAT, completed_only: false, max_results: 25 }, "responses");
  assert.deepEqual(defaults.ids, fx.responses.map((r) => r.id));
  assert.deepEqual(defaults.calls.map((c) => c.data.count), [7], "all three pages of 3 fit within the default max_results of 25, so one call is complete");
});

await check("responses withhold respondent identifiers and redact emails and phone numbers in answers, variables, contact data and URLs by default", async () => {
  const { data } = await call(client, "list_responses", { survey_id: fx.CSAT });
  const r = data.responses[0];
  assert.equal(r.id, 301);
  for (const k of ["contact_name", "contact_email", "unique_id", "ip_address", "user_agent", "saved_name", "saved_email", "saved_continue_url", "edit_url"]) assert.equal(r[k], undefined, `${k} must not be returned by default`);
  assert.deepEqual([r.status, r.tracking_link_id, r.contact_invitation_id, r.country, r.total_score, r.page_path], ["completed", 1, 501, "GB", 8, "9001,9002"]);
  assert.equal(r.entry_url, `https://www.smartsurvey.co.uk/s/${fx.CSAT}/?email=[email redacted]&campaign=summer`, "an email in the entry URL is redacted");
  assert.equal(r.referer_url, "https://mail.example.com/");
  assert.deepEqual(r.variables, [
    { id: 701, name: "email", label: "Respondent email", value: "[withheld: looks like contact data; available with include_contact_details]" },
    { id: 702, name: "campaign", label: "Campaign", value: "summer" },
  ]);
  assert.deepEqual(r.contact_data, [
    { name: "Phone", value: "[withheld: looks like contact data; available with include_contact_details]" },
    { name: "Department", value: "Sales" },
  ]);
  const answers = r.pages[0].questions[1].answers;
  assert.equal(answers[0].value, "Great visit. Reach me at [email redacted] or [phone redacted] if you want more detail.");
  assert.deepEqual(r.pages[0].questions[0].answers[0], { id: 1, type: "radio", choice_id: 61, choice: "Very satisfied", choice_score: 5 });
  assert.deepEqual(r.pages[1].questions[1].answers[0].row, "Welcome");
  assert.deepEqual([r.pages[1].questions[1].answers[0].column, r.pages[1].questions[1].answers[0].column_score], ["Good", 3]);
  const r2 = data.responses[1];
  assert.equal(r2.pages[0].questions[1].answers[0].value, "Landlord [phone redacted], office [phone redacted], agent [phone redacted], alt [phone redacted], fax [phone redacted]. Order PO-0001-000123 was fine.", "the +44 (0), bracketed area code, 00-prefixed, extra-spaced and dot-separated forms are all redacted; a hyphenated reference is not");
  // camelCase, hyphenated and concatenated column names are recognised as contact data too.
  const withheld = "[withheld: looks like contact data; available with include_contact_details]";
  assert.deepEqual(r2.variables, [
    { id: 703, name: "phoneNumber", label: "Phone number", value: withheld },
    { id: 702, name: "campaign", label: "Campaign", value: "autumn" },
  ]);
  assert.deepEqual(r2.contact_data, [
    { name: "E-mail", value: withheld },
    { name: "fullName", value: withheld },
    { name: "homeAddress", value: withheld },
    { name: "dateOfBirth", value: withheld },
    { name: "nhsnumber", value: withheld },
    { name: "Region", value: "South West" },
  ]);
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example.com"), "no email address anywhere in the default output");
  for (const leak of ["07700 900789", "7700 900123", "0117) 496", "20 7946 0958", "07 700 900 789", "07700.900555", "147.147.97.34", "Chrome/137", "cust-000", "edit=tok", "continue=tok", "Sam Evans", "Priya Shah", "Jo Bloggs", "jo.bloggs", "12 High Street", "1990-04-12", "943 476 5919", "07700 900222"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  assert.ok(text.includes("PO-0001-000123") && text.includes("100001") && text.includes("9001,9002"), "IDs, references and page paths are not mistaken for phone numbers");
  // A partial, saved response: its saved_* details are withheld too.
  const partial = await call(client, "list_responses", { survey_id: fx.CSAT, completed_only: false, page: 1 });
  const saved = partial.data.responses.find((x) => x.id === 303);
  assert.deepEqual([saved.status, saved.saved, saved.saved_name, saved.saved_email, saved.saved_continue_url], ["partial", true, undefined, undefined, undefined]);
});

await check("get_response returns everything as stored with include_contact_details, including entity fields, and withholds it otherwise", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 301, include_contact_details: true });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.include_labels, r.query.translation_id]), [[`/surveys/${fx.CSAT}/responses/301`, "true", undefined]]);
  const r = data.response;
  assert.deepEqual([r.contact_name, r.contact_email, r.unique_id, r.ip_address, r.user_agent], ["Sam Evans", "sam.evans@example.com", "cust-0001", "147.147.97.34", fx.responses[0].user_agent]);
  assert.equal(r.edit_url, fx.responses[0].edit_url);
  assert.equal(r.entry_url, fx.responses[0].entry_url);
  assert.deepEqual(r.variables[0], { id: 701, name: "email", label: "Respondent email", value: "sam.evans@example.com" });
  assert.deepEqual(r.contact_data[0], { name: "Phone", value: "07700 900789" });
  assert.equal(r.pages[0].questions[1].answers[0].value, fx.responses[0].pages[0].questions[1].answers[0].value);
  const withEntity = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 305, include_labels: false, translation_id: 2 });
  assert.deepEqual([requests.at(-1).query.include_labels, requests.at(-1).query.translation_id], ["false", "2"]);
  const e = withEntity.data.response;
  assert.deepEqual([e.entity_id, e.entity_name, e.entity_unique_id], [42, "Bristol branch", "BRS-01"]);
  assert.deepEqual(e.entity_fields, [
    { name: "Region", value: "South West" },
    { name: "Branch manager email", value: "[withheld: looks like contact data; available with include_contact_details]" },
    { name: "FFT Category" },
  ]);
  assert.equal(e.contact_email, undefined);
  const noEntity = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 302 });
  assert.deepEqual([noEntity.data.response.entity_id, noEntity.data.response.entity_fields], [undefined, undefined]);
  const columns = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 302, include_contact_details: true });
  assert.deepEqual(columns.data.response.contact_data, fx.responses[1].contact_data, "camelCase / hyphenated contact columns come back as stored on request");
  assert.equal(columns.data.response.variables[0].value, "07700 900222");
  const partial = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 303, include_contact_details: true });
  assert.deepEqual([partial.data.response.saved_name, partial.data.response.saved_email, partial.data.response.saved_continue_url], ["Priya Shah", "priya.shah@example.com", fx.responses[2].saved_continue_url]);
});

await check("list_exports returns metadata and the API download URL only", async () => {
  const { data } = await call(client, "list_exports", { survey_id: fx.CSAT });
  assert.equal(requests.at(-1).path, `/surveys/${fx.CSAT}/exports`);
  assert.deepEqual([data.count, data.total, data.complete], [2, 2, true]);
  assert.deepEqual(data.exports[0], { id: 8001, name: "Raw data August", type: "raw_data", status: "completed", file_size: 48213, file_extension: ".xlsx", file_content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", requested_date: fx.exportsBySurvey[fx.CSAT][0].requested_date, started_date: fx.exportsBySurvey[fx.CSAT][0].started_date, completed_date: fx.exportsBySurvey[fx.CSAT][0].completed_date, download_url: `https://api.smartsurvey.io/v2/surveys/${fx.CSAT}/exports/8001/download` });
  assert.deepEqual([data.exports[1].status, data.exports[1].download_url, data.exports[1].started_date], ["queued", undefined, undefined]);
  assert.ok(!requests.some((r) => /download/.test(r.path)), "no download endpoint was ever called");
  const empty = await call(client, "list_exports", { survey_id: fx.CLOSED });
  assert.deepEqual([empty.data.count, empty.data.total, empty.data.complete], [0, 0, true]);
});

await check("list_survey_folders (after a 429 retry that waits for Retry-After)", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_survey_folders");
  const tries = since(n).filter((r) => r.path === "/survey-folders");
  assert.equal(tries.length, 2, "survey-folders should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.folders, [{ id: 11, type: "folder", title: "Customer research" }, { id: 12, type: "folder", title: "HR ([email redacted])" }, { id: 13, type: "folder", title: "Archive 2025" }]);
  assert.deepEqual([data.total, data.complete], [3, true]);
  const asStored = await call(client, "list_survey_folders", { include_contact_details: true });
  assert.equal(asStored.data.folders[1].title, "HR (hr@example.com)");
});

await check("when the API honours page_size (folders, exports), pages are exactly max_results long and the continuation covers every record", async () => {
  const n = requests.length;
  const folders = await walk("list_survey_folders", { max_results: 2 }, "folders");
  assert.deepEqual(folders.ids, fx.folders.map((f) => f.id));
  assert.deepEqual(since(n).filter((r) => r.path === "/survey-folders").map((r) => [r.query.page, r.query.page_size]), [["1", "2"], ["2", "2"]]);
  assert.deepEqual(folders.calls.map((c) => [c.data.count, c.data.pages, c.data.next_page]), [[2, 2, 2], [1, 2, undefined]]);
  const exportsWalk = await walk("list_exports", { survey_id: fx.CSAT, max_results: 1 }, "exports");
  assert.deepEqual(exportsWalk.ids, [8001, 8002]);
  assert.deepEqual(exportsWalk.calls.map((c) => c.data.count), [1, 1]);
});

await check("open_survey and close_survey PATCH the documented endpoints with no body and return the ApiBasicResponse", async () => {
  for (const [tool, action] of [["open_survey", "open"], ["close_survey", "close"]]) {
    const { data } = await call(client, tool, { survey_id: fx.CSAT });
    assert.deepEqual([requests.at(-1).method, requests.at(-1).path, requests.at(-1).body, requests.at(-1).contentType], ["PATCH", `/surveys/${fx.CSAT}/${action}`, undefined, undefined]);
    assert.deepEqual(data.result, { status: 200, code: "success", message: action === "open" ? "Survey opened." : "Survey closed." });
  }
  const missing = await call(client, "close_survey", { survey_id: 1 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/surveys\/1\/close\. Check the ID\. Not Found The requested survey was not found\./);
});

// The request body is a bare $ref to InvitationRequestContact; validate by component name so the ref resolves.
const sendSchema = spec.paths["/surveys/{surveyId}/invitations/{invitationId}/sendone"].post.requestBody.content["application/json"].schema.$ref.replace("#/components/schemas/", "");
assert.equal(sendSchema, S("Public.API.Models.ContactList.InvitationRequestContact"));
const goodSend = { survey_id: fx.CSAT, invitation_id: fx.INVITATION, name: "Sam Evans", email: "sam.evans@example.com", custom_columns: [{ name: "Department", value: "Sales" }], entity_unique_id: "BRS-01" };

await check("send_invitation_to_one posts a JSON body that validates against the spec's InvitationRequestContact", async () => {
  const n = requests.length;
  const { data } = await call(client, "send_invitation_to_one", goodSend);
  assert.equal(data.result, "sent");
  assert.equal(data.message, "Invitation sent.");
  assert.deepEqual(data.failed_contacts, []);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`POST /surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`], "one request, no lookups");
  const post = requests.at(-1);
  assert.match(post.contentType, /^application\/json/);
  validateWith(sendSchema, post.body, "POST .../sendone body vs requestBody schema");
  assert.deepEqual(post.body, { name: "Sam Evans", email: "sam.evans@example.com", custom_columns: [{ name: "Department", value: "Sales" }], entity_unique_id: "BRS-01" });
  const sms = await call(client, "send_invitation_to_one", { survey_id: fx.CSAT, invitation_id: fx.INVITATION, name: "Priya Shah", mobile: "+447700900123", entity_id: 42 });
  assert.equal(sms.data.result, "sent");
  validateWith(sendSchema, requests.at(-1).body, "SMS body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { name: "Priya Shah", mobile: "+447700900123", entity_id: 42 });
});

await check("send_invitation_to_one refuses locally without an email or mobile, or with both entity IDs; 402 and 403 give actionable messages", async () => {
  const n = requests.length;
  const noContact = await call(client, "send_invitation_to_one", { survey_id: fx.CSAT, invitation_id: fx.INVITATION, name: "Sam Evans" });
  assert.ok(noContact.res.isError);
  assert.match(noContact.text, /Not sent\. Give an email address .* or a mobile number/);
  const both = await call(client, "send_invitation_to_one", { ...goodSend, entity_id: 42 });
  assert.ok(both.res.isError);
  assert.match(both.text, /Not sent\. Give either entity_id or entity_unique_id, not both/);
  const badEmail = await client.callTool({ name: "send_invitation_to_one", arguments: { ...goodSend, email: "not-an-email" } });
  assert.ok(badEmail.isError);
  assert.equal(since(n).length, 0, "no request for a locally refused send");
  const noBalance = await call(client, "send_invitation_to_one", { ...goodSend, invitation_id: fx.INVITATION_NO_BALANCE });
  assert.ok(noBalance.res.isError);
  assert.match(noBalance.text, /402 .*email invitation balance is insufficient.*Top up.*Insufficient email balance/);
  const forbidden = await call(client, "send_invitation_to_one", { ...goodSend, survey_id: fx.FORBIDDEN });
  assert.ok(forbidden.res.isError);
  assert.match(forbidden.text, /403 Forbidden.*not permitted to access that survey or resource, or the endpoint is not included in the account's plan.*premium endpoint/);
  const unknownInvitation = await call(client, "send_invitation_to_one", { ...goodSend, invitation_id: 9 });
  assert.match(unknownInvitation.text, /Not found: \/surveys\/100001\/invitations\/9\/sendone\. Check the ID\./);
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404; a forbidden survey gives the 403 message", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_survey", { survey_id: "abc" }],
    ["get_survey", { survey_id: 0 }],
    ["get_survey", { survey_id: -5 }],
    ["get_survey", { survey_id: 1.5 }],
    ["get_survey", { survey_id: 2147483648 }],
    ["get_response", { survey_id: fx.CSAT, response_id: "301; DROP" }],
    ["list_responses", { survey_id: fx.CSAT, filter_id: 0 }],
    ["list_exports", { survey_id: "../account-user" }],
    ["open_survey", { survey_id: "" }],
    ["send_invitation_to_one", { ...goodSend, invitation_id: "501/x" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_survey", { survey_id: 1 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/surveys\/1\. Check the ID\. Not Found The requested survey was not found\./);
  const missingResponse = await call(client, "get_response", { survey_id: fx.CSAT, response_id: 1 });
  assert.match(missingResponse.text, /Not found: \/surveys\/100001\/responses\/1\. Check the ID\./);
  const forbidden = await call(client, "get_survey", { survey_id: fx.FORBIDDEN });
  assert.ok(forbidden.res.isError);
  assert.match(forbidden.text, /refused GET \/surveys\/100403 \(403 Forbidden\)\. Either this API key's account is not permitted.*You do not have permission/);
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_survey_folders");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/survey-folders").length, 3, "exactly three attempts");
  assert.match(text, /SmartSurvey rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once; an HTTP-date and a fractional Retry-After are honoured", async () => {
  arm429({ retryAfter: "600" });
  let n = requests.length;
  const long = await call(client, "list_survey_folders");
  assert.ok(long.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/survey-folders").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/survey-folders \(HTTP 429\)/);
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  n = requests.length;
  const dated = await call(client, "list_survey_folders");
  assert.ok(!dated.res.isError);
  let tries = since(n).filter((r) => r.path === "/survey-folders");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  const fractional = await call(client, "list_survey_folders");
  assert.ok(!fractional.res.isError);
  tries = since(n).filter((r) => r.path === "/survey-folders");
  assert.equal(tries.length, 2);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried (even with a non-JSON gateway body); a GET failing three times with 503 reports advice without the HTML", async () => {
  arm({ method: "GET", path: "/survey-folders", status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, data } = await call(client, "list_survey_folders");
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 3);
  assert.equal(since(n).filter((r) => r.path === "/survey-folders").length, 2);
  arm({ method: "GET", path: "/account-user", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "whoami");
  assert.ok(down.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/account-user").length, 3);
  assert.match(down.text, /SmartSurvey returned 503 for GET \/account-user 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"), "gateway HTML should not be passed on");
  disarm();
});

await check("a 502 on POST .../sendone or PATCH .../close is never retried and the error says to check before repeating", async () => {
  arm({ method: "POST", path: `/surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`, status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, text } = await call(client, "send_invitation_to_one", goodSend);
  assert.ok(res.isError, "a 502 on a send must surface as an error, not a success");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 1, "exactly one POST");
  assert.match(text, /returned 502 for POST .*sendone\. The request was not retried because it may already have been processed: check with the invitation's contact list in SmartSurvey/);
  arm({ method: "PATCH", path: `/surveys/${fx.CSAT}/close`, status: 503 });
  n = requests.length;
  const failedClose = await call(client, "close_survey", { survey_id: fx.CSAT });
  assert.ok(failedClose.res.isError);
  assert.equal(since(n).length, 1, "a PATCH is not retried after a 5xx either");
  assert.match(failedClose.text, /returned 503 for PATCH .*not retried.*check with get_survey/);
  disarm();
});

await check("a 429 on POST .../sendone is retried once (a rate-limited request is assumed not to have been processed)", async () => {
  arm({ method: "POST", path: `/surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`, status: 429, headers: { "Retry-After": "0" }, body: { type: "about:blank", title: "Too Many Requests", status: 429, detail: null, instance: null } });
  const n = requests.length;
  const { res, data } = await call(client, "send_invitation_to_one", goodSend);
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.result, "sent");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "one retry after the 429");
  disarm();
});

await check("SmartSurvey's own error text is passed on with contact details redacted, and a 400 lists its validation errors field by field", async () => {
  arm({ method: "GET", path: `/surveys/${fx.CSAT}`, status: 400, body: { type: "about:blank", title: "Bad Request", status: 400, detail: "Survey shared by sam.evans@example.com (call 07700 900789).", instance: null } });
  const echoed = await call(client, "get_survey", { survey_id: fx.CSAT });
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /rejected GET \/surveys\/100001 \(400\)\. Bad Request Survey shared by \[email redacted\] \(call \[phone redacted\]\)\./);
  assert.ok(!echoed.text.includes("@example.com") && !echoed.text.includes("07700"), "the API's error text leaked contact details");
  arm({ method: "POST", path: `/surveys/${fx.CSAT}/invitations/${fx.INVITATION}/sendone`, status: 400, body: { type: "about:blank", title: "One or more validation errors occurred.", status: 400, detail: null, instance: null, errors: { name: ["The name field is required."], email: ["Enter a valid email address."] } } });
  const invalid = await call(client, "send_invitation_to_one", goodSend);
  assert.ok(invalid.res.isError);
  assert.match(invalid.text, /rejected POST .*sendone \(400\)\. One or more validation errors occurred\. Validation errors: name: The name field is required\. \| email: Enter a valid email address\./);
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list", async () => {
  arm({ method: "GET", path: "/surveys", status: 200 }); // the mock answers with an HTML page
  const { res, text } = await call(client, "list_surveys");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/surveys but the body was not JSON \(starts with: "<html>.*Check SMARTSURVEY_BASE_URL/);
  disarm();
  const ok = await call(client, "list_surveys", { max_results: 1 });
  assert.ok(!ok.res.isError);
});

await check("when the list body lacks the paging fields, X-SS-Pagination-Total decides where the list ends (PageSize is the size requested, so no page count is derived from it)", async () => {
  setBodyPaging(false);
  let n = requests.length;
  const { data } = await call(client, "list_surveys", { max_results: 1000 });
  assert.deepEqual([data.count, data.total, data.pages, data.complete], [25, 25, undefined, true]);
  assert.deepEqual(since(n).map((r) => r.query.page), ["1", "2", "3"], "stops once Total records are in hand, no fourth call (a count derived from PageSize=100 would have stopped after one page of 10)");
  n = requests.length;
  const { ids } = await walk("list_surveys", { max_results: 15 }, "surveys");
  assert.deepEqual(ids, fx.surveys.map((s) => s.id), "continuation still covers every record without body paging");
  assert.deepEqual(since(n).map((r) => r.query.page), ["1", "2", "3", "4"], "a walk that starts past page 1 cannot use Total, so the last call ends on an empty page");
  setBodyPaging(true);
});

await check("every request used Basic base64(token:secret) and a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "\\d+") + "$") })));
  assert.ok(requests.length > 40);
  for (const r of requests) {
    assert.equal(r.auth, AUTH);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    [
      "GET /account-user",
      "GET /survey-folders",
      "GET /surveys",
      "GET /surveys/{id}",
      "GET /surveys/{id}/detailed",
      "GET /surveys/{id}/exports",
      "GET /surveys/{id}/responses",
      "GET /surveys/{id}/responses/{id}",
      "PATCH /surveys/{id}/close",
      "PATCH /surveys/{id}/open",
      "POST /surveys/{id}/invitations/{id}/sendone",
    ],
  );
});
await client.close();

await check("writes are off when SMARTSURVEY_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => WRITES.includes(t.name)), [], `writes exposed with SMARTSURVEY_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, READS.length);
    await ro.close();
  }
});

await check("wrong credentials give an actionable 401; a bad region (with or without SMARTSURVEY_BASE_URL) and a missing secret stop the server at start-up", async () => {
  const bad = await connect({ secret: "wrong-secret" });
  const { res, text } = await call(bad, "list_surveys");
  assert.ok(res.isError);
  assert.match(text, /rejected the API credentials \(401\)\. Check SMARTSURVEY_API_TOKEN and SMARTSURVEY_API_SECRET/);
  await bad.close();
  // The region is checked even when SMARTSURVEY_BASE_URL (set by connect()) overrides it.
  for (const extra of [{ SMARTSURVEY_BASE_URL: "", SMARTSURVEY_REGION: "mars" }, { SMARTSURVEY_REGION: "mars" }, { SMARTSURVEY_API_SECRET: "" }]) {
    await assert.rejects(connect({ extra }), /closed|exit|EPIPE|Connection/i, `server should exit with ${JSON.stringify(extra)}`);
  }
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock.`);
