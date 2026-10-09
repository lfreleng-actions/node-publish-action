// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The npm command lines, as tables. These replace asserting on strings in
 * action.yaml's shell, which could only show that a line existed, not
 * that it produced the right arguments.
 */

import { describe, expect, it } from 'vitest';

import {
  definedHooks,
  PUBLISH_HOOKS,
  publishArgs,
  stampArgs,
  VERSION_HOOKS,
  viewArgs,
} from '../src/publish-command.js';
import type { PublishState } from '../src/state.js';

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
  idTokenEndpoint: false,
  registry: REGISTRY,
  scopes: [],
};

describe('publishArgs', () => {
  it('publishes the directory as JSON, confined to one package', () => {
    expect(publishArgs(STATE)).toEqual([
      'publish', '--json', '--tag', 'latest', '--no-workspaces', '--registry', REGISTRY,
    ]);
  });

  // npm accepts the positional only straight after the subcommand.
  it('splices a tarball in directly after the subcommand', () => {
    const args = publishArgs({ ...STATE, tarball: '/t/npmpublish.x/package.tgz' });
    expect(args.slice(0, 2)).toEqual(['publish', '/t/npmpublish.x/package.tgz']);
  });

  it('passes access and provenance only when set', () => {
    const args = publishArgs({ ...STATE, access: 'restricted', provenance: true });
    expect(args).toContain('--provenance');
    expect(args.join(' ')).toContain('--access restricted');
    expect(publishArgs(STATE)).not.toContain('--provenance');
    expect(publishArgs(STATE)).not.toContain('--access');
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

  it('passes every value as its own argument, never through a shell', () => {
    const args = publishArgs({ ...STATE, tag: 'next' });
    expect(args[args.indexOf('--tag') + 1]).toBe('next');
  });
});

describe('viewArgs', () => {
  it('reads one version back from the resolved registry, every scope pinned', () => {
    expect(viewArgs('@onap/ui', '1.2.3', { registry: REGISTRY, scopes: ['@onap'] })).toEqual([
      'view', '@onap/ui@1.2.3', 'version', '--no-json', '--registry', REGISTRY,
      `--@onap:registry=${REGISTRY}`,
    ]);
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
