// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyExisting } from '../src/existing.js';
import { sha512Integrity, tarballFilename } from '../src/integrity.js';

const OURS = 'sha512-ours==';

describe('classifyExisting', () => {
  // npm 8, 10 and 11 report a missing version and a missing package alike,
  // measured against registry.npmjs.org: exit 1 with E404.
  it.each([
    ['npm 10+ E404', { status: 1, stdout: '', stderr: 'npm error code E404\n' }, { kind: 'absent' }],
    ['npm 8 E404', { status: 1, stdout: '', stderr: 'npm ERR! code E404\n' }, { kind: 'absent' }],
    ['identical', { status: 0, stdout: `${OURS}\n`, stderr: '' }, { kind: 'identical', integrity: OURS }],
    [
      'different',
      { status: 0, stdout: 'sha512-theirs==\n', stderr: '' },
      { kind: 'different', integrity: 'sha512-theirs==' },
    ],
    ['an auth failure', { status: 1, stdout: '', stderr: 'npm error code E401\n' }, { kind: 'unknown', detail: 'E401' }],
    ['a network failure', { status: 1, stdout: '', stderr: 'npm error code ECONNREFUSED\n' }, { kind: 'unknown', detail: 'ECONNREFUSED' }],
    ['no error code', { status: 7, stdout: '', stderr: 'boom' }, { kind: 'unknown', detail: 'exit 7' }],
    ['no integrity', { status: 0, stdout: '\n', stderr: '' }, { kind: 'unknown', detail: 'no integrity reported' }],
    // A legacy sha1 shasum cannot be compared with a sha512 integrity.
    ['a sha1 integrity', { status: 0, stdout: 'sha1-abc=\n', stderr: '' }, { kind: 'unknown', detail: 'no sha512 integrity reported' }],
  ] as const)('classifies %s', (_label, result, want) => {
    expect(classifyExisting(result, OURS)).toEqual(want);
  });
});

describe('sha512Integrity', () => {
  it('matches the SRI form npm records, across several read chunks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'integrity-test-'));
    try {
      const bytes = Buffer.alloc(2.5 * 1024 * 1024, 7);
      const file = path.join(dir, 'pkg.tgz');
      writeFileSync(file, bytes);
      const want = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      expect(sha512Integrity(file)).toBe(want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tarballFilename', () => {
  it.each([
    ['pkg', '1.0.0', 'pkg-1.0.0.tgz'],
    ['@onap/ui-common', '1.0.99-SNAPSHOT', 'onap-ui-common-1.0.99-SNAPSHOT.tgz'],
  ])('names %s@%s as npm pack does', (name, version, want) => {
    expect(tarballFilename(name, version)).toBe(want);
  });
});
