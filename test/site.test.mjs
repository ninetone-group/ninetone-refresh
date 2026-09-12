import assert from "node:assert/strict";
import test from "node:test";

import { siteOrigin, isProductionShaped, resolveSitePath, jsonLdOrigin } from "../src/lib/site.ts";

// This module reads env vars via `process.env` when running outside Vite
// (plain node:test has no `import.meta.env`), so these tests drive the three
// fallback branches by setting/clearing process.env around each call.
function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("siteOrigin: PUBLIC_SITE_ORIGIN env wins over everything else", () => {
  withEnv(
    {
      PUBLIC_SITE_ORIGIN: "https://ninetone.com/",
      PUBLIC_HAS_RUNTIME: "true",
      SITE: "https://ninetone-site.micke-ohlen.workers.dev",
    },
    () => {
      const req = new Request("https://staging.example.workers.dev/records/artists");
      assert.equal(siteOrigin(req), "https://ninetone.com");
    },
  );
});

test("siteOrigin: strips any path/query/trailing slash from the env value", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: "https://ninetone.com/some/path?x=1" }, () => {
    assert.equal(siteOrigin(), "https://ninetone.com");
  });
});

test("siteOrigin: on the CF target, falls back to the request origin when no env override", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true", SITE: undefined }, () => {
    const req = new Request("https://ninetone-site.micke-ohlen.workers.dev/news/some-post");
    assert.equal(siteOrigin(req), "https://ninetone-site.micke-ohlen.workers.dev");
  });
});

test("siteOrigin: ignores the request origin when PUBLIC_HAS_RUNTIME is not set (static target)", () => {
  withEnv(
    {
      PUBLIC_SITE_ORIGIN: undefined,
      PUBLIC_HAS_RUNTIME: undefined,
      SITE: "https://mixxmastermike123.github.io",
    },
    () => {
      const req = new Request("https://staging.example.workers.dev/records/artists");
      assert.equal(siteOrigin(req), "https://mixxmastermike123.github.io");
    },
  );
});

test("siteOrigin: falls back to the static astro.config.mjs `site` when no env and no request", () => {
  withEnv(
    { PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: undefined, SITE: "https://mixxmastermike123.github.io" },
    () => {
      assert.equal(siteOrigin(), "https://mixxmastermike123.github.io");
    },
  );
});

test("siteOrigin: CF target but no request object still falls back to static SITE", () => {
  withEnv(
    {
      PUBLIC_SITE_ORIGIN: undefined,
      PUBLIC_HAS_RUNTIME: "true",
      SITE: "https://ninetone-site.micke-ohlen.workers.dev",
    },
    () => {
      assert.equal(siteOrigin(), "https://ninetone-site.micke-ohlen.workers.dev");
    },
  );
});

test("siteOrigin: returns an empty string when nothing resolves", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: undefined, SITE: undefined }, () => {
    assert.equal(siteOrigin(), "");
  });
});

test("siteOrigin: accepts a plain { url } object, not just a Request", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: undefined, PUBLIC_HAS_RUNTIME: "true", SITE: undefined }, () => {
    assert.equal(
      siteOrigin({ url: "https://ninetone-site.micke-ohlen.workers.dev/team" }),
      "https://ninetone-site.micke-ohlen.workers.dev",
    );
  });
});

test("isProductionShaped: true when PUBLIC_SITE_ORIGIN is set", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: "https://ninetone.com" }, () => {
    assert.equal(isProductionShaped(), true);
  });
});

test("isProductionShaped: false when PUBLIC_SITE_ORIGIN is unset", () => {
  withEnv({ PUBLIC_SITE_ORIGIN: undefined }, () => {
    assert.equal(isProductionShaped(), false);
  });
});

// resolveSitePath() is the exact logic that leaked the GH Pages sub-path
// ("/ninetone-refresh-preview") into production-shaped canonical/OG URLs —
// it had zero coverage before, which is how that slipped through. These
// tests drive it directly, covering the Base.astro canonical-prop branch
// (a caller-supplied site-relative path) as well as the default-path branch
// (Astro.url.pathname, which is already-based on the static target), across
// both the still-preview and production-shaped states, on both build targets.
function noopAddBase(path) {
  return `[unexpected addBase call: ${path}]`;
}

test("resolveSitePath: gh target, still-preview, path not yet based -> adds the base", () => {
  const addBase = (p) => `/ninetone-refresh-preview${p}`;
  assert.equal(
    resolveSitePath("/og-default.png", "/ninetone-refresh-preview", false, addBase),
    "/ninetone-refresh-preview/og-default.png",
  );
});

test("resolveSitePath: gh target, still-preview, path already based (Astro.url.pathname) -> left as-is, base not doubled", () => {
  assert.equal(
    resolveSitePath(
      "/ninetone-refresh-preview/records/artists/anjo/",
      "/ninetone-refresh-preview",
      false,
      noopAddBase,
    ),
    "/ninetone-refresh-preview/records/artists/anjo/",
  );
});

test("resolveSitePath: gh target, production-shaped, already-based path -> base is stripped (this was the bug)", () => {
  assert.equal(
    resolveSitePath(
      "/ninetone-refresh-preview/records/artists/anjo/",
      "/ninetone-refresh-preview",
      true,
      noopAddBase,
    ),
    "/records/artists/anjo/",
  );
});

test("resolveSitePath: gh target, production-shaped, caller-supplied canonical prop path -> no base added", () => {
  // This is the Base.astro `canonical` prop branch: a caller-supplied
  // site-relative path, never already based.
  assert.equal(
    resolveSitePath("/records/artists/anjo", "/ninetone-refresh-preview", true, noopAddBase),
    "/records/artists/anjo",
  );
});

test("resolveSitePath: gh target, production-shaped, og-default.png -> stays unprefixed", () => {
  assert.equal(
    resolveSitePath("/og-default.png", "/ninetone-refresh-preview", true, noopAddBase),
    "/og-default.png",
  );
});

test("resolveSitePath: cf target (empty base prefix), still-preview -> addBase is a no-op passthrough", () => {
  const addBase = (p) => p; // url() is a no-op when base is "/"
  assert.equal(resolveSitePath("/records/artists/anjo", "", false, addBase), "/records/artists/anjo");
});

test("resolveSitePath: cf target (empty base prefix), production-shaped -> nothing to strip, path unchanged", () => {
  assert.equal(resolveSitePath("/records/artists/anjo", "", true, noopAddBase), "/records/artists/anjo");
});

test("resolveSitePath: strips the base cleanly even when what remains would otherwise lack a leading slash", () => {
  // basePrefix consumes the whole string up to a bare "/" boundary; guard
  // against ever returning a path with no leading slash.
  assert.equal(resolveSitePath("/ninetone-refresh-preview", "/ninetone-refresh-preview", true, noopAddBase), "/");
});

// jsonLdOrigin() is the fix for JSON-LD URLs 404ing under the GH Pages
// preview sub-path — schema.ts builders do plain `${origin}${path}`
// concatenation with no access to url()/resolveSitePath(), so the sub-path
// must be folded into `origin` itself before it reaches them.
test("jsonLdOrigin: still-preview (gh target) -> folds the sub-path into the origin", () => {
  assert.equal(
    jsonLdOrigin("https://mixxmastermike123.github.io", "/ninetone-refresh-preview", false),
    "https://mixxmastermike123.github.io/ninetone-refresh-preview",
  );
});

test("jsonLdOrigin: production-shaped -> origin unchanged even if basePrefix is still configured", () => {
  assert.equal(
    jsonLdOrigin("https://ninetone.com", "/ninetone-refresh-preview", true),
    "https://ninetone.com",
  );
});

test("jsonLdOrigin: cf target (empty basePrefix) -> origin unchanged regardless of productionShaped", () => {
  assert.equal(jsonLdOrigin("https://ninetone-site.micke-ohlen.workers.dev", "", false), "https://ninetone-site.micke-ohlen.workers.dev");
  assert.equal(jsonLdOrigin("https://ninetone.com", "", true), "https://ninetone.com");
});

test("jsonLdOrigin: empty origin (siteOrigin() resolved nothing) passes through unchanged rather than emitting a bare sub-path", () => {
  assert.equal(jsonLdOrigin("", "/ninetone-refresh-preview", false), "");
});
