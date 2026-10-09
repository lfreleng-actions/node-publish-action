// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { describe, expect, it } from 'vitest';

import { interpretPublish } from '../src/publish-result.js';

const REPORT = '{"pkg":{"name":"pkg","version":"1.0.0","filename":"pkg-1.0.0.tgz"}}';
const real = { expectedVersion: '1.0.0', dryRun: false };

describe('interpretPublish', () => {
  it('returns the metadata of a successful publish', () => {
    expect(interpretPublish(REPORT, 0, real)).toEqual({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0', filename: 'pkg-1.0.0.tgz' },
    });
  });

  // npm's own failure comes first, and is never described as a publish.
  it('reports npm failure plainly, with its output', () => {
    const outcome = interpretPublish('garbage', 1, real);
    expect(outcome).toMatchObject({ ok: false, showOutput: true });
    expect(outcome.ok || outcome.message).toBe('npm publish failed (exit 1) ❌');
  });

  // npm prints its report only after the registry accepted the upload, and
  // from npm 10 before the publish and postpublish scripts run. A failing
  // script then exits non-zero after a completed publish.
  it('warns against a retry when npm failed after reporting this version', () => {
    const outcome = interpretPublish(`${REPORT}\npostpublish failed`, 1, real);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('after reporting pkg@1.0.0 as published');
    expect(outcome.message).toContain('Check the registry before retrying');
    expect(outcome.showOutput).toBe(true);
  });

  it.each([
    ['another version reported', { expectedVersion: '2.0.0', dryRun: false }],
    ['a dry run, which publishes nothing', { expectedVersion: '1.0.0', dryRun: true }],
  ])('reports a plain failure for %s', (_label, options) => {
    const outcome = interpretPublish(REPORT, 1, options);
    expect(outcome.ok || outcome.message).toBe('npm publish failed (exit 1) ❌');
  });

  // Every failure after npm succeeded leads with "do not retry".
  it.each([
    ['no metadata', 'hook noise only', '1.0.0', 'No publish metadata', true],
    ['a version mismatch', REPORT, '2.0.0', 'npm reported 1.0.0, expected 2.0.0', false],
    [
      'an unusable name',
      '{"name":"bad name","version":"1.0.0","filename":"x.tgz"}',
      '1.0.0',
      'unusable package name',
      false,
    ],
    [
      'fan-out',
      '{"a":{"name":"a","version":"1.0.0","filename":"a.tgz"},"b":{"name":"b","version":"1.0.0","filename":"b.tgz"}}',
      '1.0.0',
      'npm reported 2 packages (a, b)',
      true,
    ],
  ])('after a successful publish, reports %s as do-not-retry', (_label, raw, version, detail, show) => {
    const outcome = interpretPublish(raw, 0, { expectedVersion: version, dryRun: false });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('Do not retry');
    expect(outcome.message).toContain(detail);
    expect(outcome.showOutput).toBe(show);
  });

  it('says a dry run completed rather than that anything published', () => {
    const outcome = interpretPublish('hook noise only', 0, { expectedVersion: '1.0.0', dryRun: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message.startsWith('The dry run completed.')).toBe(true);
    expect(outcome.message).not.toContain('Do not retry');
  });

  // The capture is read back with a bound; a cut-short one cannot be
  // trusted, but npm succeeded, so it is still reported as do-not-retry.
  it('reports a truncated capture as unreadable, after a successful publish', () => {
    const outcome = interpretPublish(REPORT, 0, { ...real, truncated: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('Do not retry');
    expect(outcome.message).toContain('too large or too dense');
    expect(outcome.showOutput).toBe(false);
  });
});
