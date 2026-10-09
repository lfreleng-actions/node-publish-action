// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  makeWorkDir,
  readState,
  STAGED_NAME,
  STATE_NAME,
  StateError,
  WORK_PREFIX,
  writeState,
  type PublishState,
} from '../src/state.js';

let runnerTemp: string;
let workDir: string;

const STATE: PublishState = {
  schema: 1,
  npmVersion: '11.0.0',
  npmDir: '/opt/npm',
  projectDir: '/w/project',
  tarball: '',
  publishVersion: '1.2.3',
  dryRun: false,
  tag: 'latest',
  access: 'public',
  provenance: false,
  idTokenEndpoint: false,
  registry: 'https://registry.example.invalid/',
  scopes: ['@a', '@b c'],
};

beforeEach(() => {
  runnerTemp = mkdtempSync(path.join(tmpdir(), 'state-test-'));
  workDir = makeWorkDir(runnerTemp);
});

afterEach(() => {
  rmSync(runnerTemp, { recursive: true, force: true });
});

describe('state', () => {
  it('round-trips through a private work directory', () => {
    expect(path.basename(workDir).startsWith(WORK_PREFIX)).toBe(true);
    const file = writeState(workDir, STATE);
    expect(path.basename(file)).toBe(STATE_NAME);
    expect(readState(file, runnerTemp)).toEqual(STATE);
  });

  it('accepts the staged tarball in the same work directory', () => {
    const tarball = path.join(workDir, STAGED_NAME);
    const file = writeState(workDir, { ...STATE, tarball });
    expect(readState(file, runnerTemp).tarball).toBe(tarball);
  });

  it('refuses a tarball other than the staged copy', () => {
    const file = writeState(workDir, { ...STATE, tarball: '/w/project/pkg.tgz' });
    expect(() => readState(file, runnerTemp)).toThrow('other than the staged copy');
  });

  it('refuses to overwrite an existing state file', () => {
    writeState(workDir, STATE);
    expect(() => writeState(workDir, STATE)).toThrow();
  });

  it.each([
    ['outside RUNNER_TEMP', () => {
      const other = mkdtempSync(path.join(tmpdir(), WORK_PREFIX));
      return path.join(other, STATE_NAME);
    }],
    ['not in a work directory', () => {
      const dir = path.join(runnerTemp, 'elsewhere');
      mkdirSync(dir);
      return path.join(dir, STATE_NAME);
    }],
    ['under another name', () => path.join(workDir, 'other.json')],
  ])('refuses a state file %s', (_label, locate) => {
    const file = locate();
    writeFileSync(file, JSON.stringify(STATE));
    expect(() => readState(file, runnerTemp)).toThrow('not one the prepare step wrote');
  });

  it.each([
    ['unparsable', '{', 'cannot be read'],
    ['not an object', '[]', 'does not hold an object'],
    ['another schema', JSON.stringify({ ...STATE, schema: 2 }), 'schema 2'],
    ['a string boolean', JSON.stringify({ ...STATE, dryRun: 'false' }), 'dryRun is not a boolean'],
    ['an unknown access', JSON.stringify({ ...STATE, access: 'internal' }), 'access is not'],
    ['scopes holding a number', JSON.stringify({ ...STATE, scopes: ['@a', 1] }), 'scopes is not'],
    ['a missing registry', JSON.stringify({ ...STATE, registry: undefined }), 'registry is not'],
  ])('refuses a state file that is %s', (_label, content, message) => {
    writeFileSync(path.join(workDir, STATE_NAME), content);
    expect(() => readState(path.join(workDir, STATE_NAME), runnerTemp)).toThrow(StateError);
    expect(() => readState(path.join(workDir, STATE_NAME), runnerTemp)).toThrow(message);
  });
});
