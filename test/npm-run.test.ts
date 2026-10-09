// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCapped } from '../src/npm-run.js';

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
    const result = readCapped(file, 8);
    expect(result.text).toBe('x'.repeat(Math.min(size, 8)));
    expect(result.truncated).toBe(truncated);
  });
});
