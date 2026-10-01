// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { readdirSync } from 'node:fs';

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
