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
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raised when npm's internals cannot be located or loaded. */
export class NpmInternalsError extends Error {}

/** npm trees whose code may only load modules from inside itself. */
const guardedRoots = new Set<string>();
let guardInstalled = false;

/** The guarded npm tree `file` lies in, if any. */
function guardedRootOf(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  for (const root of guardedRoots) {
    if (file.startsWith(root + path.sep)) return root;
  }
  return undefined;
}

/**
 * Refuse a resolution made from inside a guarded npm tree that lands
 * outside it. Built-in modules resolve to a bare name and pass.
 *
 * The error carries MODULE_NOT_FOUND. To npm's code the module is absent
 * from its tree, which is the truth, so npm's own handling of an optional
 * module that is not installed applies; anything else surfaces this
 * message.
 */
function checkResolution(request: string, resolved: string, parentFile: string | undefined): void {
  const root = guardedRootOf(parentFile);
  if (root === undefined || !path.isAbsolute(resolved)) return;
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Judged by the path Node resolved; it cannot load what does not exist.
  }
  if (real.startsWith(root + path.sep)) return;
  const refusal = new NpmInternalsError(
    `npm's code requested '${request}', which resolves outside npm's own ` +
      `tree, to ${real}. Refusing to load it: it is not code the publishing ` +
      'npm ships. The npm installation is incomplete.',
  );
  (refusal as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
  throw refusal;
}

type ResolveFilename = (request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string;

/**
 * Confine every module npm's code loads to npm's own tree, for the rest of
 * this short-lived process.
 *
 * {@link assertClosureInTree} checks where each dependency's bare name
 * resolves, before anything runs. It cannot see a subpath request such as
 * `require('dep/lib/x')`: for a package without an exports map, Node
 * resolves one by trying each ancestor node_modules, so a file missing from
 * npm's copy falls through to a same-named package beside npm. The only
 * complete answer is to check each resolution as it happens -- including
 * the ones npm makes lazily, when a function first runs.
 *
 * CommonJS resolution is wrapped, which covers every npm this action
 * supports. Where the runtime offers module.registerHooks, it is used too,
 * so import() is covered as well.
 */
export function guardTree(npmRoot: string): void {
  guardedRoots.add(npmRoot);
  if (guardInstalled) return;
  guardInstalled = true;

  // _resolveFilename is internal to Node and absent from its types.
  const loader = Module as typeof Module & { _resolveFilename: ResolveFilename };
  const original = loader._resolveFilename;
  loader._resolveFilename = function (this: unknown, request, parent, ...rest) {
    const resolved = original.call(this, request, parent, ...rest);
    checkResolution(request, resolved, parent?.filename);
    return resolved;
  };

  // Read off the default export, not imported by name: a named import would
  // fail to link on a Node.js that lacks it, and the bundle targets older.
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (result.url.startsWith('file:') && context.parentURL?.startsWith('file:')) {
          checkResolution(specifier, fileURLToPath(result.url), fileURLToPath(context.parentURL));
        }
        return result;
      },
    });
  }
}

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
