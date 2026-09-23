// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Find the npm package that `npm publish` will run.
 *
 * Separate from the loading of its internals: this answers which npm, and
 * the loader trusts that answer for everything it loads.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { NpmInternalsError, type NpmTree } from './npm-tree.js';

/**
 * Whether this process may execute `candidate`, as the shell would decide.
 *
 * access(X_OK) rather than the mode bits: it answers for this process's
 * own user and honours ACLs, so it agrees with what executing the file
 * would do. Any execute bit is not the same question.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
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

/** The npm package at or above `dir`, as a linked bin/npm reaches it. */
function enclosingPackage(dir: string): string | undefined {
  for (;;) {
    if (packageName(dir) === 'npm') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The npm package the launcher in `dir` runs, when `dir` is laid out as
 * Node's Windows distribution lays it out.
 *
 * There the launcher is a copy of npm's script beside node.exe, not a
 * link, so there is nothing to follow. It runs
 * `node_modules/npm/bin/npm-cli.js` beside it with that node.exe. Without
 * a node.exe it would run whichever `node` PATH finds and that node's
 * npm, so that layout is not recognised.
 */
function launcherPackage(dir: string): string | undefined {
  const npmDir = path.join(dir, 'node_modules', 'npm');
  if (!isExecutableFile(path.join(dir, 'node.exe'))) return undefined;
  if (!existsSync(path.join(npmDir, 'bin', 'npm-cli.js'))) return undefined;
  return packageName(npmDir) === 'npm' ? npmDir : undefined;
}

/**
 * The directory of the npm package that `npm` on `PATH` runs.
 *
 * Resolved from the executable rather than asked of npm (`npm root -g`),
 * because the answer to that question is itself configuration: a project
 * `.npmrc` setting `prefix` moves it to where npm is not installed. The
 * executable is what `npm publish` will actually run.
 *
 * A relative PATH entry is refused if one comes before the npm found,
 * rather than resolved. POSIX treats an empty entry as the current
 * directory, and resolves `.` and `bin` against it too. This action runs
 * its steps from different directories, so the `npm` such an entry names
 * depends on which step asks: this loader and the publish step could find
 * different ones. Refusing is the only answer that cannot disagree.
 */
export function locateNpm(pathEnv: string | undefined = process.env['PATH']): string {
  if (!pathEnv) {
    throw new NpmInternalsError(
      "No 'npm' executable found: PATH is empty. This step runs after " +
        'actions/setup-node, which should have provided one.',
    );
  }
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) {
      throw new NpmInternalsError(
        `PATH contains a relative entry (${entry === '' ? 'an empty one' : `'${entry}'`}) ` +
          "ahead of any npm. Which 'npm' it names depends on the working " +
          "directory, so this action cannot know it is the npm that " +
          'publishes. Use absolute PATH entries.',
      );
    }
    const candidate = path.join(entry, 'npm');
    if (!isExecutableFile(candidate)) continue;

    // setup-node and npm's own installer both link bin/npm to
    // <prefix>/lib/node_modules/npm/bin/npm-cli.js; walking up from the
    // real target finds the package whatever the depth. On Windows
    // setup-node installs Node's own layout, launcher beside node.exe.
    const found =
      enclosingPackage(path.dirname(realpathSync(candidate))) ?? launcherPackage(entry);
    if (found !== undefined) return found;
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

/**
 * Refuse a configuration under which npm's Windows launcher would run a
 * different npm from the one loaded.
 *
 * That launcher does not always run the npm beside it. It first asks that
 * npm for the global prefix and, when an npm is installed there, runs
 * that one instead. The prefix is configuration, which a project .npmrc
 * can set, so the question can only be answered from the configuration
 * the launcher itself reads -- after npm has loaded it.
 */
export function assertLauncherRunsTree(globalPrefix: unknown, tree: NpmTree): void {
  const { npmDir, npmRoot, npmVersion } = tree;
  if (launcherPackage(path.dirname(path.dirname(npmDir))) === undefined) return;
  if (typeof globalPrefix !== 'string') {
    throw new NpmInternalsError(
      `npm ${npmVersion} reports no global prefix, so the npm its launcher runs is unknown.`,
    );
  }
  const deferred = path.join(globalPrefix, 'node_modules', 'npm');
  if (!existsSync(path.join(deferred, 'bin', 'npm-cli.js'))) return;
  const [a, b] = [statSync(deferred, { bigint: true }), statSync(npmRoot, { bigint: true })];
  if (a.dev === b.dev && a.ino === b.ino) return;
  throw new NpmInternalsError(
    `npm ${npmVersion}'s launcher defers to the npm under its configured ` +
      `prefix, ${globalPrefix}, which would publish instead. Remove that ` +
      'npm or the prefix setting.',
  );
}
