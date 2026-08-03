import test from "node:test";

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { setPromptNotifier, showPermissionPrompt } from "../src/ui.ts";

function stubCtx(): ExtensionContext {
  // Minimal UI stub: `custom` resolves immediately without invoking the
  // component factory, so no timer is created.
  return {
    hasUI: true,
    ui: { custom: async () => "abort" },
  } as unknown as ExtensionContext;
}

test("showPermissionPrompt fires the prompt notifier", async () => {
  let notified = 0;
  setPromptNotifier(() => {
    notified++;
  });
  try {
    const result = await showPermissionPrompt(stubCtx(), "test title");
    assert.equal(result, "abort");
    assert.equal(notified, 1);
  } finally {
    setPromptNotifier(undefined);
  }
});

test("showPermissionPrompt skips notifier when UI is unavailable", async () => {
  let notified = 0;
  setPromptNotifier(() => {
    notified++;
  });
  try {
    const ctx = stubCtx();
    ctx.hasUI = false;
    const result = await showPermissionPrompt(ctx, "test title");
    assert.equal(result, "abort");
    assert.equal(notified, 0);
  } finally {
    setPromptNotifier(undefined);
  }
});
