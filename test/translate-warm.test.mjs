import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, verifyKeyRoundTrip, parseChromeCaptureLines, buildJob } from "../scripts/translate-warm.mjs";

// ---------------------------------------------------------------------------
// parseArgs — CLI flag parsing (task brief: dry-run default, --max-calls
// ceiling, --concurrency, --live opt-in).
// ---------------------------------------------------------------------------

test("translate-warm parseArgs: default is dry-run (live: false) with the documented defaults", () => {
  const args = parseArgs([]);
  assert.equal(args.live, false, "dry-run must be the default — the task brief's own safety argument depends on this");
  assert.equal(args.maxCalls, 2000);
  assert.equal(args.concurrency, 4);
  assert.equal(args.chromeOnly, false);
  assert.equal(args.entitiesOnly, false);
});

test("translate-warm parseArgs: --live is the only way to leave dry-run mode", () => {
  assert.equal(parseArgs(["--live"]).live, true);
  assert.equal(parseArgs(["--dry-run"]).live, false);
  // A later --dry-run overrides an earlier --live in the same invocation —
  // whichever is last wins, so "safe" always wins a conflicting pair.
  assert.equal(parseArgs(["--live", "--dry-run"]).live, false);
});

test("translate-warm parseArgs: --max-calls and --concurrency parse as numbers", () => {
  const args = parseArgs(["--max-calls=500", "--concurrency=2"]);
  assert.equal(args.maxCalls, 500);
  assert.equal(args.concurrency, 2);
});

test("translate-warm parseArgs: --chrome-only and --entities-only are independent flags", () => {
  assert.equal(parseArgs(["--chrome-only"]).chromeOnly, true);
  assert.equal(parseArgs(["--entities-only"]).entitiesOnly, true);
});

test("translate-warm parseArgs: a non-numeric --max-calls is a hard parse error, never a silent NaN", () => {
  // Regression test: --max-calls=abc used to parse to NaN, and
  // `missing.length > NaN` is always false — which silently disabled the
  // cost-guard ceiling entirely instead of refusing to run. Verified against
  // a real 10,144-call dry-run before this guard existed: it reported no
  // violation at all. args.help must be set (which main() treats as "print
  // usage and exit before touching FM/the API"), and maxCalls must NOT have
  // been silently coerced to NaN or silently left at the 2000 default —
  // either would hide the operator's typo.
  const prevExitCode = process.exitCode;
  try {
    const args = parseArgs(["--max-calls=abc"]);
    assert.equal(args.help, true, "an unparseable --max-calls must trip the help/exit path, not proceed with a disabled guard");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevExitCode;
  }
});

test("translate-warm parseArgs: --max-calls=0 and negative values are rejected, not accepted as 'no limit'", () => {
  const prevExitCode = process.exitCode;
  try {
    assert.equal(parseArgs(["--max-calls=0"]).help, true);
    assert.equal(parseArgs(["--max-calls=-5"]).help, true);
    assert.equal(parseArgs(["--concurrency=0"]).help, true);
  } finally {
    process.exitCode = prevExitCode;
  }
});

test("translate-warm parseArgs: a valid --max-calls is accepted and not flagged as help", () => {
  const args = parseArgs(["--max-calls=500"]);
  assert.equal(args.help, undefined);
  assert.equal(args.maxCalls, 500);
});

test("translate-warm parseArgs: an unrecognized flag sets help + a nonzero exit code, never silently ignored", () => {
  const prevExitCode = process.exitCode;
  try {
    const args = parseArgs(["--bogus-flag"]);
    assert.equal(args.help, true);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevExitCode;
  }
});

// ---------------------------------------------------------------------------
// verifyKeyRoundTrip — THE critical correctness property (task brief:
// "Verify it — e.g. round-trip one key through both paths and assert
// equality before writing anything"). This test exercises the SAME function
// the script itself calls as its very first step, so a regression here is a
// regression in the actual safety check, not a parallel copy of it.
// ---------------------------------------------------------------------------

test("translate-warm verifyKeyRoundTrip: resolves without throwing when translate.ts's key format is unchanged", async () => {
  // No network involved — translationKey() is a pure sha256-based function
  // (src/lib/translate.ts, documented as "MUST STAY PURE" specifically so
  // scripts can call it from plain Node with no side effects).
  await assert.doesNotReject(() => verifyKeyRoundTrip());
});

// ---------------------------------------------------------------------------
// parseChromeCaptureLines — the note D discovery mechanism's JSONL reader.
// ---------------------------------------------------------------------------

test("translate-warm parseChromeCaptureLines: parses one JSON object per line into a de-duplicated set", () => {
  const raw = ['{"source":"Hem"}', '{"source":"Records"}', '{"source":"Hem"}', ""].join("\n");
  const { sources, malformed } = parseChromeCaptureLines(raw);
  assert.deepEqual([...sources].sort(), ["Hem", "Records"]);
  assert.equal(malformed, 0);
});

test("translate-warm parseChromeCaptureLines: a malformed line is counted and skipped, not thrown", () => {
  const raw = ['{"source":"Hem"}', "not json", '{"source":"Records"}'].join("\n");
  const { sources, malformed } = parseChromeCaptureLines(raw);
  assert.deepEqual([...sources].sort(), ["Hem", "Records"]);
  assert.equal(malformed, 1);
});

test("translate-warm parseChromeCaptureLines: a line with an empty/blank source is dropped, not captured as ''", () => {
  const raw = ['{"source":""}', '{"source":"   "}', '{"source":"Real string"}'].join("\n");
  const { sources } = parseChromeCaptureLines(raw);
  assert.deepEqual([...sources], ["Real string"]);
});

test("translate-warm parseChromeCaptureLines: blank lines between entries are ignored, not counted as malformed", () => {
  const raw = ['{"source":"Hem"}', "", "", '{"source":"Records"}', ""].join("\n");
  const { sources, malformed } = parseChromeCaptureLines(raw);
  assert.equal(sources.size, 2);
  assert.equal(malformed, 0);
});

// ---------------------------------------------------------------------------
// buildJob (the internal `job()` helper) — trims and filters empty sources,
// used identically for both entity-field jobs and chrome jobs so a blank FM
// field or an accidentally-captured empty string never becomes a real
// translation call.
// ---------------------------------------------------------------------------

test("translate-warm buildJob: trims whitespace and returns null for an empty/blank source", () => {
  assert.equal(buildJob("  Hej  ", "fast").source, "Hej");
  assert.equal(buildJob("", "fast"), null);
  assert.equal(buildJob("   ", "fast"), null);
  assert.equal(buildJob(undefined, "fast"), null);
  assert.equal(buildJob(null, "fast"), null);
});

test("translate-warm buildJob: defaults kind to 'plain' when not specified", () => {
  const j = buildJob("Hello", "quality");
  assert.equal(j.tier, "quality");
  assert.equal(j.kind, "plain");
});

test("translate-warm buildJob: carries the given kind through unchanged", () => {
  assert.equal(buildJob("# Heading", "quality", "markdown").kind, "markdown");
  assert.equal(buildJob("A Title", "fast", "title").kind, "title");
});
