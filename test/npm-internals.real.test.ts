// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The loader against real npm installations.
 *
 * Always runs against the npm on PATH. CI adds one npm per supported major
 * through NPM_INTERNALS_DIRS (path-delimited npm package directories), so
 * a layout change in a new npm fails here rather than in a consumer's
 * publish.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadNpmInternals, locateNpm } from '../src/npm-internals.js';

const extra = (process.env['NPM_INTERNALS_DIRS'] ?? '')
  .split(path.delimiter)
  .filter((dir) => dir !== '');
const npmDirs = [locateNpm(), ...extra];

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'npm-internals-real-'));
  writeFileSync(path.join(project, 'package.json'), '{"name":"@set/probe","version":"0.0.0"}');
  writeFileSync(
    path.join(project, '.npmrc'),
    ['@lit:registry=undefined', '@set:registry=https://set.example/', ''].join('\n'),
  );
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe.each(npmDirs)('npm at %s', (npmDir) => {
  const internals = loadNpmInternals(npmDir);
  const major = Number(internals.npmVersion.split('.')[0]);

  it('selects registries with its own pickRegistry', () => {
    const opts = { registry: 'https://default.example/', '@s:registry': 'https://s.example/' };
    expect(internals.pickRegistry('plain', opts)).toBe('https://default.example/');
    expect(internals.pickRegistry('@s/p', opts)).toBe('https://s.example/');
    expect(internals.pickRegistry('@other/p', opts)).toBe('https://default.example/');
    // publishConfig.scope flattens into opts.scope and applies to an
    // unscoped name.
    expect(internals.pickRegistry('plain', { ...opts, scope: '@s' })).toBe('https://s.example/');
  });

  it.runIf(major >= 7)('loads layered configuration', async () => {
    const config = await internals.loadConfig?.({ cwd: project, flags: [], env: {} });
    expect(config).toBeDefined();
    if (!config) return;

    expect(config.get('@set:registry')).toBe('https://set.example/');
    expect(config.find('@set:registry')).toBe('project');
    expect(internals.pickRegistry('@set/p', config.flat)).toBe('https://set.example/');
  });

  it.runIf(major >= 7)('tells unset from a literal undefined by layer', async () => {
    const config = await internals.loadConfig?.({ cwd: project, flags: [], env: {} });
    if (!config) throw new Error('loadConfig unavailable');

    // Neither has a value...
    expect(config.get('@lit:registry')).toBeUndefined();
    expect(config.get('@unset:registry')).toBeUndefined();
    // ...but npm knows one was set, which `npm config get`'s stdout cannot
    // convey: it prints 'undefined' for both.
    expect(config.find('@lit:registry')).toBe('project');
    expect(config.find('@unset:registry')).toBeNull();
    // And npm's own selection falls through for both.
    const fallback = internals.pickRegistry('@unset/p', config.flat);
    expect(internals.pickRegistry('@lit/p', config.flat)).toBe(fallback);
  });

  it.runIf(major >= 7)('takes CLI flags as the cli layer, over project config', async () => {
    const config = await internals.loadConfig?.({
      cwd: project,
      flags: ['--@set:registry=https://cli.example/'],
      env: {},
    });
    if (!config) throw new Error('loadConfig unavailable');
    expect(config.find('@set:registry')).toBe('cli');
    expect(internals.pickRegistry('@set/p', config.flat)).toBe('https://cli.example/');
  });

  it.runIf(major < 7)('offers no config loader before @npmcli/config', () => {
    expect(internals.loadConfig).toBeUndefined();
  });
});
