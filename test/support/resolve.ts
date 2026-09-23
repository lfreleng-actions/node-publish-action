// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Resolve a scenario the way the action does: with a real npm's own
 * configuration, flatten and pickRegistry, in the same isolated environment
 * ground-truth.ts gives `npm publish --dry-run`.
 *
 * Unit and parity tests both go through here, so they exercise one code
 * path and differ only in what they assert.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadNpmInternals } from '../../src/npm-internals.js';
import { publishFlags } from '../../src/publish-options.js';
import { resolveEffectiveRegistry, type RegistryResolution } from '../../src/registry.js';
import { isolatedEnv, makeProject, type Scenario } from './ground-truth.js';

export async function resolveScenario(
  npmDir: string,
  scenario: Scenario,
): Promise<RegistryResolution> {
  const internals = loadNpmInternals(npmDir);
  if (!internals.loadConfig) {
    throw new Error(`npm ${internals.npmVersion} has no @npmcli/config`);
  }
  const project = makeProject(scenario);
  const home = mkdtempSync(path.join(tmpdir(), 'npm-resolve-home-'));
  try {
    const config = await internals.loadConfig({
      cwd: project.dir,
      flags: publishFlags(scenario.registryUrl),
      env: { ...isolatedEnv(home), ...scenario.env },
    });
    return resolveEffectiveRegistry({
      packageName: scenario.packageName,
      publishConfig: scenario.publishConfig,
      registryUrl: scenario.registryUrl,
      config,
      npmVersion: internals.npmVersion,
      pickRegistry: internals.pickRegistry,
    });
  } finally {
    project.remove();
    rmSync(home, { recursive: true, force: true });
  }
}
