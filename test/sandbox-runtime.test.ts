import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  buildRuntimeConfig,
  extractBlockedWritePath,
  extractExitCodeFromMessage,
  isExecExitCode,
  isSetuidExecDenial,
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

test("extractBlockedWritePath does not false-positive on command output", () => {
  // Command output that merely echoes the words — not a bash error line.
  assert.equal(extractBlockedWritePath('grep: "Operation not permitted"; exit 5'), null);
  assert.equal(extractBlockedWritePath("echo Operation not permitted"), null);
  // Non-bash shell prefix is not matched (also guards against "zsh"/"crash"
  // containing "sh" as a substring).
  assert.equal(extractBlockedWritePath("zsh: /bin/ps: Operation not permitted"), null);
  assert.equal(extractBlockedWritePath("crash: /bin/ps: Operation not permitted"), null);
  // Bash error line with a different errno text is not matched.
  assert.equal(extractBlockedWritePath("bash: /bin/ps: Permission denied"), null);
});

test("extractExitCodeFromMessage parses bash tool exit code", () => {
  assert.equal(
    extractExitCodeFromMessage(
      "/bin/bash: /bin/ps: Operation not permitted\n\nCommand exited with code 126",
    ),
    126,
  );
  assert.equal(extractExitCodeFromMessage("no exit code here"), null);
});

test("extractExitCodeFromMessage uses pi's final status line, not output lookalikes", () => {
  // Output echoing the phrase must not shadow pi's appended status.
  const msg =
    'echo "Command exited with code 5"\nCommand exited with code 5\n\nCommand exited with code 126';
  assert.equal(extractExitCodeFromMessage(msg), 126);
});

test("isExecExitCode flags only 126/127", () => {
  assert.equal(isExecExitCode(126), true);
  assert.equal(isExecExitCode(127), true);
  assert.equal(isExecExitCode(1), false);
  assert.equal(isExecExitCode(null), false);
});

test("isSetuidExecDenial detects setuid/setgid binaries", () => {
  if (process.platform !== "darwin") {
    // setuid system binaries are macOS-specific; skip elsewhere.
    return;
  }
  // /bin/ps is setuid root on macOS.
  assert.equal(isSetuidExecDenial("/bin/ps"), true);
  // /bin/date is not setuid.
  assert.equal(isSetuidExecDenial("/bin/date"), false);
  assert.equal(isSetuidExecDenial("/nonexistent/path"), false);
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});
