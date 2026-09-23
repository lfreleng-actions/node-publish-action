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

import { realpathSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Raised when npm's internals cannot be located or loaded. */
export class NpmInternalsError extends Error {}

/** The layer a configuration value came from, as npm names it. */
export type ConfigLayer = 'default' | 'builtin' | 'global' | 'user' | 'project' | 'env' | 'cli';

/** npm's `pickRegistry(spec, opts)` from npm-registry-fetch. */
export type PickRegistry = (spec: string, opts: Readonly<Record<string, unknown>>) => string;

/** The slice of a loaded `@npmcli/config` instance this action relies on. */
export interface LoadedConfig {
  /** The effective value of `key`, or undefined when no layer sets it. */
  get(key: string): unknown;
  /** The layer that set `key`, or null when none did. */
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
  validate?: () => boolean;
}

type ConfigConstructor = new (options: Record<string, unknown>) => ConfigInstance;

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    // Any execute bit: the runner resolves commands for its own user, and
    // a stricter check would need uid/gid comparisons that add nothing
    // here, since spawning is what finally proves it.
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function packageName(dir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'name' in parsed) {
      const { name } = parsed as { name: unknown };
      return typeof name === 'string' ? name : undefined;
    }
  } catch {
    // Missing or unreadable: not the npm package.
  }
  return undefined;
}

/**
 * The directory of the npm package that `npm` on `PATH` runs.
 *
 * Resolved from the executable rather than asked of npm (`npm root -g`),
 * because the answer to that question is itself configuration: a project
 * `.npmrc` setting `prefix` moves it to where npm is not installed. The
 * executable is what `npm publish` will actually run.
 */
export function locateNpm(pathEnv: string | undefined = process.env['PATH']): string {
  for (const entry of (pathEnv ?? '').split(path.delimiter)) {
    if (entry === '') continue;
    const candidate = path.join(entry, 'npm');
    if (!isExecutableFile(candidate)) continue;

    let dir = path.dirname(realpathSync(candidate));
    // setup-node and npm's own installer both link bin/npm to
    // <prefix>/lib/node_modules/npm/bin/npm-cli.js; walking up from the
    // real target finds the package whatever the depth.
    for (;;) {
      if (packageName(dir) === 'npm') return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // The first npm on PATH is the one that runs. Settling for a later
    // one would load internals from an npm that does not publish.
    throw new NpmInternalsError(
      `The 'npm' found on PATH at ${candidate} does not resolve to an npm ` +
        'package directory. Install npm through actions/setup-node, or ' +
        "ensure the first 'npm' on PATH is a standard npm installation.",
    );
  }
  throw new NpmInternalsError(
    "No 'npm' executable found on PATH. This step runs after " +
      'actions/setup-node, which should have provided one.',
  );
}

function loadDefinitions(req: NodeJS.Require, npmVersion: string): Definitions {
  for (const location of DEFINITION_LOCATIONS) {
    let loaded: unknown;
    try {
      loaded = req(location);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
      throw err;
    }
    const defs = loaded as Partial<Definitions>;
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

/** Load npm's internals from the npm package at `npmDir`. */
export function loadNpmInternals(npmDir: string = locateNpm()): NpmInternals {
  const req = createRequire(path.join(npmDir, 'package.json'));

  const npmVersion = (req('./package.json') as { version?: unknown }).version;
  if (typeof npmVersion !== 'string') {
    throw new NpmInternalsError(`${npmDir} has no npm version in package.json.`);
  }

  let pickRegistry: unknown;
  try {
    pickRegistry = (req('npm-registry-fetch') as { pickRegistry?: unknown }).pickRegistry;
  } catch (err) {
    throw new NpmInternalsError(
      `npm ${npmVersion}: cannot load npm-registry-fetch from its own tree ` +
        `(${(err as Error).message.split('\n')[0]}).`,
    );
  }
  if (typeof pickRegistry !== 'function') {
    throw new NpmInternalsError(`npm ${npmVersion}: npm-registry-fetch exports no pickRegistry.`);
  }

  let Config: ConfigConstructor | undefined;
  try {
    Config = req('@npmcli/config') as ConfigConstructor;
  } catch (err) {
    // npm 6 predates @npmcli/config. Any other failure is a real fault.
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw err;
  }

  const loadConfig =
    Config === undefined
      ? undefined
      : async ({ cwd, flags, env }: LoadConfigOptions): Promise<LoadedConfig> => {
          const defs = loadDefinitions(req, npmVersion);
          const instance = new (Config as ConfigConstructor)({
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
          // Materialise the flattened options now, before anything else
          // touches the configuration. npm does exactly this: npm.js reads
          // flatOptions straight after config.load(), and only then
          // constructs the command, whose constructor runs validate().
          // validate() coerces values in place -- on npm 9 and later it
          // turns a parsed `scope=null` into the string "null" -- but the
          // cached flat object npm publishes with was built beforehand, so
          // npm never sees the coercion. Reading flat after validate()
          // would.
          const flat = instance.flat;
          const flatten = defs.flatten as (
            source: Readonly<Record<string, unknown>>,
            target: Record<string, unknown>,
          ) => void;
          const cliKeys = new Set(Object.keys(instance.data?.get('cli')?.raw ?? {}));
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
          };
        };

  return { npmVersion, npmDir, pickRegistry: pickRegistry as PickRegistry, loadConfig };
}
