// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Confine the action's paths to the workspace, and stage a tarball outside
 * it.
 *
 * Relative values anchor to GITHUB_WORKSPACE rather than the working
 * directory: a composite action can run with a caller-set working directory,
 * so resolving against it would be non-deterministic. Every path is resolved
 * before it is judged, so a symlink counts as its target.
 */

import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { InputError } from './inputs.js';
import { STAGED_NAME } from './state.js';

/** The runner directories the boundary checks depend on, resolved. */
export interface RunnerDirs {
  /** GITHUB_WORKSPACE, as given: relative inputs anchor here. */
  readonly workspace: string;
  /** GITHUB_WORKSPACE with symlinks resolved: the boundary itself. */
  readonly boundary: string;
  readonly runnerTemp: string;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Read the runner directories. An empty value would make every boundary
 * check vacuous, so both must name an existing directory.
 */
export function runnerDirs(env: NodeJS.ProcessEnv): RunnerDirs {
  for (const name of ['GITHUB_WORKSPACE', 'RUNNER_TEMP']) {
    const value = env[name];
    if (!value || !isDirectory(value)) {
      throw new InputError(
        `${name} not set to a directory. This action requires a standard runner environment`,
      );
    }
  }
  const workspace = env['GITHUB_WORKSPACE'] as string;
  return {
    workspace,
    boundary: realpathSync(workspace),
    runnerTemp: env['RUNNER_TEMP'] as string,
  };
}

/** Whether `resolved` lies under `root`, or is `root` when `allowRoot`. */
export function isWithin(resolved: string, root: string, allowRoot: boolean): boolean {
  if (resolved === root) return allowRoot;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved.startsWith(prefix);
}

/** Anchor a relative input to the workspace; an absolute one stands. */
export function anchor(value: string, workspace: string): string {
  return path.isAbsolute(value) ? value : path.join(workspace, value);
}

/**
 * Remove control characters before a path reaches a log line. Workflow
 * commands are escaped on output, but a plain log line is not, and the path
 * is caller input.
 */
export function printable(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * The project directory: it must exist, resolve within the workspace and
 * hold a package.json. Publishing from anywhere else could pack and publish
 * arbitrary runner content.
 */
export function confineProject(pathPrefix: string, dirs: RunnerDirs): string {
  const candidate = anchor(pathPrefix, dirs.workspace);
  if (!isDirectory(candidate)) {
    throw new InputError(`invalid project directory. Path not found: ${printable(candidate)}`);
  }
  const resolved = realpathSync(candidate);
  if (!isWithin(resolved, dirs.boundary, true)) {
    throw new InputError(
      'project directory escapes the workspace. path_prefix must resolve within GITHUB_WORKSPACE',
    );
  }
  if (!isFile(path.join(resolved, 'package.json'))) {
    throw new InputError('no package.json in project directory');
  }
  return resolved;
}

/**
 * node_version_file must name a file within the workspace. setup-node has
 * read it by now; this keeps an escaping value from passing unremarked.
 */
export function confineNodeVersionFile(nodeVersionFile: string, dirs: RunnerDirs): void {
  if (nodeVersionFile === '') return;
  const candidate = anchor(nodeVersionFile, dirs.workspace);
  if (!isFile(candidate)) {
    throw new InputError('node_version_file not found');
  }
  if (!isWithin(realpathSync(candidate), dirs.boundary, true)) {
    throw new InputError('node_version_file escapes the workspace');
  }
}

/**
 * Resolve tarball_path to a .tgz file inside the workspace.
 *
 * Line breaks are refused on the raw input, before anything resolves it:
 * the resolved path becomes a step output, and a value carrying one names a
 * different file from the one a log line would show.
 */
export function resolveTarball(tarballPath: string, dirs: RunnerDirs): string {
  if (/[\r\n]/.test(tarballPath)) {
    throw new InputError('tarball_path contains a line break');
  }
  const candidate = anchor(tarballPath, dirs.workspace);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new InputError(`cannot resolve tarball_path. Path not found: ${printable(tarballPath)}`);
  }
  if (!isWithin(resolved, dirs.boundary, false)) {
    throw new InputError('tarball escapes the workspace. tarball_path must resolve within GITHUB_WORKSPACE');
  }
  // A symlink can resolve to a target that carries one even when the
  // input did not.
  if (/[\r\n]/.test(resolved)) {
    throw new InputError('resolved tarball path contains a line break');
  }
  if (!isFile(resolved)) {
    throw new InputError(`tarball_path is not a file. Path: ${printable(resolved)}`);
  }
  if (!resolved.endsWith('.tgz')) {
    throw new InputError(
      'tarball_path must name a .tgz file. npm pack produces .tgz; npm ' +
        'publish rejects other extensions after the credential setup has run',
    );
  }
  return resolved;
}

/**
 * How the source archive is opened: read-only, not through a final
 * symlink, and without waiting on a FIFO.
 *
 * O_NOFOLLOW and O_NONBLOCK are POSIX; where a platform lacks one the flag
 * contributes nothing, and the identity check in {@link stageTarball} is
 * what still refuses a swapped file. Every POSIX runner defines both, so
 * the FIFO case cannot arise without O_NONBLOCK.
 */
export const STAGE_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The copy buffer: bounded, so archive size does not set memory use. */
const COPY_CHUNK = 1024 * 1024;

/** Copy everything readable from `from` to `to`, a chunk at a time. */
function copyDescriptor(from: number, to: number): void {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  for (;;) {
    const read = readSync(from, buffer, 0, COPY_CHUNK, null);
    if (read === 0) return;
    for (let written = 0; written < read; ) {
      written += writeSync(to, buffer, written, read - written);
    }
  }
}

const REPLACED = 'the tarball was replaced while being staged';

/**
 * Whether an open descriptor's status and a path's lstat describe the
 * same regular file. Device and inode, not just type: a link swapped in
 * for the open and swapped back before the lstat leaves two regular
 * files, and only their identity tells them apart.
 */
export function isSameRegularFile(opened: BigIntStats, named: BigIntStats): boolean {
  return (
    opened.isFile() && named.isFile() && opened.dev === named.dev && opened.ino === named.ino
  );
}

/**
 * Copy the archive into the work directory before anything reads it.
 *
 * Every later check opens the archive, and so does npm publish. On the
 * workspace path each open is a fresh chance to substitute the file, and no
 * digest taken around a read can close that. Copying first removes the race
 * rather than narrowing it: the bytes validated are the bytes published,
 * because they are the same file, somewhere repository content cannot reach.
 *
 * The source is opened once and read through that descriptor. The
 * boundary check resolved the path, but the file there is still repository
 * content and may since have become a link out of the workspace. So the
 * descriptor must be a regular file *and* the very file the path names now:
 * its device and inode must match an lstat of the path. A swapped link
 * fails that whether or not O_NOFOLLOW stopped the open, and a link
 * swapped back again fails it too, since the descriptor then names another
 * file.
 */
export function stageTarball(
  resolved: string,
  workDir: string,
  openFlags: number = STAGE_OPEN_FLAGS,
): string {
  const staged = path.join(workDir, STAGED_NAME);
  let fd: number;
  try {
    fd = openSync(resolved, openFlags);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new InputError(
      code === 'ELOOP' ? REPLACED : `cannot stage the tarball (${code ?? 'unknown error'})`,
    );
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    let named;
    try {
      named = lstatSync(resolved, { bigint: true });
    } catch {
      throw new InputError(REPLACED);
    }
    if (!isSameRegularFile(opened, named)) {
      throw new InputError(REPLACED);
    }
    const out = openSync(staged, 'wx', 0o600);
    try {
      copyDescriptor(fd, out);
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
  return staged;
}

/**
 * Re-check, at the point of use, that a directory resolved earlier still
 * resolves to itself inside the workspace. The workspace is mutable, and
 * lifecycle scripts run between the publish and its verification, so a
 * validated directory may since have become a link out of it.
 */
export function assertStillConfined(projectDir: string, boundary: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(projectDir);
  } catch {
    throw new InputError('the project directory has disappeared');
  }
  if (resolved !== projectDir || !isWithin(resolved, boundary, true)) {
    throw new InputError(
      'the project directory no longer resolves where it did. It must stay within GITHUB_WORKSPACE',
    );
  }
  // A file swapped in at the same path resolves too, and npm could not run
  // there: a verification failing for that reason would read as an
  // unreadable registry and pass with a warning.
  if (!isDirectory(resolved)) {
    throw new InputError('the project directory has been replaced by something that is not a directory');
  }
}
