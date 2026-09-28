// Fake SmartSurvey data shaped exactly like the published OpenAPI schemas (validated in e2e.mjs).
// Timestamps use the UTC ISO 8601 form the docs describe (YYYY-MM-DDTHH:MM:SSZ).
const stamp = (d, h = 9, m = 0, s = 0) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const API = "https://api.smartsurvey.io/v2";

// ---- Account user (AccountUserResponse) ----
export const accountUser = {
  id: 90210,
  type: "master",
  firstname: "Alex",
  lastname: "Example",
  fullname: "Alex Example",
  email: "alex@example.com",
  date_created: stamp(1, 8, 0),
  surveys: 25,
  href: `${API}/account-users/90210`,
};

// ---- Surveys (SurveyResponse for lists, SurveySingleResponse / SurveyDetailedResponse for gets) ----
export const CSAT = 100001;
export const CLOSED = 100002;
export const STAFF = 100003;
export const FORBIDDEN = 100403; // a survey the key's account may not access: the mock answers 403
const mkSurvey = (id, title, status, responses, created, modified, nickname = null) => ({
  id,
  type: "survey",
  title,
  nickname,
  date_created: created,
  date_modified: modified,
  responses,
  status,
  survey_url: `https://www.smartsurvey.co.uk/s/${id}/`,
  href: `${API}/surveys/${id}`,
  href_responses: `${API}/surveys/${id}/responses`,
  href_links: `${API}/surveys/${id}/links`,
});
const named = [
  mkSurvey(CSAT, "Customer satisfaction 2026", "open", 7, stamp(1, 10, 0), stamp(20, 16, 30), "CSAT Q3"),
  mkSurvey(CLOSED, "Event feedback: Summer party", "closed", 0, stamp(2, 11, 0), stamp(3, 9, 0)),
  mkSurvey(STAFF, "Staff pulse (queries to hr@example.com or 0117 496 0000)", "open", 0, stamp(4, 12, 0), stamp(4, 12, 0)),
];
// 22 more so the list spans three pages of ten (total 25, pages 3).
const bulk = Array.from({ length: 22 }, (_, i) => mkSurvey(100010 + i, `Bulk survey ${i + 1}`, i % 3 === 0 ? "closed" : "open", i, stamp(5 + (i % 9), 8, i), stamp(5 + (i % 9), 9, i)));
export const surveys = [...named, ...bulk];

const single = (s, page_count, question_count) => ({ ...s, page_count, question_count, theme_id: 4242, properties: { scoring: true, presentation_mode: 0 } });
export const surveySingles = Object.fromEntries(surveys.map((s) => [s.id, single(s, s.id === CSAT ? 2 : 1, s.id === CSAT ? 4 : 1)]));

// Question IDs used by the design and by the responses below.
export const Q_RATING = 5001; // single_choice / radio, scored
export const Q_COMMENT = 5002; // open_ended / essay
export const Q_NPS = 5003; // nps
export const Q_MATRIX = 5004; // matrix / single
const choice = (id, title, position, score_value, extra = {}) => ({ id, title, type: "radio", position, properties: { required: false, hide_option: false, score_value, none_of_the_above: false, lines: null, width: null, required_message: null, validation_message: null }, ...extra });
export const surveyDetailed = {
  [CSAT]: {
    ...surveySingles[CSAT],
    date_responses_modified: stamp(20, 16, 30),
    variables: [
      { id: 701, name: "email", label: "Respondent email", date_created: stamp(1, 10, 5) },
      { id: 702, name: "campaign", label: "Campaign", date_created: stamp(1, 10, 6) },
      { id: 703, name: "phoneNumber", label: "Phone number", date_created: stamp(1, 10, 7) },
    ],
    translations: [
      { id: 1, name: "English", language_id: 1, default: true, date_created: stamp(1, 10, 0) },
      { id: 2, name: "Cymraeg", language_id: 10, date_created: stamp(6, 10, 0) },
    ],
    pages: [
      {
        id: 9001,
        title: "About your visit",
        description: "A few questions about your last visit.",
        position: 1,
        date_created: stamp(1, 10, 1),
        questions: [
          {
            id: Q_RATING,
            type: "single_choice",
            sub_type: "radio",
            title: "How satisfied were you with your visit?",
            raw_title: "How satisfied were you with your visit?",
            position: 1,
            number: 1,
            date_created: stamp(1, 10, 2),
            date_modified_utc: stamp(1, 10, 2),
            properties: { required: true, hide_question: false, skip_numbering: false, css_class: null, required_message: "Please pick one", validation_message: null, default_answer: null },
            choices: [choice(61, "Very satisfied", 1, 5), choice(62, "Satisfied", 2, 4), choice(63, "Neutral", 3, 3), choice(64, "Dissatisfied", 4, 2), choice(65, "Very dissatisfied", 5, 1)],
            config: {},
            has_display_logic: false,
            skip_logic_count: 0,
          },
          {
            id: Q_COMMENT,
            type: "open_ended",
            sub_type: "essay",
            title: "Anything else you'd like to tell us?",
            position: 2,
            number: 2,
            properties: { required: false, hide_question: false, skip_numbering: false, css_class: null, required_message: null, validation_message: null, default_answer: null },
            choices: [{ id: 66, title: "Comments", type: "text", position: 1, properties: { required: false, hide_option: false, score_value: null, none_of_the_above: null, lines: 5, width: "100%", required_message: null, validation_message: null } }],
            has_display_logic: false,
            skip_logic_count: 1,
          },
        ],
        has_display_logic: true,
        page_logic: { completion_action: { action: 0, destination_page_id: null }, terminal: { thank_you: false, response_status: 0 }, question_randomisation: { randomisation: 0, number_questions_to_display: null, questions: null }, is_empty: false },
      },
      {
        id: 9002,
        title: "Recommendation",
        description: null,
        position: 2,
        date_created: stamp(1, 10, 3),
        questions: [
          { id: Q_NPS, type: "nps", sub_type: null, title: "How likely are you to recommend us to a friend?", position: 1, number: 3, properties: { required: true, hide_question: false, skip_numbering: false, css_class: null, required_message: null, validation_message: null, default_answer: null }, choices: Array.from({ length: 11 }, (_, i) => ({ id: 70 + i, title: String(i), type: "nps", position: i + 1 })), has_display_logic: false, skip_logic_count: 0 },
          {
            id: Q_MATRIX,
            type: "matrix",
            sub_type: "single",
            title: "Rate each part of the visit",
            position: 2,
            number: 4,
            properties: { required: false, hide_question: false, skip_numbering: false, css_class: null, required_message: null, validation_message: null, default_answer: null },
            choices: [
              { id: 81, title: "Welcome", type: "matrix_row", position: 1 },
              { id: 82, title: "Waiting time", type: "matrix_row", position: 2 },
              { id: 91, title: "Poor", type: "matrix_col", position: 1, properties: { required: false, hide_option: false, score_value: 1 } },
              { id: 92, title: "Good", type: "matrix_col", position: 2, properties: { required: false, hide_option: false, score_value: 3 } },
            ],
            has_display_logic: false,
            skip_logic_count: 0,
          },
        ],
        page_logic: { completion_action: { action: 1, destination_page_id: null }, terminal: { thank_you: true, response_status: 1 }, is_empty: false },
      },
    ],
  },
};
for (const s of surveys) surveyDetailed[s.id] ??= { ...surveySingles[s.id], date_responses_modified: null, variables: [], translations: [{ id: 1, name: "English", language_id: 1, default: true, date_created: s.date_created }], pages: [{ id: 9100 + (s.id % 1000), title: "Page 1", description: null, position: 1, date_created: s.date_created, questions: [{ id: 6000 + (s.id % 1000), type: "open_ended", sub_type: "single", title: "Your thoughts", position: 1, number: 1 }] }] };
// The staff survey's design carries contact details in its own text (page description, question and
// choice titles, variable label): the account holder's content, redacted by default like everything else.
surveyDetailed[STAFF].variables = [{ id: 704, name: "dept", label: "Department (ask hr@example.com)", date_created: stamp(4, 12, 1) }];
surveyDetailed[STAFF].pages[0].description = "Questions? Call HR on 0117 496 0000 or email hr@example.com.";
surveyDetailed[STAFF].pages[0].questions[0].title = "Your thoughts (or write to hr@example.com)";
surveyDetailed[STAFF].pages[0].questions[0].choices = [{ id: 6103, title: "Other: text 07700 900999", type: "text", position: 1 }];

// ---- Responses (Response for lists, DetailedResponse for gets) ----
// Free-text answers carry emails and phone numbers in the written forms the redaction must recognise
// (see PHONE in src/format.ts). Variables and contact-list columns mix contact data with plain segmentation.
const answerChoice = (choiceTitle, choiceId, score) => ({ id: 1, type: "radio", choice_title: choiceTitle, choice_id: choiceId, choice_score_value: score });
const answerText = (value) => ({ id: 2, type: "text", choice_title: "Comments", choice_id: 66, value });
const answerNps = (n) => ({ id: 3, type: "nps", choice_title: String(n), choice_id: 70 + n, value: String(n) });
const answerMatrix = (rowTitle, rowId, colTitle, colId, score) => ({ id: 4, type: "matrix_col", row_title: rowTitle, row_id: rowId, column_title: colTitle, column_id: colId, column_score_value: score });
const pagesFor = (rating, comment, nps, matrixCol) => [
  {
    id: 9001,
    title: "About your visit",
    position: 1,
    total_score: rating[2],
    questions: [
      { id: Q_RATING, title: "How satisfied were you with your visit?", type: "single_choice", sub_type: "radio", number: 1, position: 1, total_score: rating[2], answers: [answerChoice(...rating)] },
      { id: Q_COMMENT, title: "Anything else you'd like to tell us?", type: "open_ended", sub_type: "essay", number: 2, position: 2, total_score: null, answers: comment === null ? [] : [answerText(comment)] },
    ],
  },
  ...(nps === null
    ? []
    : [
        {
          id: 9002,
          title: "Recommendation",
          position: 2,
          total_score: matrixCol ? matrixCol[2] : null,
          questions: [
            { id: Q_NPS, title: "How likely are you to recommend us to a friend?", type: "nps", sub_type: null, number: 3, position: 1, total_score: null, answers: [answerNps(nps)] },
            { id: Q_MATRIX, title: "Rate each part of the visit", type: "matrix", sub_type: "single", number: 4, position: 2, total_score: matrixCol ? matrixCol[2] : null, answers: matrixCol ? [answerMatrix("Welcome", 81, ...matrixCol)] : [] },
          ],
        },
      ]),
];
const mkResponse = (id, { status, started, ended, tracking = 1, unique_id = null, contact = null, invitation = 0, ip, ua, country = "GB", entry, referer = null, saved = false, savedName = null, savedEmail = null, variables = [], contactData = [], pages, score = null, page_path = "9001,9002", current_page = 9002, manual = false, entity_id = null }) => ({
  id,
  survey_id: CSAT,
  tracking_link_id: tracking,
  translation_id: 1,
  unique_id,
  date_started: started,
  date_ended: ended,
  date_modified: ended,
  status,
  contact_name: contact ? contact[0] : null,
  contact_email: contact ? contact[1] : null,
  contact_invitation_id: invitation,
  ip_address: ip,
  user_agent: ua,
  country,
  entry_url: entry,
  referer_url: referer,
  edit_url: `https://www.smartsurvey.co.uk/s/${CSAT}/?r=${id}&edit=tok${id}`,
  saved,
  saved_name: savedName,
  saved_email: savedEmail,
  saved_continue_url: saved ? `https://www.smartsurvey.co.uk/s/${CSAT}/?continue=tok${id}` : null,
  current_page_id: current_page,
  page_path,
  manual_entry: manual,
  total_score: score,
  href: `${API}/surveys/${CSAT}/responses/${id}`,
  variables,
  contact_data: contactData,
  pages,
  entity_id,
});
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0";
export const responses = [
  mkResponse(301, {
    status: "completed",
    started: stamp(10, 9, 0),
    ended: stamp(10, 9, 6),
    unique_id: "cust-0001",
    contact: ["Sam Evans", "sam.evans@example.com"],
    invitation: 501,
    ip: "147.147.97.34",
    ua: UA,
    entry: `https://www.smartsurvey.co.uk/s/${CSAT}/?email=sam.evans@example.com&campaign=summer`,
    referer: "https://mail.example.com/",
    variables: [
      { id: 701, name: "email", value: "sam.evans@example.com", label: "Respondent email" },
      { id: 702, name: "campaign", value: "summer", label: "Campaign" },
    ],
    contactData: [
      { name: "Phone", value: "07700 900789" },
      { name: "Department", value: "Sales" },
    ],
    pages: pagesFor(["Very satisfied", 61, 5], "Great visit. Reach me at sam.evans@example.com or 07700 900789 if you want more detail.", 9, ["Good", 92, 3]),
    score: 8,
  }),
  mkResponse(302, {
    status: "completed",
    started: stamp(11, 14, 0),
    ended: stamp(11, 14, 4),
    tracking: 2,
    ip: "10.1.2.3",
    ua: UA,
    entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`,
    // Variable and column names in camelCase / hyphenated / concatenated forms, as an integration might pass them.
    variables: [
      { id: 703, name: "phoneNumber", value: "07700 900222", label: "Phone number" },
      { id: 702, name: "campaign", value: "autumn", label: "Campaign" },
    ],
    contactData: [
      { name: "E-mail", value: "jo.bloggs@example.com" },
      { name: "fullName", value: "Jo Bloggs" },
      { name: "homeAddress", value: "12 High Street, Bristol" },
      { name: "dateOfBirth", value: "1990-04-12" },
      { name: "nhsnumber", value: "943 476 5919" },
      { name: "Region", value: "South West" },
    ],
    pages: pagesFor(["Dissatisfied", 64, 2], "Landlord +44 (0)7700 900123, office (0117) 496 0000, agent 0044 20 7946 0958, alt 07 700 900 789, fax 07700.900555. Order PO-0001-000123 was fine.", 3, ["Poor", 91, 1]),
    score: 3,
  }),
  mkResponse(303, {
    status: "partial",
    started: stamp(12, 8, 30),
    ended: stamp(12, 8, 31),
    ip: "10.1.2.4",
    ua: UA,
    entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`,
    saved: true,
    savedName: "Priya Shah",
    savedEmail: "priya.shah@example.com",
    pages: pagesFor(["Neutral", 63, 3], null, null),
    page_path: "9001",
    current_page: 9001,
    score: 3,
  }),
  mkResponse(304, {
    status: "disqualified",
    started: stamp(13, 17, 0),
    ended: stamp(13, 17, 1),
    ip: "10.1.2.5",
    ua: UA,
    entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`,
    pages: pagesFor(["Very dissatisfied", 65, 1], "no", null),
    page_path: "9001",
    current_page: 9001,
    score: 1,
  }),
  mkResponse(305, { status: "completed", started: stamp(15, 10, 0), ended: stamp(15, 10, 5), tracking: 2, ip: "10.1.2.6", ua: UA, entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`, pages: pagesFor(["Satisfied", 62, 4], "All good", 8, ["Good", 92, 3]), score: 7, entity_id: 42 }),
  mkResponse(306, { status: "completed", started: stamp(18, 10, 0), ended: stamp(18, 10, 5), ip: "10.1.2.7", ua: UA, entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`, pages: pagesFor(["Satisfied", 62, 4], null, 7, ["Good", 92, 3]), score: 7, manual: true }),
  mkResponse(307, { status: "completed", started: stamp(20, 16, 20), ended: stamp(20, 16, 30), unique_id: "cust-0002", ip: "10.1.2.8", ua: UA, entry: `https://www.smartsurvey.co.uk/s/${CSAT}/`, pages: pagesFor(["Very satisfied", 61, 5], "Thanks!", 10, ["Good", 92, 3]), score: 8 }),
];
export const SINCE_ISO = stamp(12, 0, 0); // responses 303..307 started on or after this
export const UNTIL_ISO = stamp(16, 0, 0); // responses 301..305 ended before this
export const SINCE_UNIX = unix(SINCE_ISO);
export const UNTIL_UNIX = unix(UNTIL_ISO);

// DetailedResponse adds the Organisation Hierarchy fields for a response recorded against an entity.
export const detailedResponses = Object.fromEntries(
  responses.map((r) => [
    r.id,
    r.entity_id === null
      ? { ...r }
      : { ...r, entity_name: "Bristol branch", entity_unique_id: "BRS-01", entity: { fields: [{ name: "Region", value: "South West" }, { name: "Branch manager email", value: "manager@example.com" }, { name: "FFT Category", value: "" }] } },
  ]),
);

// ---- Exports (SurveyExportResponse) ----
export const exportsBySurvey = {
  [CSAT]: [
    { id: 8001, name: "Raw data August", type: "raw_data", status: "completed", file_size: 48213, file_extension: ".xlsx", file_content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", requested_date: stamp(21, 8, 0), started_date: stamp(21, 8, 0, 5), completed_date: stamp(21, 8, 1), href: `${API}/surveys/${CSAT}/exports/8001`, href_download: `${API}/surveys/${CSAT}/exports/8001/download` },
    { id: 8002, name: "Summary report", type: "summary", status: "queued", file_size: 0, file_extension: ".pdf", file_content_type: "application/pdf", requested_date: stamp(22, 8, 0), started_date: null, completed_date: null, href: `${API}/surveys/${CSAT}/exports/8002`, href_download: null },
  ],
};

// ---- Survey folders (SurveyFolderResponse) ----
export const folders = [
  { id: 11, type: "folder", title: "Customer research", href: `${API}/survey-folders/11` },
  { id: 12, type: "folder", title: "HR (hr@example.com)", href: `${API}/survey-folders/12` },
  { id: 13, type: "folder", title: "Archive 2025", href: `${API}/survey-folders/13` },
];

// ---- Invitations that exist on the CSAT survey (only their IDs matter for POST .../sendone) ----
export const INVITATION = 501;
export const INVITATION_NO_BALANCE = 502; // the mock answers 402 for this one
