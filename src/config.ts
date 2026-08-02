import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network"> & {
  enabled?: boolean;
  sandboxUserBash?: boolean;
  promptTimeoutSec?: number;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PROMPT_TIMEOUT_SEC = 60;

export function resolvePromptTimeoutSec(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_PROMPT_TIMEOUT_SEC;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sandboxUserBash: false,
  promptTimeoutSec: DEFAULT_PROMPT_TIMEOUT_SEC,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
    allowedDomains: ["*"],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: [],
    allowRead: [".", "~/.agents", "~/**/.agents"],
    allowWrite: [".", "/tmp", "/private/tmp", "$TMPDIR"],
    denyWrite: [],
  },
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  return {
    ...base,
    ...overrides,
    network: overrides.network
      ? ({ ...base.network, ...overrides.network } as NetworkConfig)
      : base.network,
    filesystem: overrides.filesystem
      ? { ...base.filesystem, ...overrides.filesystem }
      : base.filesystem,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function mergeConfiguredArray(
  fallback: string[] | undefined,
  globalValue: unknown,
  projectValue: unknown,
): string[] | undefined {
  const globalEntries = stringArray(globalValue);
  const projectEntries = stringArray(projectValue);
  if (globalEntries === undefined && projectEntries === undefined) return fallback;
  return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);

  return {
    ...merged,
    promptTimeoutSec: resolvePromptTimeoutSec(merged.promptTimeoutSec),
    network: {
      ...merged.network,
      allowedDomains:
        mergeConfiguredArray(
          defaults.network?.allowedDomains,
          globalConfig.network?.allowedDomains,
          projectConfig.network?.allowedDomains,
        ) ?? [],
      deniedDomains:
        mergeConfiguredArray(
          defaults.network?.deniedDomains,
          globalConfig.network?.deniedDomains,
          projectConfig.network?.deniedDomains,
        ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaults.network?.allowUnixSockets,
        globalConfig.network?.allowUnixSockets,
        projectConfig.network?.allowUnixSockets,
      ),
      allowMachLookup: mergeConfiguredArray(
        defaults.network?.allowMachLookup,
        globalConfig.network?.allowMachLookup,
        projectConfig.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        mergeConfiguredArray(
          defaults.filesystem?.denyRead,
          globalConfig.filesystem?.denyRead,
          projectConfig.filesystem?.denyRead,
        ) ?? [],
      allowRead: mergeConfiguredArray(
        defaults.filesystem?.allowRead,
        globalConfig.filesystem?.allowRead,
        projectConfig.filesystem?.allowRead,
      ),
      allowWrite:
        mergeConfiguredArray(
          defaults.filesystem?.allowWrite,
          globalConfig.filesystem?.allowWrite,
          projectConfig.filesystem?.allowWrite,
        ) ?? [],
      denyWrite:
        mergeConfiguredArray(
          defaults.filesystem?.denyWrite,
          globalConfig.filesystem?.denyWrite,
          projectConfig.filesystem?.denyWrite,
        ) ?? [],
    },
  };
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
    return {};
  }
}

export function getConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  return {
    globalPath: join(homedir(), ".pi", "agent", "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

export function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(getAgentDir(), "sandbox.json");
  const globalConfig = readJsonConfig(globalConfigPath, true);
  const projectConfig = readJsonConfig(projectConfigPath, true);
  return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.network?.allowedDomains) ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
  };
  writeConfigFile(configPath, config);
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowRead) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowWrite) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}
