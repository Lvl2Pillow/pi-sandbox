import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { type SandboxConfig, DEFAULT_PROMPT_TIMEOUT_SEC } from "./config.ts";
import { allowsAllDomains } from "./policy.ts";
import { type SessionAllowances } from "./sandbox-runtime.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global" | "unsandboxed";

export type PermissionResult = PermissionChoice | "timeout";

interface PromptOption {
  label: string;
  key: string;
  action: PermissionChoice;
  confirm?: boolean;
  hint?: string;
}

const PERMISSION_OPTIONS: PromptOption[] = [
  { label: "Allow for this session only", key: "s", action: "session" },
  { label: "Abort (keep blocked)", key: "esc", action: "abort" },
  {
    label: "Allow for this project",
    key: "P",
    action: "project",
    confirm: true,
    hint: "→ .pi/sandbox.json",
  },
  {
    label: "Allow for all projects",
    key: "A",
    action: "global",
    confirm: true,
    hint: "→ ~/.pi/agent/sandbox.json",
  },
];

/**
 * Run the blocked command once with default (unsandboxed) pi bash.
 * One-shot: never persisted in allowances or config, so every command re-asks.
 */
export const UNSANDBOXED_OPTION: PromptOption = {
  label: "Run once with default pi bash",
  key: "U",
  action: "unsandboxed",
  hint: "(not saved; re-asks every time)",
};

/**
 * Setuid/setgid denials have no grant path — only a one-shot unsandboxed
 * run or abort. "Run once" is first so Enter picks it.
 */
export const SETUID_OPTIONS: PromptOption[] = [
  UNSANDBOXED_OPTION,
  { label: "Abort (keep blocked)", key: "esc", action: "abort" },
];

let promptNotifier: (() => void) | undefined;

/**
 * Register a callback fired right before a permission prompt is shown.
 * The notify extension listens for `notify:alert` and rings the terminal
 * bell when the user is away, so prompts don't go unnoticed.
 */
export function setPromptNotifier(notifier: (() => void) | undefined): void {
  promptNotifier = notifier;
}

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  timeoutSec: number = DEFAULT_PROMPT_TIMEOUT_SEC,
  options: PromptOption[] = PERMISSION_OPTIONS,
): Promise<PermissionResult> {
  if (!ctx.hasUI) return "abort";
  promptNotifier?.();

  const result = await ctx.ui.custom<PermissionResult>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let pendingAction: PermissionChoice | null = null;
    let timeRemaining = timeoutSec;
    let timerInterval: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    };
    const resolve = (action: PermissionResult) => {
      stopTimer();
      done(action);
    };
    if (timeoutSec > 0) {
      timerInterval = setInterval(() => {
        timeRemaining -= 1;
        if (timeRemaining <= 0) {
          resolve("timeout");
          return;
        }
        tui.requestRender();
      }, 1000);
    }

    return {
      render(width: number): string[] {
        const timerTag = timerInterval
          ? `  ${theme.fg(timeRemaining <= 3 ? "warning" : "accent", `⏱ ${timeRemaining}s`)}`
          : "";
        const lines = [truncateToWidth(theme.fg("warning", title) + timerTag, width), ""];
        for (let i = 0; i < options.length; i++) {
          const option = options[i];
          const prefix = i === selectedIndex ? " → " : "   ";
          const keyHint = theme.fg("accent", `[${option.key}]`);
          let label = option.label;
          if (option.hint) label += `  ${theme.fg("dim", option.hint)}`;
          if (pendingAction === option.action) {
            label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
          }
          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
        }
        lines.push("");
        const footer = pendingAction
          ? "↑↓ navigate  enter confirm  esc cancel"
          : "↑↓ navigate  enter select  esc/ctrl+c cancel";
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      },
      handleInput(data: string): void {
        if (timerInterval) stopTimer();
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          resolve("abort");
          return;
        }
        if (matchesKey(data, Key.enter)) {
          resolve(pendingAction ?? PERMISSION_OPTIONS[selectedIndex]?.action ?? "abort");
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          selectedIndex = Math.max(
            0,
            Math.min(PERMISSION_OPTIONS.length - 1, selectedIndex + delta),
          );
          pendingAction = null;
          tui.requestRender();
          return;
        }
        for (let i = 0; i < options.length; i++) {
          const option = options[i];
          if (data === option.key) {
            resolve(option.action);
            return;
          }
          if (data.toLowerCase() === option.key.toLowerCase()) {
            if (option.confirm) {
              pendingAction = option.action;
              selectedIndex = i;
            } else {
              resolve(option.action);
            }
            tui.requestRender();
            return;
          }
        }
      },
      invalidate(): void {},
      dispose(): void {
        stopTimer();
      },
    };
  });

  return result ?? "abort";
}

export function promptDomainBlock(
  ctx: ExtensionContext,
  domain: string,
  timeoutSec?: number,
): Promise<PermissionResult> {
  return showPermissionPrompt(
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    timeoutSec,
  );
}

export function promptReadBlock(
  ctx: ExtensionContext,
  path: string,
  timeoutSec?: number,
): Promise<PermissionResult> {
  return showPermissionPrompt(ctx, `📖 Read blocked: "${path}" is not in allowRead`, timeoutSec);
}

/**
 * Setuid/setgid exec denial: caused by the sandbox itself (Seatbelt
 * hard-blocks setuid exec), so the one-shot unsandboxed run is the fix.
 */
export function promptSetuidBlock(
  ctx: ExtensionContext,
  path: string,
  timeoutSec?: number,
): Promise<PermissionResult> {
  return showPermissionPrompt(
    ctx,
    `⛔ Cannot execute "${path}" inside the sandbox: setuid/setgid binaries are hard-blocked`,
    timeoutSec,
    SETUID_OPTIONS,
  );
}

export function promptWriteBlock(
  ctx: ExtensionContext,
  path: string,
  timeoutSec?: number,
): Promise<PermissionResult> {
  return showPermissionPrompt(ctx, `📝 Write blocked: "${path}" is not in allowWrite`, timeoutSec);
}

export function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
  if (!allowsAllDomains(config.network?.allowedDomains)) return;
  ctx.ui.notify(
    '⚠️ Network sandbox allows all domains because network.allowedDomains contains "*". ' +
      'Only use this intentionally; remove "*" to restore per-domain prompts.',
    "warning",
  );
}

/**
 * Footer summary: 📖 read, ✏️ write, 🌐 network.
 * Reads are deny-listed at the OS level: `*` = nothing denied (all
 * readable), `-` = all denied, else count of denied regions.
 * Write/network are allow-listed: `*` = everything allowed, `-` = nothing.
 */
export function formatSandboxStatus(config: SandboxConfig): string {
  return `📖 ${summarizeDenied(config.filesystem?.denyRead)} ✏️  ${summarizeList(config.filesystem?.allowWrite)} 🌐 ${summarizeList(config.network?.allowedDomains)}`;
}

/** Deny-list summary: empty deny = all readable; `*` deny = nothing. */
function summarizeDenied(entries: string[] | undefined): string {
  if (!entries || entries.length === 0) return "*";
  if (entries.includes("*")) return "-";
  return String(entries.length);
}

function summarizeList(entries: string[] | undefined): string {
  if (!entries || entries.length === 0) return "-";
  if (entries.includes("*")) return "*";
  return String(entries.length);
}

export function formatSandboxConfiguration(
  config: SandboxConfig,
  paths: { globalPath: string; projectPath: string },
  allowances: SessionAllowances,
): string {
  return [
    "Sandbox Configuration",
    `  Project config: ${paths.projectPath}`,
    `  Global config:  ${paths.globalPath}`,
    "",
    "Network (bash + !cmd):",
    `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
    ...(allowsAllDomains(config.network?.allowedDomains)
      ? ['  ⚠️ "*" allows all domains and disables per-domain prompts.']
      : []),
    `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
    ...(allowances.domains.length ? [`  Session allowed: ${allowances.domains.join(", ")}`] : []),
    "",
    "Filesystem (bash + read/write/edit tools):",
    `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
    `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
    `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
    `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read:  ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.join(", ")}`]
      : []),
    "",
    `Sandbox user bash (!cmd/!!cmd): ${config.sandboxUserBash ? "enabled" : "disabled"}`,
    `Prompt timeout: ${config.promptTimeoutSec ?? DEFAULT_PROMPT_TIMEOUT_SEC}s (no response = blocked)`,
    "",
    "Note: ALL reads are prompted unless the path is in allowRead or allowWrite.",
    "Note: allowWrite also grants read access to the same path.",
    "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
    "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
    "Note: sandboxUserBash defaults to false — user-typed commands run unsandboxed.",
  ].join("\n");
}
