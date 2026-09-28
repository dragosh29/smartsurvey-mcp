// Rebuilds spec.json from SmartSurvey's public documentation. SmartSurvey publishes its OpenAPI 3.0.1
// definition one operation per reference page: the Markdown version of each page (its URL + ".md")
// embeds an "OpenAPI definition" JSON block with that page's path, its operation and the component
// schemas it uses. The index of pages is https://docs.smartsurvey.io/llms.txt. This script fetches
// them all and merges them into one document; the merge refuses to continue if two pages define the
// same path+method or the same schema name differently.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LLMS_URL = "https://docs.smartsurvey.io/llms.txt";
const CONCURRENCY = 4;

const stable = (v) => JSON.stringify(v);

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "text/markdown, text/plain, */*" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** The JSON block under "# OpenAPI definition" on one reference page. */
export function extractDefinition(markdown, url) {
  const at = markdown.indexOf("# OpenAPI definition");
  if (at < 0) throw new Error(`${url}: no "OpenAPI definition" section`);
  const open = markdown.indexOf("```json", at);
  const close = open < 0 ? -1 : markdown.indexOf("\n```", open + 7);
  if (open < 0 || close < 0) throw new Error(`${url}: no JSON code block after the OpenAPI heading`);
  return JSON.parse(markdown.slice(open + 7, close));
}

export async function assembleSpec(outPath) {
  const index = await fetchText(LLMS_URL);
  const urls = [...new Set(index.match(/https:\/\/docs\.smartsurvey\.io\/reference\/[^\s)]+\.md/g) ?? [])];
  if (urls.length === 0) throw new Error(`${LLMS_URL}: no reference page URLs found`);

  const spec = { openapi: undefined, info: undefined, servers: undefined, paths: {}, components: { schemas: {}, securitySchemes: {} }, security: undefined };
  let operations = 0;
  const merge = (def, url) => {
    for (const key of ["openapi", "info", "servers", "security"]) {
      if (def[key] === undefined) continue;
      if (spec[key] === undefined) spec[key] = def[key];
      else if (stable(spec[key]) !== stable(def[key])) throw new Error(`${url}: "${key}" differs from the other pages`);
    }
    for (const [path, ops] of Object.entries(def.paths ?? {})) {
      spec.paths[path] ??= {};
      for (const [method, op] of Object.entries(ops)) {
        if (spec.paths[path][method] !== undefined && stable(spec.paths[path][method]) !== stable(op)) throw new Error(`${url}: ${method.toUpperCase()} ${path} is defined differently on another page`);
        if (spec.paths[path][method] === undefined) operations++;
        spec.paths[path][method] = op;
      }
    }
    for (const group of ["schemas", "securitySchemes"]) {
      for (const [name, schema] of Object.entries(def.components?.[group] ?? {})) {
        const existing = spec.components[group][name];
        if (existing !== undefined && stable(existing) !== stable(schema)) throw new Error(`${url}: component ${group}.${name} is defined differently on another page`);
        spec.components[group][name] = schema;
      }
    }
  };

  let next = 0;
  const failures = [];
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        merge(extractDefinition(await fetchText(url), url), url);
      } catch (err) {
        failures.push(`${url}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  if (failures.length) throw new Error(`Could not assemble the spec:\n  ${failures.join("\n  ")}`);

  spec.info = { ...(spec.info ?? {}), "x-note": `Assembled on ${new Date().toISOString().slice(0, 10)} from the per-page OpenAPI definitions published on docs.smartsurvey.io (each reference page embeds one).` };
  writeFileSync(outPath, JSON.stringify(spec, null, 2));
  return { pages: urls.length, operations, schemas: Object.keys(spec.components.schemas).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? fileURLToPath(new URL("../spec.json", import.meta.url));
  const r = await assembleSpec(out);
  console.log(`Wrote ${out}: ${r.pages} pages, ${r.operations} operations, ${r.schemas} schemas.`);
}
