import { performance } from "node:perf_hooks";
import { createT } from "../../../src/lib/translate.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kv = {
  async get() {
    await sleep(10);
    return "cached";
  },
  async put() {},
};

const sequentialT = createT({ lang: "en" }, { kv });
const sequentialStart = performance.now();
for (let i = 0; i < 50; i += 1) {
  await sequentialT(`unique-${i}`);
}
const sequentialMs = performance.now() - sequentialStart;

const parallelT = createT({ lang: "en" }, { kv });
const parallelStart = performance.now();
await Promise.all(
  Array.from({ length: 50 }, (_, i) => parallelT(`parallel-${i}`)),
);
const parallelMs = performance.now() - parallelStart;

console.log(JSON.stringify({
  mockKvDelayMs: 10,
  calls: 50,
  sequentialMs: Number(sequentialMs.toFixed(1)),
  parallelMs: Number(parallelMs.toFixed(1)),
}));
