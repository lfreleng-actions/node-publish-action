// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Load npm's own configuration and registry code from the npm that will
 * publish.
 *
 * npm bundles `npm-registry-fetch` and `@npmcli/config` in its own tree.
 * Loading them from there, rather than bundling a copy or transcribing
 * them, means the answers this action computes cannot drift from the npm
 * that acts on them: they come from the same code. It also adds nothing to
 * `dist/`, which is committed and reviewed.
 *
 * The cost is that npm's bundled layout is not a public API. So this module
 * probes a declared list of locations, each covered by tests, and fails
 * closed when none loads. It never falls back to a reimplementation: a
 * fallback would reintroduce exactly the drift this module exists to
 * remove, and would do so silently.
 *
 * Capabilities by npm major, measured against each npm's own tree:
 *
 * | npm   | pickRegistry | Config (credentials, layers) |
 * | ----- | ------------ | ---------------------------- |
 * | 6     | yes          | no (predates @npmcli/config)  |
 * | 7-8   | yes          | yes, definitions in npm       |
 * | 9+    | yes          | yes, definitions in config    |
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { assertLauncherRunsTree, locateNpm } from './npm-locate.js';
import { readManifestFrom, type Manifest, type ManifestTarget } from './npm-manifest.js';
import {
  assertClosureInTree,
  loadResolved,
  NpmInternalsError,
  resolveInTree,
  type NpmTree,
} from './npm-tree.js';

export { NpmInternalsError };
export { locateNpm } from './npm-locate.js';
export { manifestFields } from './npm-manifest.js';
export type { Manifest, ManifestTarget } from './npm-manifest.js';

/** The layer a configuration value came from, as npm names it. */
export type ConfigLayer = 'default' | 'builtin' | 'global' | 'user' | 'project' | 'env' | 'cli';

/** npm's `pickRegistry(spec, opts)` from npm-registry-fetch. */
export type PickRegistry = (spec: string, opts: Readonly<Record<string, unknown>>) => string;

/** The slice of a loaded `@npmcli/config` instance this action relies on. */
export interface LoadedConfig {
  /**
   * The effective value of `key`.
   *
   * Undefined means only that no value was *usable*. A literal
   * `key=undefined` in an .npmrc also yields undefined, so use find() to
   * tell absent from set; reading get() alone recreates the sentinel
   * ambiguity that `npm config get` had.
   */
  get(key: string): unknown;
  /**
   * The layer that set `key`, or null when none did. The authoritative
   * answer to whether a key is present at all.
   */
  find(key: string): ConfigLayer | null;
  /**
   * The flattened options npm passes to its registry code.
   *
   * npm caches this object and reuses it, so treat it as read-only. npm's
   * own publish command merges publishConfig into a copy; mutating this one
   * would corrupt the configuration it came from.
   */
  readonly flat: Readonly<Record<string, unknown>>;
  /** Keys set on the command line, as npm parsed them. */
  readonly cliKeys: ReadonlySet<string>;
  /**
   * npm's own flatten: apply `source` over `target` the way npm applies
   * publishConfig. Mutates `target`.
   */
  flatten(source: Readonly<Record<string, unknown>>, target: Record<string, unknown>): void;
  /**
   * Reject configuration this npm would refuse to run with.
   *
   * Delegates to npm's own validation, so the verdict follows the npm
   * that publishes: npm 9 and later refuse an invalid `registry=` in an
   * `.npmrc`, while npm 8 drops it and uses the default. Throws
   * {@link NpmInternalsError} naming npm's error code but never the value,
   * which npm's own error carries verbatim, credentials included.
   */
  validate(): void;
  /**
   * The credentials npm would use for `uri`: npm's own lookup, which
   * `npm publish` calls on the registry it picked. It reads one exact
   * nerf-darted key per credential and walks no ancestor paths.
   */
  getCredentialsByURI(uri: string): Credentials;
  /**
   * Whether `key` holds its default, set in no configuration layer. npm's
   * trusted publishing enables provenance by itself only while this is
   * true of `provenance`.
   */
  isDefault(key: string): boolean;
}

/** The fields of npm's credential lookup this action inspects. */
export interface Credentials {
  readonly token?: unknown;
  readonly username?: unknown;
  readonly certfile?: unknown;
  readonly keyfile?: unknown;
}

export interface LoadConfigOptions {
  /** Directory npm treats as the working directory: the project root. */
  readonly cwd: string;
  /**
   * Command-line flags npm would receive, e.g. `['--registry=https://…']`.
   * Always passed explicitly: `@npmcli/config` otherwise parses
   * `process.argv`, which here is this action's own command line.
   */
  readonly flags: readonly string[];
  /** Environment npm would see. The publish's own environment. */
  readonly env: NodeJS.ProcessEnv;
}

export interface NpmInternals {
  /** Version of the npm the modules were loaded from. */
  readonly npmVersion: string;
  /** Directory of that npm package. */
  readonly npmDir: string;
  readonly pickRegistry: PickRegistry;
  /**
   * Load npm's layered configuration for a project. Undefined on npm 6,
   * which predates `@npmcli/config`.
   */
  readonly loadConfig: ((options: LoadConfigOptions) => Promise<LoadedConfig>) | undefined;
  /**
   * Read the manifest `npm publish` would read, normalised as npm
   * normalises it: the name trimmed, for one, which decides the scope.
   * Reading package.json raw would let `" @s/p "` look unscoped while npm
   * publishes it as `@s/p`.
   */
  readonly readManifest: (
    target: ManifestTarget,
    opts: Readonly<Record<string, unknown>>,
  ) => Promise<Manifest>;
}

/**
 * Where npm keeps its configuration definitions. They moved into
 * `@npmcli/config` in npm 9; npm 7 and 8 keep them in npm itself. Order
 * does not matter for correctness, since exactly one exists in any npm,
 * but the current layout is tried first.
 */
export const DEFINITION_LOCATIONS: readonly string[] = [
  '@npmcli/config/lib/definitions',
  './lib/utils/config/index.js',
];

interface Definitions {
  definitions: unknown;
  shorthands: unknown;
  flatten: unknown;
}

interface ConfigInstance {
  load(): Promise<void>;
  get(key: string): unknown;
  find(key: string): string | null;
  readonly flat: Record<string, unknown>;
  readonly data?: Map<string, { raw?: Record<string, unknown> }>;
  readonly globalPrefix?: unknown;
  validate?: () => boolean;
  getCredentialsByURI?: (uri: string) => Credentials;
  isDefault?: (key: string) => boolean;
}

type ConfigConstructor = new (options: Record<string, unknown>) => ConfigInstance;

function loadDefinitions(req: NodeJS.Require, npmRoot: string, npmVersion: string): Definitions {
  for (const location of DEFINITION_LOCATIONS) {
    const resolved = resolveInTree(req, location, npmRoot);
    if (resolved === undefined) continue;
    const defs = loadResolved(req, resolved, `'${location}'`, npmVersion) as Partial<Definitions>;
    if (
      defs.definitions && typeof defs.definitions === 'object' &&
      defs.shorthands && typeof defs.shorthands === 'object' &&
      typeof defs.flatten === 'function'
    ) {
      return defs as Definitions;
    }
    throw new NpmInternalsError(
      `npm ${npmVersion}: '${location}' loaded but does not export ` +
        'definitions, shorthands and flatten.',
    );
  }
  throw new NpmInternalsError(
    `npm ${npmVersion}: configuration definitions not found at any known ` +
      `location (${DEFINITION_LOCATIONS.join(', ')}). This npm's layout is ` +
      'not one this action supports yet.',
  );
}

/** Load npm's layered configuration for a project, as npm itself does. */
async function loadConfigFrom(
  Config: ConfigConstructor,
  tree: NpmTree,
  { cwd, flags, env }: LoadConfigOptions,
): Promise<LoadedConfig> {
  const { req, npmDir, npmRoot, npmVersion } = tree;
  const defs = loadDefinitions(req, npmRoot, npmVersion);
  const instance = new Config({
    definitions: defs.definitions,
    shorthands: defs.shorthands,
    flatten: defs.flatten,
    npmPath: npmDir,
    // nopt skips the first two entries, as it would for
    // `node npm-cli.js <flags>`.
    argv: [process.execPath, path.join(npmDir, 'bin', 'npm-cli.js'), ...flags],
    cwd,
    env,
  });
  await instance.load();
  assertLauncherRunsTree(instance.globalPrefix, tree);
  // Materialise the flattened options now, before anything else touches
  // the configuration. npm does exactly this: npm.js reads flatOptions
  // straight after config.load(), and only then constructs the command,
  // whose constructor runs validate(). validate() coerces values in place
  // -- on npm 9 and later it turns a parsed `scope=null` into the string
  // "null" -- but the cached flat object npm publishes with was built
  // beforehand, so npm never sees the coercion. Reading flat after
  // validate() would.
  const flat = instance.flat;
  const flatten = defs.flatten as (
    source: Readonly<Record<string, unknown>>,
    target: Record<string, unknown>,
  ) => void;
  const cliKeys = new Set(Object.keys(instance.data?.get('cli')?.raw ?? {}));
  // Present on every npm from 8 (measured to 12), and needed only by the
  // trusted-publishing checks, which require npm 11.5.2. npm 7 lacks
  // isDefault, and its configuration must still load for registry
  // resolution, so absence fails closed where a lookup is asked for rather
  // than here -- never falling back to a guess.
  const lookup = <A extends unknown[], R>(
    name: 'getCredentialsByURI' | 'isDefault',
  ): ((...args: A) => R) => {
    const method = instance[name] as ((...args: A) => R) | undefined;
    if (typeof method === 'function') return (...args) => method.apply(instance, args);
    return () => {
      throw new NpmInternalsError(`npm ${npmVersion}: @npmcli/config has no ${name}.`);
    };
  };
  return {
    get: (key) => instance.get(key),
    find: (key) => instance.find(key) as ConfigLayer | null,
    get flat() {
      return flat;
    },
    cliKeys,
    flatten: (source, target) => flatten(source, target),
    validate: () => {
      // Present on every npm from 7 to 11; guarded, not assumed.
      if (typeof instance.validate !== 'function') return;
      try {
        instance.validate();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EINVALID';
        throw new NpmInternalsError(
          `npm ${npmVersion} rejects its configuration (${code}), so ` +
            'npm publish would fail. Check the .npmrc files and ' +
            'npm_config_* variables in effect for this project.',
        );
      }
    },
    getCredentialsByURI: lookup<[string], Credentials>('getCredentialsByURI'),
    isDefault: lookup<[string], boolean>('isDefault'),
  };
}

/** Load npm's internals from the npm package at `npmDir`. */
export function loadNpmInternals(npmDir: string = locateNpm()): NpmInternals {
  const npmRoot = realpathSync(npmDir);
  const req = createRequire(path.join(npmRoot, 'package.json'));

  const npmVersion = (req('./package.json') as { version?: unknown }).version;
  if (typeof npmVersion !== 'string') {
    throw new NpmInternalsError(`${npmDir} has no npm version in package.json.`);
  }
  // Before any of npm's code runs: every module it could require, however
  // deep and however late, must be the one npm ships.
  assertClosureInTree(npmRoot, npmVersion);
  const major = Number(npmVersion.split('.')[0]);

  const fetchPath = resolveInTree(req, 'npm-registry-fetch', npmRoot);
  if (fetchPath === undefined) {
    throw new NpmInternalsError(
      `npm ${npmVersion}: cannot load npm-registry-fetch from its own tree ` +
        '(not found).',
    );
  }
  const pickRegistry = (
    loadResolved(req, fetchPath, 'npm-registry-fetch', npmVersion) as { pickRegistry?: unknown }
  ).pickRegistry;
  if (typeof pickRegistry !== 'function') {
    throw new NpmInternalsError(`npm ${npmVersion}: npm-registry-fetch exports no pickRegistry.`);
  }

  // Absence is expected only on npm 6, which predates @npmcli/config. On any
  // later npm a missing copy is a broken installation, not a capability
  // gap, and reporting it as one would quietly change what is checked.
  const configPath = resolveInTree(req, '@npmcli/config', npmRoot);
  if (configPath === undefined && major >= 7) {
    throw new NpmInternalsError(
      `npm ${npmVersion}: @npmcli/config is missing from its own tree, ` +
        'though every npm from 7 ships it. The installation is incomplete.',
    );
  }
  const Config =
    configPath === undefined
      ? undefined
      : (loadResolved(req, configPath, '@npmcli/config', npmVersion) as ConfigConstructor);

  const tree: NpmTree = { req, npmDir, npmRoot, npmVersion };
  const loadConfig =
    Config === undefined
      ? undefined
      : (options: LoadConfigOptions) => loadConfigFrom(Config, tree, options);

  return {
    npmVersion,
    npmDir,
    pickRegistry: pickRegistry as PickRegistry,
    loadConfig,
    readManifest: (target, opts) => readManifestFrom(tree, target, opts),
  };
}
