import { AsyncLocalStorage } from "node:async_hooks";

type Sample = { start: number; end: number };
type Metric = { count: number; samples: Sample[] };
type TimingStore = Map<string, Metric>;

const requestTimings = new AsyncLocalStorage<TimingStore>();

function record(name: string, start: number, end: number): void {
  const store = requestTimings.getStore();
  if (!store) return;
  const metric = store.get(name) ?? { count: 0, samples: [] };
  metric.count += 1;
  metric.samples.push({ start, end });
  store.set(name, metric);
}

export async function timeServer<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    record(name, start, performance.now());
  }
}

function elapsed(samples: Sample[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const sample of sorted.slice(1)) {
    if (sample.start <= end) end = Math.max(end, sample.end);
    else {
      total += end - start;
      start = sample.start;
      end = sample.end;
    }
  }
  return total + end - start;
}

function header(store: TimingStore): string {
  return [...store.entries()].map(([name, metric]) => {
    const sum = metric.samples.reduce((total, sample) => total + sample.end - sample.start, 0);
    return `${name};dur=${elapsed(metric.samples).toFixed(1)};desc="n=${metric.count} sum=${sum.toFixed(1)}ms"`;
  }).join(", ");
}

export async function withServerTiming(work: () => Promise<Response>): Promise<Response> {
  // Astro rewrites re-enter middleware in the same async scope. The outer
  // invocation owns the header so the inner render's samples are retained.
  if (requestTimings.getStore()) return work();
  const store: TimingStore = new Map();
  const response = await requestTimings.run(store, work);
  const annotated = new Response(response.body, response);
  // set() replaces a header from a cached response, so timings cannot go stale.
  annotated.headers.set("Server-Timing", header(store));
  return annotated;
}
