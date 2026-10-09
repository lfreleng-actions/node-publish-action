// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Workspace confinement and tarball staging, against a real filesystem.
 */

import {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputError } from '../src/inputs.js';
import { STAGED_NAME } from '../src/state.js';
import {
  anchor,
  assertStillConfined,
  confineNodeVersionFile,
  confineProject,
  isSameRegularFile,
  isWithin,
  printable,
  resolveTarball,
  runnerDirs,
  STAGE_OPEN_FLAGS,
  stageTarball,
  type RunnerDirs,
} from '../src/workspace.js';

let root: string;
let outside: string;
let dirs: RunnerDirs;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workspace-test-')));
  outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'workspace-outside-')));
  mkdirSync(path.join(root, 'ws', 'project'), { recursive: true });
  mkdirSync(path.join(root, 'temp'));
  writeFileSync(path.join(root, 'ws', 'project', 'package.json'), '{}');
  dirs = runnerDirs({
    GITHUB_WORKSPACE: path.join(root, 'ws'),
    RUNNER_TEMP: path.join(root, 'temp'),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ws = (...parts: string[]) => path.join(root, 'ws', ...parts);

describe('runnerDirs', () => {
  it.each([
    ['GITHUB_WORKSPACE unset', { RUNNER_TEMP: '/' }, 'GITHUB_WORKSPACE'],
    ['GITHUB_WORKSPACE empty', { GITHUB_WORKSPACE: '', RUNNER_TEMP: '/' }, 'GITHUB_WORKSPACE'],
    ['RUNNER_TEMP missing', { GITHUB_WORKSPACE: '/', RUNNER_TEMP: '/no/such/dir' }, 'RUNNER_TEMP'],
  ])('refuses %s, which would make every boundary vacuous', (_label, env, name) => {
    expect(() => runnerDirs(env)).toThrow(`${name} not set to a directory`);
  });

  it('resolves the boundary through symlinks', () => {
    const link = path.join(root, 'link');
    symlinkSync(path.join(root, 'ws'), link);
    expect(runnerDirs({ GITHUB_WORKSPACE: link, RUNNER_TEMP: root }).boundary).toBe(ws());
  });
});

describe('isWithin and anchor', () => {
  it.each([
    ['/w/a', '/w', false, true],
    ['/w', '/w', true, true],
    ['/w', '/w', false, false],
    ['/wx', '/w', true, false],
    ['/a', '/', false, true],
  ])('isWithin(%j, %j, allowRoot=%j) is %j', (resolved, boundary, allowRoot, want) => {
    expect(isWithin(resolved, boundary, allowRoot)).toBe(want);
  });

  it('anchors a relative value to the workspace and leaves an absolute one', () => {
    expect(anchor('a/b', '/w')).toBe(path.join('/w', 'a', 'b'));
    expect(anchor('/etc', '/w')).toBe('/etc');
  });

  it('strips control characters before a path is logged', () => {
    expect(printable('a\nb\r\u001bc')).toBe('abc');
  });
});

describe('confineProject', () => {
  it('resolves a project inside the workspace', () => {
    expect(confineProject('project', dirs)).toBe(ws('project'));
  });

  it('accepts the workspace itself', () => {
    writeFileSync(ws('package.json'), '{}');
    expect(confineProject('.', dirs)).toBe(ws());
  });

  it.each([
    ['an absolute path outside', () => outside, 'escapes the workspace'],
    ['a relative escape', () => path.relative(ws(), outside), 'escapes the workspace'],
    ['a missing directory', () => 'missing', 'invalid project directory'],
  ])('refuses %s', (_label, value, message) => {
    writeFileSync(path.join(outside, 'package.json'), '{}');
    expect(() => confineProject(value(), dirs)).toThrow(message);
  });

  it('refuses a symlink that leaves the workspace', () => {
    writeFileSync(path.join(outside, 'package.json'), '{}');
    symlinkSync(outside, ws('escape'));
    expect(() => confineProject('escape', dirs)).toThrow('escapes the workspace');
  });

  it('requires a package.json', () => {
    mkdirSync(ws('empty'));
    expect(() => confineProject('empty', dirs)).toThrow('no package.json');
  });
});

describe('confineNodeVersionFile', () => {
  it('accepts an empty value and a file in the workspace', () => {
    writeFileSync(ws('.nvmrc'), '22\n');
    expect(() => confineNodeVersionFile('', dirs)).not.toThrow();
    expect(() => confineNodeVersionFile('.nvmrc', dirs)).not.toThrow();
  });

  it('refuses a missing file and one outside the workspace', () => {
    writeFileSync(path.join(outside, '.nvmrc'), '22\n');
    expect(() => confineNodeVersionFile('.nvmrc', dirs)).toThrow('not found');
    expect(() => confineNodeVersionFile(path.join(outside, '.nvmrc'), dirs)).toThrow(
      'node_version_file escapes the workspace',
    );
  });
});

describe('resolveTarball', () => {
  beforeEach(() => {
    mkdirSync(ws('tbcase'));
    writeFileSync(ws('tbcase', 'ok.tgz'), 'archive bytes');
    writeFileSync(ws('tbcase', 'wrong.txt'), 'archive bytes');
    mkdirSync(ws('tbcase', 'adir'));
    // A directory whose name ends in .tgz clears the extension check, so
    // only the file-type test can reject it.
    mkdirSync(ws('tbcase', 'dir.tgz'));
    writeFileSync(path.join(outside, 'escape.tgz'), 'archive bytes');
    symlinkSync(path.join(outside, 'escape.tgz'), ws('tbcase', 'symlink.tgz'));
  });

  it('resolves a relative or absolute path inside the workspace', () => {
    expect(resolveTarball('tbcase/ok.tgz', dirs)).toBe(ws('tbcase', 'ok.tgz'));
    expect(resolveTarball(ws('tbcase', 'ok.tgz'), dirs)).toBe(ws('tbcase', 'ok.tgz'));
  });

  it('follows a symlink that stays inside the workspace', () => {
    symlinkSync(ws('tbcase', 'ok.tgz'), ws('tbcase', 'inside.tgz'));
    expect(resolveTarball('tbcase/inside.tgz', dirs)).toBe(ws('tbcase', 'ok.tgz'));
  });

  it.each([
    ['wrong extension', 'tbcase/wrong.txt', 'must name a .tgz file'],
    ['missing file', 'tbcase/nope.tgz', 'cannot resolve tarball_path'],
    ['directory', 'tbcase/adir', 'tarball_path is not a file'],
    ['directory named .tgz', 'tbcase/dir.tgz', 'tarball_path is not a file'],
    ['relative escape', '../escape.tgz', 'cannot resolve tarball_path'],
    ['symlink escape', 'tbcase/symlink.tgz', 'tarball escapes the workspace'],
    // Refused on the raw input: resolving first would silently test the
    // newline-free sibling instead.
    ['trailing newline', 'tbcase/ok.tgz\n', 'line break'],
    ['carriage return', 'tbcase/ok.tgz\r', 'line break'],
  ])('refuses %s', (_label, value, message) => {
    expect(() => resolveTarball(value, dirs)).toThrow(InputError);
    expect(() => resolveTarball(value, dirs)).toThrow(message);
  });

  it('refuses an absolute path outside the workspace', () => {
    expect(() => resolveTarball(path.join(outside, 'escape.tgz'), dirs)).toThrow(
      'tarball escapes the workspace',
    );
  });

  it('refuses the workspace itself', () => {
    expect(() => resolveTarball('.', dirs)).toThrow('tarball escapes the workspace');
  });
});

describe('stageTarball', () => {
  it('copies the bytes into the work directory', () => {
    writeFileSync(ws('ok.tgz'), 'archive bytes');
    const staged = stageTarball(ws('ok.tgz'), dirs.runnerTemp);
    expect(staged).toBe(path.join(dirs.runnerTemp, STAGED_NAME));
    expect(readFileSync(staged, 'utf8')).toBe('archive bytes');
  });

  // The boundary check resolved the path, but the file may since have been
  // swapped for a link out of the workspace. Staging must not follow it.
  it('refuses a source that became a symlink, and stages nothing', () => {
    writeFileSync(path.join(outside, 'secret.tgz'), 'outside bytes');
    symlinkSync(path.join(outside, 'secret.tgz'), ws('swapped.tgz'));
    expect(() => stageTarball(ws('swapped.tgz'), dirs.runnerTemp)).toThrow(
      'the tarball was replaced while being staged',
    );
    expect(readdirSync(dirs.runnerTemp)).toEqual([]);
  });

  // Where O_NOFOLLOW is unavailable the open follows the link, and the
  // identity check is what refuses it.
  it('refuses a swapped symlink even when the open follows it', () => {
    writeFileSync(path.join(outside, 'secret.tgz'), 'outside bytes');
    symlinkSync(path.join(outside, 'secret.tgz'), ws('swapped.tgz'));
    expect(() => stageTarball(ws('swapped.tgz'), dirs.runnerTemp, constants.O_RDONLY)).toThrow(
      'the tarball was replaced while being staged',
    );
    expect(readdirSync(dirs.runnerTemp)).toEqual([]);
  });

  // The swap-back race cannot be staged deterministically, so the identity
  // test that catches it is checked directly.
  it('tells two regular files apart by identity, not just type', () => {
    writeFileSync(ws('a.tgz'), 'a');
    writeFileSync(ws('b.tgz'), 'b');
    const a = lstatSync(ws('a.tgz'), { bigint: true });
    const b = lstatSync(ws('b.tgz'), { bigint: true });
    expect(isSameRegularFile(a, lstatSync(ws('a.tgz'), { bigint: true }))).toBe(true);
    expect(isSameRegularFile(a, b)).toBe(false);
    expect(isSameRegularFile(a, lstatSync(ws(), { bigint: true }))).toBe(false);
  });

  it('opens without following a link wherever the platform allows', () => {
    if (constants.O_NOFOLLOW === undefined) return;
    expect(STAGE_OPEN_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  // Copied in bounded chunks, so the archive's size does not set the
  // step's memory use. Spans several chunks and a partial last one.
  it('copies an archive larger than one chunk byte for byte', () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 12345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    writeFileSync(ws('large.tgz'), bytes);
    const staged = stageTarball(ws('large.tgz'), dirs.runnerTemp);
    expect(readFileSync(staged).equals(bytes)).toBe(true);
  });

  it('refuses a source that became a FIFO, without blocking on it', () => {
    const fifo = ws('fifo.tgz');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return;
    expect(() => stageTarball(fifo, dirs.runnerTemp)).toThrow('replaced while being staged');
    expect(readdirSync(dirs.runnerTemp)).toEqual([]);
  });
});

describe('assertStillConfined', () => {
  it('accepts a directory that still resolves to itself', () => {
    expect(() => assertStillConfined(ws('project'), dirs.boundary)).not.toThrow();
  });

  // Lifecycle scripts run between the publish and its verification, and
  // the directory is repository content.
  it('refuses a directory swapped for a link out of the workspace', () => {
    renameSync(ws('project'), ws('moved'));
    symlinkSync(outside, ws('project'));
    expect(() => assertStillConfined(ws('project'), dirs.boundary)).toThrow(
      'no longer resolves where it did',
    );
  });

  it('refuses a directory that has gone', () => {
    rmSync(ws('project'), { recursive: true });
    expect(() => assertStillConfined(ws('project'), dirs.boundary)).toThrow('has disappeared');
  });
});
