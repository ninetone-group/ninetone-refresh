/**
 * Translation queue consumer — the only place in the publication flow that
 * spends money.
 *
 * Everything external is injected (`translateFn`, `cache`, `coordinator`,
 * `sleep`), so every rule below — cache-before-spend, protected names,
 * retry/backoff, duplicate handling — is testable against a fake provider with
 * no network, no bindings, and no translation calls.
 *
 * THE RULE THAT MATTERS MOST: CHECK THE CACHE BEFORE CALLING THE MODEL.
 *
 * The translation cache is keyed on `sha256(source text)` per target and tier
 * (src/lib/translate.ts), NOT on record identity or status. So the same text
 * is the same entry no matter which record carries it or which section that
 * record currently sits in. Moving an artist Active -> Previous -> Active must
 * therefore cost nothing: the text never changed, so the key never changed,
 * so the entry is already there.
 *
 * That is only true if the consumer actually looks. A consumer that translated
 * whatever it was handed would re-pay for every status flip and every
 * redelivery, and the queue redelivers by design. `processJob` looks first and
 * reports `reused` so the saving is observable rather than assumed.
 *
 * PROTECTED NAMES ARE POPULATED HERE. `jobsForRecord()` leaves `protect` empty
 * because it has no access to entity names; the consumer fills it from the
 * record in scope plus the fixed list, via translate.ts's own
 * `buildProtectedTerms`. Doing it at the call site rather than in the contract
 * keeps the contracts module free of FM knowledge.
 */

import type { TranslationJob } from "./contracts.ts";

export interface TranslationCache {
  /** Returns the cached translation for a key, or null. */
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ConsumerDeps {
  readonly cache: TranslationCache;
  /** Computes the cache key. Inject translate.ts's translationKey in production. */
  readonly keyFor: (source: string, target: string, tier: string) => Promise<string>;
  /**
   * Performs the actual translation. Inject translate.ts's callWithGuard.
   * Returns null when the output contract rejects the result, which the
   * consumer treats as a failure rather than caching bad text.
   */
  readonly translateFn: (args: {
    text: string;
    target: string;
    tier: string;
    kind: string;
    protect: readonly string[];
  }) => Promise<string | null>;
  /** Source text for a job. Separate so the consumer never re-reads FM itself. */
  readonly sourceFor: (job: TranslationJob) => Promise<string | null>;
  /** Names that must survive translation, for this job's entity. */
  readonly protectFor?: (job: TranslationJob) => Promise<readonly string[]>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export type JobOutcome =
  | { readonly status: "reused"; readonly key: string }
  | { readonly status: "translated"; readonly key: string; readonly calls: number }
  | { readonly status: "failed"; readonly reason: string; readonly calls: number }
  | { readonly status: "skipped"; readonly reason: "no-source" };

/** Retry schedule for transient provider failures. Exponential, bounded. */
export const RETRY_DELAYS_MS = [500, 2000, 8000] as const;

/**
 * Process one job.
 *
 * Order is deliberate and is the whole point: resolve the key, LOOK IN THE
 * CACHE, and only call the model on a genuine miss.
 */
export async function processJob(deps: ConsumerDeps, job: TranslationJob): Promise<JobOutcome> {
  const source = await deps.sourceFor(job);
  if (!source || !source.trim()) return { status: "skipped", reason: "no-source" };

  const key = await deps.keyFor(source.trim(), job.target, job.tier);

  // CACHE FIRST. A hit costs nothing and is the common case for a status
  // change, a redelivery, or any text that appears on more than one record.
  const cached = await deps.cache.get(key);
  if (cached !== null) return { status: "reused", key };

  const protect = deps.protectFor ? await deps.protectFor(job) : job.protect;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let calls = 0;
  let lastError = "unknown";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      calls += 1;
      const text = await deps.translateFn({
        text: source.trim(),
        target: job.target,
        tier: job.tier,
        kind: job.kind,
        protect,
      });

      if (text === null) {
        // The output-contract guard rejected it. Retrying an identical request
        // is unlikely to help and caching it would poison a permanent entry,
        // so fail rather than store.
        return { status: "failed", reason: "output-contract", calls };
      }

      await deps.cache.put(key, text);
      return { status: "translated", key, calls };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  return { status: "failed", reason: lastError, calls };
}

export interface BatchResult {
  readonly reused: number;
  readonly translated: number;
  readonly failed: number;
  readonly skipped: number;
  /** Total model calls actually made. Zero for an all-cached batch. */
  readonly calls: number;
  /** Jobs that exhausted retries — these go to the dead-letter queue. */
  readonly deadLettered: readonly TranslationJob[];
}

/**
 * Process a batch with bounded concurrency.
 *
 * Bounded because an unbounded fan-out is how a large first scan turns into a
 * rate-limit wall and an unpredictable bill. Four matches the warm script's
 * concurrency, which ran 10,000 jobs without hitting provider limits.
 */
export const CONSUMER_CONCURRENCY = 4;

export async function processBatch(
  deps: ConsumerDeps,
  jobs: readonly TranslationJob[],
  concurrency: number = CONSUMER_CONCURRENCY,
): Promise<BatchResult> {
  let reused = 0;
  let translated = 0;
  let failed = 0;
  let skipped = 0;
  let calls = 0;
  const deadLettered: TranslationJob[] = [];

  let index = 0;
  async function worker(): Promise<void> {
    while (index < jobs.length) {
      const job = jobs[index++];
      const outcome = await processJob(deps, job);
      switch (outcome.status) {
        case "reused":
          reused += 1;
          break;
        case "translated":
          translated += 1;
          calls += outcome.calls;
          break;
        case "failed":
          failed += 1;
          calls += outcome.calls;
          deadLettered.push(job);
          break;
        case "skipped":
          skipped += 1;
          break;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  return { reused, translated, failed, skipped, calls, deadLettered };
}

/**
 * Estimate what a batch WOULD cost, without calling the model.
 *
 * This is the bootstrap dry run: it resolves every key and checks the cache,
 * so the returned count is the number of genuine misses rather than a guess.
 * Token and cost figures are approximations from source length and are labelled
 * as such — the real numbers come from the provider's own usage fields on a
 * live run, which is why the warm script prints measured usage rather than an
 * estimate.
 */
export interface DryRunEstimate {
  readonly jobs: number;
  readonly cached: number;
  readonly missing: number;
  readonly sourceChars: number;
  readonly missingByTier: Readonly<Record<string, number>>;
}

export async function dryRun(
  deps: Pick<ConsumerDeps, "cache" | "keyFor" | "sourceFor">,
  jobs: readonly TranslationJob[],
): Promise<DryRunEstimate> {
  let cached = 0;
  let missing = 0;
  let sourceChars = 0;
  const missingByTier: Record<string, number> = {};

  for (const job of jobs) {
    const source = await deps.sourceFor(job);
    if (!source || !source.trim()) continue;
    const key = await deps.keyFor(source.trim(), job.target, job.tier);
    if ((await deps.cache.get(key)) !== null) {
      cached += 1;
      continue;
    }
    missing += 1;
    sourceChars += source.trim().length;
    missingByTier[job.tier] = (missingByTier[job.tier] ?? 0) + 1;
  }

  return { jobs: jobs.length, cached, missing, sourceChars, missingByTier };
}
