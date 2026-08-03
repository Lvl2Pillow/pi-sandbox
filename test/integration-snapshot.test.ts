import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

// The sandbox masks TMPDIR (/tmp/claude credential store) — symlinks there
// fail with EPERM. Fall back to /tmp for temp dirs.
function tmpRoot(): string {
  const t = tmpdir();
  return t.includes("/claude") ? "/tmp" : t;
}

type SandboxCall = ["initialize", unknown] | ["reset"];

const sandboxCalls: SandboxCall[] = [];

/** Stub the OS-level sandbox so tests exercise handler logic only. */
function stubSandboxManager(): void {
  mock.method(SandboxManager, "initialize", ((config?: unknown) => {
    sandboxCalls.push(["initialize", config]);
    return Promise.resolve();
  }) as unknown as typeof SandboxManager.initialize);
  mock.method(SandboxManager, "reset", (async () => {
    sandboxCalls.push(["reset"]);
  }) as unknown as typeof SandboxManager.reset);
}

afterEach(() => {
  mock.restoreAll();
  sandboxCalls.length = 0;
});

interface MockPi {
  pi: ExtensionAPI;
  handlers: Record<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
  crossHandlers: Record<string, Array<(data?: unknown) => unknown>>;
}

function makeMockPi(): MockPi {
  const handlers: MockPi["handlers"] = {};
  const crossHandlers: MockPi["crossHandlers"] = {};
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, fn: (event?: unknown, ctx?: unknown) => unknown) => {
      (handlers[name] ??= []).push(fn);
    },
    events: {
      on: (name: string, fn: (data?: unknown) => unknown) => {
        (crossHandlers[name] ??= []).push(fn);
      },
      emit: () => {},
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, crossHandlers };
}

function makeCtx(cwd: string, notifies: string[]): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: (message: string) => notifies.push(message),
      setStatus: () => {},
      theme: { fg: (_name: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
}

/** Fire a captured handler and let its fire-and-forget async chain settle. */
async function fire(
  fn: ((...args: unknown[]) => unknown) | undefined,
  ...args: unknown[]
): Promise<void> {
  assert.ok(fn, "handler not registered");
  fn(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** SandboxManager.initialize configs in call order. */
function initializedConfigs(): unknown[] {
  return sandboxCalls.filter((c) => c[0] === "initialize").map((c) => c[1]);
}

function allowWriteOf(call: unknown): unknown {
  return (call as { filesystem?: { allowWrite?: unknown } }).filesystem?.allowWrite;
}

const RESTRICTED_CONFIG = { filesystem: { allowWrite: [] } };

test("enable snapshots the current config and reinitializes with the restricted config", async () => {
  stubSandboxManager();
  const { pi, handlers, crossHandlers } = makeMockPi();
  const notifies: string[] = [];
  const ctx = makeCtx(mkdtempSync(join(tmpRoot(), "pi-sandbox-test-")), notifies);

  const { default: createExtension } = await import("../src/extension.ts");
  createExtension(pi);

  // session start: sandbox enabled with the loaded (default) config
  await fire(handlers["session_start"]?.[0], {}, ctx);
  assert.equal(sandboxCalls.length, 1);

  // plan-mode ON: enable with the restricted config
  await fire(crossHandlers["pi-sandbox:enable"]?.[0], { config: RESTRICTED_CONFIG });

  // reinit path: reset then initialize with the restricted config
  assert.deepEqual(
    sandboxCalls.map((c) => c[0]),
    ["initialize", "reset", "initialize"],
  );
  assert.deepEqual(allowWriteOf(initializedConfigs().at(-1)), []);
  assert.ok(notifies.includes("Sandbox enabled"));
});

test("disable restores the pre-enable config instead of fully disabling", async () => {
  stubSandboxManager();
  const { pi, handlers, crossHandlers } = makeMockPi();
  const notifies: string[] = [];
  const ctx = makeCtx(mkdtempSync(join(tmpRoot(), "pi-sandbox-test-")), notifies);

  const { default: createExtension } = await import("../src/extension.ts");
  createExtension(pi);

  await fire(handlers["session_start"]?.[0], {}, ctx);
  await fire(crossHandlers["pi-sandbox:enable"]?.[0], { config: RESTRICTED_CONFIG });
  assert.deepEqual(allowWriteOf(initializedConfigs().at(-1)), []);

  // plan-mode OFF: disable → restore the snapshot, not a full disable
  await fire(crossHandlers["pi-sandbox:disable"]?.[0]);

  const configs = initializedConfigs();
  assert.equal(configs.length, 3);
  const restored = allowWriteOf(configs.at(-1));
  assert.ok(Array.isArray(restored) && restored.length > 0, "restored allowWrite is non-empty");
  assert.notDeepEqual(restored, []);
  assert.ok(!notifies.includes("Sandbox disabled"));
});

test("disable without a matching enable falls back to full disable", async () => {
  stubSandboxManager();
  const { pi, handlers, crossHandlers } = makeMockPi();
  const notifies: string[] = [];
  const ctx = makeCtx(mkdtempSync(join(tmpRoot(), "pi-sandbox-test-")), notifies);

  const { default: createExtension } = await import("../src/extension.ts");
  createExtension(pi);

  await fire(handlers["session_start"]?.[0], {}, ctx);

  // No prior pi-sandbox:enable — this disable fully disables the sandbox.
  await fire(crossHandlers["pi-sandbox:disable"]?.[0]);

  assert.ok(notifies.includes("Sandbox disabled"));
  assert.deepEqual(
    sandboxCalls.map((c) => c[0]),
    ["initialize", "reset"],
  );
});

test("nested enables restore in reverse order (LIFO)", async () => {
  stubSandboxManager();
  const { pi, handlers, crossHandlers } = makeMockPi();
  const notifies: string[] = [];
  const ctx = makeCtx(mkdtempSync(join(tmpRoot(), "pi-sandbox-test-")), notifies);

  const { default: createExtension } = await import("../src/extension.ts");
  createExtension(pi);

  await fire(handlers["session_start"]?.[0], {}, ctx);
  await fire(crossHandlers["pi-sandbox:enable"]?.[0], {
    config: { filesystem: { allowWrite: ["/custom-a"] } },
  });
  await fire(crossHandlers["pi-sandbox:enable"]?.[0], {
    config: { filesystem: { allowWrite: ["/custom-b"] } },
  });

  // Disable restores the most recent pre-enable config (custom-a), then the
  // original loaded config.
  await fire(crossHandlers["pi-sandbox:disable"]?.[0]);
  assert.deepEqual(allowWriteOf(initializedConfigs().at(-1)), ["/custom-a"]);

  await fire(crossHandlers["pi-sandbox:disable"]?.[0]);
  const last = allowWriteOf(initializedConfigs().at(-1));
  assert.ok(
    Array.isArray(last) && last.length > 0 && !last.includes("/custom-a"),
    "restored the loaded config",
  );
  assert.ok(!notifies.includes("Sandbox disabled"));
});
