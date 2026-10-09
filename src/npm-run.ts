// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Run the npm whose internals made the decisions.
 *
 * Invoked as `node <npm>/bin/npm-cli.js` with the Node.js running this
 * program, rather than as whatever `npm` PATH names. That is the launch
 * setup-node's bin/npm link performs, and it makes the npm that publishes
 * the npm that was checked by construction rather than by coincidence.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

export interface NpmResult {
  /** npm's exit status; a signal counts as failure. */
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Whether stdout was cut short at {@link MAX_CAPTURE}. Only a capture
   * to a file can be; the caller must not treat what was read as whole.
   */
  readonly truncated?: boolean;
}

/**
 * The most of a captured stdout read back: twice the scanner's parse
 * budget, so anything the scanner could use is read whole. Lifecycle
 * scripts write to the same stream without bound, and reading all of it
 * could exhaust memory after npm has already published -- losing the
 * do-not-retry report that matters most then.
 */
export const MAX_CAPTURE = 32 * 1024 * 1024;

/** Read at most `limit` bytes of `file`, saying whether there was more. */
export function readCapped(file: string, limit: number = MAX_CAPTURE): { text: string; truncated: boolean } {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length === buffer.length) break;
    }
    const truncated = length > limit;
    return { text: buffer.subarray(0, Math.min(length, limit)).toString('utf8'), truncated };
  } finally {
    closeSync(fd);
  }
}

export interface NpmRunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Send stdout to this file and read it back, rather than through a pipe.
   * For the publish itself: a pipe's buffer limit would have Node kill npm
   * part way through, and lifecycle scripts can write without bound.
   */
  readonly stdoutFile?: string;
  /** 'inherit' streams npm's diagnostics to the job log as they happen. */
  readonly stderr: 'inherit' | 'pipe' | 'ignore';
}

/** Runs npm with `args`; tests substitute one that records instead. */
export type NpmRunner = (args: readonly string[], options: NpmRunOptions) => NpmResult;

/** A runner for the npm package at `npmDir`. */
export function npmRunner(npmDir: string): NpmRunner {
  const cli = path.join(npmDir, 'bin', 'npm-cli.js');
  return (args, { cwd, env, stdoutFile, stderr }) => {
    const fd = stdoutFile === undefined ? undefined : openSync(stdoutFile, 'wx', 0o600);
    try {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        // No prompt can be answered here, and one would hang the job.
        stdio: ['ignore', fd ?? 'pipe', stderr],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (stdoutFile === undefined) {
        return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      }
      const captured = readCapped(stdoutFile);
      return {
        status: result.status ?? 1,
        stdout: captured.text,
        stderr: result.stderr ?? '',
        truncated: captured.truncated,
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}
