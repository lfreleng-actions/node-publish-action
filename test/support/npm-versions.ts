// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Read the test/npm-versions fixtures, each a directory whose lockfile
 * pins one npm release for the loader and parity tests.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const NPM_VERSIONS_DIR = path.join('test', 'npm-versions');

/** The npm release a fixture's lockfile pins, or '' when it pins none. */
export function lockedNpm(fixture: string): string {
  const lock = JSON.parse(
    readFileSync(path.join(NPM_VERSIONS_DIR, fixture, 'package-lock.json'), 'utf8'),
  ) as { packages: Record<string, { version?: string }> };
  return lock.packages['node_modules/npm']?.version ?? '';
}
