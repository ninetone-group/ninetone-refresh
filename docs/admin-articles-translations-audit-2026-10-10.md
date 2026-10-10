# Admin, articles and translations audit

Date: **2026-10-10**, Europe/Stockholm. Reviewed revision: **`47652c5`**, release **`0.3.2.1`**, on **`fix/english-pages-stuck-on-source`**.

The local checkout was verified at full commit `47652c51d6f48b3016342e008cf071b2f8272377`. The user confirmed that this branch/revision is live in production and that `main` is one fix behind. This audit includes the deployed second-visit/source-identity fix; it was not performed against `main`. Production deployment status was provided by the user, not independently checked.

## Result

**Fix the correction workflow and translation validation before relying on the new admin tools for routine editing.** Authentication and Markdown escaping have useful protections, but saved corrections can disappear, unsaved edits can be discarded, and automatic translations can still change links or serve damaged cached text.

**Recommend upgrading both translation tiers to 5.5:** `claude-haiku-5-5` for fast translations and `claude-sonnet-5-5` for quality translations. Include cache invalidation, request policy and warm-script updates in that change; changing the two model strings alone is insufficient.

Found **14 actionable issues: 8 P1, 6 P2; no P0 or P3 findings**. P1 means a material integrity/security problem or an accessibility failure to fix before further rollout. P2 means an edge case, usability problem or integration gap with a workaround. These are local reproductions and code findings, not claims that all affected conditions occurred in production.

No confirmed authentication bypass or executable Markdown injection was found in this scope. That is a bounded review result, not a guarantee for the entire application.

## Scope and verification

Reviewed changes from `2a5fb32..47652c5`, particularly:

- Admin session authentication, `/api/admin`, homepage block status, translation review, locks, content health and cache flushing.
- Article source selection, excerpt cleanup, Markdown rendering, language detection, output guards, translation caches and the second-visit fix.
- Homepage FileMaker copy parsing and the corresponding translation inventory.
- Claude model configuration, the warm script and the shared model-call path used by the publication queue.

| Check | Result | Evidence |
| --- | --- | --- |
| Existing repository tests | **835 passed, 0 failed** | [Test output](audit-evidence/admin-article-2026-10-10/test-output.txt) |
| Cloudflare build | **Passed**; expected SSR `getStaticPaths()` warnings | [Build output](audit-evidence/admin-article-2026-10-10/build-output.txt) |
| Build secret gate | **Passed**; five local secrets checked against 108 files, none baked | Same build output |
| Targeted integrity probes | Confirmed F01–F03, F09–F12 and F14 under controlled inputs | [Runnable probes](audit-evidence/admin-article-2026-10-10/probes.mjs), [results](audit-evidence/admin-article-2026-10-10/probe-results.json) |
| Browser verification | Chrome, 1280×900 desktop and 390×844 mobile; confirmed draft loss, response mixing, target sizes, selector width and contrast | [Browser harness](audit-evidence/admin-article-2026-10-10/browser-ui.mjs), [results](audit-evidence/admin-article-2026-10-10/browser-results.json) |
| UI detector | No static findings; manual and browser checks found issues beyond its coverage | [Detector output](audit-evidence/admin-article-2026-10-10/ui-detector.json) |
| Workers binding checks | KV and rate-limit calls checked against `@cloudflare/workers-types` **5.20261010.1** and the installed Wrangler schema | Retrieval and schema inspection; no new binding API mismatch found |
| Model documentation | Current official Anthropic model pages, migration guides and pricing checked on audit date | Sources linked in the model section |

All browser API responses, KV storage and model responses used for reproductions were mocked. **No production writes, real admin login, deployment or paid translation calls were made.** Product code and model settings were left unchanged. The local browser used the default preview target; these checks validate the shared admin DOM/CSS and scripts, not production Worker networking. The Astro development toolbar visible in screenshots is outside the audited product UI.

Not assessed: production access configuration, actual global KV propagation, live translation quality from the proposed models, full screen-reader behavior or field Core Web Vitals. The build transpiles TypeScript; it does not substitute for a strict TypeScript/Astro diagnostic run.

## UI health

**Visual system verdict: coherent. Functional integrity verdict: needs fixes.** The shared admin layout follows the incumbent paper canvas, display serif, square controls and restrained red accent. No replacement design system is needed. The editing state and accessibility defects below are the priority.

These scores describe the reviewed admin surfaces, not a whole-site WCAG or performance certification.

| Dimension | Score / 4 | Evidence |
| --- | --- | --- |
| Accessibility | 2 | Missing specific editor labels; muted navigation contrast is 4.01:1 |
| Performance | 3 | Small standalone shell, no FM rendering dependency; homepage warming inventory has drifted |
| Responsive design | 2 | Columns stack without overflow in tested fixtures; page selector collapses to 74px and controls are small |
| Theming | 4 | Shared tokens and established brand treatment; no dark-mode requirement for these admin screens |
| Implementation integrity | 2 | Shared shell and inventory are useful, but asynchronous state and correction persistence have confirmed defects |
| **Total** | **13 / 20** | **Acceptable visual foundation; significant functional work remains** |

## P1 findings

### F01. Saving a correction can erase another correction

**Category:** content integrity. **Confidence:** high; reproduced with a stale-read KV fake.

**Location:** [translation-locks.ts:129](../src/lib/translation-locks.ts#L129), particularly the load, spread and whole-map `put()` at lines 131–137.

Every save reads and replaces the shared `tr-locks:v1` value. Two overlapping saves can overwrite one another. More importantly, **sequential saves by one editor are not guaranteed safe**: a stale KV read can return the pre-save map and erase the previous correction. The settled in-memory map does not protect the write, because `writeLock()` explicitly reloads it. A save that follows an unlock can similarly restore a removed lock.

**Reproduction:** the fake KV continues returning the previously missing value. Save `first`, then `second`; both operations complete successfully, but the stored map contains only `en:second`. The changelog already acknowledges concurrent loss, but its “one person saves locks at a time” workaround is stronger than KV guarantees. Cloudflare documents that even visibility in the writing location is not guaranteed. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

**Recommendation:** give each lock its own authoritative key and keep a derived map for fast rendering, or serialize authoritative mutations through a Durable Object with strongly consistent state. Preserve deletion state when rebuilding the map. Simply serializing writes while continuing to read a stale KV map is insufficient. Keep lock reads out of the per-string translation path.

The shared key also has a one-write-per-second limit, so rapid saves can fail even without overwriting. Disable duplicate submissions and handle throttling explicitly. [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)

### F02. Automatic translation validation does not protect all rendered links or structure

**Category:** security/content integrity. **Confidence:** high; mocked model outputs accepted by the real guard.

**Location:** [translate.ts:791](../src/lib/translate.ts#L791), `breaksMarkdownStructure()` at line 820 and its use at line 864. Compare [admin-api.ts:53](../src/lib/admin-api.ts#L53), which checks rendered `href`/`src` values when locking text.

The automatic guard compares blank-line block counts and raw `http(s)` URLs. It accepts all of the following:

- A relative link changed from `/news/original` to `/news/changed`.
- Changed `mailto:` and `tel:` targets.
- A link changed into an image using the same URL.
- A clickable link converted into a fenced code block containing the same URL.
- A heading removed while paragraph counts remain equal.
- A visible single line break removed. `renderBio()` uses `breaks: true`, so that changes rendering.

**Impact:** model output is untrusted. A translation can redirect readers to an unintended destination or damage article presentation while being permanently accepted. The admin lock validator prevents more link mutations than the model validator, and content health inherits the weaker automatic check.

**Recommendation:** share the rendered-link comparison between automatic output, locks and health. Validate Markdown token structure for headings, lists and other supported elements, with an explicit policy for authored versus reflowable line breaks. Keep the existing HTML escaping and URL allowlist; they protect a different boundary. Consider preserving link destinations outside the text sent for translation.

### F03. Damaged cached translations bypass the new structural guard

**Category:** translation consistency. **Confidence:** high; reproduced.

**Location:** [translate.ts:1503](../src/lib/translate.ts#L1503); contrast with [admin-content.ts:98](../src/lib/admin-content.ts#L98).

A cache hit is checked only for an unchanged source returned in the wrong target language. A cached English translation with collapsed paragraphs is still returned as `origin: "cached"` and enters the route bundle ledger. Content health can flag it as damaged, but public rendering continues to serve it and no new translation is scheduled.

**Reproduction:** supply a two-paragraph LF source and a one-paragraph cached English output. `translate()` returns the damaged output as cached; `shownFor()` reports `structureBroken: true`; the bundle ledger receives the same bad entry.

**Impact:** the recent CR normalization retires entries whose source key changes, but it does not invalidate previously normalized LF entries. Per-string translations have no TTL, and route bundles can keep reseeding damaged values.

**Recommendation:** validate cached Markdown against the consuming source/structure before accepting it. On rejection, exclude it from the ledger, evict the isolate value and schedule regeneration. Retire affected bundles/translation generations during the rollout. Apply validation on read even when an entry was originally generated under another `kind`, because the current persistent key does not include `kind`.

### F04. Saving one field discards unsaved edits in all other fields

**Category:** UI/editing integrity. **Confidence:** high; browser reproduction.

**Location:** [translations.astro:74](../src/pages/admin/translations.astro#L74), [translations.astro:96](../src/pages/admin/translations.astro#L96).

After a lock succeeds, `load()` clears and rebuilds the entire editor. Unsaved values in other textareas disappear. Unlocking, changing the page selector and the automatic 401 reload can also discard drafts. Buttons remain enabled during mutations.

**Reproduction:** edit the headline and body, save the headline, and wait for reload. The body reverts from the draft to the server-provided translation. The browser evidence records the lost draft.

**Recommendation:** track drafts per item/string/language and update only the saved field. Preserve drafts through refresh and reauthentication. Add dirty-state protection when switching items or leaving the page, and disable each mutation button while its request is active. Suggested UI command: `$impeccable harden`.

### F05. Overlapping page loads mix article content in one editor

**Category:** UI/consistency. **Confidence:** high; browser reproduction.

**Location:** [translations.astro:96](../src/pages/admin/translations.astro#L96), selector change handler at line 115.

`load()` clears the root before fetching, then appends its response without checking whether that response still belongs to the selected item. Multiple requests share the same root. A slow earlier request can append its fields after the new item has loaded.

**Reproduction:** select article A, then article B; delay A's response. The selector stays on B while the DOM contains **four sections from both A and B**. Each save handler captures the response's item ID, so a control beneath the B selector can modify A.

**Recommendation:** use a request generation ID or `AbortController`, capture the requested item, and ignore superseded responses. Assemble the winning result before replacing the DOM. Display the reviewed page name/link above its fields. Suggested command: `$impeccable harden`.

Evidence: [mixed responses screenshot](audit-evidence/admin-article-2026-10-10/translations-race.png).

### F06. Translation textareas lack persistent, specific labels

**Category:** accessibility. **Confidence:** high; DOM inspection.

**Location:** [translations.astro:67](../src/pages/admin/translations.astro#L67).

The generated textareas have no associated `<label>`, ID or `aria-labelledby`. The visual labels identify language and field, but their relationship to the textarea is not exposed programmatically. Every editor uses the same placeholder. Browser accessibility fallback to that placeholder does not identify which field/language is being edited.

**Impact/standard:** screen-reader and voice-control users cannot reliably distinguish editors. This fails the intended label/relationship requirements of WCAG 1.3.1 and 3.3.2.

**Recommendation:** give every textarea a stable item/string/language ID and visible label such as “English article text.” Connect state, structural warnings and validation help with `aria-describedby`; set `aria-invalid` for failed input. The health problem table also needs column headers and an accessible description. Suggested command: `$impeccable harden`.

### F07. Muted admin text fails normal-text contrast

**Category:** accessibility/theming. **Confidence:** high; browser color compositing.

**Location:** [AdminLayout.astro:110](../src/layouts/AdminLayout.astro#L110); repeated `text-ninetone-ink/55` labels in the new admin pages.

The inactive navigation uses ink at 55% opacity on the paper background. The browser measurement gives **4.01:1**, below the **4.5:1** threshold for normal text. Navigation is 12px; other metadata uses similarly small text. The design-system palette's strong base contrast does not survive this opacity reduction.

**Recommendation:** introduce or use an accessible muted-text token, verify its rendered ratio and apply it to navigation, language labels, table headings and explanatory text. Preserve the paper/ink aesthetic. WCAG 1.4.3. Suggested command: `$impeccable colorize`.

### F12. A stale review can lock old wording against newly edited FileMaker text

**Category:** content integrity. **Confidence:** high; reproduced.

**Location:** [admin-api.ts:122](../src/lib/admin-api.ts#L122), lock/unlock handlers at line 147; [translations.astro:76](../src/pages/admin/translations.astro#L76).

Review returns source text but no revision/hash to be checked when saving. A mutation submits only item, string, language and wording. The server looks up the current source and derives a new hash, even if the editor composed the correction against an older source.

**Reproduction:** review `Ny singel`; change the FM title to `Ny turné`; submit `New single`. The API answers 200 and serves **“New single” as the locked translation of “Ny turné.”** Paragraph/link checks cannot detect this semantic mismatch. Unlock has the same missing revision check and can target a different source than the one reviewed.

**Recommendation:** return a normalized source hash/revision with review and require it on mutation. Compare it to the server's freshly derived hash and return 409 when changed. Preserve the draft and show both versions for reconciliation. Also detect competing updates to the same correction. Do not trust client-supplied source text as authority.

## P2 findings

### F08. Mobile selector and touch targets need adaptation

**Category:** responsive UI. **Confidence:** high; measured in Chrome.

**Location:** [translations.astro:12](../src/pages/admin/translations.astro#L12), action buttons at lines 72 and 82; [AdminLayout.astro:106](../src/layouts/AdminLayout.astro#L106).

At 390px, the page selector is only **74px wide** because the long flush button consumes most of the flex row. Even “Homepage” is visibly truncated. Lock buttons are **32px high**, and navigation links are **16px high**, below the project's 44px touch-target standard. Tested fixtures did not cause horizontal document overflow.

**Recommendation:** stack the selector and flush action at narrow widths, give the selector full available width, and enlarge action/nav hit areas to the documented minimum. Preserve two-column review only when room permits. Suggested command: `$impeccable adapt`.

Evidence: [mobile translations](audit-evidence/admin-article-2026-10-10/translations-mobile.png), [mobile homepage blocks](audit-evidence/admin-article-2026-10-10/homepage-mobile.png), [mobile health](audit-evidence/admin-article-2026-10-10/health-mobile.png).

### F09. Source-language protection is incomplete for short news text

**Category:** translation consistency. **Confidence:** high; reproduced.

**Location:** [translate.ts:932](../src/lib/translate.ts#L932), same-language check at line 1483; [admin-api.ts:162](../src/lib/admin-api.ts#L162).

The detector intentionally declines many short strings. For `Ny singel`, it returns `null`, so the Swedish news headline follows the translation/cache/lock path. A lock in Swedish is accepted, and the original Swedish title can be replaced. The homepage handles this more reliably with an explicit Swedish source bypass.

**Impact:** the statement that source-language wording cannot be locked is not true for every news field. Short source headlines can also continue to receive same-language model rewrites. This is a documented detector limitation, but the new admin behavior exposes its consequence.

**Recommendation:** carry an explicit source-language policy for known CMS surfaces/fields and share it with public rendering and admin review. Handle exceptional foreign-language records deliberately. Do not change FM schema or force the detector to classify ambiguous names/song titles.

### F10. Health omits empty content, and homepage status can report incomplete blocks as filled

**Category:** admin consistency. **Confidence:** high; parser/inventory reproduction and renderer inspection.

**Location:** [admin-content.ts:37](../src/lib/admin-content.ts#L37), [homepage-copy.ts:64](../src/lib/homepage-copy.ts#L64), [index.astro:145](../src/pages/index.astro#L145).

Empty source fields are filtered out before health checks. A mapped hero block with a subject and empty message is reported as filling the hero, while the parser supplies an empty body/tagline. The homepage selects FM content based on the presence of the slot object, so those empty fields replace the built-in body/tagline. An empty news body is likewise absent from health.

**Recommendation:** separate block mapping from content completeness. Define required/optional fields for each slot; report missing required content and duplicate slot mappings. Make empty-field fallback policy explicit and show what is actually used. Keep translation waiting/damage counters separate from content completeness.

Review labels should also clarify that “site shows” is the current translation lookup result: the API does not inspect the visitor's existing edge/browser page-cache entry. Change “Show changes … now” to describe the existing propagation delay; the current success message already says “over the next few minutes.” Suggested command: `$impeccable clarify`.

### F11. Session-key storage errors escape the admin JSON error handling

**Category:** reliability/UI consistency. **Confidence:** high; reproduced.

**Location:** [admin-api.ts:92](../src/lib/admin-api.ts#L92), token verification at line 95; the action-level `try` starts only at line 97.

`issueAdminToken()` and `verifyAdminToken()` perform KV reads outside the action error handler. A signing-key KV failure rejects `handleAdmin()` instead of returning its controlled, no-store JSON error response. The browser then gets a generic response/path and provides little recovery guidance. The limiter correctly fails closed; signing-key failure needs equivalent handling.

**Recommendation:** catch issuance/verification storage errors, fail closed with 503 and a generic JSON message, and distinguish temporary authentication-service failure from “wrong password” or “preview deployment.” Add a bounded read timeout consistent with the lock-read policy.

### F13. Translation warming still collects raw homepage blocks instead of the consumed slot text

**Category:** integration/performance. **Confidence:** high; compared both callers.

**Location:** [translate-warm.mjs:479](../scripts/translate-warm.mjs#L479), [homepage-copy.ts:100](../src/lib/homepage-copy.ts#L100), [index.astro:130](../src/pages/index.astro#L130), [admin-content.ts:58](../src/lib/admin-content.ts#L58).

The warm script collects each raw homepage subject/message. The new homepage consumes separately parsed body, tagline, bridge-case and closing strings after removing Markdown syntax. Those are different source hashes. Warming a whole marked-up block does not warm its individually consumed strings.

**Impact:** prewarming can spend money on values the homepage never looks up, while the homepage still schedules missing translations within its 25-call render budget. This becomes more visible when the model upgrade starts a fresh translation generation.

**Recommendation:** derive warm jobs from the same parsed homepage inventory as runtime/admin review, at quality/plain, skipping source-language work and code-pinned overrides as appropriate. Compare expected runtime keys with collected warm keys before running the upgrade warm pass. No production warm job was run during this audit.

### F14. First-login signing-key creation can issue an immediately invalid session

**Category:** authentication reliability. **Confidence:** high; concurrent bootstrap reproduction.

**Location:** [admin-auth.ts:42](../src/lib/admin-auth.ts#L42).

When the key is absent, two authenticated logins can each read absence, generate a different key and store it. Both return successful tokens, but only the token signed with the final stored key verifies. This is most relevant at initial deployment or after deliberate key deletion. It does not allow a forged login.

**Recommendation:** provision a random stable signing key as a Worker secret, or create it atomically through a consistent authority. Preserve password-change invalidation. Do not derive it from the password. Treat a new key that has not propagated as a transient auth-service condition, not a password failure.

## Claude model recommendation: 5.5 for both tiers

The current model IDs live in [translate.ts:678](../src/lib/translate.ts#L678). Article headlines, excerpts and bodies use `fast` through `fmText()`; homepage slot text and UI chrome use `quality` through `t()`. Both tiers are also used by the warm script and the publication queue's shared guard.

| Tier | Current model | Recommended model | Typical use |
| --- | --- | --- | --- |
| Fast | `claude-haiku-4-5` | **`claude-haiku-5-5`** | News and other high-volume CMS text |
| Quality | `claude-sonnet-5` | **`claude-sonnet-5-5`** | Homepage voice and UI wording |

Anthropic documents both proposed IDs as current models. Both currently used generations remain listed as active; this is an upgrade recommendation, not a claim that the present IDs are invalid. The Haiku 4.5 date “not sooner than October 15, 2026” is a minimum support commitment, not a scheduled shutdown. [Models overview](https://platform.claude.com/docs/en/models/overview), [deprecation status](https://platform.claude.com/docs/en/about-claude/model-deprecations)

For ordinary requests below Haiku's 100,000-token prompt threshold, published base pricing per million tokens is Haiku 5.5 **$0.10 input / $0.50 output**, and Sonnet 5.5 **$2 input / $10 output**. Recalculate actual cost using new usage counts, retries, thinking and cache charges; do not infer a matching cost reduction from nominal token rates alone. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Changes to include in the upgrade

1. **Update both model IDs together**, keeping the existing fast/quality call-site assignments initially. Evaluate translation quality before changing which surfaces use each tier. The audit has not measured real 5.5 outputs.

2. **Set thinking/effort policy deliberately.** Current requests omit both settings despite a comment saying “No thinking.” Start the Haiku 5.5 evaluation at low effort; adaptive thinking is on by default, and its newer tokenizer changes token counts and output headroom. For Sonnet 5.5's simple, tool-free translation, evaluate `thinking: { type: "between_tools" }` with medium effort to avoid up-front thinking; `type: "disabled"` is rejected on that model. Do not apply one shared thinking setting to both models without checking their supported values. [Haiku 5.5 migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [Sonnet 5.5 migration](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)

3. **Keep response parsing by content-block type.** The current `.find(b => b.type === "text")` already avoids assuming the first block is text. Reevaluate the fixed 16,000-token ceiling against the longest article, and verify refusal/empty/truncated responses. Continue rejecting an unchanged source for the wrong language.

4. **Retire old machine translations deliberately.** `TRANSLATION_KEY_VERSION` is still `v1`; neither per-string keys nor bundle keys identify the model. A model-ID-only deploy keeps serving old translations for unchanged source. Use a new machine-translation generation such as `v2` for the coordinated two-tier upgrade, or include a shared model/prompt policy version in machine keys. Preserve human overrides and locks, whose source hashes need not change. A page-cache flush alone does not invalidate translation keys/bundles.

5. **Update warm jobs, metrics and pricing together.** Fix F13 before prewarming. [translate-warm.mjs:935](../scripts/translate-warm.mjs#L935) recognizes only the old IDs; after an ID-only upgrade both new IDs become `unknown`, cost prints `n/a`, and the total can omit those charges. Update tier identification and `PRICING_PER_MTOK`, and include cache read/write charges in cost reporting; the present formula only prices input/output. Centralize the model/policy metadata so runtime and scripts agree.

6. **Decide fallback behavior explicitly.** `callWithGuard()` currently switches fast→quality **and quality→fast** after rejection. A quality-key cache entry can therefore contain Haiku-generated wording. Record the actual model used, and decide whether rejected Sonnet 5.5 output should retry Sonnet, use Haiku or remain a miss. Do not describe quality→fast as escalation.

7. **Run a representative evaluation before release.** Include Swedish and English source, CR/CRLF/LF breaks, short headlines containing English song names, relative/email/telephone/reference links, images, lists, long articles, identity rejection and protected artist/division names. Compare structure, meaning, cost and completion latency. Then prewarm under the new generation, deploy and verify ordinary second visits show translations. Keep the previous generation available for rollback without deleting locks.

The next implementation release should update `VERSION` and `CHANGELOG.md` alongside the actual model/policy changes. This audit only recommends the upgrade; it does not change release numbers or execute a migration.

## Protections that should be preserved

- [admin-api.ts:61](../src/lib/admin-api.ts#L61) rejects cross-site origins before handling actions, caps request bodies at 64,000 bytes, fails closed on login limiter errors and checks a token before reading CMS content or mutating it. Existing `admin.test.mjs` covers these boundaries.
- [admin-auth.ts:35](../src/lib/admin-auth.ts#L35) uses fixed-size digest comparisons and a random signing key independent of the password. Tokens expire and incorporate the current password's hash; a password change invalidates old signatures when the new secret is in effect.
- [admin-api.ts:147](../src/lib/admin-api.ts#L147) derives editable content on the server, restricts item/string/language selection, rejects empty or oversized corrections and refuses edits to code-pinned wording. Its rendered-link comparison is useful and should become shared validation.
- [AdminLayout.astro:49](../src/layouts/AdminLayout.astro#L49) inserts CMS/editor content with `textContent`. Authenticated responses use the shared no-store JSON helper. The admin layout does not require a live FM read to render its shell.
- [markdown.ts:13](../src/lib/markdown.ts#L13) allowlists URL schemes, rejects protocol-relative/control-character forms, escapes literal HTML and attributes, and prevents a second article H1. The existing security/rendering tests exercise these protections.
- [ninetone.ts:315](../src/lib/ninetone.ts#L315) centralizes excerpt cleanup for cards, standfirsts, metadata and search consumers. `excerpt.test.mjs` checks cut URLs, literal tags, Markdown markers, whitespace and byte-preservation of clean excerpts.
- [translate.ts:222](../src/lib/translate.ts#L222) normalizes line endings at key/model seams, preserves old raw-hash overrides and keeps same-language detection ahead of cached machine rewrites for confidently classified source.
- [middleware.ts:435](../src/middleware.ts#L435) correctly stops serving stale degraded copies after their short lease. The corresponding second-visit regression test passes. This is separate from the damaged-cache issue in F03.
- Locks are primed beside route bundles and read from memory during per-string translation. Keep that batching property while fixing authoritative writes. Read failures refuse mutation rather than blindly replacing the map.

## Suggested order

1. Repair authoritative lock writes and source-revision checks: **F01, F12**.
2. Share and strengthen structure validation; reject damaged cached values: **F02, F03**.
3. Preserve editor drafts and ignore obsolete responses: **F04, F05**; use `$impeccable harden` for the UI work.
4. Apply specific labels, accessible muted text and mobile control sizing: **F06–F08**; use `$impeccable harden`, `$impeccable colorize`, `$impeccable adapt`.
5. Correct source-language policy, health completeness, auth recovery and warm inventory: **F09–F11, F13, F14**.
6. Upgrade **Haiku 5.5 and Sonnet 5.5** with the model/cache/request/metrics changes above and a bounded translation evaluation.
7. Finish with `$impeccable clarify` for status/propagation wording, then `$impeccable polish`. Re-run the focused audit and existing checks after repairs.

The repairs can be taken individually or as a coordinated change. The model upgrade should preserve manual wording and should not require changes to FileMaker's production schema.
