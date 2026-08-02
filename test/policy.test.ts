import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  isSandboxConfigPath,
  matchesPattern,
  shouldPromptForWrite,
} from "../src/policy.ts";

// The sandbox masks TMPDIR (/tmp/claude credential store) — symlinks there
// fail with EPERM. Fall back to /tmp for temp dirs.
function tmpRoot(): string {
  const t = tmpdir();
  return t.includes("/claude") ? "/tmp" : t;
}

test("extracts and deduplicates literal HTTP domains", () => {
  assert.deepEqual(
    extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b"),
    ["api.example.com"],
  );
});

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("empty allowWrite prompts securely", () => {
  assert.equal(shouldPromptForWrite("/tmp/file", [], matchesPattern), true);
  assert.equal(shouldPromptForWrite("/tmp/file", ["/tmp"], matchesPattern), false);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpRoot(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpRoot(), "pi-sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});

test("canonicalizes paths with env var expansion", () => {
  const dir = mkdtempSync(join(tmpRoot(), "pi-sandbox-envvar-"));
  mkdirSync(join(dir, "sub"));
  process.env.TEST_PI_SANDBOX_DIR = dir;
  try {
    assert.equal(canonicalizePath("$TEST_PI_SANDBOX_DIR/sub"), canonicalizePath(join(dir, "sub")));
  } finally {
    delete process.env.TEST_PI_SANDBOX_DIR;
  }
});

test("canonicalizes paths with ~ expansion", () => {
  const home = process.env.HOME!;
  assert.ok(canonicalizePath("~/tmp").startsWith(canonicalizePath(home)));
});

test("isSandboxConfigPath matches any .pi/sandbox.json at any depth", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpRoot(), "pi-sandbox-configpath-")));
  const globalPath = join(root, ".pi", "agent", "sandbox.json");
  const projectPath = join(root, "proj", ".pi", "sandbox.json");
  // exact global + project paths
  assert.equal(isSandboxConfigPath(projectPath), true);
  assert.equal(isSandboxConfigPath(globalPath), true);
  // location-independent: config planted in any directory is still caught
  assert.equal(isSandboxConfigPath(join(root, "evil", ".pi", "sandbox.json")), true);
  assert.equal(
    isSandboxConfigPath(join(root, "a", "b", "c", ".pi", "agent", "sandbox.json")),
    true,
  );
  // non-config files / near-misses are not
  assert.equal(isSandboxConfigPath(join(root, "other.json")), false);
  assert.equal(isSandboxConfigPath(join(root, "proj", ".pi", "sandbox.json.bak")), false);
  assert.equal(isSandboxConfigPath(join(root, "proj", ".pi", "sandbox.json", "child")), false);
  assert.equal(isSandboxConfigPath(join(root, "proj", ".pi", "other.json")), false);
});

test("isSandboxConfigPath catches symlinks planted at the config path", () => {
  const root = mkdtempSync(join(tmpRoot(), "pi-sandbox-configpath-link-"));
  const dir = join(root, ".pi");
  mkdirSync(dir, { recursive: true });
  const real = join(root, "real.json");
  const link = join(dir, "sandbox.json");
  writeFileSync(real, "{}");
  try {
    symlinkSync(real, link);
  } catch (error) {
    // The OS-level sandbox denies planting a symlink at a config path —
    // that denial is the protection this test targets.
    const message = (error as NodeJS.ErrnoException).message ?? "";
    assert.match(message, /EPERM|Operation not permitted/);
    return;
  }
  assert.equal(isSandboxConfigPath(link), true);
  // a symlink to a non-config name is not a config path
  const other = join(root, "link.json");
  symlinkSync(real, other);
  assert.equal(isSandboxConfigPath(other), false);
});
