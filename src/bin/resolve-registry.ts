// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Resolve the registry npm will publish to, and emit it for later steps.
 *
 * The selection rules live in src/registry.ts, unit tested there. This
 * entry point does the IO those rules cannot: reading the manifest and
 * asking npm for its resolved configuration.
 *
 * `npm config get` is used rather than any parsing of .npmrc, so the
 * configuration half of the answer comes from npm itself and cannot drift
 * from it. publishConfig is read from the manifest, because `npm config`
 * does not load it at all -- which is exactly why this redirection was
 * invisible before.
 *
 * Reads: PROJECT_DIR, REGISTRY_URL.
 * Writes: the 'registry' and 'registry_source' step outputs.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { error, info, notice, setOutput } from '../actions-io.js';
import {
  RegistryError,
  resolveEffectiveRegistry,
  scopeOf,
  type RegistryResolution,
} from '../registry.js';

/** `npm config get <key>`, or undefined when npm cannot be asked. */
function npmConfigGet(key: string, cwd: string): string | undefined {
  const result = spawnSync('npm', ['config', 'get', key], {
    cwd,
    encoding: 'utf8',
    // A workspace-aware npm refuses some commands inside a workspace
    // package with ENOWORKSPACES; disabling workspaces keeps this a
    // plain configuration read.
    env: { ...process.env, npm_config_workspaces: 'false' },
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return result.stdout;
}

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

/**
 * Ask npm for the registry of every scope it would consult.
 *
 * pickRegistry checks the spec's scope and then npm's configured default
 * scope, so both are queried. The second redirects packages that are not
 * themselves scoped, which is easy to overlook.
 */
function scopedRegistries(
  packageName: string,
  publishConfig: Record<string, unknown> | undefined,
  npmConfigScope: string | undefined,
  cwd: string,
): Record<string, string | undefined> {
  const scopes = new Set<string>();
  const specScope = scopeOf(packageName);
  if (specScope) {
    scopes.add(specScope);
  }
  // The configured scope the resolver will consult: publishConfig.scope
  // when the manifest has the key (even empty, which masks), else npm's
  // own. Mirrors the resolver so the registry for whichever scope it
  // picks has actually been fetched.
  let configured: string;
  if (publishConfig && 'scope' in publishConfig) {
    // Manifest data: only '' means unset. A literal 'undefined' here is
    // the scope '@undefined', which npm honours, so it is queried too.
    const raw = publishConfig['scope'];
    configured = typeof raw === 'string' ? raw : '';
  } else {
    configured = (npmConfigScope ?? '').trim();
    // Mirrors normaliseScope: npm prefixes '@' to any scope it honours,
    // so the bare literals it discards are discarded here too.
    if (configured === 'undefined' || configured === 'null') {
      configured = '';
    }
  }
  if (configured !== '') {
    scopes.add(configured.startsWith('@') ? configured : `@${configured}`);
  }
  const registries: Record<string, string | undefined> = {};
  for (const scope of scopes) {
    registries[`${scope}:registry`] = npmConfigGet(`${scope}:registry`, cwd);
  }
  return registries;
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

function main(): void {
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
  const npmConfigScope = npmConfigGet('scope', cwd);

  let resolution;
  try {
    resolution = resolveEffectiveRegistry({
      packageName,
      publishConfig,
      npmConfigScopedRegistry: scopedRegistries(packageName, publishConfig, npmConfigScope, cwd),
      npmConfigScope,
      // Only meaningful when no --registry is passed; the resolver
      // ignores it otherwise.
      npmConfigRegistry: registryUrl.trim() === '' ? npmConfigGet('registry', cwd) : undefined,
      registryUrl,
    });
  } catch (cause) {
    if (cause instanceof RegistryError) {
      error(cause.message);
      process.exit(1);
    }
    throw cause;
  }

  emit(resolution, registryUrl);
}

/**
 * Prove this bundle loads and its selection logic works, before anything
 * irreversible depends on it.
 *
 * This is now the *first* bundled program the action runs, so it inherits
 * the guard that used to sit in the publish step: a node_version too old
 * to load a bundle must fail with an actionable message rather than a raw
 * syntax or module error. Exercising the resolver rather than merely
 * printing a version means the check covers the artefact that will run.
 */
function selfTest(): void {
  const result = resolveEffectiveRegistry({
    packageName: '@scope/pkg',
    publishConfig: { '@scope:registry': 'https://example.invalid/' },
    npmConfigScopedRegistry: {},
    npmConfigScope: undefined,
    npmConfigRegistry: undefined,
    registryUrl: 'https://other.invalid/',
  });
  if (result.registry !== 'https://example.invalid/' || result.scope !== '@scope') {
    throw new Error('registry resolver self-test did not return the sample selection');
  }
  info('registry resolver self-test passed');
}

try {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else {
    main();
  }
} catch (cause) {
  error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
