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
 * The selection follows `pickRegistry` in npm-registry-fetch:
 *
 *   let registry = spec.scope && opts[spec.scope + ':registry']
 *   if (!registry && opts.scope) {
 *     registry = opts[opts.scope + ':registry']
 *   }
 *   if (!registry) { registry = opts.registry || defaultOpts.registry }
 *
 * `opts` is the resolved configuration with the manifest's `publishConfig`
 * flattened over it — **except** for keys already supplied on the command
 * line, which npm filters out. Each rule below was checked against npm
 * 11.19.0 rather than read from the source alone:
 *
 * | Case                                        | Winner        |
 * | ------------------------------------------- | ------------- |
 * | `publishConfig.registry` vs `--registry`     | `--registry`  |
 * | `publishConfig["@s:registry"]` vs `--registry` | publishConfig |
 * | `publishConfig["@s:registry"]` vs `--@s:registry` | the CLI   |
 * | unscoped package, `scope=@s` + `@s:registry` | `@s:registry` |
 *
 * Row one is why `publishConfig.registry` is consulted only when this
 * action passes no `--registry` at all. Row three is what lets the caller
 * make a resolved value authoritative. Row four is the `opts.scope`
 * fallback, which applies to packages that are not themselves scoped.
 *
 * Only the *selection* lives here. Reading `.npmrc` is left to npm: the
 * caller supplies what `npm config get` returned, so this module never
 * parses npm configuration.
 */


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
  /** Result of `npm config get <scope>:registry` per consulted scope. */
  readonly npmConfigScopedRegistry: Readonly<Record<string, string | undefined>>;
  /** Result of `npm config get scope`, npm's configured default scope. */
  readonly npmConfigScope: string | undefined;
  /**
   * Result of `npm config get registry`, npm's configured default.
   *
   * Only consulted when this action passes no `--registry`, which is the
   * one case where npm falls back to it rather than to the caller's
   * value. Returning an empty registry there would report `(none)` while
   * npm quietly contacted the project's or user's own registry.
   */
  readonly npmConfigRegistry: string | undefined;
  /** The action's registry_url input. May be empty for a dry run. */
  readonly registryUrl: string;
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
 * Normalise npm's configured `scope`, which may omit the leading '@'.
 *
 * The literals `cleanConfigValue` discards are exactly the ones npm
 * ignores, measured on npm 11.19.0 by publishing against an
 * `@<scope>:registry` entry for each:
 *
 * | `scope=`    | `npm config get scope` | npm selects the scoped registry |
 * | ----------- | ---------------------- | ------------------------------- |
 * | *(unset)*   | *(empty)*              | no                              |
 * | `null`      | `null`                 | **no**                          |
 * | `undefined` | `@undefined`           | **yes**                         |
 * | `NULL`      | `@NULL`                | **yes**                         |
 * | `onap`      | `@onap`                | yes                             |
 *
 * npm normalises a usable value by prefixing '@' before printing it, so
 * anything it honours arrives here already distinguishable from the
 * renderings it does not. `null` is the one value npm discards itself,
 * and it prints unprefixed, so discarding it here agrees rather than
 * guesses. Treating these as real scopes would query and pin keys npm
 * never consults.
 */
function normaliseScope(value: string | undefined): string | null {
  return prefixScope(cleanConfigValue(value));
}

/** Add the leading '@' npm expects, treating only an absent value as none. */
function prefixScope(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return value.startsWith('@') ? value : `@${value}`;
}

/**
 * npm prints the string 'undefined' for an unset key rather than writing
 * nothing, so an unguarded read turns a missing setting into a registry
 * literally named 'undefined'.
 */
function cleanConfigValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') {
    return undefined;
  }
  return trimmed;
}

interface ManifestEntry {
  /**
   * Whether the key exists in publishConfig at all.
   *
   * A present key matters even when empty: npm flattens it over the
   * resolved options, masking any `.npmrc` value for the same key. The
   * selection then falls past it rather than back to configuration.
   */
  readonly present: boolean;
  readonly value: string | undefined;
}

function readPublishConfig(
  publishConfig: Readonly<Record<string, unknown>> | undefined,
  key: string,
): ManifestEntry {
  if (!publishConfig || typeof publishConfig !== 'object' || !(key in publishConfig)) {
    return { present: false, value: undefined };
  }
  const value = publishConfig[key];
  // npm's flatten copies the entry across without checking its type, so
  // JavaScript truthiness decides, not the declared type. Measured on
  // npm 11.19.0: a scoped entry of 42 makes npm reject the publish
  // outright rather than fall back.
  //
  // A truthy non-string is therefore rejected here, so this fails for
  // the same reason npm does instead of silently selecting the .npmrc
  // URL and publishing where npm would have refused.
  //
  // The message names the key and the type, never the value. An object
  // would otherwise be serialised into an ::error:: -- publishing
  // whatever manifest fields it happened to carry into the job log.
  if (typeof value !== 'string') {
    if (value) {
      const kind = Array.isArray(value) ? 'an array' : `a ${typeof value}`;
      throw new RegistryError(
        `package.json publishConfig (${key}) is ${kind}, not a registry ` +
          'URL. npm copies it through unchecked and then rejects the ' +
          'publish, so it is refused here.',
      );
    }
    return { present: true, value: undefined };
  }
  // Manifest data is not `npm config get` stdout, so the stdout
  // conventions do not apply to it. npm copies the literal string into
  // flatOptions, where only '' is falsey -- a literal 'undefined', 'null'
  // or '   ' is selected, and npm then fails on it. Treating those as
  // empty here would pin the fallback registry and publish somewhere npm
  // would have refused to.
  return { present: true, value: value === '' ? undefined : value };
}

/**
 * The first scoped key npm would honour, or null when none applies.
 *
 * Split out from the main resolution so each half stays readable; the
 * ordering it implements is pickRegistry's, described above.
 */
function selectScoped(
  inputs: RegistryInputs,
  candidates: readonly string[],
  registryUrl: string,
): RegistryResolution | null {
  for (const scope of candidates) {
    const key = `${scope}:registry`;
    const manifest = readPublishConfig(inputs.publishConfig, key);
    if (manifest.present) {
      if (manifest.value !== undefined) {
        assertUsable(manifest.value, 'publishConfig-scoped', scope);
        return {
          registry: manifest.value,
          source: 'publishConfig-scoped',
          scope,
          scopes: candidates,
          overridden: manifest.value !== registryUrl,
        };
      }
      // Present but empty. npm flattens it over the resolved options, so
      // the .npmrc value for this key is masked and the selection moves
      // on rather than falling back to configuration.
      continue;
    }
    const configured = cleanConfigValue(inputs.npmConfigScopedRegistry[key]);
    if (configured !== undefined) {
      assertUsable(configured, 'npm-config-scoped', scope);
      return {
        registry: configured,
        source: 'npm-config-scoped',
        scope,
        scopes: candidates,
        overridden: configured !== registryUrl,
      };
    }
  }
  return null;
}

  // publishConfig.registry loses to --registry, because npm filters any
  // publishConfig key already supplied as a command-line flag. It therefore
  // only decides when this action passes no --registry at all, which
  // happens for a dry run with no registry_url. Consulting it otherwise
  // would redirect a publish npm would have sent to the caller's registry.
function selectWithoutInput(
  inputs: RegistryInputs,
  candidates: readonly string[],
  registryUrl: string,
): RegistryResolution {
  const manifest = readPublishConfig(inputs.publishConfig, 'registry');
  if (manifest.value !== undefined) {
    assertUsable(manifest.value, 'publishConfig-registry', null);
    return {
      registry: manifest.value,
      source: 'publishConfig-registry',
      scope: null,
      scopes: candidates,
      overridden: true,
    };
  }
  // npm does not publish to "no registry". With no --registry it uses
  // its own configured value, and failing that its built-in default --
  // measured on npm 11.19.0, including that an explicitly empty
  // publishConfig.registry masks the configured value and leaves the
  // built-in default. Reporting '' here would name no destination
  // while npm quietly contacted one, and would pin nothing.
  //
  // This key is not read through cleanConfigValue. Unlike a scoped key,
  // `registry` is never printed as 'undefined' when unset -- npm prints
  // its built-in default -- so 'undefined' or 'null' here is a value the
  // user actually configured, and npm rejects the publish on it. Treating
  // it as unset would publish to the default where npm refused.
  const rawConfigured = (inputs.npmConfigRegistry ?? '').trim();
  const configured = manifest.present || rawConfigured === '' ? undefined : rawConfigured;
  const fallback = configured ?? NPM_DEFAULT_REGISTRY;
  assertUsable(fallback, 'npm-config-registry', null);
  return {
    registry: fallback,
    source: 'npm-config-registry',
    scope: null,
    scopes: candidates,
    // Derived, not assumed. This branch runs when registry_url is
    // empty, so the fallback always differs from it -- and the notice
    // is exactly what tells a caller their empty input did not mean
    // "no registry".
    overridden: fallback !== registryUrl,
  };
}

/**
 * Resolve the registry npm will publish to, following npm's own precedence.
 *
 * Throws {@link RegistryError} when the winning value is unusable, so an
 * override cannot smuggle in an http registry that registry_url's own
 * validation would have refused.
 */
export function resolveEffectiveRegistry(inputs: RegistryInputs): RegistryResolution {
  const registryUrl = inputs.registryUrl.trim();
  const specScope = scopeOf(inputs.packageName);
  // npm flattens publishConfig.scope over the configured scope before
  // pickRegistry reads opts.scope, so the manifest wins when present --
  // and a present-but-empty entry masks the .npmrc value rather than
  // deferring to it. Measured on npm 11.19.0: an unscoped package with
  // publishConfig.scope '@other' published to '@other:registry', and an
  // empty publishConfig.scope beside an .npmrc 'scope=@onap' fell
  // through to --registry.
  //
  // The manifest value is not `npm config get` output, so the stdout
  // sentinels do not apply: a publishConfig.scope of 'undefined' is a
  // real scope, '@undefined', which npm flattens through unchanged.
  const manifestScope = readPublishConfig(inputs.publishConfig, 'scope');
  const configScope = manifestScope.present
    ? prefixScope(manifestScope.value)
    : normaliseScope(inputs.npmConfigScope);

  // pickRegistry consults the spec's scope first, then npm's configured
  // default scope. The second is easy to miss: it redirects packages that
  // are not themselves scoped.
  const candidates: string[] = [];
  for (const candidate of [specScope, configScope]) {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  const scoped = selectScoped(inputs, candidates, registryUrl);
  if (scoped) {
    return scoped;
  }

  if (registryUrl === '') {
    return selectWithoutInput(inputs, candidates, registryUrl);
  }

  assertUsable(registryUrl, 'input', specScope);
  // The scopes are still reported when nothing overrode, so the publish and
  // verification commands can pin those keys and keep a later publishConfig
  // -- one written by prepublishOnly, say -- from moving the destination.
  return {
    registry: registryUrl,
    source: 'input',
    scope: null,
    scopes: candidates,
    overridden: false,
  };
}
