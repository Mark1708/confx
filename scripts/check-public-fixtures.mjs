import { readdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoots = ["tests/fixtures", "sandbox/catalog.mjs", "sandbox/public"];
const textExtensions = new Set([
  ".html",
  ".json",
  ".csv",
  ".txt",
  ".md",
  ".js",
  ".mjs",
  ".css",
  ".base64",
]);
// These are public syntax namespaces / diagram endpoints, not captured site data.
const publicEndpoints = new Map([
  ["www.w3.org", ["/1999/xhtml", "/2000/svg", "/1999/xlink", "/XML/1998/namespace"]],
  ["www.plantuml.com", ["/plantuml/"]],
  ["plantuml.com", ["/plantuml/"]],
]);

function isSyntheticHost(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid)$/.test(host);
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (isSyntheticHost(url.hostname)) return true;
    return (publicEndpoints.get(url.hostname) || []).some((prefix) =>
      prefix.endsWith("/") ? url.pathname.startsWith(prefix) : url.pathname === prefix,
    );
  } catch {
    return false;
  }
}

function decodeFixtureText(text) {
  return text
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (match, hex, decimal) => {
      const value = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(
      /&(?:colon|sol|bsol|commat|period|amp|quot|apos);/gi,
      (match) =>
        ({
          "&colon;": ":",
          "&sol;": "/",
          "&bsol;": "\\",
          "&commat;": "@",
          "&period;": ".",
          "&amp;": "&",
          "&quot;": '"',
          "&apos;": "'",
        })[match.toLowerCase()],
    );
}

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

/** Findings deliberately never contain the matched value or a source excerpt. */
export function inspectFixture(file, input) {
  const text = decodeFixtureText(input);
  const findings = [];
  const seen = new Set();
  function report(rule, index) {
    const line = text.slice(0, index).split("\n").length;
    const key = `${rule}:${line}`;
    if (!seen.has(key)) findings.push({ file, line, rule });
    seen.add(key);
  }
  function matches(pattern, rule, reject = () => true) {
    for (const match of text.matchAll(pattern)) if (reject(match)) report(rule, match.index);
  }

  matches(
    /(?:file:\/{2,3})?(?:\/(?:Users|home)\/[^\s"'<>]+|[A-Z]:[\\/]Users[\\/][^\s"'<>]+)/gi,
    "HOME_PATH",
  );
  matches(
    /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi,
    "NON_SYNTHETIC_EMAIL",
    (match) => !isSyntheticHost(match[1]),
  );
  matches(
    /(?:https?:)?\/\/(?:\[[\da-f:.]+\]|[^\s<>"'`\\)\]}]+)[^\s<>"'`\\)\]}]*/gi,
    "EXTERNAL_SITE_DATA",
    (match) => {
      const value = match[0].replace(/[.,;]+$/, "");
      return !isAllowedUrl(value.startsWith("//") ? `https:${value}` : value);
    },
  );

  for (const match of text.matchAll(/<(?:meta|input)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const name = attrs.get("name") || attrs.get("id") || "";
    if (
      /(?:^ajs-atl-token$|csrf|xsrf|auth.?token|api.?token|session.?token|^atl_token$)/i.test(
        name,
      ) &&
      (attrs.get("content") || attrs.get("value") || "").trim()
    )
      report("AUTHENTICATING_SAMPLE", match.index);
  }
  matches(
    /(?:["']?(?:csrf[_-]?token|xsrf[_-]?token|atl[_-]?token|api[_-]?token|access[_-]?token|session[_-]?token)["']?\s*[:=]\s*["'])([^"']+)["']/gi,
    "AUTHENTICATING_SAMPLE",
    (match) => Boolean(match[1].trim()),
  );
  matches(
    /(?:authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+\S+|(?:set-cookie|cookie)["']?\s*[:=]\s*["']?\s*[^\s"']+=[^\s"']+|document\.cookie\s*=\s*["'][^"']+=[^"']+)/gi,
    "AUTHENTICATING_SAMPLE",
  );
  matches(
    /(?:ajs-remote-user|ajs-current-user-fullname|ajs-user-key|ajs-atlassian-account-id|ajs-beacon-token|ajs-synchrony-token|atl\.analytics|a\.t-b\.co)/gi,
    "CAPTURED_ACCOUNT_OR_TELEMETRY",
  );
  return findings;
}

async function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Fixture symlink is not allowed: ${child}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (textExtensions.has(path.extname(entry.name))) files.push(child);
  }
  return files;
}

export async function checkPublicFixtures(root = projectRoot) {
  const files = [];
  for (const relative of fixtureRoots) {
    if (path.extname(relative)) files.push(relative);
    else files.push(...(await listFiles(root, relative)));
  }
  const findings = [];
  for (const file of files)
    findings.push(...inspectFixture(file, await readFile(path.join(root, file), "utf8")));
  return { files: files.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { files, findings } = await checkPublicFixtures();
    if (findings.length) {
      for (const { file, line, rule } of findings) console.error(`${file}:${line}: ${rule}`);
      console.error(
        `Privacy check failed: ${findings.length} finding(s). Values are intentionally redacted.`,
      );
      process.exitCode = 1;
    } else
      console.log(
        `Privacy check passed: ${files} authored fixture/sandbox files (synthetic-only policy).`,
      );
  } catch (error) {
    console.error(`Privacy check could not complete: ${error.code || "fixture inventory error"}.`);
    process.exitCode = 1;
  }
}
