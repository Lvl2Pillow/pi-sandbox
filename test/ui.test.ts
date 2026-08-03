import test from "node:test";

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import { setPromptNotifier, showPermissionPrompt, formatSandboxStatus } from "../src/ui.ts";

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

function configWith(partial: {
  denyRead?: string[];
  allowWrite?: string[];
  allowedDomains?: string[];
}) {
  return {
    filesystem: { denyRead: partial.denyRead, allowWrite: partial.allowWrite },
    network: { allowedDomains: partial.allowedDomains },
  } as Parameters<typeof formatSandboxStatus>[0];
}

test("formatSandboxStatus with no config or allowances", () => {
  // Read `*` (all readable) and any `*` section are omitted as noise.
  assert.equal(formatSandboxStatus(configWith({})), "✏️  - 🌐 -");
});

test("formatSandboxStatus counts config entries without session allowances", () => {
  assert.equal(
    formatSandboxStatus(
      configWith({ denyRead: ["/a", "/b"], allowWrite: ["/w"], allowedDomains: ["x.com"] }),
    ),
    "📖 2 ✏️  1 🌐 1",
  );
});

test("formatSandboxStatus folds session write paths into the write count", () => {
  const status = formatSandboxStatus(configWith({ allowWrite: ["/w"] }), {
    domains: [],
    readPaths: [],
    writePaths: ["/session-w"],
  });
  assert.equal(status, "✏️  2 🌐 -");
});

test("formatSandboxStatus folds session domains into the network count", () => {
  const status = formatSandboxStatus(configWith({ allowedDomains: ["x.com"] }), {
    domains: ["y.com"],
    readPaths: [],
    writePaths: [],
  });
  assert.equal(status, "✏️  - 🌐 2");
});

test("formatSandboxStatus dedupes session grants against config entries", () => {
  const status = formatSandboxStatus(
    configWith({ allowWrite: ["/w"], allowedDomains: ["x.com"] }),
    {
      domains: ["x.com"],
      readPaths: [],
      writePaths: ["/w"],
    },
  );
  assert.equal(status, "✏️  1 🌐 1");
});

test("formatSandboxStatus read grant neutralizes matching denyRead entry", () => {
  const status = formatSandboxStatus(configWith({ denyRead: ["/secret"] }), {
    domains: [],
    readPaths: ["/secret"],
    writePaths: [],
  });
  assert.equal(status, "✏️  - 🌐 -");
});

test("formatSandboxStatus read grant neutralizes parent denyRead entry", () => {
  const status = formatSandboxStatus(configWith({ denyRead: ["/a/b"] }), {
    domains: [],
    readPaths: ["/a"],
    writePaths: [],
  });
  assert.equal(status, "✏️  - 🌐 -");
});

test("formatSandboxStatus read grant neutralizes glob denyRead entry", () => {
  const status = formatSandboxStatus(configWith({ denyRead: ["/private/tmp/**"] }), {
    domains: [],
    readPaths: ["/private/tmp/x"],
    writePaths: [],
  });
  assert.equal(status, "✏️  - 🌐 -");
});

test("formatSandboxStatus keeps denyRead entries not covered by grants", () => {
  const status = formatSandboxStatus(configWith({ denyRead: ["/secret", "/other"] }), {
    domains: [],
    readPaths: ["/secret"],
    writePaths: [],
  });
  assert.equal(status, "📖 1 ✏️  - 🌐 -");
});

test("formatSandboxStatus treats denyRead '*' as everything denied", () => {
  const status = formatSandboxStatus(configWith({ denyRead: ["*"] }), {
    domains: [],
    readPaths: ["/secret"],
    writePaths: [],
  });
  assert.equal(status, "📖 - ✏️  - 🌐 -");
});

test("formatSandboxStatus omits '*' write and network sections", () => {
  const status = formatSandboxStatus(configWith({ allowWrite: ["*"], allowedDomains: ["*"] }), {
    domains: [],
    readPaths: [],
    writePaths: [],
  });
  assert.equal(status, "");
});
