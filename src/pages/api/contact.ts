import type { APIRoute } from "astro";

/**
 * Real contact-form delivery for the three division contact pages
 * (records, management, nation). Cloudflare-only — see src/lib/cf.ts.
 *
 * Pattern mirrors src/pages/api/publish.ts: cross-site rejection, a capped
 * streamed body read, a Cloudflare rate-limit binding keyed off a hashed
 * connecting IP that fails CLOSED when missing, `no-store` JSON responses.
 *
 * Submissions are stored in KV first (source of truth — 90-day retention),
 * then emailed to the relevant division inbox. A failed email send does not
 * fail the request: the submission is already durably stored, so we still
 * report success to the visitor and flag delivered:false. A failed KV write
 * does fail the request, since nothing was persisted.
 *
 * No personal data (name, email, message body) is ever logged.
 */

import { getCfEnv, type CfEnv } from "../../lib/cf.ts";
import { readLimitedBody, json, isCrossSite, sha256Hex } from "../../lib/http.ts";

const DIVISIONS = ["records", "management", "nation"] as const;
type Division = (typeof DIVISIONS)[number];

const RECIPIENTS: Record<Division, string> = {
  records: "office@ninetone.com",
  management: "office@ninetone.com",
  nation: "booking@ninetone.com",
};

const SUBJECT_PREFIX: Record<Division, string> = {
  records: "[Ninetone Records] Demo from",
  management: "[Ninetone Management] Enquiry from",
  nation: "[Ninetone Nation] Booking request from",
};

// Sent from a dedicated subdomain so Cloudflare Email Sending writes its MX/SPF/DKIM/DMARC
// under send.ninetone.com and never touches the apex, where Google Workspace mail lives
// (2026-10-10). Recipients reply to the visitor via replyTo, so the sender is never answered.
const FROM_ADDRESS = { email: "noreply@send.ninetone.com", name: "Ninetone website" };

/** Fields accepted beyond the required name/email/division, all optional free text. */
const TEXT_FIELDS = ["links", "about", "message", "details"] as const;
const SHORT_FIELDS = ["date", "company"] as const;

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_TEXT = 4_000;
const MAX_SHORT = 200;
const MAX_BODY_BYTES = 8 * 1024;

// Simple RFC-ish check — not exhaustive, just enough to reject obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDivision(value: unknown): value is Division {
  return typeof value === "string" && (DIVISIONS as readonly string[]).includes(value);
}

/** Strips control characters except newline (\n) and tab (\t). */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function readString(source: Record<string, unknown>, key: string): string {
  const raw = source[key];
  if (typeof raw !== "string") return "";
  return stripControlChars(raw).trim();
}

/** Single-line fields: collapse any newline/tab runs so they can never reach
 * an email header (Subject/Reply-To) or break the plain-text body layout. */
function readLine(source: Record<string, unknown>, key: string): string {
  return readString(source, key).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

type ParsedFields = {
  division: string;
  name: string;
  email: string;
  website: string; // honeypot
  fields: Record<string, string>;
};

async function parseBody(request: Request): Promise<ParsedFields | null> {
  const raw = await readLimitedBody(request, MAX_BODY_BYTES);
  const ct = request.headers.get("content-type") || "";

  let source: Record<string, unknown>;
  if (ct.includes("application/json")) {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    source = body as Record<string, unknown>;
  } else if (ct.includes("application/x-www-form-urlencoded")) {
    source = Object.fromEntries(new URLSearchParams(raw).entries());
  } else {
    return null;
  }

  const fields: Record<string, string> = {};
  for (const key of TEXT_FIELDS) {
    const value = readString(source, key);
    if (value) fields[key] = value;
  }
  for (const key of SHORT_FIELDS) {
    const value = readLine(source, key);
    if (value) fields[key] = value;
  }

  return {
    division: readLine(source, "division"),
    name: readLine(source, "name"),
    email: readLine(source, "email"),
    website: readLine(source, "website"),
    fields,
  };
}

function validate(parsed: ParsedFields): string[] {
  const invalidFields: string[] = [];
  if (!isDivision(parsed.division)) invalidFields.push("division");
  if (!parsed.name || parsed.name.length > MAX_NAME) invalidFields.push("name");
  if (!parsed.email || parsed.email.length > MAX_EMAIL || !EMAIL_RE.test(parsed.email)) {
    invalidFields.push("email");
  }
  for (const key of TEXT_FIELDS) {
    const value = parsed.fields[key];
    if (value && value.length > MAX_TEXT) invalidFields.push(key);
  }
  for (const key of SHORT_FIELDS) {
    const value = parsed.fields[key];
    if (value && value.length > MAX_SHORT) invalidFields.push(key);
  }
  return invalidFields;
}

function buildEmailBody(parsed: ParsedFields, kvKey: string): string {
  const lines = [`Name: ${parsed.name}`, `Email: ${parsed.email}`];
  for (const key of [...TEXT_FIELDS, ...SHORT_FIELDS]) {
    const value = parsed.fields[key];
    if (value) lines.push(`${key[0].toUpperCase()}${key.slice(1)}: ${value}`);
  }
  lines.push("", `— submission ${kvKey}`);
  return lines.join("\n");
}

export async function handleContact(request: Request, env: CfEnv | null): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, { Allow: "POST" });
  }

  if (isCrossSite(request)) {
    return json(403, { ok: false, error: "Cross-site request rejected" });
  }

  const kv = env?.CONTACT_SUBMISSIONS;
  const limiter = env?.CONTACT_RATE_LIMITER;

  if (!kv || !limiter) {
    return json(503, { ok: false, error: "Contact delivery is only available on the live (Cloudflare) deployment" });
  }

  const connectingIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rateKey = await sha256Hex(connectingIp);
  try {
    if (!(await limiter.limit({ key: rateKey })).success) {
      return json(429, { ok: false, error: "Too many attempts" });
    }
  } catch {
    return json(503, { ok: false, error: "Contact protection is unavailable" });
  }

  let parsed: ParsedFields | null;
  try {
    parsed = await parseBody(request);
  } catch (err) {
    if (err instanceof RangeError) return json(413, { ok: false, error: "Request too large" });
    return json(400, { ok: false, error: "invalid" });
  }

  if (!parsed) {
    return json(415, { ok: false, error: "Unsupported content type" });
  }

  // Honeypot: pretend success, do nothing.
  if (parsed.website) {
    return json(200, { ok: true });
  }

  const invalidFields = validate(parsed);
  if (invalidFields.length > 0) {
    return json(400, { ok: false, error: "invalid", fields: invalidFields });
  }

  const division = parsed.division as Division;
  const kvKey = `${division}:${new Date().toISOString()}:${crypto.randomUUID()}`;
  const record = {
    division,
    name: parsed.name,
    email: parsed.email,
    ...parsed.fields,
    receivedAt: new Date().toISOString(),
  };

  try {
    await kv.put(kvKey, JSON.stringify(record), { expirationTtl: 90 * 24 * 3600 });
  } catch {
    return json(503, { ok: false, error: "unavailable" });
  }

  let delivered = false;
  const emailBinding = env?.CONTACT_EMAIL;
  if (emailBinding) {
    try {
      await emailBinding.send({
        to: RECIPIENTS[division],
        from: FROM_ADDRESS,
        replyTo: parsed.email,
        subject: `${SUBJECT_PREFIX[division]} ${parsed.name}`,
        text: buildEmailBody(parsed, kvKey),
      });
      delivered = true;
    } catch {
      console.warn(`contact: email send failed division=${division} kvKey=${kvKey}`);
    }
  } else {
    console.warn(`contact: email binding unavailable division=${division} kvKey=${kvKey}`);
  }

  return json(200, { ok: true, delivered });
}

// A single ALL handler (rather than exporting only POST) so GET/PUT/etc.
// reach handleContact's own 405 response instead of Astro's generic one —
// keeps the method check unit-testable via handleContact directly.
export const ALL: APIRoute = async ({ request }) => handleContact(request, await getCfEnv());
