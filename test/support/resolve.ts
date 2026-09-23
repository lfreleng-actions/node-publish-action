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

import { loadNpmInternals, manifestFields } from '../../src/npm-internals.js';
import { publishFlags } from '../../src/publish-options.js';
import { resolveEffectiveRegistry, type RegistryResolution } from '../../src/registry.js';
import { isolatedEnv, makeProject, type Scenario } from './ground-truth.js';

export async function resolveScenario(
  npmDir: string,
  scenario: Scenario,
  /**
   * Resolve as this npm release, overriding the loaded npm's own version.
   * Only the release-gated publishConfig filtering reads it, so this tests
   * behaviour either side of a boundary with whichever npm is on PATH.
   */
  asVersion?: string,
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
    // Through npm's own reader, as the bin does, so manifest reading is
    // under test too rather than bypassed with the scenario's raw fields.
    const manifest = await internals.readManifest(
      project.tarball === undefined ? { dir: project.dir } : { tarball: project.tarball },
      config.flat,
    );
    const { packageName, publishConfig } = manifestFields(manifest);
    return resolveEffectiveRegistry({
      packageName,
      publishConfig,
      registryUrl: scenario.registryUrl,
      config,
      npmVersion: asVersion ?? internals.npmVersion,
      pickRegistry: internals.pickRegistry,
    });
  } finally {
    project.remove();
    rmSync(home, { recursive: true, force: true });
  }
}
