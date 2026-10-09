// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The input rules, as tables. These replace running the validate step's
 * shell, extracted from action.yaml, against each case.
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoWorkspaceSelector,
  checkInputs,
  checkPublishVersion,
  checkRegistryUrl,
  INPUT_VARIABLES,
  InputError,
  readRawInputs,
  type RawInputs,
} from '../src/inputs.js';

/** A valid Basic auth publish; each case overrides what it tests. */
const BASE: RawInputs = {
  publishVersion: '1.0.0',
  registryUrl: 'https://nexus3.example.org/repository/npm/',
  dryRun: 'false',
  pathPrefix: '.',
  tarballPath: '',
  nodeVersion: '22',
  nodeVersionFile: '',
  tag: 'latest',
  access: '',
  provenance: 'false',
  loadCredential: 'false',
  nexusUser: '',
  nexusPassword: 'placeholder-not-a-secret',
  authToken: '',
  vaultMappingJson: '',
  opServiceAccountToken: '',
};

const check = (overrides: Partial<RawInputs>) => checkInputs({ ...BASE, ...overrides });

describe('checkPublishVersion', () => {
  it.each([
    '1.0.0',
    '0.0.0',
    '10.20.30',
    '01.2.3',
    '1.2.3-SNAPSHOT',
    '1.2.3-rc.1',
    '1.2.3-x-y',
    // The shell accepted an empty suffix, and npm rejects it at the stamp;
    // kept so the port changes nothing.
    '1.2.3-',
  ])('accepts %j', (version) => {
    expect(checkPublishVersion(version)).toBe(version);
  });

  it.each([
    ['', 'Allowed characters'],
    ['1.0.0;rm -rf /', 'Allowed characters'],
    ['1.0.0\n9.9.9-injected', 'Allowed characters'],
    ['1.0.0\n', 'Allowed characters'],
    ['1.0.0 ', 'Allowed characters'],
    ['1.0.0+build', 'Allowed characters'],
    ['1.0', 'semver-style'],
    ['1', 'semver-style'],
    ['1.2.3.4', 'semver-style'],
    ['a.b.c', 'semver-style'],
    ['1..3', 'semver-style'],
    ['.1.2.3', 'semver-style'],
    ['1.2.x', 'semver-style'],
    ['1.2.-3', 'semver-style'],
  ])('rejects %j', (version, message) => {
    expect(() => checkPublishVersion(version)).toThrow(InputError);
    expect(() => checkPublishVersion(version)).toThrow(message);
  });
});

describe('checkRegistryUrl', () => {
  it.each([
    'https://registry.npmjs.org/',
    'https://nexus3.example.org/repository/npm.release/',
    'https://a/',
    'https://host:8443/path_with-chars/',
  ])('accepts %j', (url) => {
    expect(checkRegistryUrl(url, false)).toBe(url);
  });

  it.each([
    ['https://nexus3.example.org/repository/npm', 'trailing slash'],
    ['http://registry.npmjs.org/', 'Expected https://'],
    ['HTTPS://registry.npmjs.org/', 'Expected https://'],
    ['https:///', 'Expected https://'],
    ['https:///npm/', 'must include a host'],
    ['https://user:pass@host/', 'characters'],
    ['https://host/?token=x/', 'characters'],
    ['https://host/\n', 'characters'],
    ['https://host/ ', 'characters'],
  ])('rejects %j', (url, message) => {
    expect(() => checkRegistryUrl(url, false)).toThrow(message);
  });

  it('requires a value unless dry_run', () => {
    expect(() => checkRegistryUrl('', false)).toThrow('registry_url required unless dry_run');
    expect(checkRegistryUrl('', true)).toBe('');
  });

  it('still validates a value supplied for a dry run', () => {
    expect(() => checkRegistryUrl('http://x/', true)).toThrow(InputError);
  });
});

describe('checkInputs: booleans, tag and access', () => {
  it.each([
    ['dryRun', 'dry_run'],
    ['provenance', 'provenance'],
    ['loadCredential', 'load_credential'],
  ] as const)('%s accepts only true or false', (key, name) => {
    for (const bad of ['', 'TRUE', 'yes', '1', 'true\n']) {
      expect(() => check({ [key]: bad })).toThrow(`${name} must be 'true' or 'false'`);
    }
  });

  it.each(['', 'public', 'restricted'])('access accepts %j', (access) => {
    expect(check({ access }).inputs.access).toBe(access);
  });

  it.each(['internal', 'Public', 'public\n'])('access rejects %j', (access) => {
    expect(() => check({ access })).toThrow('invalid access');
  });

  it.each(['latest', 'next', 'v1.x', 'snap_shot-1'])('tag accepts %j', (tag) => {
    expect(check({ tag }).inputs.tag).toBe(tag);
  });

  it.each(['', 'not a tag', 'a;b', 'next\n', '@scope'])('tag rejects %j', (tag) => {
    expect(() => check({ tag })).toThrow('invalid tag');
  });
});

describe('checkInputs: authentication modes', () => {
  const NONE = { nexusPassword: '', authToken: '', loadCredential: 'false' };

  it.each([
    ['password', { nexusPassword: 'p' }, 'basic'],
    ['load_credential', { loadCredential: 'true', vaultMappingJson: '{}', opServiceAccountToken: 't' }, 'basic'],
    ['token', { authToken: 't' }, 'token'],
  ] as const)('selects one mode from %s', (_label, overrides, mode) => {
    expect(check({ ...NONE, ...overrides }).inputs.authMode).toBe(mode);
  });

  // Both routes into Basic auth count. Without the load_credential case,
  // dropping that half of the condition would leave two modes accepted.
  it.each([
    ['token + password', { authToken: 't', nexusPassword: 'p' }],
    ['token + load_credential', { authToken: 't', nexusPassword: '', loadCredential: 'true' }],
  ])('rejects %s, even in a dry run', (_label, overrides) => {
    for (const dryRun of ['false', 'true']) {
      expect(() => check({ ...NONE, ...overrides, dryRun })).toThrow('conflicting authentication modes');
    }
  });

  it('requires a credential for a real publish', () => {
    expect(() => check(NONE)).toThrow('no registry credential configured');
  });

  it('needs no credential for a dry run', () => {
    expect(check({ ...NONE, dryRun: 'true' }).inputs.authMode).toBe('none');
  });

  it('requires both load_credential companions for a real publish', () => {
    const load = { ...NONE, loadCredential: 'true' };
    expect(() => check({ ...load, opServiceAccountToken: 't' })).toThrow(
      "load_credential is 'true' but vault_mapping_json is empty",
    );
    expect(() => check({ ...load, vaultMappingJson: '{}' })).toThrow(
      "load_credential is 'true' but op_service_account_token is empty",
    );
    expect(check({ ...load, dryRun: 'true' }).inputs.loadCredential).toBe(true);
  });

  it('never echoes a credential value in a refusal', () => {
    const secret = 'npm_SECRETVALUE0123456789';
    for (const overrides of [
      { authToken: secret, nexusPassword: secret },
      { authToken: secret, loadCredential: 'true' },
    ]) {
      expect(() => check(overrides)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(secret) }),
      );
    }
  });

  // nexus_user selects no mode, so it never conflicts; under token auth
  // it is reported as ignored, and under Basic auth it is not, since
  // Basic auth uses it.
  it('reports nexus_user as ignored under token auth alone', () => {
    const token = check({ ...NONE, authToken: 't', nexusUser: 'u' });
    expect(token.inputs.authMode).toBe('token');
    expect(token.notices).toEqual([expect.stringContaining('Ignoring nexus_user')]);

    expect(check({ ...NONE, nexusPassword: 'p', nexusUser: 'u' }).notices).toEqual([]);
    expect(check({ ...NONE, authToken: 't' }).notices).toEqual([]);
  });
});

describe('checkInputs: Node.js version', () => {
  it.each(['22', '22.x', '22.14.0', 'lts/*', 'lts/jod', 'node'])(
    'node_version accepts %j',
    (nodeVersion) => {
      expect(() => check({ nodeVersion })).not.toThrow();
    },
  );

  it.each(['22 ', '>=22', '22;x', '22\n'])('node_version rejects %j', (nodeVersion) => {
    expect(() => check({ nodeVersion })).toThrow('invalid node_version');
  });

  it.each(['.nvmrc', 'sub/.node-version', '../escape'])('node_version_file accepts the text %j', (file) => {
    expect(check({ nodeVersionFile: file }).inputs.nodeVersionFile).toBe(file);
  });

  it.each(['a b', '.nvmrc\n', 'x*'])('node_version_file rejects %j', (file) => {
    expect(() => check({ nodeVersionFile: file })).toThrow('invalid node_version_file');
  });

  it('requires one of the two', () => {
    expect(() => check({ nodeVersion: '', nodeVersionFile: '' })).toThrow('no Node.js version specified');
    expect(() => check({ nodeVersion: '', nodeVersionFile: '.nvmrc' })).not.toThrow();
  });
});

describe('readRawInputs', () => {
  it('reads every input from its INPUT_ variable, unset as empty', () => {
    const raw = readRawInputs({ INPUT_TAG: 'next', INPUT_DRY_RUN: 'true' });
    expect(raw.tag).toBe('next');
    expect(raw.dryRun).toBe('true');
    expect(raw.authToken).toBe('');
    expect(Object.keys(raw).sort()).toEqual(Object.keys(INPUT_VARIABLES).sort());
  });
});

describe('assertNoWorkspaceSelector', () => {
  it.each(['npm_config_workspace', 'NPM_CONFIG_WORKSPACE', 'Npm_Config_Workspace'])(
    'rejects a selection through %s',
    (name) => {
      expect(() => assertNoWorkspaceSelector({ [name]: 'packages/a' })).toThrow(
        `a workspace is selected through ${name}`,
      );
    },
  );

  it('ignores an empty selector, which npm skips', () => {
    expect(() => assertNoWorkspaceSelector({ npm_config_workspace: '' })).not.toThrow();
  });

  it('ignores the plural workspaces setting', () => {
    expect(() => assertNoWorkspaceSelector({ npm_config_workspaces: 'true' })).not.toThrow();
  });
});
