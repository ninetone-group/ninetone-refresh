# Public browser and payload evidence — 2026-09-12

This directory preserves the bounded, read-only staging evidence behind
`../../performance-browser-2026-09-12.md`. It deliberately excludes response
bodies, the full DevTools Protocol trace, cookies, request headers that could
contain user data, and any credentials.

`browser-trace-summary.json` contains only:

- public staging URLs;
- response status, selected cache/content-encoding headers, and curl timings;
- browser-observed DOM counts, LCP candidates, loading-failure counts; and
- public resource URLs with transfer and decoded sizes.

The data is a single local desktop headless Chromium capture without CPU or
network throttling. It is evidence of resource selection and cache state, not
field-user performance.
