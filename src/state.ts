// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The decisions the prepare step hands to the publish step.
 *
 * One JSON document in a private work directory under RUNNER_TEMP, outside
 * the checked-out tree, replaces passing each value through a step output
 * and re-validating it on arrival. It is checked against one schema when
 * read: the publish step trusts nothing else that crossed the boundary.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Access } from './inputs.js';

/** The prefix of a work directory, which the cleanup step matches on. */
export const WORK_PREFIX = 'npmpublish.';

/** The state file's name inside its work directory. */
export const STATE_NAME = 'state.json';

/** The staged archive's name inside its work directory. */
export const STAGED_NAME = 'package.tgz';

const SCHEMA = 1;

export interface PublishState {
  readonly schema: typeof SCHEMA;
  /** The npm whose code made the decisions; the publish must run it. */
  readonly npmVersion: string;
  readonly npmDir: string;
  /** The resolved project directory. */
  readonly projectDir: string;
  /** The staged archive, or '' to pack the project directory. */
  readonly tarball: string;
  readonly publishVersion: string;
  readonly dryRun: boolean;
  readonly tag: string;
  readonly access: Access;
  readonly provenance: boolean;
  /** The registry npm will publish to. */
  readonly registry: string;
  /** Every scope whose `:registry` key npm would consult, to pin. */
  readonly scopes: readonly string[];
}

/** Raised when a state file is missing, malformed or out of place. */
export class StateError extends Error {}

/** Make a private work directory under `runnerTemp`. */
export function makeWorkDir(runnerTemp: string): string {
  return mkdtempSync(path.join(runnerTemp, WORK_PREFIX));
}

/** Remove a work directory and everything in it. */
export function removeWorkDir(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}

/** Write `state` into `workDir`, returning the file's path. */
export function writeState(workDir: string, state: PublishState): string {
  const file = path.join(workDir, STATE_NAME);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

function field<T>(
  data: Record<string, unknown>,
  key: string,
  test: (value: unknown) => value is T,
  expected: string,
): T {
  const value = data[key];
  if (!test(value)) throw new StateError(`state ${key} is not ${expected}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isAccess = (value: unknown): value is Access =>
  value === '' || value === 'public' || value === 'restricted';
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/**
 * Read and check a state file. It must be this action's own: named as
 * prepare names it, directly inside a work directory under `runnerTemp`.
 * A staged tarball must be the one in that same directory.
 */
/**
 * The work directory holding `file`, provided `file` is named as prepare
 * names a state file, directly inside a work directory under `runnerTemp`.
 */
function ownWorkDir(file: string, runnerTemp: string): string {
  const workDir = path.dirname(file);
  if (
    path.basename(file) !== STATE_NAME ||
    path.dirname(workDir) !== path.resolve(runnerTemp) ||
    !path.basename(workDir).startsWith(WORK_PREFIX)
  ) {
    throw new StateError('the state file is not one the prepare step wrote');
  }
  return workDir;
}

/**
 * Remove the work directory holding the state file `file`, refusing
 * anything that is not one: a recursive delete driven by a path that
 * crossed a step boundary is worth being strict about.
 */
export function removeStateDir(file: string, runnerTemp: string): void {
  removeWorkDir(ownWorkDir(file, runnerTemp));
}

export function readState(file: string, runnerTemp: string): PublishState {
  const workDir = ownWorkDir(file, runnerTemp);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new StateError('the state file cannot be read');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new StateError('the state file does not hold an object');
  }
  const record = data as Record<string, unknown>;
  if (record['schema'] !== SCHEMA) {
    throw new StateError(`the state file has schema ${String(record['schema'])}, expected ${SCHEMA}`);
  }
  const tarball = field(record, 'tarball', isString, 'a string');
  if (tarball !== '' && tarball !== path.join(workDir, STAGED_NAME)) {
    throw new StateError('the state names a tarball other than the staged copy');
  }
  return {
    schema: SCHEMA,
    npmVersion: field(record, 'npmVersion', isString, 'a string'),
    npmDir: field(record, 'npmDir', isString, 'a string'),
    projectDir: field(record, 'projectDir', isString, 'a string'),
    tarball,
    publishVersion: field(record, 'publishVersion', isString, 'a string'),
    dryRun: field(record, 'dryRun', isBoolean, 'a boolean'),
    tag: field(record, 'tag', isString, 'a string'),
    access: field(record, 'access', isAccess, "'', 'public' or 'restricted'"),
    provenance: field(record, 'provenance', isBoolean, 'a boolean'),
    registry: field(record, 'registry', isString, 'a string'),
    scopes: field(record, 'scopes', isStrings, 'a list of strings'),
  };
}
