import { SandboxManager } from "@carderne/sandbox-runtime";
import {
  ExtensionContext,
  type AgentToolResult,
  type BashToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  getConfigPaths,
  loadConfig,
  type SandboxConfig,
} from "./config.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  isSandboxConfigPath,
  matchesPattern,
  shouldPromptForWrite,
} from "./policy.ts";
import {
  createSandboxedBashOps,
  extractBlockedWritePath,
  extractExitCodeFromMessage,
  initializeSandbox,
  isExecExitCode,
  isSetuidExecDenial,
  reinitializeSandbox,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./sandbox-runtime.ts";
import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionChoice,
  promptDomainBlock,
  promptReadBlock,
  promptSetuidBlock,
  promptWriteBlock,
  warnIfAllDomainsAllowed,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, {
    shellPath: userShellPath,
  });

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  const allowances: SessionAllowances = {
    domains: [],
    readPaths: [],
    writePaths: [],
  };

  const effectiveAllowances = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      await reinitializeSandbox(loadConfig(cwd), allowances);
    } catch (error) {
      console.error(`Warning: Failed to reinitialize sandbox: ${error}`);
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionChoice, "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    if (choice === "unsandboxed") return;
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    if (kind === "domain") {
      if (!allowances.domains.includes(value)) allowances.domains.push(value);
      if (choice !== "session") addDomainToConfig(target, value);
    } else if (kind === "read") {
      if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
      if (choice !== "session") addReadPathToConfig(target, value);
    } else {
      if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
      if (choice !== "session") addWritePathToConfig(target, value);
    }
    await refreshSandbox(cwd);
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    config: ReturnType<typeof loadConfig>,
  ) {
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
    config?: SandboxConfig,
  ): Promise<boolean> {
    const mergedConfig = mergeConfigs(loadConfig(ctx.cwd), config);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      await initializeSandbox(mergedConfig, allowances);
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
      warnIfAllDomainsAllowed(ctx, mergedConfig);
      updateStatus(ctx, mergedConfig);
      return true;
    } catch (error) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = () => {
        if (!sandboxEnabled || !sandboxInitialized) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        return createBashToolDefinition(localCwd, {
          operations: createSandboxedBashOps(userShellPath),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<BashToolDetails | undefined>;
      let exitCode: number | null = null;
      try {
        result = await runBash();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // Only treat it as a sandbox denial when the message contains a real
        // bash error line (`bash: <path>: Operation not permitted`).
        const blockedPath = extractBlockedWritePath(error.message);
        if (!blockedPath) throw error;
        exitCode = extractExitCodeFromMessage(error.message);
        if (isExecExitCode(exitCode) && !isSetuidExecDenial(blockedPath)) {
          // Bash found the command but could not exec it for a reason that has
          // nothing to do with the sandbox (no exec bit, wrong arch, bad
          // shebang). Surface the exact error default pi bash would produce.
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const output = (result.content as Array<{ type: string; text?: string }>)
          .filter((content) => content.type === "text")
          .map((content) => content.text ?? "")
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);

        if (blockedPath) {
          // OS-hard-denied; no grant path, so don't prompt.
          if (isSandboxConfigPath(blockedPath)) {
            return result;
          }
          // Exec denial caused by the sandbox itself: Seatbelt hard-blocks
          // setuid/setgid exec, so no write grant can ever unblock it. The
          // one-shot unsandboxed run is the only fix.
          if (isSetuidExecDenial(blockedPath)) {
            const choice = await promptSetuidBlock(
              ctx,
              blockedPath,
              loadConfig(ctx.cwd).promptTimeoutSec,
            );
            if (choice === "unsandboxed") {
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `\n--- Running once with default pi bash (unsandboxed) ---\n`,
                  },
                ],
                details: {},
              });
              return localBash.execute(id, params, signal, onUpdate, ctx);
            }
            return {
              ...result,
              content: [
                ...(result.content ?? []),
                {
                  type: "text",
                  text:
                    choice === "timeout"
                      ? `Blocked: approval for "${blockedPath}" timed out; still blocked in sandbox.`
                      : `Blocked: "${blockedPath}" is not executable in the sandbox and was not approved.`,
                },
              ],
            };
          }
          const promptTimeoutSec = loadConfig(ctx.cwd).promptTimeoutSec;
          const choice = await promptWriteBlock(ctx, blockedPath, promptTimeoutSec);
          if (choice !== "abort" && choice !== "timeout") {
            await applyChoice(choice, "write", blockedPath, ctx.cwd);
            const config = loadConfig(ctx.cwd);
            const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
            if (matchesPattern(blockedPath, config.filesystem?.denyWrite ?? [])) {
              ctx.ui.notify(
                `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                  `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
                "warning",
              );
              return result;
            }
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${blockedPath}", retrying ---\n`,
                },
              ],
              details: {},
            });
            return runBash();
          }
          if (choice === "timeout") {
            return {
              ...result,
              content: [
                ...(result.content ?? []),
                {
                  type: "text",
                  text:
                    `\n--- Write access for "${blockedPath}" was NOT granted: ` +
                    `approval timed out (${promptTimeoutSec ?? 60}s). ` +
                    `Add it to allowWrite in your sandbox config to allow it. ---`,
                },
              ],
            };
          }
        }
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    const config = loadConfig(ctx.cwd);
    if (!config.sandboxUserBash) return;

    for (const domain of extractDomainsFromCommand(event.command)) {
      if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
        const choice = await promptDomainBlock(ctx, domain, config.promptTimeoutSec);
        if (choice === "abort" || choice === "timeout") {
          return {
            result: {
              output:
                choice === "timeout"
                  ? `Blocked: approval for "${domain}" timed out; still not in allowedDomains. Use /sandbox to review.`
                  : `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice, "domain", domain, ctx.cwd);
      }
    }
    return { operations: createSandboxedBashOps(userShellPath) };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (sandboxInitialized && isToolCallEventType("bash", event)) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
          const choice = await promptDomainBlock(ctx, domain, config.promptTimeoutSec);
          if (choice === "abort" || choice === "timeout") {
            return {
              block: true,
              reason:
                choice === "timeout"
                  ? `Network access to "${domain}" was NOT granted: approval timed out.`
                  : `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyChoice(choice, "domain", domain, ctx.cwd);
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path);
      if (!matchesPattern(path, effectiveReadPaths(ctx.cwd))) {
        const choice = await promptReadBlock(ctx, path, config.promptTimeoutSec);
        if (choice === "abort" || choice === "timeout") {
          return {
            block: true,
            reason:
              choice === "timeout"
                ? `Sandbox: read access for "${path}" was NOT granted: approval timed out.`
                : `Sandbox: read access denied for "${path}"`,
          };
        }
        await applyChoice(choice, "read", path, ctx.cwd);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path);
      // Hard-denied before every other rule: sandbox config files are
      // never writable via tools. The OS layer applies the same deny.
      if (isSandboxConfigPath(path)) {
        return {
          block: true,
          reason: `Sandbox: write to sandbox config "${path}" is not permitted.`,
        };
      }
      const denyWrite = config.filesystem?.denyWrite ?? [];
      if (matchesPattern(path, denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
      if (shouldPromptForWrite(path, effectiveWritePaths(ctx.cwd), matchesPattern)) {
        const choice = await promptWriteBlock(ctx, path, config.promptTimeoutSec);
        if (choice === "abort" || choice === "timeout") {
          return {
            block: true,
            reason:
              choice === "timeout"
                ? `Sandbox: write access for "${path}" was NOT granted: approval timed out.`
                : `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyChoice(choice, "write", path, ctx.cwd);
        return;
      }
    }
  });

  // Stored ctx for event-triggered enable/disable
  let _sandboxCtx: ExtensionContext | null = null;

  pi.on("session_start", async (_event, ctx) => {
    _sandboxCtx = ctx;
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!loadConfig(ctx.cwd).enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  function mergeConfigs(base: SandboxConfig, override?: Partial<SandboxConfig>): SandboxConfig {
    if (override === undefined) {
      return base;
    }
    return {
      ...base,
      ...override,
      network: override.network ? { ...base.network, ...override.network } : base.network,
      filesystem: override.filesystem
        ? { ...base.filesystem, ...override.filesystem }
        : base.filesystem,
    };
  }

  async function doEnable(
    ctx: Parameters<typeof enableSandbox>[0],
    config?: SandboxConfig,
  ): Promise<void> {
    if (sandboxEnabled) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false, config)) ctx.ui.notify("Sandbox enabled", "info");
  }

  async function doDisable(ctx: Parameters<typeof enableSandbox>[0]): Promise<void> {
    if (!sandboxEnabled) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return;
    }
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    ctx.ui.setStatus("sandbox", "");
    ctx.ui.notify("Sandbox disabled", "info");
  }

  // Cross-extension events for external enable/disable requests
  pi.events.on("pi-sandbox:enable", (data) => {
    if (_sandboxCtx) {
      const d = data as { config: SandboxConfig } | undefined;
      doEnable(_sandboxCtx, d?.config);
    }
  });

  pi.events.on("pi-sandbox:disable", () => {
    if (_sandboxCtx) doDisable(_sandboxCtx);
  });

  pi.on("session_shutdown", async () => {
    if (!sandboxInitialized) return;
    try {
      await SandboxManager.reset();
    } catch {
      // Ignore cleanup errors.
    }
  });

  pi.registerCommand("sandbox", {
    description:
      "Show sandbox configuration. Use `/sandbox enable` or `/sandbox disable` to toggle.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "enable") {
        await doEnable(ctx);
        return;
      }
      if (arg === "disable") {
        await doDisable(ctx);
        return;
      }

      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled. Use `/sandbox enable` to turn on.", "info");
        return;
      }
      ctx.ui.notify(
        formatSandboxConfiguration(loadConfig(ctx.cwd), getConfigPaths(ctx.cwd), allowances),
        "info",
      );
    },
  });
}
