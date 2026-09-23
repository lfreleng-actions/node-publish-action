// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Work out which registry npm will actually publish to.
 *
 * The action passes `--registry` and then reports and verifies against that
 * value. npm does not necessarily agree, so a scoped package can publish
 * somewhere the action never names: the summary misreports the destination
 * and `npm view` checks the wrong host.
 *
 * **npm decides.** The registry is whatever the publishing npm's own
 * `pickRegistry` returns for the options its publish command would build
 * (see publish-options.ts). This module does not reimplement that
 * selection. It does three things npm cannot do for it:
 *
 * - **Attribute** the result to a source, for the summary and the notice.
 * - **Cross-check** the attribution against npm's answer and fail closed
 *   when they disagree, so a mislabelled source can never ship.
 * - **Validate** the result, so an override cannot bring in a registry
 *   that registry_url's own validation would refuse (registry-url.ts).
 *
 * Precedence is not tested here. It varies by npm release, so it is tested
 * against `npm publish --dry-run` on each supported npm, in
 * test/registry.parity.test.ts.
 */

import type { LoadedConfig, PickRegistry } from './npm-internals.js';
import { NpmInternalsError } from './npm-internals.js';
import { publishOptions } from './publish-options.js';
import { assertUsable, RegistryError } from './registry-url.js';
import type { RegistrySource } from './registry-source.js';

export { RegistryError };
export type { RegistrySource };

/** Where npm publishes with no registry configured anywhere. */
const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export interface RegistryResolution {
  /** The registry npm will publish to. */
  readonly registry: string;
  readonly source: RegistrySource;
  /**
   * Every scope whose `:registry` key npm would consult, in npm's order.
   *
   * All of them are emitted, not merely the one that won, so the publish
   * and verification commands can pin each on the command line where it
   * outranks anything the manifest carries. Pinning only the winner
   * leaves the others live: a prepublishOnly script can add a key for an
   * earlier scope and redirect the publish, and `npm view` -- which does
   * not load publishConfig at all -- can re-activate a key the manifest
   * had masked.
   */
  readonly scopes: readonly string[];
  /** The scope that decided, or null when nothing scoped applied. */
  readonly scope: string | null;
  /** True when the result differs from the caller's registry_url. */
  readonly overridden: boolean;
}

export interface RegistryInputs {
  readonly packageName: string;
  readonly publishConfig: Readonly<Record<string, unknown>> | undefined;
  /** The action's registry_url input. May be empty for a dry run. */
  readonly registryUrl: string;
  /**
   * The publishing npm's configuration for the project, loaded with the
   * flags the publish step passes (`--registry` when registryUrl is set).
   */
  readonly config: LoadedConfig;
  /** That npm's version; decides which publishConfig keys it applies. */
  readonly npmVersion: string;
  /** That npm's own pickRegistry. */
  readonly pickRegistry: PickRegistry;
}

/**
 * The scope of a package name, including the leading '@'.
 *
 * Returns null for an unscoped name. npm's own spec parsing treats only a
 * leading '@' with a following '/' as a scope, so '@nope' and 'a/b' are both
 * unscoped.
 */
export function scopeOf(packageName: string): string | null {
  if (!packageName.startsWith('@')) {
    return null;
  }
  const slash = packageName.indexOf('/');
  if (slash <= 1) {
    return null;
  }
  return packageName.slice(0, slash);
}

/**
 * Refuse a truthy non-string where npm expects a registry or scope.
 *
 * npm's flatten copies publishConfig entries across without checking their
 * type, and npm then rejects the publish. Refusing here fails for the same
 * reason npm does, rather than reporting a destination npm never reaches.
 *
 * The message names the key and the type, never the value. An object would
 * otherwise be serialised into an ::error::, publishing whatever manifest
 * fields it happened to carry into the job log.
 */
function assertManifestString(
  publishConfig: Readonly<Record<string, unknown>> | undefined,
  key: string,
): void {
  if (!publishConfig || !(key in publishConfig)) return;
  const value = publishConfig[key];
  if (typeof value === 'string' || !value) return;
  const kind = Array.isArray(value) ? 'an array' : `a ${typeof value}`;
  throw new RegistryError(
    `package.json publishConfig (${key}) is ${kind}, not a registry ` +
      'URL. npm copies it through unchecked and then rejects the ' +
      'publish, so it is refused here.',
  );
}

/** npm's configured scope, as its flatten normalised it, or null. */
function optionScope(opts: Readonly<Record<string, unknown>>): string | null {
  const scope = opts['scope'];
  return typeof scope === 'string' && scope !== '' ? scope : null;
}

/**
 * Name the source of the key that decided.
 *
 * A manifest key counts only when it supplied the value. An empty one
 * masks the configured value without supplying a URL of its own, so npm's
 * default applies and the manifest is not the source. Likewise 'input' is
 * claimed only when the result is the caller's own URL.
 */
function sourceOf(
  key: string,
  registry: unknown,
  inputs: RegistryInputs,
  applied: ReadonlySet<string>,
): RegistrySource {
  const scoped = key !== 'registry';
  if (applied.has(key) && inputs.publishConfig?.[key]) {
    return scoped ? 'publishConfig-scoped' : 'publishConfig-registry';
  }
  if (scoped) {
    return 'npm-config-scoped';
  }
  // The registry key from the command line is the one this action passes.
  const fromInput =
    inputs.config.find('registry') === 'cli' && registry === inputs.registryUrl.trim();
  return fromInput ? 'input' : 'npm-config-registry';
}

/**
 * Resolve the registry npm will publish to, using npm's own selection.
 *
 * Throws {@link RegistryError} when the winning value is unusable, and
 * {@link NpmInternalsError} when npm itself would refuse the configuration
 * or when attribution disagrees with npm.
 */
export function resolveEffectiveRegistry(inputs: RegistryInputs): RegistryResolution {
  const { config, publishConfig } = inputs;
  const registryUrl = inputs.registryUrl.trim();

  // npm refuses some configuration outright; npm 9 and later reject an
  // invalid `registry=` in an .npmrc, where npm 8 drops it. Following npm
  // means asking it, not deciding here.
  config.validate();
  // npm's flatten dereferences a scope as a string, so a non-string would
  // fail inside npm with a message that is not ours to control.
  assertManifestString(publishConfig, 'scope');

  const { opts, applied } = publishOptions(config, inputs.npmVersion, publishConfig);
  if (applied.has('registry')) {
    assertManifestString(publishConfig, 'registry');
  }

  const registry: unknown = inputs.pickRegistry(inputs.packageName, opts);

  // Attribute the result: the first consulted key npm would find set.
  // This restates only pickRegistry's order, to *label* the answer; the
  // answer itself is npm's, and the two are checked against each other.
  const specScope = scopeOf(inputs.packageName);
  const scopes: string[] = [];
  for (const candidate of [specScope, optionScope(opts)]) {
    if (candidate && !scopes.includes(candidate)) scopes.push(candidate);
  }
  const winner = scopes.find((scope) => opts[`${scope}:registry`]);
  const key = winner ? `${winner}:registry` : 'registry';
  const expected = winner ? opts[key] : (opts['registry'] || NPM_DEFAULT_REGISTRY);

  if (expected !== registry) {
    throw new NpmInternalsError(
      `npm ${inputs.npmVersion}: pickRegistry chose a registry this action ` +
        `did not attribute to '${key}'. Refusing to report a source it ` +
        'cannot account for; this npm may select registries differently.',
    );
  }

  if (winner && applied.has(key)) {
    // Only a manifest value can be a non-string; configuration is text.
    assertManifestString(publishConfig, key);
  }

  const source = sourceOf(key, registry, inputs, applied);
  const scope = winner ?? null;
  assertUsable(registry as string, source, source === 'input' ? specScope : scope);

  return {
    registry: registry as string,
    source,
    scope,
    scopes,
    overridden: registry !== registryUrl,
  };
}
