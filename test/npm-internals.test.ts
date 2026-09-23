// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** Include @npmcli/config; default true, as every npm from 7 does. */
  config?: boolean;
  /** Where definitions live, if config is included. */
  definitions?: 'config' | 'npm' | 'none' | 'malformed';
  /** npm's version; default 99.1.2. */
  version?: string;
  /** Prefix directory name under the test root; default 'prefix'. */
  prefixName?: string;
}

/**
 * Lay out an npm the way setup-node does: <prefix>/bin/npm linking to
 * <prefix>/lib/node_modules/npm/bin/npm-cli.js. Returns the prefix.
 */
function fakeNpm(options: FakeNpm = {}): { prefix: string; npmDir: string } {
  const {
    registryFetch = true,
    config = true,
    definitions = 'config',
    version = '99.1.2',
    prefixName = 'prefix',
  } = options;
  const prefix = path.join(root, prefixName);
  const npmDir = path.join(prefix, 'lib', 'node_modules', 'npm');
  // Declares its bundled modules as dependencies, as a real npm manifest
  // does; the closure check walks exactly these.
  write(
    path.join(npmDir, 'package.json'),
    JSON.stringify({
      name: 'npm',
      version,
      dependencies: { 'npm-registry-fetch': '*', '@npmcli/config': '*' },
    }),
  );
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
    // Two distinct installations, so an implementation that searched
    // PATH in any other order would pick the wrong one.
    const first = fakeNpm({ prefixName: 'first', version: '11.0.0' });
    const second = fakeNpm({ prefixName: 'second', version: '10.0.0' });
    const bins = [path.join(first.prefix, 'bin'), path.join(second.prefix, 'bin')];
    expect(locateNpm(bins.join(path.delimiter))).toBe(first.npmDir);
    expect(locateNpm([...bins].reverse().join(path.delimiter))).toBe(second.npmDir);
  });

  it('skips PATH entries with no npm', () => {
    const { prefix, npmDir } = fakeNpm();
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    expect(locateNpm([empty, path.join(prefix, 'bin')].join(path.delimiter))).toBe(npmDir);
  });

  it.each([
    ['an empty entry', ''],
    ['a dot', '.'],
    ['a relative directory', 'bin'],
  ])('refuses %s ahead of any npm, which names a directory-dependent npm', (_label, entry) => {
    // POSIX resolves these against the working directory, and this
    // action's steps run from different ones: the loader and the publish
    // step could each find a different npm.
    const { prefix } = fakeNpm();
    expect(() => locateNpm([entry, path.join(prefix, 'bin')].join(path.delimiter))).toThrow(
      /relative entry/,
    );
  });

  it('accepts a relative entry after the npm, which never takes part', () => {
    const { prefix, npmDir } = fakeNpm();
    expect(locateNpm([path.join(prefix, 'bin'), '', '.'].join(path.delimiter))).toBe(npmDir);
  });

  it('ignores a non-executable file named npm', () => {
    const { prefix, npmDir } = fakeNpm();
    const decoy = path.join(root, 'decoy');
    write(path.join(decoy, 'npm'), 'not executable');
    chmodSync(path.join(decoy, 'npm'), 0o644);
    expect(locateNpm([decoy, path.join(prefix, 'bin')].join(path.delimiter))).toBe(npmDir);
  });

  // Root may execute any file with an execute bit set anywhere, so the case
  // cannot be told apart when running as root.
  it.skipIf(process.getuid?.() === 0)(
    'judges executability for this process, not by any execute bit',
    () => {
      // Group-executable but not owner-executable: any-bit says yes, but
      // the shell running as the owner could not execute it.
      const { prefix, npmDir } = fakeNpm();
      const decoy = path.join(root, 'group-only');
      write(path.join(decoy, 'npm'), '#!/bin/sh\n');
      chmodSync(path.join(decoy, 'npm'), 0o610);
      expect(locateNpm([decoy, path.join(prefix, 'bin')].join(path.delimiter))).toBe(npmDir);
    },
  );

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
    expect(() => locateNpm('')).toThrow(/PATH is empty/);
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
    const { npmDir } = fakeNpm({ config: false, version: '6.14.18' });
    expect(loadNpmInternals(npmDir).loadConfig).toBeUndefined();
  });

  it('refuses a missing @npmcli/config on npm 7 or later, as a broken install', () => {
    // Only npm 6 lacks it by design. Anywhere else, treating absence as a
    // capability gap would quietly skip the checks that need it.
    const { npmDir } = fakeNpm({ config: false, version: '11.0.0' });
    expect(() => loadNpmInternals(npmDir)).toThrow(/@npmcli\/config is missing/);
  });

  it("refuses a module that resolves outside npm's own tree", () => {
    // createRequire walks up into parent node_modules. With npm's bundled
    // copy gone, a sibling installed beside npm would otherwise load.
    const { npmDir } = fakeNpm({ registryFetch: false });
    const sibling = path.join(path.dirname(npmDir), 'npm-registry-fetch');
    write(path.join(sibling, 'package.json'), '{"main":"index.js"}');
    write(path.join(sibling, 'index.js'), 'module.exports = { pickRegistry: () => "imposter" };');
    expect(() => loadNpmInternals(npmDir)).toThrow(/resolves outside npm's own tree/);
  });

  it("refuses an install whose transitive dependency resolves outside npm's tree", () => {
    // The entry point is in npm's tree, but it requires a dependency that
    // is missing there, so an ordinary require would walk up and run a
    // sibling installed beside npm. The sibling must never execute.
    const { npmDir } = fakeNpm();
    const fetchDir = path.join(npmDir, 'node_modules', 'npm-registry-fetch');
    write(
      path.join(fetchDir, 'package.json'),
      JSON.stringify({ main: 'index.js', dependencies: { 'evil-dep': '1.0.0' } }),
    );
    write(
      path.join(fetchDir, 'index.js'),
      "require('evil-dep'); module.exports = { pickRegistry: () => 'x' };",
    );
    const marker = path.join(root, 'EXECUTED');
    const sibling = path.join(path.dirname(npmDir), 'evil-dep');
    write(path.join(sibling, 'package.json'), '{"main":"index.js"}');
    write(
      path.join(sibling, 'index.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );

    expect(() => loadNpmInternals(npmDir)).toThrow(
      /dependency 'evil-dep' resolves outside npm's own tree/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a module that is present but fails to load, rather than calling it absent', () => {
    // A missing *transitive* import raises MODULE_NOT_FOUND too. It must
    // not read as "this location does not exist" and fall through.
    const { npmDir } = fakeNpm({ config: true, version: '11.0.0' });
    write(
      path.join(npmDir, 'node_modules', '@npmcli', 'config', 'lib', 'definitions', 'index.js'),
      "require('./no-such-dependency'); module.exports = {};",
    );
    // The npm 7-8 location exists too; a fall-through would load it.
    write(
      path.join(npmDir, 'lib', 'utils', 'config', 'index.js'),
      'module.exports = { definitions: {}, shorthands: {}, flatten: () => ({}) };',
    );
    const { loadConfig } = loadNpmInternals(npmDir);
    return expect(loadConfig?.({ cwd: root, flags: [], env: {} })).rejects.toThrow(
      /present but fails to load/,
    );
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
