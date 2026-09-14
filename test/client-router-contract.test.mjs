import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Client router contract (2026-09-14). With <ClientRouter /> in Base.astro a
 * hoisted <script> runs ONCE per full page load; every client-side navigation
 * swaps the DOM and fires astro:page-load instead. A script that binds at
 * module scope therefore works on the first page and silently dies on the
 * second — no error, just a button that stops responding. This test pins the
 * convention so the next component cannot regress it.
 */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".astro")) out.push(p);
  }
  return out;
}

const files = [...walk("src/components"), ...walk("src/layouts"), ...walk("src/pages")];

test("Base.astro mounts the client router with the page fade off", () => {
  const base = readFileSync("src/layouts/Base.astro", "utf8");
  assert.match(base, /<ClientRouter \/>/);
  assert.match(base, /<html lang=\{lang\} transition:animate="none">/);
  assert.match(base, /astro:before-preparation/);
  assert.match(base, /astro:after-swap/);
});

test("every hoisted <script> registers its bindings on astro:page-load", () => {
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^[ \t]*<script>\n([\s\S]*?)^[ \t]*<\/script>/gm)) {
      if (!/astro:page-load/.test(m[1])) offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `hoisted scripts without astro:page-load: ${offenders.join(", ")}`);
});

test("every inline behaviour script reruns after a swap (data-astro-rerun)", () => {
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<script([^>]*)>/g)) {
      const attrs = m[1];
      if (!/is:inline|define:vars/.test(attrs)) continue;
      if (/type="application\/ld\+json"/.test(attrs)) continue; // data, not behaviour
      if (f.endsWith("Base.astro")) continue; // consent-mode + tracker bootstraps: once per tab, by design
      if (!/data-astro-rerun/.test(attrs)) offenders.push(`${f}: <script${attrs}>`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("both language-switch anchors are marked for the keep-place + decode behaviour", () => {
  const header = readFileSync("src/components/Header.astro", "utf8");
  assert.equal((header.match(/data-lang-switch/g) ?? []).length, 2);
});
