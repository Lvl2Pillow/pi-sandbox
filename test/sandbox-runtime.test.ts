import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
  });
  assert.equal(runtime.network?.allowedDomains?.includes("example.com"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig force-denies sandbox config paths despite allowWrite", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem,
      allowWrite: [".", "/tmp"],
      denyWrite: [],
    },
  };
  const runtime = buildRuntimeConfig(config);
  // Root-anchored glob: a bare two-star glob resolves against cwd and
  // misses configs elsewhere.
  assert.ok(runtime.filesystem?.denyWrite?.includes("/**/.pi/sandbox.json"));
  assert.ok(runtime.filesystem?.denyWrite?.includes("~/.pi/agent/sandbox.json"));
  if (process.platform === "linux") {
    // bubblewrap can't express `**` — literal fallbacks are added.
    assert.ok(
      runtime.filesystem?.denyWrite?.includes(join(homedir(), ".pi", "agent", "sandbox.json")),
    );
    assert.ok(runtime.filesystem?.denyWrite?.includes(join(process.cwd(), ".pi", "sandbox.json")));
  }
});

test("resolveAllowances makes configured and session write paths readable", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(config, {
    domains: [],
    readPaths: [],
    writePaths: ["/session-write"],
  });

  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});
