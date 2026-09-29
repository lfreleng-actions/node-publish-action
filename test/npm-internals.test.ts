// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFINITION_LOCATIONS,
  NpmInternalsError,
  loadNpmInternals,
  locateNpm,
} from '../src/npm-internals.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'npm-internals-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface FakeNpm {
  /** Include npm-registry-fetch; default true. */
  registryFetch?: boolean;
  /** Include @npmcli/config; default false. */
  config?: boolean;
  /** Where definitions live, if config is included. */
  definitions?: 'config' | 'npm' | 'none' | 'malformed';
}

/**
 * Lay out an npm the way setup-node does: <prefix>/bin/npm linking to
 * <prefix>/lib/node_modules/npm/bin/npm-cli.js. Returns the prefix.
 */
function fakeNpm(options: FakeNpm = {}): { prefix: string; npmDir: string } {
  const { registryFetch = true, config = false, definitions = 'config' } = options;
  const prefix = path.join(root, 'prefix');
  const npmDir = path.join(prefix, 'lib', 'node_modules', 'npm');
  write(path.join(npmDir, 'package.json'), JSON.stringify({ name: 'npm', version: '99.1.2' }));
  const cli = path.join(npmDir, 'bin', 'npm-cli.js');
  write(cli, '#!/usr/bin/env node\n');
  chmodSync(cli, 0o755);
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  symlinkSync(cli, path.join(prefix, 'bin', 'npm'));

  const nm = path.join(npmDir, 'node_modules');
  if (registryFetch) {
    write(path.join(nm, 'npm-registry-fetch', 'package.json'), '{"main":"index.js"}');
    write(
      path.join(nm, 'npm-registry-fetch', 'index.js'),
      "module.exports = { pickRegistry: (spec) => 'picked:' + spec };",
    );
  }
  const defsBody =
    definitions === 'malformed'
      ? 'module.exports = { definitions: {} };'
      : 'module.exports = { definitions: {}, shorthands: {}, flatten: () => ({}) };';
  if (config) {
    write(path.join(nm, '@npmcli', 'config', 'package.json'), '{"main":"lib/index.js"}');
    write(
      path.join(nm, '@npmcli', 'config', 'lib', 'index.js'),
      [
        'module.exports = class Config {',
        '  constructor (o) { this.o = o; }',
        '  async load () {}',
        '  get (k) { return k === "argv" ? this.o.argv : this.o.env[k]; }',
        '  find (k) { return k in this.o.env ? "env" : null; }',
        '  get flat () { return { cwd: this.o.cwd }; }',
        '};',
      ].join('\n'),
    );
    if (definitions === 'config' || definitions === 'malformed') {
      write(path.join(nm, '@npmcli', 'config', 'lib', 'definitions', 'index.js'), defsBody);
    } else if (definitions === 'npm') {
      write(path.join(npmDir, 'lib', 'utils', 'config', 'index.js'), defsBody);
    }
  }
  return { prefix, npmDir };
}

describe('locateNpm', () => {
  it('follows the bin symlink to the npm package directory', () => {
    const { prefix, npmDir } = fakeNpm();
    expect(locateNpm(path.join(prefix, 'bin'))).toBe(npmDir);
  });

  it('uses the first npm on PATH, not a later one', () => {
    const { prefix, npmDir } = fakeNpm();
    const later = path.join(root, 'later');
    mkdirSync(later);
    expect(locateNpm([path.join(prefix, 'bin'), later].join(path.delimiter))).toBe(npmDir);
  });

  it('skips PATH entries with no npm and empty entries', () => {
    const { prefix, npmDir } = fakeNpm();
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    const pathEnv = ['', empty, path.join(prefix, 'bin')].join(path.delimiter);
    expect(locateNpm(pathEnv)).toBe(npmDir);
  });

  it('ignores a non-executable file named npm', () => {
    const { prefix, npmDir } = fakeNpm();
    const decoy = path.join(root, 'decoy');
    write(path.join(decoy, 'npm'), 'not executable');
    chmodSync(path.join(decoy, 'npm'), 0o644);
    expect(locateNpm([decoy, path.join(prefix, 'bin')].join(path.delimiter))).toBe(npmDir);
  });

  it('refuses an npm on PATH that is not an npm package, rather than trying the next', () => {
    const { prefix } = fakeNpm();
    const impostor = path.join(root, 'impostor');
    write(path.join(impostor, 'npm'), '#!/bin/sh\n');
    chmodSync(path.join(impostor, 'npm'), 0o755);
    const pathEnv = [impostor, path.join(prefix, 'bin')].join(path.delimiter);
    expect(() => locateNpm(pathEnv)).toThrow(NpmInternalsError);
    expect(() => locateNpm(pathEnv)).toThrow(/does not resolve to an npm package/);
  });

  it('fails clearly when PATH has no npm', () => {
    expect(() => locateNpm(root)).toThrow(/No 'npm' executable found on PATH/);
    // An empty PATH, as an unset one reaches the loader. (An explicit
    // `undefined` would select the default parameter, the real PATH.)
    expect(() => locateNpm('')).toThrow(NpmInternalsError);
  });
});

describe('loadNpmInternals', () => {
  it("loads pickRegistry from npm's own tree and reports the version", () => {
    const { npmDir } = fakeNpm();
    const internals = loadNpmInternals(npmDir);
    expect(internals.npmVersion).toBe('99.1.2');
    expect(internals.npmDir).toBe(npmDir);
    expect(internals.pickRegistry('@s/p', {})).toBe('picked:@s/p');
  });

  it('fails closed when npm-registry-fetch is missing', () => {
    const { npmDir } = fakeNpm({ registryFetch: false });
    expect(() => loadNpmInternals(npmDir)).toThrow(/cannot load npm-registry-fetch/);
  });

  it('fails closed when npm-registry-fetch exports no pickRegistry', () => {
    const { npmDir } = fakeNpm();
    write(path.join(npmDir, 'node_modules', 'npm-registry-fetch', 'index.js'), 'module.exports = {};');
    expect(() => loadNpmInternals(npmDir)).toThrow(/exports no pickRegistry/);
  });

  it('reports no config loader on an npm without @npmcli/config (npm 6)', () => {
    const { npmDir } = fakeNpm({ config: false });
    expect(loadNpmInternals(npmDir).loadConfig).toBeUndefined();
  });

  it.each([
    ['in @npmcli/config (npm 9+)', 'config'],
    ['in npm itself (npm 7-8)', 'npm'],
  ] as const)('finds definitions %s', async (_label, definitions) => {
    const { npmDir } = fakeNpm({ config: true, definitions });
    const { loadConfig } = loadNpmInternals(npmDir);
    await expect(loadConfig?.({ cwd: root, flags: [], env: {} })).resolves.toBeDefined();
  });

  it('fails closed when definitions are at no known location', async () => {
    const { npmDir } = fakeNpm({ config: true, definitions: 'none' });
    const { loadConfig } = loadNpmInternals(npmDir);
    await expect(loadConfig?.({ cwd: root, flags: [], env: {} })).rejects.toThrow(
      /not found at any known location/,
    );
  });

  it('fails closed when definitions load but are malformed', async () => {
    const { npmDir } = fakeNpm({ config: true, definitions: 'malformed' });
    const { loadConfig } = loadNpmInternals(npmDir);
    await expect(loadConfig?.({ cwd: root, flags: [], env: {} })).rejects.toThrow(
      /does not export definitions, shorthands and flatten/,
    );
  });

  it("passes flags through argv, never this process's own arguments", async () => {
    const { npmDir } = fakeNpm({ config: true });
    const { loadConfig } = loadNpmInternals(npmDir);
    const config = await loadConfig?.({ cwd: root, flags: ['--registry=https://r/'], env: {} });
    const argv = config?.get('argv') as string[];
    // nopt skips two entries, as for `node npm-cli.js <flags>`.
    expect(argv.slice(2)).toEqual(['--registry=https://r/']);
    expect(argv).not.toContain(process.argv[1]);
  });

  it('passes the given environment and working directory', async () => {
    const { npmDir } = fakeNpm({ config: true });
    const { loadConfig } = loadNpmInternals(npmDir);
    const config = await loadConfig?.({ cwd: root, flags: [], env: { npm_config_x: 'y' } });
    expect(config?.find('npm_config_x')).toBe('env');
    expect(config?.flat).toEqual({ cwd: root });
  });

  it('declares exactly the two definition locations npm has used', () => {
    expect(DEFINITION_LOCATIONS).toEqual([
      '@npmcli/config/lib/definitions',
      './lib/utils/config/index.js',
    ]);
  });
});
