// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { npmRunner, readCapped } from '../src/npm-run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'npm-run-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCapped', () => {
  it.each([
    ['shorter than the limit', 5, false],
    ['exactly the limit', 8, false],
    ['longer than the limit', 9, true],
  ])('reads a file %s', (_label, size, truncated) => {
    const file = path.join(dir, 'out');
    writeFileSync(file, 'x'.repeat(size));
    const fd = openSync(file, 'r');
    const result = readCapped(fd, 8);
    closeSync(fd);
    expect(result.text).toBe('x'.repeat(Math.min(size, 8)));
    expect(result.truncated).toBe(truncated);
  });
});

describe('npmRunner capture', () => {
  // Lifecycle scripts can find the capture's path. What is parsed must be
  // what npm wrote through its descriptor, whatever a script does to the
  // path afterwards.
  it('reads back what was written, not a file swapped in at the path', () => {
    const fake = path.join(dir, 'fake-npm');
    const bin = path.join(fake, 'bin');
    writeFileSync(path.join(dir, 'decoy'), 'decoy');
    const out = path.join(dir, 'publish.json');
    // A stand-in npm-cli.js: writes the report to stdout, then replaces the
    // capture's path, as a postpublish script could.
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'npm-cli.js'),
      `process.stdout.write('REPORT'); require('fs').renameSync(${JSON.stringify(path.join(dir, 'decoy'))}, ${JSON.stringify(out)});`,
    );
    const result = npmRunner(fake)([], { cwd: dir, env: process.env, stdoutFile: out, stderr: 'ignore' });
    expect(result.stdout).toBe('REPORT');
  });
});
