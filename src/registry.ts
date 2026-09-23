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
 * against `npm publish --dry-run` on every supported npm, from
 * MINIMUM_NPM_MAJOR up, in test/registry.parity.test.ts.
 */

import type { LoadedConfig, PickRegistry } from './npm-internals.js';
import { NpmInternalsError } from './npm-internals.js';
import { appliedKeys, publishOptions } from './publish-options.js';
import { assertUsable, RegistryError } from './registry-url.js';
import type { RegistrySource } from './registry-source.js';

export { RegistryError };
export type { RegistrySource };

/** Where npm publishes with no registry configured anywhere. */
const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/**
 * The oldest npm major this resolver supports: the oldest whose behaviour
 * is verified, since the parity tests compare every scenario against
 * `npm publish --dry-run`, and npm 7's dry run never names a destination.
 * npm 7 also differs in substance: it flattens `scope` to `projectScope`
 * while its npm-registry-fetch reads `opts.scope`, so a configured scope
 * never redirects there. Nothing current needs it. No Node.js LTS release
 * shipped npm 7, only Node 15 and the pre-LTS Node 16 releases, the last
 * in September 2021.
 */
export const MINIMUM_NPM_MAJOR = 8;

/** Refuse an npm older than the verified floor. */
export function assertSupportedNpm(npmVersion: string): void {
  const major = Number(npmVersion.split('.')[0]);
  if (Number.isInteger(major) && major >= MINIMUM_NPM_MAJOR) return;
  throw new NpmInternalsError(
    `npm ${npmVersion} is older than npm ${MINIMUM_NPM_MAJOR}, the oldest ` +
      'release this action resolves publish registries for. Every Node.js ' +
      `LTS release ships npm ${MINIMUM_NPM_MAJOR} or later; raise ` +
      'node_version, or the version in node_version_file.',
  );
}

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
  const expected = key === 'scope' ? 'a scope name' : 'a registry URL';
  throw new RegistryError(
    `package.json publishConfig (${key}) is ${kind}, not ${expected}. ` +
      'npm copies it through unchecked and then rejects the publish, so ' +
      'it is refused here.',
  );
}

/** npm's configured scope, as its flatten normalised it, or null. */
function optionScope(opts: Readonly<Record<string, unknown>>): string | null {
  const scope = opts['scope'];
  return typeof scope === 'string' && scope !== '' ? scope : null;
}

/**
 * Refuse a consulted scope that cannot be pinned faithfully.
 *
 * The publish and verification steps pin each consulted scope as
 * `--<scope>:registry=<url>`. Two kinds of character break that:
 *
 * - **Control characters.** The scopes are emitted one per line and read
 *   back line by line, so a line break would split a scope into keys npm
 *   never consults. publishConfig.scope is JSON and an npm_config_scope
 *   variable is unrestricted, so either can carry one.
 * - **`=`.** npm's option parser splits a flag at its first `=`, so the
 *   pin for `@a=b` is read as the key `@a` and the real key stays unpinned.
 *   Measured on npm 8 and 11. An .npmrc cannot define such a key, since its
 *   parser splits there too, but publishConfig can.
 *
 * Either way the real key would stay open for a lifecycle script to
 * redirect. The value is never echoed: the character is named, by code
 * point where it would corrupt the line reporting it.
 */
function assertScopeText(scope: string, where: string): void {
  const control = /[\u0000-\u001f\u007f]/.exec(scope);
  if (control) {
    const code = (control[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    throw new RegistryError(
      `${where} contains a control character (U+${code}). Remove it: the ` +
        'scope is pinned on the command line from a line-based list, and ' +
        'cannot be pinned faithfully with one.',
    );
  }
  if (scope.includes('=')) {
    throw new RegistryError(
      `${where} contains '='. Remove it: npm splits a command-line flag at ` +
        "its first '=', so this scope's registry cannot be pinned.",
    );
  }
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
  // The registry key from the command line is the one this action passes,
  // but only if the manifest did not mask it. Before npm 10.5.2 an applied
  // publishConfig.registry overrides the flag; a truthy one returned above,
  // so an applied one here is empty, and npm fell through to its default.
  // That default can equal registry_url, which makes the values match while
  // the flag played no part.
  const fromInput =
    !applied.has('registry') &&
    inputs.config.find('registry') === 'cli' &&
    registry === inputs.registryUrl.trim();
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

  // Only verified behaviour is reported; see MINIMUM_NPM_MAJOR.
  assertSupportedNpm(inputs.npmVersion);

  // npm refuses some configuration outright; npm 9 and later reject an
  // invalid `registry=` in an .npmrc, where npm 8 drops it. Following npm
  // means asking it, not deciding here.
  config.validate();

  // Manifest types are checked before npm's flatten sees the values, so
  // an invalid one is always reported here, in these terms, and never as
  // whatever npm's own code throws on it. For `registry` that is
  // `output.endsWith is not a function`, from pacote building a fetcher,
  // later in npm's publish; flatten copies the value through untouched.
  //
  // Only keys npm will apply are checked, so the verdict tracks npm's: a
  // non-string publishConfig.registry crashes npm whenever it is applied,
  // even when a scoped key wins, and is harmless where npm filters it
  // (10.5.2 and later, with --registry). `scope` is always applied, since
  // this action never passes it on the command line.
  const willApply = appliedKeys(config, inputs.npmVersion, publishConfig);
  if (willApply.has('scope')) assertManifestString(publishConfig, 'scope');
  if (willApply.has('registry')) assertManifestString(publishConfig, 'registry');

  const { opts, applied } = publishOptions(config, inputs.npmVersion, publishConfig);

  const registry: unknown = inputs.pickRegistry(inputs.packageName, opts);

  // Attribute the result: the first consulted key npm would find set.
  // This restates only pickRegistry's order, to *label* the answer; the
  // answer itself is npm's, and the two are checked against each other.
  const specScope = scopeOf(inputs.packageName);
  const configuredScope = optionScope(opts);
  const scopes: string[] = [];
  for (const candidate of [specScope, configuredScope]) {
    if (candidate && !scopes.includes(candidate)) scopes.push(candidate);
  }
  if (specScope) assertScopeText(specScope, 'the package name');
  if (configuredScope) {
    assertScopeText(
      configuredScope,
      applied.has('scope') ? 'package.json publishConfig (scope)' : 'npm config scope',
    );
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
