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

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { error, info, notice, setOutput } from '../actions-io.js';
import {
  loadNpmInternals,
  NpmInternalsError,
  type LoadedConfig,
  type PickRegistry,
} from '../npm-internals.js';
import { publishFlags } from '../publish-options.js';
import {
  RegistryError,
  resolveEffectiveRegistry,
  type RegistryResolution,
} from '../registry.js';

/**
 * The manifest npm will resolve the publish from.
 *
 * For a tarball publish that is the manifest *inside the archive*, not the
 * one in the working directory. npm reads the spec from the tarball, so its
 * scope and its publishConfig decide the registry -- verified: a tarball
 * whose publishConfig named one host published there while the working
 * directory held an unscoped project and --registry named a third.
 *
 * Reading the project directory in that mode would resolve the registry
 * from a manifest nothing publishes.
 */
function readManifest(projectDir: string, tarball: string): { name?: unknown; publishConfig?: unknown } {
  if (tarball !== '') {
    const result = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`cannot read package.json from ${tarball}`);
    }
    return JSON.parse(result.stdout) as { name?: unknown; publishConfig?: unknown };
  }
  return JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as {
    name?: unknown;
    publishConfig?: unknown;
  };
}

/** The manifest fields the selection needs, in the shapes it expects. */
function manifestFields(manifest: { name?: unknown; publishConfig?: unknown }): {
  packageName: string;
  publishConfig: Record<string, unknown> | undefined;
} {
  return {
    packageName: typeof manifest.name === 'string' ? manifest.name : '',
    publishConfig:
      manifest.publishConfig && typeof manifest.publishConfig === 'object'
        ? (manifest.publishConfig as Record<string, unknown>)
        : undefined,
  };
}

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

  let manifest: { name?: unknown; publishConfig?: unknown };
  try {
    manifest = readManifest(projectDir, tarball);
  } catch (cause) {
    error(
      tarball !== ''
        ? `Cannot read the manifest from ${tarball}: ${String(cause)}`
        : `Cannot read package.json in ${projectDir}: ${String(cause)}`,
    );
    process.exit(1);
  }

  const { packageName, publishConfig } = manifestFields(manifest);
  const cwd = projectDir || '.';

  // The npm on PATH is the one the publish step runs, so its own code
  // decides. Found from the executable, not from 'npm root -g', whose
  // answer is itself configuration.
  const internals = loadNpmInternals();
  if (!internals.loadConfig) {
    error(
      `npm ${internals.npmVersion} predates @npmcli/config, which this ` +
        'action loads to resolve the publish registry. Use npm 7 or later.',
    );
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
