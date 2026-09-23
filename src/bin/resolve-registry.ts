// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Resolve the registry npm will publish to, and emit it for later steps.
 *
 * The selection is npm's: this loads the publishing npm's configuration
 * and pickRegistry in-process (src/npm-internals.ts) and hands them to
 * src/registry.ts. This entry point does the IO around that: reading the
 * manifest, loading npm's configuration with the flags the publish step
 * passes, and writing the outputs.
 *
 * It used to shell out to `npm config get` and decode its stdout, where an
 * unset key prints the string 'undefined'. That decoding is gone. npm's
 * configuration is read directly, so there is no text to misread.
 *
 * Reads: PROJECT_DIR, REGISTRY_URL, TARBALL.
 * Writes: the 'registry', 'registry_source' and 'registry_scopes' outputs.
 */

import { error, info, notice, setOutput } from '../actions-io.js';
import {
  loadNpmInternals,
  manifestFields,
  NpmInternalsError,
  type LoadedConfig,
  type Manifest,
  type PickRegistry,
} from '../npm-internals.js';
import { publishFlags } from '../publish-options.js';
import {
  assertSupportedNpm,
  RegistryError,
  resolveEffectiveRegistry,
  type RegistryResolution,
} from '../registry.js';

/** Write the outputs and say what was decided. */
function emit(resolution: RegistryResolution, registryUrl: string): void {
  setOutput('registry', resolution.registry);
  setOutput('registry_source', resolution.source);
  // Emitted so the verification step can force the same choice. Passing
  // --registry alone does not: pickRegistry prefers a scoped setting, so
  // 'npm view --registry A' still queries the project's @scope:registry
  // when one exists -- the very mechanism this step exists to resolve.
  // Every consulted scope, one per line, so the publish and
  // verification commands can pin each. Pinning only the winner leaves
  // an earlier scope live for a prepublishOnly script to claim, and
  // leaves a manifest-masked key free to re-activate under 'npm view',
  // which does not load publishConfig at all.
  //
  // Newline separated rather than space separated: npm accepts a scope
  // containing whitespace and publishes to that key, so a
  // space-separated list would word-split it into two names and pin
  // neither. An .npmrc value cannot contain a newline, the file being
  // line based, so this separator is unambiguous.
  setOutput('registry_scopes', resolution.scopes.join('\n'));

  if (resolution.overridden) {
    // Surfaced rather than applied silently: the publish still goes where
    // the project asked, but a caller who set registry_url deserves to
    // know their value was not the one used.
    notice(
      `Publishing to ${resolution.registry}, not the registry_url ` +
        `${registryUrl}. The project selects it through ${resolution.source}.`,
    );
  } else {
    info(`Effective registry: ${resolution.registry || '(none; dry run)'}`);
  }
}

async function main(): Promise<void> {
  const projectDir = process.env.PROJECT_DIR ?? '';
  const registryUrl = process.env.REGISTRY_URL ?? '';
  const tarball = (process.env.TARBALL ?? '').trim();
  const cwd = projectDir || '.';

  // The npm on PATH is the one the publish step runs, so its own code
  // decides. Found from the executable, not from 'npm root -g', whose
  // answer is itself configuration.
  const internals = loadNpmInternals();
  // Checked before loading configuration, so an old npm fails for what it
  // is rather than for a missing module.
  assertSupportedNpm(internals.npmVersion);
  if (!internals.loadConfig) {
    error(`npm ${internals.npmVersion} did not provide @npmcli/config.`);
    process.exit(1);
  }
  // Configured exactly as the publish step invokes npm: the same project
  // directory, environment and configuration flags.
  const config: LoadedConfig = await internals.loadConfig({
    cwd,
    flags: publishFlags(registryUrl),
    env: process.env,
  });
  info(`Resolving the registry with npm ${internals.npmVersion}'s own configuration`);

  // The manifest npm will publish, read by npm's own reader, so the name
  // is normalised as npm normalises it. For a tarball publish that is the
  // manifest *inside the archive*, not the working directory's: its scope
  // and publishConfig decide the registry.
  let manifest: Manifest;
  try {
    manifest = await internals.readManifest(
      tarball !== '' ? { tarball } : { dir: cwd },
      config.flat,
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
    error(
      tarball !== ''
        ? `Cannot read the manifest from ${tarball}: ${reason}`
        : `Cannot read package.json in ${projectDir}: ${reason}`,
    );
    process.exit(1);
  }
  const { packageName, publishConfig } = manifestFields(manifest);

  let resolution;
  try {
    resolution = resolveEffectiveRegistry({
      packageName,
      publishConfig,
      registryUrl,
      config,
      npmVersion: internals.npmVersion,
      pickRegistry: internals.pickRegistry,
    });
  } catch (cause) {
    if (cause instanceof RegistryError || cause instanceof NpmInternalsError) {
      error(cause.message);
      process.exit(1);
    }
    throw cause;
  }

  emit(resolution, registryUrl);
}

/**
 * Prove this bundle loads and its resolution logic runs, before anything
 * irreversible depends on it.
 *
 * This is the *first* bundled program the action runs, so it carries the
 * guard for a node_version too old to load a bundle: that must fail with
 * an actionable message rather than a raw syntax or module error.
 *
 * Deliberately independent of npm. The action reports a failure here as
 * the selected Node.js being unable to run its programs, so an npm problem
 * must not surface here; main() reports those in their own terms. A stub
 * configuration exercises the resolver end to end instead.
 */
function selfTest(): void {
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
  info('registry resolver self-test passed');
}

async function run(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else {
    await main();
  }
}

run().catch((cause: unknown) => {
  error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
