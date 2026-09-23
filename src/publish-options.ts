// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The options `npm publish` hands to `pickRegistry`.
 *
 * npm builds them from its flattened configuration with the manifest's
 * publishConfig applied over a copy. The flattening is npm's own, loaded
 * from the publishing npm. What npm keeps inside its publish command, and
 * so exports nowhere, is which publishConfig keys it applies. That one
 * rule lives here, and it changed:
 *
 * | npm               | publishConfig keys applied                  |
 * | ----------------- | ------------------------------------------- |
 * | before 10.5.2     | all of them, even over command-line flags   |
 * | 10.5.2 and later  | all except those set on the command line    |
 *
 * Found by reading each release's lib/commands/publish.js, then confirmed
 * with `npm publish --dry-run`. For a manifest with publishConfig.registry,
 * published with --registry, npm 10.5.1 used the manifest's registry and
 * 10.5.2 used the flag's. Node 16's npm and early Node 18 and 20 releases
 * are on the older side of that line.
 */

import type { LoadedConfig } from './npm-internals.js';

/** The first npm release that lets command-line flags beat publishConfig. */
export const CLI_FILTER_SINCE: readonly [number, number, number] = [10, 5, 2];

/** Whether `npmVersion` is at or above `floor`. Pre-release tags are ignored. */
export function meetsVersion(npmVersion: string, floor: readonly [number, number, number]): boolean {
  const parts = npmVersion.split('-')[0]?.split('.').map((p) => Number(p)) ?? [];
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const want = floor[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== want) return have > want;
  }
  return true;
}

/**
 * The configuration flags the publish step passes to `npm publish`.
 *
 * Loading configuration with exactly these is what makes the resolution
 * describe the publish. `--no-workspaces` is not cosmetic: npm reads it
 * when choosing the project root, and so which project .npmrc applies.
 * The publish step passes it unconditionally. Shared with the parity
 * tests, so the flags they check are the flags that ship.
 */
export function publishFlags(registryUrl: string): string[] {
  const flags = ['--no-workspaces'];
  const url = registryUrl.trim();
  if (url !== '') flags.push(`--registry=${url}`);
  return flags;
}

export interface PublishOptions {
  /** The options, as `npm publish` would pass them to pickRegistry. */
  readonly opts: Readonly<Record<string, unknown>>;
  /** The publishConfig keys npm applied; it discards the rest. */
  readonly applied: ReadonlySet<string>;
}

/** Build the options `npm publish` would give pickRegistry. */
export function publishOptions(
  config: LoadedConfig,
  npmVersion: string,
  publishConfig: Readonly<Record<string, unknown>> | undefined,
): PublishOptions {
  // A copy: npm caches `flat` and reuses it, and its own publish command
  // flattens publishConfig into a copy for the same reason.
  const opts: Record<string, unknown> = { ...config.flat };
  if (!publishConfig) {
    return { opts, applied: new Set() };
  }
  const filter = meetsVersion(npmVersion, CLI_FILTER_SINCE);
  const kept = Object.entries(publishConfig).filter(
    ([key]) => !(filter && config.cliKeys.has(key)),
  );
  config.flatten(Object.fromEntries(kept), opts);
  return { opts, applied: new Set(kept.map(([key]) => key)) };
}
