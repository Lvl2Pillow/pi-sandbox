import test from "node:test";

import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_PROMPT_TIMEOUT_SEC,
  mergeConfigLayers,
  resolvePromptTimeoutSec,
} from "../src/config.ts";

test("resolvePromptTimeoutSec", () => {
  assert.equal(resolvePromptTimeoutSec(undefined), DEFAULT_PROMPT_TIMEOUT_SEC);
  assert.equal(resolvePromptTimeoutSec(30), 30);
  assert.equal(resolvePromptTimeoutSec(0), 0);
  assert.equal(resolvePromptTimeoutSec(-1), DEFAULT_PROMPT_TIMEOUT_SEC);
  assert.equal(resolvePromptTimeoutSec("30"), DEFAULT_PROMPT_TIMEOUT_SEC);
  assert.equal(resolvePromptTimeoutSec(NaN), DEFAULT_PROMPT_TIMEOUT_SEC);
  assert.equal(resolvePromptTimeoutSec(Infinity), DEFAULT_PROMPT_TIMEOUT_SEC);
});

test("mergeConfigLayers resolves promptTimeoutSec", () => {
  const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, { promptTimeoutSec: 120 });
  assert.equal(merged.promptTimeoutSec, 120);
});

test("mergeConfigLayers falls back to default for invalid promptTimeoutSec", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { promptTimeoutSec: "fast" as unknown as number },
    {},
  );
  assert.equal(merged.promptTimeoutSec, DEFAULT_PROMPT_TIMEOUT_SEC);
});
