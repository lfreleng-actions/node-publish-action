// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Ground truth for registry resolution: where does `npm publish` really go?
 *
 * Runs `npm publish --dry-run` from a given npm package directory, in a
 * scratch project built from a scenario, and reads the destination npm
 * reports. No network: every registry is a `.invalid` host, and a dry run
 * contacts none of them.
 *
 * Shared by the parity tests, so the resolver is judged against npm's
 * behaviour rather than against a description of it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { publishFlags } from '../../src/publish-options.js';

export { publishFlags };

export interface Scenario {
  /** Short, unique description; used as the test name. */
  readonly name: string;
  /** package.json name. */
  readonly packageName: string;
  readonly publishConfig?: Record<string, unknown>;
  /** Lines for the project .npmrc. */
  readonly npmrc?: readonly string[];
  /** The action's registry_url; '' passes no --registry at all. */
  readonly registryUrl: string;
  /**
   * Extra environment for npm, e.g. `npm_config_@s:registry`. For values
   * an .npmrc cannot carry, such as ones containing a newline.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Project {
  readonly dir: string;
  remove(): void;
}

/** Lay a scenario out as a publishable project. */
export function makeProject(scenario: Scenario): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-ground-truth-'));
  const manifest: Record<string, unknown> = {
    name: scenario.packageName,
    version: '1.0.0',
    // Nothing to pack beyond the manifest; keeps the dry run fast.
    files: [],
  };
  if (scenario.publishConfig !== undefined) {
    manifest['publishConfig'] = scenario.publishConfig;
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (scenario.npmrc !== undefined) {
    writeFileSync(path.join(dir, '.npmrc'), `${scenario.npmrc.join('\n')}\n`);
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Outcome =
  | { readonly kind: 'publishes'; readonly registry: string }
  | { readonly kind: 'fails'; readonly detail: string }
  /**
   * The dry run succeeded without naming a destination. npm 7 never
   * reports it, so it has no ground truth to compare against; callers
   * must not treat this as agreement.
   */
  | { readonly kind: 'unreported' };

/**
 * An environment with no ambient npm configuration, so only the scenario
 * decides. A developer's own ~/.npmrc or npm_config_* variables would
 * otherwise leak into ground truth and differ from CI.
 */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_/i.test(key)) env[key] = value;
  }
  env['HOME'] = home;
  env['USERPROFILE'] = home;
  env['npm_config_userconfig'] = path.join(home, '.npmrc');
  env['npm_config_globalconfig'] = path.join(home, 'npmrc-global');
  env['npm_config_update_notifier'] = 'false';
  env['npm_config_fund'] = 'false';
  env['npm_config_audit'] = 'false';
  // Offline: every registry here is a .invalid host, and npm 11 fetches
  // the packument during a dry run. Offline removes the lookup entirely
  // without changing the destination npm reports, which was measured on
  // npm 8 to 11. That matters under harden-runner's block policy, whose
  // DNS proxy answers a disallowed name with a sinkhole address rather
  // than NXDOMAIN, so a lookup would hang instead of failing fast.
  env['npm_config_offline'] = 'true';
  return env;
}

/** Where `npm publish` from `npmDir` actually sends this scenario. */
export function groundTruth(npmDir: string, scenario: Scenario): Outcome {
  const project = makeProject(scenario);
  const home = mkdtempSync(path.join(tmpdir(), 'npm-ground-truth-home-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(npmDir, 'bin', 'npm-cli.js'),
        'publish',
        '--dry-run',
        ...publishFlags(scenario.registryUrl),
      ],
      { cwd: project.dir, env: { ...isolatedEnv(home), ...scenario.env }, encoding: 'utf8', timeout: 60_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    // npm 7+: "Publishing to <url> with tag ...". The URL is the first
    // token after "Publishing to".
    const match = /Publishing to (\S+)/.exec(output);
    if (result.status === 0 && match?.[1]) {
      return { kind: 'publishes', registry: match[1] };
    }
    if (result.status === 0) {
      return { kind: 'unreported' };
    }
    const line = output
      .split('\n')
      .find((l) => /npm (ERR!|error)/.test(l)) ?? `exit ${String(result.status)}`;
    return { kind: 'fails', detail: line.trim() };
  } finally {
    project.remove();
    rmSync(home, { recursive: true, force: true });
  }
}
