# SmartSurvey MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with a SmartSurvey account: surveys and their designs, responses, exports and survey folders, and (when enabled) opening or closing a survey and sending an invitation to one person. It is built from SmartSurvey's public API documentation and the OpenAPI definitions it publishes, one per reference page, on docs.smartsurvey.io.

Once it's connected, someone on the account can ask things like:

- "Which of our surveys are open, and how many responses does each have?"
- "Show me the questions in the customer satisfaction survey."
- "What did people write in the comments box since 1 September? Anything about waiting times?"
- "Pull response 301 with the respondent's details so I can follow up."
- "Is last night's raw-data export ready?"
- With writes enabled: "Close the summer party survey." / "Send the CSAT invitation to Sam Evans at sam.evans@example.com."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `whoami` | The account user the API key belongs to (name, email, type, survey count) and the base URL in use. | `GET /account-user` |
| `list_surveys` | Surveys with title, nickname, status, response count and dates, in whole API pages up to `max_results`, continued with `page`, optional `sort_by`. | `GET /surveys` |
| `get_survey` | One survey with page/question counts, theme and settings. With `detail=true`: variables, translations and every page with its questions, answer choices (with score values) and logic flags. | `GET /surveys/{id}`, or `GET /surveys/{id}/detailed` |
| `list_responses` | Responses to a survey with every page, question and answer, in whole API pages up to `max_results` (25 by default). Filters `since`, `until`, `completed_only`, `filter_id`, `tracking_link_id`, `unique_id`, `include_labels` and `translation_id` are passed to the API as documented; `since`/`until` accept ISO 8601 or a Unix timestamp in seconds. | `GET /surveys/{id}/responses` |
| `get_response` | One response in full, including Organisation Hierarchy entity fields when present. | `GET /surveys/{id}/responses/{responseId}` |
| `list_exports` | Exports (reports) of a survey: name, type, status, size, dates and the API download URL. Metadata only; files are never downloaded. | `GET /surveys/{id}/exports` |
| `list_survey_folders` | Survey folders on the account. | `GET /survey-folders` |
| `open_survey` | Opens a survey (the API opens only the default tracking link). Writes only. | `PATCH /surveys/{id}/open` |
| `close_survey` | Closes a survey and, per the API, all of its tracking links. Writes only, marked destructive. | `PATCH /surveys/{id}/close` |
| `send_invitation_to_one` | Emails or texts an existing invitation to one named recipient. The spec calls this a premium endpoint. Writes only. | `POST /surveys/{id}/invitations/{invitationId}/sendone` |

Not covered on purpose: contact lists and contacts, API keys, account users, permissions, tracking links, page and question writes, survey creation, copying and deletion, response inserts and deletes, export downloads and deletes, file library, themes, webhooks, and the multi-recipient invitation send.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API key from SmartSurvey (My Account > API Keys > Add New API Key). A key has an API token and a token secret. The API authenticates with HTTP Basic: the token is the username and the secret the password, as the Getting Started guide states ("Username" is the API Token, "Password" is the Token Secret; not the SmartSurvey login).

Use the region you sign in to: `app.smartsurvey.co.uk` or `app.smartsurvey.com` is the default (`api.smartsurvey.io`), `app-eu.smartsurvey.com` is `eu` (`api-eu.smartsurvey.io`), `app-us.smartsurvey.com` is `us` (`api-us.smartsurvey.io`).

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smartsurvey": {
      "command": "node",
      "args": ["/absolute/path/to/smartsurvey-mcp/dist/index.js"],
      "env": { "SMARTSURVEY_API_TOKEN": "your-token", "SMARTSURVEY_API_SECRET": "your-secret" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add smartsurvey -e SMARTSURVEY_API_TOKEN=your-token -e SMARTSURVEY_API_SECRET=your-secret -- node /absolute/path/to/smartsurvey-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `SMARTSURVEY_API_TOKEN` | yes | The API token, sent as the HTTP Basic username. |
| `SMARTSURVEY_API_SECRET` | yes | The token secret, sent as the HTTP Basic password. |
| `SMARTSURVEY_REGION` | no | `default` (UK, `api.smartsurvey.io`), `uk` (the same), `eu` or `us`. Anything else stops the server at start-up, whether or not `SMARTSURVEY_BASE_URL` is set. |
| `SMARTSURVEY_ALLOW_WRITES` | no | `true` to register `open_survey`, `close_survey` and `send_invitation_to_one`. Off by default. |
| `SMARTSURVEY_BASE_URL` | no | Overrides the region's host, e.g. `https://api-eu.smartsurvey.io/v2`. Used by the tests. |

## Safety defaults

- Read-only unless `SMARTSURVEY_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation; `close_survey` is marked destructive because the API closes every tracking link and `open_survey` afterwards reopens only the default one.
- Survey responses are third-party data. By default a response's `contact_name`, `contact_email`, `unique_id`, `ip_address`, `user_agent`, `saved_name`, `saved_email`, and the two links that open the respondent's answers for editing (`edit_url`, `saved_continue_url`) are not returned; the value of any survey variable, contact-list column or entity field whose name looks like contact data (email, phone, mobile, name, address, postcode, date of birth, IP, NHS or passport number and the like, whether written as `Email Address`, `E-mail`, `home_address`, `customerName`, `dateOfBirth` or `nhsnumber`) is replaced by a placeholder; and in every other free-text field (answers, choice/row/column labels, question and page titles, variable values, `entry_url`, `referer_url`, `entity_name`) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]`. `include_contact_details=true` on `list_responses` or `get_response` returns all of it as stored. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings that happen to start with `0` (an order number, say) are redacted too, and so is a hyphenated reference that starts with `0` and holds 9 to 11 digits (`0-123-45678-9`); numeric IDs, timestamps, page paths such as `9001,9002` and references that start with another digit or letter, such as `PO-0001-000123`, are left alone. The same redaction is applied to SmartSurvey's own error messages before they are passed on.
- Survey titles and nicknames, folder titles and the survey design (`get_survey`: page titles and descriptions, question and choice text, variable labels) are the account holder's own content, but they get the same email and phone redaction by default, so that a question such as "Email us at …" reads the same in `get_survey` and in `list_responses`. `include_contact_details=true` on `list_surveys`, `get_survey` or `list_survey_folders` returns them as stored. Variable *names* (URL parameter names such as `email`) and survey URLs are never altered. `whoami` returns the key owner's own email.
- List tools return whole API pages, never part of one. The page size sent is `min(100, max_results)`, and a call stops before a page that could take it past `max_results`, so `count` can be below `max_results` (the API may also return fewer rows per page than asked; the docs say visibility rules can filter items out). The result carries `page_size`, `next_page` and a `note` saying to call again with that page **and the same `max_results`**: page numbers only line up for one page size, so changing `max_results` on a continuation would renumber the pages. Cutting a page in the middle and pointing at the page after it would silently skip the rest of that page; this server does not do that.
- Export download links are the API's own `/download` endpoints, which need the same credentials; the server returns them as metadata and never fetches a file.
- IDs are checked before any call is made: every ID in the spec is a positive int32, so anything else (`abc`, `0`, `-5`, `1.5`, `2147483648`, `../account-user`) is refused locally. `since`/`until` take a Unix timestamp in seconds between 2000-01-01 and 2100-01-01, or an ISO 8601 date or date-time (`2026-09-01`, `2026-09-01T00:00:00`, `2026-09-01T00:00:00+01:00`; a missing zone means UTC, never the machine's local time). Anything else is refused locally with a message saying what is accepted, rather than guessed: `2026` is not sent as the Unix timestamp 2026 (33 minutes past the epoch), a millisecond timestamp such as `1756000000000` is not sent as seconds, and `12/08/2026` is not read as either 8 December or 12 August.
- `send_invitation_to_one` refuses locally when neither an email nor a mobile number is given, or when both `entity_id` and `entity_unique_id` are given (the spec says to supply one or the other).
- SmartSurvey does not document a rate limit anywhere in its Getting Started guide or reference pages (the only "429" in the spec is a generic HTTP status enum). Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method, including `POST …/sendone`, on the assumption that a rate-limited request was not processed (see Status). The retry waits for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds so a tool call stays under the MCP client's default 60-second request timeout: if SmartSurvey asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML. A `POST …/sendone` or a `PATCH …/open|close` is never retried after a gateway error, because the request may already have been processed and a retry could email someone twice; the error says what to check before repeating it.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `SMARTSURVEY_BASE_URL` / `SMARTSURVEY_REGION`, never as an empty list or an empty survey.
- Rejected credentials (401) produce a message that says which variables to fix and how the two halves of the key are used; a 403 explains the two documented causes (no permission for that survey, or an endpoint not included in the plan); a 402 on an invitation send says the email balance is insufficient; a 400 passes on SmartSurvey's validation errors field by field.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the component schemas in SmartSurvey's published OpenAPI definitions (`AccountUserResponse`, `SurveyResponse`, `SurveySingleResponse`, `SurveyDetailedResponse`, `Response`, `DetailedResponse`, `SurveyExportResponse`, `SurveyFolderResponse`). SmartSurvey publishes one OpenAPI document per reference page; `test/assemble-spec.mjs` fetches the page index (`docs.smartsurvey.io/llms.txt`) and every reference page's Markdown version, merges the 89 operations and 115 schemas into `spec.json` on the first run, and refuses to continue if two pages define the same operation or schema differently.
2. Starts a local mock of the API under `/v2` that serves those fixtures with the documented `page`/`page_size` pagination (the `PaginatedList*` body fields and the four `X-SS-Pagination-*` headers, `X-SS-Pagination-PageSize` being the number of rows requested as Getting Started defines it; surveys are capped at 10 per page and responses at 3 whatever is asked, so that lists span several pages and pages are shorter than requested, while folders and exports honour the requested size), Basic-auth 401s, and 402, 403, 404 and 400 answers in the documented `ProblemDetails` / `ValidationProblemDetails` shapes, and answers the first `GET /survey-folders` with a 429. The mock's list, detail, action and error responses are validated against the response schemas the spec names for each operation and status, and the documented keys of each list response are asserted explicitly (the `PaginatedList*` schemas mark nothing as required).
3. Starts the built server and drives it over stdio with the official MCP client: 27 checks (29 in the whole suite) covering every tool, tool annotations, page-based pagination stopping at the documented page count (from the body and, when the body lacks the paging fields, at `X-SS-Pagination-Total`) and continuing across pages shorter than requested, `max_results` sent as the page size and honoured with whole pages only (following the tool's own continuation notes from a first page, and from a later start page, yields every fixture record exactly once, both when the mock caps the page size below `max_results` and when it honours it), `sort_by` sent as a repeated query parameter, `translation_id` passed through on the detailed survey endpoint and on `get_response`, every documented `list_responses` filter passed through exactly (`since`/`until` converted from ISO 8601 with and without a zone to Unix timestamps or passed as given, and refused for a bare year, a millisecond timestamp, a fractional number, `12/08/2026`, `2026-08` and an impossible date, `completed` 1 or 0, `filter_id`, `tracking_link_id`, `unique_id`, `include_labels`, `translation_id`), redaction of respondent identifiers, edit links, contact-like variables and columns (including `E-mail`, `fullName`, `homeAddress`, `dateOfBirth`, `phoneNumber` and `nhsnumber`), of emails and phone numbers in answers and URLs, in survey titles, folder titles and the survey design by default (the `+44 (0)…`, bracketed, `00`-prefixed, extra-spaced and dot-separated phone forms), and their return on request, entity fields on a detailed response, exports without any download call, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 429 on `POST …/sendone` retried once, a 502 retried for `GET` and never for `POST …/sendone` or `PATCH …/close`, a `GET` failing three times with 503 reported with advice and without the gateway HTML, a 200 with a non-JSON body reported as an error, the write gate with the variable unset and set to `false`, the `POST …/sendone` body validated against the spec's `InvitationRequestContact` schema for an email and an SMS recipient, the local refusals, the 402/403/404 messages, SmartSurvey's own error text passed on with contact details redacted and a 400's validation errors listed field by field, ID validation before any call, the 401 message, a bad `SMARTSURVEY_REGION` (with or without `SMARTSURVEY_BASE_URL`) or a missing secret stopping the server at start-up, and that every request used `Basic base64(token:secret)` and a documented method and path.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a SmartSurvey account. The API itself is a paid-plan feature: SmartSurvey's public pricing page (checked September 2026) lists "API & Webhooks" on the Growth plan, Scale includes everything in Growth, and the Basic and Advanced plans do not list it. Everything below is taken from the published documentation and should be confirmed on a real account:

- Authentication: that the API token is the Basic username and the token secret the password (Getting Started says so), and the body of a 401 (not documented; the mock answers with `ProblemDetails`).
- Pagination: that `page_index` in list bodies is 1-based like the `page` parameter (the server keeps its own page counter and stops when it reaches `pages`, when it has collected `total` records from page 1, or on an empty page; `X-SS-Pagination-Total` stands in for `total` when the body lacks it, and no page count is derived from `X-SS-Pagination-PageSize`, which Getting Started defines as the number of rows requested, not returned); that `pages`, `total` and `page_size` are present on every list; that the API honours `page_size` up to 100 (the mock deliberately serves fewer for surveys and responses; the budget check uses the body's `page_size` when present, else the size requested); and what a `page` past the end returns (the mock answers 200 with an empty list). A page shorter than `page_size` is not treated as the end, because the docs say visibility rules may filter items out.
- `sort_by`: the accepted property names are not documented, and neither is the serialisation of the array; the server sends the key once per value (`sort_by=title&sort_by=date_created`), the OpenAPI default for query arrays.
- `completed`: the parameter is documented as "Whether to only include completed responses", integer, default 1. The server sends `completed=0` for `completed_only=false` and expects partial and disqualified responses back; the exact effect of 0 is not documented.
- `since`/`until`: documented as Unix timestamps filtering "after"/"before" a date/time; which response timestamp they compare against (`date_started`, `date_ended` or `date_modified`) and whether the bounds are inclusive is not documented. The mock compares `since` with `date_started` and `until` with `date_ended`, inclusive.
- `include_labels`: Getting Started says labels are not included by default and `include_labels=true` adds them; the list endpoint's own parameter description says the opposite about size. The server passes the value through explicitly on both endpoints (defaulting to `true` so answers carry question and choice text) and does not know which fields disappear without labels.
- `translation_id`: defaults to 0 on the survey endpoints and 1 on the response endpoints in the spec; the server only sends it when given.
- The values of `Response.status` (`completed`, `partial`, `disqualified` per the Data Types page), `SurveyResponse.status` ("e.g. open or closed") and `SurveyExportResponse.status` (queued, completed or errored), and the integer enums `presentation_mode`, `completion_action.action`, `terminal.response_status` and `randomisation`, whose names are not documented and are passed through as numbers.
- Which respondent fields the live API actually fills (`unique_id`, `contact_name`/`contact_email` for invitation responses, `ip_address`, `user_agent`, `edit_url`, `saved_*`, `entity_*`) and whether `edit_url` and `saved_continue_url` really grant access to the answers, as their names suggest; they are withheld by default either way.
- `PATCH …/open` and `PATCH …/close`: sent with no body and no `Content-Type`, as the spec defines no request body; the `ApiBasicResponse` content and whether a 200 is returned when nothing changed.
- `POST …/sendone`: whether the invitation's type (email or SMS) decides which of `email`/`mobile` is required, whether partial failures come back as a 200 with `failed_contacts` (as the schema suggests) or as a 4xx, and the exact 402 and 403 behaviour (the spec documents 402 for an insufficient email balance and describes the endpoint as premium and "not available on all plans").
- A 429 on `POST …/sendone` is retried on the assumption that a rate-limited request was not processed. SmartSurvey documents no 429 and no rate limit at all, so the 250 ms spacing here is a guess on the polite side.
- The wording of SmartSurvey's error messages and whether any of them echo request data such as a recipient's email address; the texts here are placeholders, and the server redacts contact details from them regardless.
- Whether `GET /surveys` includes surveys owned by sub-users of a master account, and whether `GET /account-user` reports the master account or the sub-user the key was created under.
- Timestamps: the docs say all date-times are UTC ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`); the server passes them through unchanged.

## Going to production

This version runs locally over stdio, with the account holder's own API key. For customers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by SmartSurvey, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
