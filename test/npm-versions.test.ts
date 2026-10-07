// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NPM_VERSIONS_DIR, lockedNpm } from './support/npm-versions.js';

// Each test/npm-versions/npm-<N> stands for npm major N in the loader and
// parity tests, which pass against whatever npm the fixture installs.
// Dependabot's ignore rule keeps version updates within the major, but
// security updates disregard it: to clear an advisory in a dependency
// bundled with an npm that will never be patched, Dependabot moves the
// fixture to the latest npm instead. This pins each fixture to its major.
const fixtures = readdirSync(NPM_VERSIONS_DIR)
  .map((dir) => /^npm-(\d+)$/.exec(dir))
  .filter((match) => match !== null)
  .map(([dir, major]) => [dir, Number(major)] as const);

describe('the per-major fixtures', () => {
  it('are present', () => {
    expect(fixtures).not.toHaveLength(0);
  });

  it.each(fixtures)('%s locks npm %i', (dir, major) => {
    expect(lockedNpm(dir)).toMatch(new RegExp(`^${major}\\.`));
  });
});

// OSV-Scanner, and the OpenSSF Scorecard Vulnerabilities check built on it,
// read neither Dependabot's dismissals nor its rules. Each fixture therefore
// carries an osv-scanner.toml telling it to skip every package. The file
// applies to its own directory alone, so a fixture added without one would
// report every advisory against the npm it pins.
const everyFixture = readdirSync(NPM_VERSIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * The one form an osv-scanner.toml here may take, comments and blank lines
 * aside: a single override that skips every package, with a reason. The file
 * is matched against it line by line rather than parsed, so nothing else
 * passes. OSV-Scanner discards a file it cannot parse, a repeated key or a
 * key with no value among them, and then reports every advisory as though
 * the file were absent. Any further key would narrow the override (name,
 * version, ecosystem, group) or let it lapse (effectiveUntil).
 *
 * The file must also be printable ASCII throughout, with LF or CRLF line
 * endings. TOML forbids most control characters, in comments as in strings,
 * and trimming would hide some of them; refusing every one, with a lone
 * carriage return and anything outside ASCII, settles that before any line
 * is read.
 */
const SKIP_ALL = [/^\[\[PackageOverrides\]\]$/, /^ignore = true$/, /^reason = "[^"\\]+"$/];

function isSkipAll(text: string): boolean {
  if (!/^(?:[\x20-\x7e]|\r?\n)*$/.test(text)) return false;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return (
    lines.length === SKIP_ALL.length &&
    lines.every((line, i) => SKIP_ALL[i]?.test(line) === true)
  );
}

describe('isSkipAll', () => {
  const header = '[[PackageOverrides]]';
  const reason = 'reason = "Test fixture"';

  it('accepts the override with comments and blank lines', () => {
    expect(isSkipAll(`# note\n\n${header}\nignore = true\n${reason}\n`)).toBe(true);
  });

  it('accepts CRLF line endings', () => {
    expect(isSkipAll(`# note\r\n${header}\r\nignore = true\r\n${reason}\r\n`)).toBe(true);
  });

  it.each([
    ['an empty file', ''],
    ['no table header', `ignore = true\n${reason}`],
    ['another table', `[[IgnoredVulns]]\nignore = true\n${reason}`],
    ['a second override', `${header}\nignore = true\n${reason}\n${header}\nignore = true`],
    ['a repeated key', `${header}\nignore = true\nignore = true\n${reason}`],
    ['a key with no value', `${header}\nignore = true\nreason =`],
    ['an empty reason', `${header}\nignore = true\nreason = ""`],
    ['no separator', `${header}\nignore true\n${reason}`],
    ['ignore turned off', `${header}\nignore = false\n${reason}`],
    ['a narrowing key', `${header}\nname = "tar"\nignore = true\n${reason}`],
    ['an expiry date', `${header}\nignore = true\n${reason}\neffectiveUntil = 2027-01-01`],
    ['a NUL in the reason', `${header}\nignore = true\nreason = "a\u0000b"`],
    ['DEL in a comment', `# a\u007fb\n${header}\nignore = true\n${reason}`],
    ['a vertical tab trimming would hide', `${header}\u000b\nignore = true\n${reason}`],
    ['a lone carriage return', `${header}\rignore = true\n${reason}`],
    ['a byte-order mark', `\ufeff${header}\nignore = true\n${reason}`],
  ])('rejects %s', (_, text) => {
    expect(isSkipAll(text)).toBe(false);
  });
});

describe('every fixture', () => {
  it.each(everyFixture)('%s tells OSV-Scanner to skip its packages', (dir) => {
    const text = readFileSync(path.join(NPM_VERSIONS_DIR, dir, 'osv-scanner.toml'), 'utf8');
    expect(isSkipAll(text)).toBe(true);
  });
});
