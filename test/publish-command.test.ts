// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The npm command lines, as tables. These replace asserting on strings in
 * action.yaml's shell, which could only show that a line existed, not
 * that it produced the right arguments.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';


import {
  definedHooks,
  PUBLISH_HOOKS,
  publishArgs,
  stampArgs,
  VERSION_HOOKS,
  viewArgs,
} from '../src/publish-command.js';
import { loadNpmInternals } from '../src/npm-internals.js';
import type { PublishState } from '../src/state.js';
import { isolatedEnv } from './support/ground-truth.js';

const REGISTRY = 'https://registry.example.invalid/';

const STATE: PublishState = {
  schema: 1,
  npmVersion: '11.0.0',
  npmDir: '/opt/npm',
  projectDir: '/w/project',
  tarball: '',
  publishVersion: '1.2.3',
  dryRun: false,
  tag: 'latest',
  access: '',
  provenance: false,
  provenanceFile: '',
  userconfig: '',
  globalconfig: '',
  idTokenEndpoint: false,
  packageName: '@onap/ui',
  ifExists: 'fail',
  integrity: '',
  registry: REGISTRY,
  scopes: [],
};

describe('publishArgs', () => {
  it('publishes the directory as JSON, confined to one package', () => {
    expect(publishArgs(STATE)).toEqual([
      'publish', '--json', '--tag', 'latest', '--no-workspaces', '--no-provenance',
      '--registry', REGISTRY, '--no-dry-run',
    ]);
  });

  // npm accepts the positional only straight after the subcommand.
  it('splices a tarball in directly after the subcommand', () => {
    const args = publishArgs({ ...STATE, tarball: '/t/npmpublish.x/package.tgz' });
    expect(args.slice(0, 2)).toEqual(['publish', '/t/npmpublish.x/package.tgz']);
  });

  it('passes access only when set', () => {
    const args = publishArgs({ ...STATE, access: 'restricted' });
    expect(args.join(' ')).toContain('--access restricted');
    expect(publishArgs(STATE)).not.toContain('--access');
  });

  // The .npmrc step replaces the project's .npmrc before a Basic or token
  // publish, so the provenance resolved beforehand is stated either way.
  // A trusted publish leaves it to npm, which attaches provenance itself
  // only while the setting is at its default.
  it.each([
    [true, ['--provenance'], ['--no-provenance']],
    [false, ['--no-provenance'], ['--provenance']],
    [null, [], ['--provenance', '--no-provenance']],
  ])('states provenance %s as %j', (provenance, present, absent) => {
    const args = publishArgs({ ...STATE, provenance });
    for (const flag of present) expect(args).toContain(flag);
    for (const flag of absent) expect(args).not.toContain(flag);
  });

  // npm refuses an explicit provenance alongside a provenance-file, even
  // a false one, so a bundle is stated alone.
  it('states a provenance bundle instead of the boolean', () => {
    const args = publishArgs({ ...STATE, provenance: null, provenanceFile: '/b/bundle.json' });
    expect(args).toContain('--provenance-file=/b/bundle.json');
    expect(args.filter((arg) => /^--(no-)?provenance$/.test(arg))).toEqual([]);
  });

  // npm reads dry-run from its configuration, so an ambient setting must
  // not turn the publish every earlier decision was made for into another.
  it.each([
    [true, '--dry-run', '--no-dry-run'],
    [false, '--no-dry-run', '--dry-run'],
  ])('states dry run %s as %s', (dryRun, present, absent) => {
    const args = publishArgs({ ...STATE, dryRun });
    expect(args).toContain(present);
    expect(args).not.toContain(absent);
  });

  // A dry run still queries the registry, so --registry must apply to it.
  it('keeps --registry for a dry run', () => {
    const args = publishArgs({ ...STATE, dryRun: true });
    expect(args).toContain('--dry-run');
    expect(args.join(' ')).toContain(`--registry ${REGISTRY}`);
  });

  // Every consulted scope, not just the winner: a prepublishOnly script
  // could otherwise claim an earlier scope after resolution.
  it('pins the resolved registry under every consulted scope', () => {
    const args = publishArgs({ ...STATE, scopes: ['@onap', '@other scope'] });
    expect(args).toContain(`--@onap:registry=${REGISTRY}`);
    expect(args).toContain(`--@other scope:registry=${REGISTRY}`);
  });

  it('passes no registry when none was resolved', () => {
    expect(publishArgs({ ...STATE, registry: '' })).not.toContain('--registry');
  });

  // A project .npmrc can select these, and the .npmrc step replaces it.
  it('pins the configuration files prepare resolved', () => {
    const args = publishArgs({ ...STATE, userconfig: '/u/clean.npmrc', globalconfig: '/g/npmrc' });
    expect(args).toContain('--userconfig=/u/clean.npmrc');
    expect(args).toContain('--globalconfig=/g/npmrc');
    expect(publishArgs(STATE).some((arg) => /^--(user|global)config/.test(arg))).toBe(false);
  });

  it('passes every value as its own argument, never through a shell', () => {
    const args = publishArgs({ ...STATE, tag: 'next' });
    expect(args[args.indexOf('--tag') + 1]).toBe('next');
  });
});

describe('viewArgs', () => {
  const PINNED = { registry: REGISTRY, scopes: ['@onap'], userconfig: '', globalconfig: '' };

  it('reads one field back from the resolved registry, every scope pinned', () => {
    expect(viewArgs('@onap/ui', '1.2.3', PINNED)).toEqual([
      'view', '@onap/ui@1.2.3', 'version', '--no-json', '--loglevel=error', '--no-workspaces', '--scope=',
      '--registry', REGISTRY, `--@onap:registry=${REGISTRY}`,
    ]);
    expect(viewArgs('@onap/ui', '1.2.3', PINNED, 'dist.integrity')[2]).toBe('dist.integrity');
  });

  // The same configuration the publish reads: the package's own project,
  // and the user and global files prepare pinned.
  it('selects configuration exactly as the publish does', () => {
    const state = { ...STATE, userconfig: '/u/.npmrc', globalconfig: '/g/npmrc' };
    const view = viewArgs('p', '1.0.0', state);
    for (const flag of ['--no-workspaces', '--userconfig=/u/.npmrc', '--globalconfig=/g/npmrc']) {
      expect(view).toContain(flag);
      expect(publishArgs(state)).toContain(flag);
    }
  });

  // A configured loglevel=silent hides npm's error code, so an absent
  // version would read as an unanswerable question and block a first
  // publish. Asked of npm's own configuration, with the read's flags.
  it("keeps npm's error code visible despite a configured silent log level", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'view-loglevel-'));
    try {
      const internals = loadNpmInternals();
      const config = await internals.loadConfig?.({
        cwd: home,
        flags: viewArgs('plain', '1.0.0', { ...PINNED, scopes: [] }).slice(3),
        env: { ...isolatedEnv(home), npm_config_loglevel: 'silent' },
      });
      expect(config?.get('loglevel')).toBe('error');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // npm view ignores publishConfig, so a configured scope the manifest
  // masked at publish time would otherwise choose its own registry. Asked
  // of npm's own configuration and pickRegistry, with the read's flags.
  it("reads from the resolved registry despite an ambient scope, by npm's own selection", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'view-scope-'));
    try {
      const internals = loadNpmInternals();
      const flags = viewArgs('plain', '1.0.0', { ...PINNED, scopes: [] }).slice(3);
      const config = await internals.loadConfig?.({
        cwd: home,
        flags,
        env: {
          ...isolatedEnv(home),
          npm_config_scope: '@ambient',
          'npm_config_@ambient:registry': 'https://elsewhere.example.invalid/',
        },
      });
      expect(internals.pickRegistry('plain@1.0.0', config?.flat ?? {})).toBe(REGISTRY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('stampArgs', () => {
  it('stamps without git, scripts or workspaces, idempotently', () => {
    expect(stampArgs('1.2.3')).toEqual([
      'version', '1.2.3', '--no-git-tag-version', '--allow-same-version', '--ignore-scripts',
      '--no-workspaces',
    ]);
  });
});

describe('definedHooks', () => {
  const manifest = JSON.stringify({
    scripts: { version: 'x', test: 'y', prepublishOnly: 'z', postversion: 'w', prepack: 'v' },
  });

  it('names the defined hooks of each kind, sorted', () => {
    expect(definedHooks(manifest, VERSION_HOOKS)).toEqual(['postversion', 'version']);
    expect(definedHooks(manifest, PUBLISH_HOOKS)).toEqual(['prepack', 'prepublishOnly']);
  });

  it.each(['{', '{}', '{"scripts":null}', '{"scripts":["version"]}'])(
    'names none for %j',
    (text) => {
      expect(definedHooks(text, VERSION_HOOKS)).toEqual([]);
    },
  );
});
