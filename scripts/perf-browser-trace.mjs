/**
 * Bounded, read-only Chrome DevTools Protocol capture for public staging pages.
 * Usage: node scripts/perf-browser-trace.mjs http://127.0.0.1:9223
 */
import WebSocket from "ws";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9223";
const targets = [
  "https://ninetone-site.ninetone.workers.dev/",
  "https://ninetone-site.ninetone.workers.dev/en",
  "https://ninetone-site.ninetone.workers.dev/records/artists/previous",
];

// The `/json/version` WebSocket accepts Browser-domain commands only. Attach
// directly to the initial blank page target so Network/Page/Performance CDP
// commands work without session multiplexing.
const pages = await fetch(`${endpoint}/json/list`).then((r) => r.json());
const page = pages.find((target) => target.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("No inspectable page target from Chrome");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let nextId = 0;
const pending = new Map();
const events = [];
ws.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.id) {
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    message.error ? wait.reject(new Error(message.error.message)) : wait.resolve(message.result);
    return;
  }
  events.push(message);
});
function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventAfter(method, mark) {
  for (;;) {
    const candidate = events.slice(mark).find((event) => event.method === method);
    if (candidate) return candidate;
    await delay(25);
  }
}

await send("Network.enable");
await send("Page.enable");
await send("Performance.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__ninetoneLcp = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__ninetoneLcp.push({
          startTime: entry.startTime,
          renderTime: entry.renderTime,
          loadTime: entry.loadTime,
          size: entry.size,
          url: entry.url,
          element: entry.element?.tagName || null,
          id: entry.id || null,
        });
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  `,
});

const captures = [];
for (const url of targets) {
  const mark = events.length;
  await send("Page.navigate", { url });
  await eventAfter("Page.loadEventFired", mark);
  await delay(3500);
  const dom = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      domNodes: document.getElementsByTagName('*').length,
      links: document.links.length,
      images: document.images.length,
      imageSources: [...document.images].map((i) => i.currentSrc || i.src),
      lcp: window.__ninetoneLcp || [],
      resourceTiming: performance.getEntriesByType('resource').map((r) => ({
        name: r.name, initiatorType: r.initiatorType, transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize,
        startTime: r.startTime, responseEnd: r.responseEnd, duration: r.duration,
      })),
    })`,
    returnByValue: true,
  });
  const metrics = await send("Performance.getMetrics");
  const messages = events.slice(mark);
  const documentResponse = messages.find(
    (event) => event.method === "Network.responseReceived" && event.params.type === "Document",
  );
  const failures = messages
    .filter((event) => event.method === "Network.loadingFailed")
    .map((event) => ({ errorText: event.params.errorText, type: event.params.type }));
  captures.push({
    url,
    documentResponse: documentResponse && {
      status: documentResponse.params.response.status,
      protocol: documentResponse.params.response.protocol,
      timing: documentResponse.params.response.timing,
      headers: documentResponse.params.response.headers,
    },
    dom: JSON.parse(dom.result.value),
    metrics: Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value])),
    failures,
  });
}
console.log(JSON.stringify(captures, null, 2));
ws.close();
