// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Confinement primitives shared by the modules that load npm's code.
 *
 * Everything this action loads from npm goes through here, so the guarantee
 * that it is the publishing npm's own code -- and not a copy found by
 * walking up out of npm's tree -- holds in one place.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Raised when npm's internals cannot be located or loaded. */
export class NpmInternalsError extends Error {}

/** What loadConfig needs to know about the npm it loads from. */
export interface NpmTree {
  readonly req: NodeJS.Require;
  readonly npmDir: string;
  readonly npmRoot: string;
  readonly npmVersion: string;
}

/**
 * Resolve `spec` from npm's tree, or undefined when npm has no such module.
 *
 * Two guarantees the module loader alone does not give:
 *
 * - **Confinement.** createRequire starts resolution in npm's directory but
 *   does not stop there: a bare specifier walks up into parent
 *   node_modules. With npm's bundled copy missing, a globally installed
 *   sibling beside npm would load instead -- code from a different npm.
 *   The resolved path must therefore lie inside npm's own tree.
 * - **Absence, told apart from failure.** Resolving does not evaluate the
 *   module, so a resolution failure means the module itself is missing.
 *   Loading happens separately, where a missing *transitive* dependency is
 *   an error rather than a signal to try another location.
 */
export function resolveInTree(
  req: NodeJS.Require,
  spec: string,
  npmRoot: string,
): string | undefined {
  let resolved: string;
  try {
    resolved = realpathSync(req.resolve(spec));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw err;
  }
  if (!resolved.startsWith(npmRoot + path.sep)) {
    throw new NpmInternalsError(
      `'${spec}' resolves outside npm's own tree, to ${resolved}. Refusing ` +
        'to load it: it is not the code the publishing npm runs.',
    );
  }
  return resolved;
}

/**
 * The installed directory of package `name` as Node would resolve it from
 * the package at `from`: `from`'s own node_modules first, then each
 * ancestor's. Undefined when no directory on that path holds it.
 */
function locatePackage(name: string, from: string): string | undefined {
  for (let dir = from; ; ) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The file `require(name)` loads from the package at `dir`, or undefined
 * when it resolves to nothing and so cannot load anything at all.
 */
function resolveEntry(name: string, dir: string): string | undefined {
  try {
    return realpathSync(createRequire(path.join(dir, 'package.json')).resolve(name));
  } catch {
    return undefined;
  }
}

/**
 * The directory of npm's dependency `name`, required from `dir`, to walk
 * next. Throws when anything Node would load for it lies outside npm's
 * tree.
 *
 * The package directory alone does not answer that. Node loads the first
 * match on its search path, and a lone `name.js` or a directory with only
 * an index.js matches without being a package, so the entry Node resolves
 * is checked as well as the directory walked.
 */
function locateDependency(
  name: string,
  dir: string,
  npmRoot: string,
  npmVersion: string,
): string | undefined {
  const found = locatePackage(name, dir);
  for (const location of [resolveEntry(name, dir), found]) {
    if (location !== undefined && !location.startsWith(npmRoot + path.sep)) {
      throw new NpmInternalsError(
        `npm ${npmVersion}: its dependency '${name}' resolves outside npm's ` +
          `own tree, to ${location}. The installation is incomplete; refusing ` +
          'to run code the publishing npm does not ship.',
      );
    }
  }
  return found;
}

/** The manifest fields naming packages a package may require. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
] as const;

/**
 * Refuse an npm installation whose dependency graph reaches outside it.
 *
 * resolveInTree confines the modules this action asks for, but not what
 * they require in turn. A missing dependency deep inside npm walks up out of
 * npm's tree, as any bare require does, and a sibling installed beside npm
 * would be *executed* instead. A partial install would run another
 * package's code rather than failing.
 *
 * So before anything of npm's is evaluated, walk npm's declared dependency
 * graph and require that every package resolves inside npm's tree. npm
 * bundles exactly its `dependencies`, and every module this action loads is
 * one of them, so the walk covers everything the loader can reach. That
 * includes modules npm requires lazily at call time, which a hook active only
 * while loading would miss. Optional and peer dependencies are walked too:
 * npm may not install them, but a package requires them like any other, and
 * a peer named only in peerDependenciesMeta is still one it may require. A
 * declared dependency that resolves to nothing is left alone: requiring it
 * would fail loudly, not load something else.
 *
 * One pass over roughly 150-210 packages: 40-130 ms, as the file cache
 * allows.
 */
export function assertClosureInTree(npmRoot: string, npmVersion: string): void {
  const seen = new Set<string>();
  const pending = [npmRoot];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    let manifest: Partial<Record<(typeof DEPENDENCY_FIELDS)[number], object>>;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof manifest;
    } catch {
      throw new NpmInternalsError(
        `npm ${npmVersion}: cannot read the manifest of ${dir}, inside its own tree.`,
      );
    }
    const names = new Set(
      DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
    );
    for (const name of names) {
      const found = locateDependency(name, dir, npmRoot, npmVersion);
      if (found !== undefined) pending.push(found);
    }
  }
}

/** Load a resolved module, reporting a failure without its stack. */
export function loadResolved(
  req: NodeJS.Require,
  resolved: string,
  what: string,
  npmVersion: string,
): unknown {
  try {
    return req(resolved);
  } catch (err) {
    throw new NpmInternalsError(
      `npm ${npmVersion}: ${what} is present but fails to load ` +
        `(${(err as Error).message.split('\n')[0]}).`,
    );
  }
}
