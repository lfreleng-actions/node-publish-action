// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Check the inputs, stage any tarball and resolve the registry, then emit
 * the outputs later steps consume. The decisions are src/prepare.ts's; this
 * entry point does the IO around them.
 *
 * Reads: the INPUT_* variables action.yaml passes, GITHUB_WORKSPACE,
 * RUNNER_TEMP and PATH.
 * Writes: the state file, and the 'state', 'registry', 'registry_source'
 * and 'registry_scopes' outputs.
 */

import path from 'node:path';

import { error, info, notice, setOutput } from '../actions-io.js';
import { checkInputs, type RawInputs } from '../inputs.js';
import type { LoadedConfig, PickRegistry } from '../npm-internals.js';
import { prepare, type PrepareResult } from '../prepare.js';
import { resolveEffectiveRegistry } from '../registry.js';
import { removeWorkDir } from '../state.js';

/** Write the outputs and say what was decided. */
function emit(result: PrepareResult): void {
  const { resolution, inputs, tarball } = result;
  for (const message of result.notices) notice(message);

  // Everything the publish step needs is in the state file. The registry
  // is also an output because the .npmrc step between the two keys its
  // credential to it.
  setOutput('state', result.statePath);
  setOutput('registry', resolution.registry);
  setOutput('registry_source', resolution.source);
  // One scope per line: npm accepts a scope containing whitespace, and an
  // .npmrc value cannot contain a newline, the file being line based.
  setOutput('registry_scopes', resolution.scopes.join('\n'));

  if (tarball !== '') {
    info(`Publishing pre-packed tarball at ${inputs.publishVersion} ✅`);
  }
  info(`Resolved the registry with npm ${result.npmVersion}'s own configuration`);
  if (resolution.overridden) {
    // Surfaced rather than applied silently: the publish still goes where
    // the project asked, but a caller who set registry_url deserves to
    // know their value was not the one used.
    notice(
      `Publishing to ${resolution.registry}, not the registry_url ` +
        `${inputs.registryUrl}. The project selects it through ${resolution.source}.`,
    );
  } else {
    info(`Effective registry: ${resolution.registry || '(none; dry run)'}`);
  }
}

async function main(): Promise<void> {
  const result = await prepare(process.env);
  try {
    emit(result);
  } catch (cause) {
    // The cleanup step keys off the state output; if writing it failed,
    // nothing will remove the work directory but this.
    removeWorkDir(path.dirname(result.statePath));
    throw cause;
  }
}

/**
 * Prove this bundle loads and its logic runs, before anything depends on
 * it.
 *
 * This is the first bundled program the action runs, so it carries the
 * guard for a node_version too old to load a bundle: that must fail with an
 * actionable message rather than a raw syntax or module error.
 *
 * Deliberately independent of npm and the filesystem. The action reports a
 * failure here as the selected Node.js being unable to run its programs, so
 * an npm problem must not surface here; main() reports those in their own
 * terms. Stubs exercise the checks and the resolver end to end instead.
 */
function selfTest(): void {
  const raw: RawInputs = {
    publishVersion: '1.2.3-rc.1',
    registryUrl: 'https://example.invalid/',
    dryRun: 'false',
    pathPrefix: '.',
    tarballPath: '',
    nodeVersion: '22',
    nodeVersionFile: '',
    tag: 'latest',
    access: '',
    provenance: 'false',
    loadCredential: 'false',
    nexusUser: 'user',
    nexusPassword: '',
    authToken: 'token',
    vaultMappingJson: '',
    opServiceAccountToken: '',
  };
  const checked = checkInputs(raw);
  if (checked.inputs.authMode !== 'token' || checked.notices.length !== 1) {
    throw new Error('input check self-test did not return the sample verdict');
  }

  const flat: Record<string, unknown> = {
    registry: 'https://other.invalid/',
    '@scope:registry': 'https://example.invalid/',
  };
  const config: LoadedConfig = {
    get: (key) => flat[key],
    find: (key) => (key === 'registry' ? 'cli' : key in flat ? 'project' : null),
    flat,
    cliKeys: new Set(['registry']),
    flatten: (source, target) => Object.assign(target, source),
    validate: () => undefined,
  };
  const pickRegistry: PickRegistry = (spec, opts) => {
    const scope = spec.startsWith('@') ? spec.slice(0, spec.indexOf('/')) : '';
    return String((scope && opts[`${scope}:registry`]) || opts['registry']);
  };
  const result = resolveEffectiveRegistry({
    packageName: '@scope/pkg',
    publishConfig: undefined,
    registryUrl: 'https://other.invalid/',
    config,
    npmVersion: '11.0.0',
    pickRegistry,
  });
  if (result.registry !== 'https://example.invalid/' || result.scope !== '@scope') {
    throw new Error('registry resolver self-test did not return the sample selection');
  }
  info('prepare self-test passed');
}

async function run(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else {
    await main();
  }
}

run().catch((cause: unknown) => {
  // Every expected refusal (InputError, RegistryError, NpmInternalsError)
  // carries a message naming the input or setting at fault.
  error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
