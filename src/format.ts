// Turn SmartSurvey API records into compact objects an assistant can read quickly.
// Field names follow the schemas in SmartSurvey's OpenAPI definition (AccountUserResponse,
// SurveyResponse, SurveySingleResponse, SurveyDetailedResponse, Response, DetailedResponse,
// SurveyExportResponse, SurveyFolderResponse, ApiBasicResponse, SendInvitationResponse).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so numeric IDs, timestamps and
// hyphenated references such as PO-0001-000123 are left alone. Any other 9-11 digit string starting
// with 0 (an order number, say) is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (answers, variable
 * values, URLs, titles) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// Variable and custom-column names that mark the value as contact data (a respondent's email, phone,
// name, address, date of birth, IP address, or an official identifier). Such values are withheld
// entirely by default; other values get the email/phone redaction. The name is normalised first
// (camelCase split at each capital, spaces and hyphens turned into "_", lower-cased) so that
// "customerName", "E-Mail", "Date of birth" and "home_address" all read the same. Tokens that only
// ever mean contact data (email, phone, mobile, postcode, birth, passport, nhs, address) match
// anywhere in the name, so "ipaddress" and "nhsnumber" are caught; the rest match as whole words so
// that "zip" is caught but "description" (contains "ip") is not.
const CONTACT_ANYWHERE = /e_?mail|phone|mobile|post_?code|birth|passport|nhs|address/;
const CONTACT_WORD = /(?:^|_)(?:tel|fax|cell|names?|surname|forename|firstname|lastname|first_name|last_name|full_name|zip|dob|ip|ni_number|national_insurance|contact)(?:_|$)/;
const normaliseName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
export const looksLikeContactField = (name: unknown) => {
  if (typeof name !== "string") return false;
  const n = normaliseName(name);
  return CONTACT_ANYWHERE.test(n) || CONTACT_WORD.test(n);
};

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

// AccountUserResponse: the owner of the API key. This is the account holder's own record, not a
// third party's, so the email is returned as stored.
export function accountUser(u: Rec) {
  return {
    id: num(u.id),
    type: str(u.type),
    name: str(u.fullname) ?? str([u.firstname, u.lastname].filter((x) => typeof x === "string" && x).join(" ")),
    email: str(u.email),
    surveys: num(u.surveys),
    date_created: str(u.date_created),
  };
}

// SurveyResponse (list) / SurveySingleResponse (get) / SurveyDetailedResponse (get with detail).
// Titles, nicknames and the design text below are the account holder's own content, but they are
// free text all the same, so emails and phone numbers in them are redacted unless asked for, as in
// every other tool. survey_url is the survey's own link (an integer id in a fixed path) and stays.
export function survey(s: Rec, includeContact = false) {
  return {
    id: num(s.id),
    title: redactContacts(s.title, includeContact),
    nickname: redactContacts(s.nickname, includeContact),
    type: str(s.type),
    status: str(s.status),
    responses: num(s.responses),
    date_created: str(s.date_created),
    date_modified: str(s.date_modified),
    survey_url: str(s.survey_url),
  };
}

export function surveySingle(s: Rec, includeContact = false) {
  return {
    ...survey(s, includeContact),
    page_count: num(s.page_count),
    question_count: num(s.question_count),
    theme_id: num(s.theme_id),
    properties: s.properties && typeof s.properties === "object" ? { scoring: bool(s.properties.scoring), presentation_mode: num(s.properties.presentation_mode) } : undefined,
  };
}

// QuestionChoice: a designed answer option (not a respondent's answer).
function choice(c: Rec, includeContact: boolean) {
  const p = c.properties ?? {};
  return {
    id: num(c.id),
    title: redactContacts(c.title, includeContact),
    type: str(c.type),
    position: num(c.position),
    score_value: num(p.score_value),
    none_of_the_above: bool(p.none_of_the_above),
    hidden: p.hide_option === true ? true : undefined,
    image_url: str(c.image?.url),
  };
}

// QuestionModel: a question in the survey design.
function questionDesign(q: Rec, includeContact: boolean) {
  const p = q.properties ?? {};
  return {
    id: num(q.id),
    number: num(q.number),
    position: num(q.position),
    type: str(q.type),
    sub_type: str(q.sub_type),
    title: redactContacts(q.title, includeContact),
    required: bool(p.required),
    hidden: p.hide_question === true ? true : undefined,
    has_display_logic: bool(q.has_display_logic),
    skip_logic_count: num(q.skip_logic_count),
    choices: Array.isArray(q.choices) ? q.choices.map((c: Rec) => choice(c, includeContact)) : undefined,
  };
}

// Spec enums are bare integers (PageCompletionActionTypes 0-3, TerminalResponseStatusTypes 0-3,
// RandomiseTypes 0-3, SurveyPresentationMode 0-2) with no names documented, so they are passed through.
function pageLogic(l: Rec | undefined) {
  if (!l || typeof l !== "object" || l.is_empty === true) return undefined;
  return {
    completion_action: l.completion_action ? { action: num(l.completion_action.action), destination_page_id: num(l.completion_action.destination_page_id) } : undefined,
    terminal: l.terminal ? { thank_you: bool(l.terminal.thank_you), response_status: num(l.terminal.response_status) } : undefined,
    question_randomisation: l.question_randomisation
      ? { randomisation: num(l.question_randomisation.randomisation), number_questions_to_display: num(l.question_randomisation.number_questions_to_display), questions: Array.isArray(l.question_randomisation.questions) ? l.question_randomisation.questions : undefined }
      : undefined,
  };
}

// PageDetailedResponse
function pageDesign(p: Rec, includeContact: boolean) {
  return {
    id: num(p.id),
    position: num(p.position),
    title: redactContacts(p.title, includeContact),
    description: redactContacts(p.description, includeContact),
    has_display_logic: bool(p.has_display_logic),
    logic: pageLogic(p.page_logic),
    questions: Array.isArray(p.questions) ? p.questions.map((q: Rec) => questionDesign(q, includeContact)) : [],
  };
}

// Variable names are URL parameter names ("email", "campaign"), kept as stored so they can be matched
// against a response's variables; the display label is free text and is redacted.
export function surveyDetailed(s: Rec, includeContact = false) {
  return {
    ...surveySingle(s, includeContact),
    date_responses_modified: str(s.date_responses_modified),
    variables: Array.isArray(s.variables) ? s.variables.map((v: Rec) => ({ id: num(v.id), name: str(v.name), label: redactContacts(v.label, includeContact) })) : [],
    translations: Array.isArray(s.translations) ? s.translations.map((t: Rec) => ({ id: num(t.id), name: str(t.name), language_id: num(t.language_id), default: bool(t.default) })) : [],
    pages: Array.isArray(s.pages) ? s.pages.map((p: Rec) => pageDesign(p, includeContact)) : [],
  };
}

// AnswerDto: one answer item inside a respondent's answer to a question. `value` is free text typed
// by the respondent (open-ended answers, "other" boxes, comments), so it gets the redaction; the
// choice/row/column/dropdown titles are the designed labels, redacted like the design in get_survey.
export function answer(a: Rec, includeContact: boolean) {
  return {
    id: num(a.id),
    type: str(a.type),
    choice_id: num(a.choice_id),
    choice: redactContacts(a.choice_title, includeContact),
    choice_score: num(a.choice_score_value),
    row_id: num(a.row_id),
    row: redactContacts(a.row_title, includeContact),
    column_id: num(a.column_id),
    column: redactContacts(a.column_title, includeContact),
    column_score: num(a.column_score_value),
    dropdown_id: num(a.dropdown_id),
    dropdown: redactContacts(a.dropdown_title, includeContact),
    dropdown_score: num(a.dropdown_score_value),
    value: redactContacts(a.value, includeContact),
    categories: Array.isArray(a.categories) ? a.categories.map((c: unknown) => redactContacts(c, includeContact)) : undefined,
  };
}

// QuestionDto (in a response)
function questionAnswers(q: Rec, includeContact: boolean) {
  return {
    id: num(q.id),
    number: num(q.number),
    position: num(q.position),
    type: str(q.type),
    sub_type: str(q.sub_type),
    title: redactContacts(q.title, includeContact),
    total_score: num(q.total_score),
    answers: Array.isArray(q.answers) ? q.answers.map((a: Rec) => answer(a, includeContact)) : [],
  };
}

// Page (in a response)
function pageAnswers(p: Rec, includeContact: boolean) {
  return {
    id: num(p.id),
    position: num(p.position),
    title: redactContacts(p.title, includeContact),
    total_score: num(p.total_score),
    questions: Array.isArray(p.questions) ? p.questions.map((q: Rec) => questionAnswers(q, includeContact)) : [],
  };
}

// Variable (survey variables passed in the URL) and CustomColumn (contact-list columns): the value is
// free text that often carries contact data (an email passed as ?email=..., a "Phone" column). A value
// whose name marks it as contact data is withheld by default; every other value is redacted as text.
function namedValue(v: Rec, includeContact: boolean) {
  const name = str(v.name);
  const withheld = !includeContact && looksLikeContactField(name);
  return {
    ...(v.id !== undefined ? { id: num(v.id) } : {}),
    name,
    ...(v.label !== undefined ? { label: redactContacts(v.label, includeContact) } : {}),
    value: withheld ? "[withheld: looks like contact data; available with include_contact_details]" : redactContacts(v.value, includeContact),
  };
}

// Response (list) and DetailedResponse (get). Respondent identifiers (contact_name, contact_email,
// unique_id, ip_address, user_agent, saved_name, saved_email) and the two links that let anyone open
// the respondent's answers for editing (edit_url, saved_continue_url) are only returned on request.
// entry_url and referer_url stay, with any email or phone number inside them redacted.
export function response(r: Rec, includeContact: boolean) {
  return {
    id: num(r.id),
    survey_id: num(r.survey_id),
    status: str(r.status),
    date_started: str(r.date_started),
    date_ended: str(r.date_ended),
    date_modified: str(r.date_modified),
    tracking_link_id: num(r.tracking_link_id),
    contact_invitation_id: num(r.contact_invitation_id),
    translation_id: num(r.translation_id),
    country: str(r.country),
    saved: bool(r.saved),
    manual_entry: bool(r.manual_entry),
    total_score: num(r.total_score),
    current_page_id: num(r.current_page_id),
    page_path: str(r.page_path),
    entry_url: redactContacts(r.entry_url, includeContact),
    referer_url: redactContacts(r.referer_url, includeContact),
    entity_id: num(r.entity_id),
    entity_name: redactContacts(r.entity_name, includeContact),
    entity_unique_id: str(r.entity_unique_id),
    entity_fields: Array.isArray(r.entity?.fields) ? r.entity.fields.map((f: Rec) => namedValue(f, includeContact)) : undefined,
    ...(includeContact
      ? {
          contact_name: str(r.contact_name),
          contact_email: str(r.contact_email),
          unique_id: str(r.unique_id),
          ip_address: str(r.ip_address),
          user_agent: str(r.user_agent),
          saved_name: str(r.saved_name),
          saved_email: str(r.saved_email),
          saved_continue_url: str(r.saved_continue_url),
          edit_url: str(r.edit_url),
        }
      : {}),
    variables: Array.isArray(r.variables) ? r.variables.map((v: Rec) => namedValue(v, includeContact)) : [],
    contact_data: Array.isArray(r.contact_data) ? r.contact_data.map((c: Rec) => namedValue(c, includeContact)) : [],
    pages: Array.isArray(r.pages) ? r.pages.map((p: Rec) => pageAnswers(p, includeContact)) : [],
  };
}

// SurveyExportResponse: metadata only. href_download is the API's own download endpoint, which
// needs the same credentials; the file itself is never fetched by this server.
export function surveyExport(e: Rec) {
  return {
    id: num(e.id),
    name: str(e.name),
    type: str(e.type),
    status: str(e.status),
    file_size: num(e.file_size),
    file_extension: str(e.file_extension),
    file_content_type: str(e.file_content_type),
    requested_date: str(e.requested_date),
    started_date: str(e.started_date),
    completed_date: str(e.completed_date),
    download_url: str(e.href_download),
  };
}

// SurveyFolderResponse
export function surveyFolder(f: Rec, includeContact = false) {
  return { id: num(f.id), type: str(f.type), title: redactContacts(f.title, includeContact) };
}

// ApiBasicResponse {status, code, message}
export function basicResult(r: Rec | undefined) {
  return { status: num(r?.status), code: str(r?.code), message: str(r?.message) };
}

// SendInvitationResponse {message, validation_errors, failed_contacts}. ContactFailureInfo.contact is
// the email or mobile the caller just supplied, so it is returned as stored.
export function sendResult(r: Rec | undefined) {
  return {
    message: str(r?.message),
    validation_errors: r?.validation_errors && typeof r.validation_errors === "object" && Object.keys(r.validation_errors).length ? r.validation_errors : undefined,
    failed_contacts: Array.isArray(r?.failed_contacts)
      ? r.failed_contacts.map((f: Rec) => ({ contact: str(f.contact), name: str(f.name), error_message: str(f.error_message), status_code: str(f.status_code), mail_user_id: num(f.mail_user_id) }))
      : [],
  };
}
