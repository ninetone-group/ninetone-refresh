/**
 * The scheduler handed to translate() must call the Workers ExecutionContext's
 * waitUntil AS A METHOD. workerd's host methods throw "Illegal invocation"
 * when detached from their receiver, and until 2026-09-13 waitUntilFromLocals
 * returned the bare method — so no background translation ever ran on the
 * live site, silently. Fakes built from arrow functions cannot catch that;
 * this one insists on its `this`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { waitUntilFromLocals } from "../src/lib/translate.ts";

class FakeExecutionContext {
  constructor() { this.jobs = []; }
  waitUntil(promise) {
    if (!(this instanceof FakeExecutionContext)) throw new TypeError("Illegal invocation");
    this.jobs.push(promise);
  }
}

test("waitUntilFromLocals returns a scheduler that keeps the context as `this`", async () => {
  const ctx = new FakeExecutionContext();
  const schedule = waitUntilFromLocals({ cfContext: ctx });
  assert.equal(typeof schedule, "function");
  const job = Promise.resolve("done");
  schedule(job); // would throw "Illegal invocation" with the bare method
  assert.equal(ctx.jobs.length, 1);
  assert.equal(await ctx.jobs[0], "done");
});

test("no context, or a context without waitUntil, yields no scheduler", () => {
  assert.equal(waitUntilFromLocals(undefined), undefined);
  assert.equal(waitUntilFromLocals({}), undefined);
  assert.equal(waitUntilFromLocals({ cfContext: {} }), undefined);
});
