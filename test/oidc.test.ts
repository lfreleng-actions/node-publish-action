// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Trusted publishing: the toolchain floors, the token endpoint, mode
 * isolation, and -- through real npm configuration -- the stored-credential
 * guard and provenance precedence.
 *
 * The credential and provenance cases load each npm's own configuration,
 * so they assert npm's behaviour rather than a description of it. They run
 * on the npm on PATH and, in CI, every fixture npm at or above the OIDC
 * floor, where the checks apply.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputError } from '../src/inputs.js';
import { loadNpmInternals, locateNpm, type LoadedConfig } from '../src/npm-internals.js';
import {
  assertNoStoredCredential,
  assertOidcEndpoint,
  assertToolchain,
  meetsFloor,
  checkOidcProvenance,
  needsIdTokenEndpoint,
  npmEnv,
  OIDC_NPM_FLOOR,
  provenanceVerdict,
} from '../src/oidc.js';
import { publishFlags } from '../src/publish-options.js';
import { isolatedEnv } from './support/ground-truth.js';

const NPMJS = 'https://registry.npmjs.org/';

describe('meetsFloor', () => {
  it.each([
    ['11.5.2', true],
    ['11.5.3', true],
    ['11.6.0', true],
    ['12.0.0', true],
    ['11.5.1', false],
    ['10.9.2', false],
    // A prerelease of the floor precedes it; of a later release, follows.
    ['11.5.2-pre.0', false],
    ['11.6.0-beta.1', true],
    ['garbage', false],
  ])('%s against 11.5.2 is %s', (version, want) => {
    expect(meetsFloor(version, OIDC_NPM_FLOOR)).toBe(want);
  });
});

describe('assertToolchain', () => {
  it('accepts npm 11.5.2 on Node 22.14.0', () => {
    expect(() => assertToolchain('11.5.2', '22.14.0')).not.toThrow();
  });

  // Node 22.14.0 ships npm 10.9.2: meeting one floor does not meet the other.
  it('refuses npm below 11.5.2, saying setup-node picks up its own npm', () => {
    expect(() => assertToolchain('10.9.2', '22.14.0')).toThrow(/npm 10\.9\.2 is below the 11\.5\.2/);
    expect(() => assertToolchain('11.5.1', '24.0.0')).toThrow(/runs setup-node first/);
  });

  it('refuses Node below 22.14.0', () => {
    expect(() => assertToolchain('11.5.2', '22.13.1')).toThrow(/Node\.js 22\.13\.1 is below the 22\.14\.0/);
  });

  it('names both shortfalls at once', () => {
    expect(() => assertToolchain('10.0.0', '20.0.0')).toThrow(/npm 10\.0\.0.*Node\.js 20\.0\.0/s);
  });
});

describe('assertOidcEndpoint', () => {
  const URL = 'https://token.actions.example/';
  it.each([
    [{}, false],
    [{ ACTIONS_ID_TOKEN_REQUEST_URL: URL }, false],
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' }, false],
    [{ ACTIONS_ID_TOKEN_REQUEST_URL: URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, false],
    [{ ACTIONS_ID_TOKEN_REQUEST_URL: URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' }, true],
  ])('with %j accepts: %s', (env, ok) => {
    if (ok) expect(() => assertOidcEndpoint(env)).not.toThrow();
    else expect(() => assertOidcEndpoint(env)).toThrow(/Grant 'id-token: write'.*both the caller/);
  });
});

describe('mode isolation', () => {
  const ENV = {
    PATH: '/bin',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    NPM_ID_TOKEN: 'ambient',
  };

  it('withholds the endpoint unless kept, and NPM_ID_TOKEN always', () => {
    expect(npmEnv(ENV, false)).toEqual({ PATH: '/bin' });
    expect(npmEnv(ENV, true)).toEqual({
      PATH: '/bin',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    });
  });

  // Windows environment names are case-insensitive, so a lower-case
  // spelling reaches npm as the upper-case variable.
  it('withholds the variables whatever their case', () => {
    expect(
      npmEnv({ npm_id_token: 'x', actions_id_token_request_url: 'u', Path: '/bin' }, false),
    ).toEqual({ Path: '/bin' });
  });

  it('does not modify the environment it is given', () => {
    const env = { ...ENV };
    npmEnv(env, false);
    expect(env).toEqual(ENV);
  });

  it.each([
    // dryRun, oidc, provenance, keep
    [false, true, false, true],
    [false, false, true, true],
    [false, false, false, false],
    [true, true, false, false],
    [true, false, true, false],
  ])('dryRun=%s oidc=%s provenance=%s keeps the endpoint: %s', (dryRun, oidc, provenance, keep) => {
    expect(needsIdTokenEndpoint(dryRun, oidc, provenance)).toBe(keep);
  });
});

/** Every npm to run the configuration cases on: PATH's, and CI's fixtures. */
const npmDirs = [
  locateNpm(),
  ...(process.env['NPM_INTERNALS_DIRS'] ?? '').split(path.delimiter).filter((dir) => dir !== ''),
].filter((dir) => meetsFloor(loadNpmInternals(dir).npmVersion, OIDC_NPM_FLOOR));

let root: string;
let project: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'oidc-test-'));
  project = path.join(root, 'project');
  home = path.join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(path.join(project, 'package.json'), '{"name":"p","version":"1.0.0"}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  readonly npmrc?: readonly string[];
  readonly userNpmrc?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly registryUrl?: string;
}

async function configFor(npmDir: string, setup: Setup = {}): Promise<LoadedConfig> {
  if (setup.npmrc) writeFileSync(path.join(project, '.npmrc'), `${setup.npmrc.join('\n')}\n`);
  if (setup.userNpmrc) writeFileSync(path.join(home, '.npmrc'), `${setup.userNpmrc.join('\n')}\n`);
  const internals = loadNpmInternals(npmDir);
  if (!internals.loadConfig) throw new Error('no @npmcli/config');
  return internals.loadConfig({
    cwd: setup.cwd ?? project,
    flags: publishFlags(setup.registryUrl ?? NPMJS),
    env: { ...isolatedEnv(home), ...setup.env },
  });
}

// Test literals, not credentials.
const TOKEN = 'placeholder-not-a-secret';
const PASSWORD = Buffer.from('testpass').toString('base64');
const AUTH = Buffer.from('testuser:testpass').toString('base64');

describe.each(npmDirs.map((dir) => [loadNpmInternals(dir).npmVersion, dir]))(
  'stored-credential guard on npm %s',
  (_version, npmDir) => {
    it.each([
      ['no credentials', {}, 'allow'],
      ['a target _authToken', { npmrc: [`//registry.npmjs.org/:_authToken=${TOKEN}`] }, 'reject'],
      ['a target _auth', { npmrc: [`//registry.npmjs.org/:_auth=${AUTH}`] }, 'reject'],
      ['a token for another registry', { npmrc: [`//other.example/:_authToken=${TOKEN}`] }, 'allow'],
      [
        // getCredentialsByURI walks no ancestor paths, so a host-level
        // token does not apply to a publish under a path on that host.
        'a host-level token for a pathful registry',
        {
          registryUrl: 'https://nexus.example/repository/npm/',
          npmrc: [`//nexus.example/:_authToken=${TOKEN}`],
        },
        'allow',
      ],
      ['a lone username', { npmrc: ['//registry.npmjs.org/:username=testuser'] }, 'allow'],
      ['a lone _password', { npmrc: [`//registry.npmjs.org/:_password=${PASSWORD}`] }, 'allow'],
      [
        'username with _password',
        {
          npmrc: [
            '//registry.npmjs.org/:username=testuser',
            `//registry.npmjs.org/:_password=${PASSWORD}`,
          ],
        },
        'reject',
      ],
      ['a lone certfile', { npmrc: ['//registry.npmjs.org/:certfile=/c.pem'] }, 'allow'],
      ['a lone keyfile', { npmrc: ['//registry.npmjs.org/:keyfile=/k.pem'] }, 'allow'],
      [
        'certfile with keyfile',
        { npmrc: ['//registry.npmjs.org/:certfile=/c.pem', '//registry.npmjs.org/:keyfile=/k.pem'] },
        'reject',
      ],
      ['registry-only configuration', { npmrc: [`registry=${NPMJS}`] }, 'allow'],
      ['auth-type, which is not a credential', { npmrc: ['auth-type=legacy'] }, 'allow'],
      ['cafile, which is not a credential', { npmrc: ['cafile=/ca.pem'] }, 'allow'],
      ['a token in the user config', { userNpmrc: [`//registry.npmjs.org/:_authToken=${TOKEN}`] }, 'reject'],
      // Settings that blinded the shell implementation's `npm config list`
      // parsing; in-process they change nothing, which is the point.
      ['a token with json=true', { npmrc: ['json=true', `//registry.npmjs.org/:_authToken=${TOKEN}`] }, 'reject'],
      ['a token with long=true', { npmrc: ['long=true', `//registry.npmjs.org/:_authToken=${TOKEN}`] }, 'reject'],
      [
        'a token in an npm_config_ variable',
        { env: { 'npm_config_//registry.npmjs.org/:_authToken': TOKEN } },
        'reject',
      ],
    ] as const)('%s: %s', async (_label, setup, want) => {
      const config = await configFor(npmDir, setup);
      const registry = 'registryUrl' in setup ? setup.registryUrl : NPMJS;
      const check = () => assertNoStoredCredential(config, registry);
      if (want === 'allow') {
        expect(check).not.toThrow();
      } else {
        expect(check).toThrow(InputError);
        // Never the value, only the kind.
        expect(check).toThrow(expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }));
      }
    });

    // npm's config commands fail with ENOWORKSPACES inside a workspace
    // package, which once made the shell guard refuse every such publish.
    // In-process, the workspace changes nothing. The publish passes
    // --no-workspaces, so npm's project is the package itself: a token in
    // its own .npmrc is a fallback, one at the workspace root is not --
    // measured with `npm publish --dry-run`, which warns it is not logged
    // in for the root token and does not for the package's.
    it.each([
      ['no credentials', 'project', [], 'allow'],
      ['a target token in its own .npmrc', 'project', [`//registry.npmjs.org/:_authToken=${TOKEN}`], 'reject'],
      ['a target token at the workspace root', 'root', [`//registry.npmjs.org/:_authToken=${TOKEN}`], 'allow'],
    ] as const)('inside a workspace package, %s: %s', async (_label, where, lines, want) => {
      writeFileSync(
        path.join(project, 'package.json'),
        '{"name":"ws","version":"1.0.0","private":true,"workspaces":["packages/*"]}',
      );
      const child = path.join(project, 'packages', 'a');
      mkdirSync(child, { recursive: true });
      writeFileSync(path.join(child, 'package.json'), '{"name":"a","version":"1.0.0"}');
      writeFileSync(path.join(where === 'root' ? project : child, '.npmrc'), `${lines.join('\n')}\n`);
      const config = await configFor(npmDir, { cwd: child });
      const check = () => assertNoStoredCredential(config, NPMJS);
      if (want === 'allow') expect(check).not.toThrow();
      else expect(check).toThrow(InputError);
    });
  },
);

describe.each(npmDirs.map((dir) => [loadNpmInternals(dir).npmVersion, dir]))(
  'provenance precedence on npm %s',
  (version, npmDir) => {
    const verdict = async (setup: Setup, publishConfig?: Record<string, unknown>) =>
      provenanceVerdict(await configFor(npmDir, setup), version, publishConfig);

    it('leaves provenance to npm when nothing sets it', async () => {
      const v = await verdict({});
      expect(v).toEqual({ provenance: false, provenanceFile: false, notice: null });
      expect(checkOidcProvenance(v)).toBeNull();
    });

    it.each([
      ['provenance=true in .npmrc', { npmrc: ['provenance=true'] }, undefined],
      ['npm_config_provenance=true', { env: { npm_config_provenance: 'true' } }, undefined],
      ['publishConfig.provenance true', {}, { provenance: true }],
      ['provenance-file in .npmrc', { npmrc: ['provenance-file=/bundle.json'] }, undefined],
    ] as const)('refuses explicit provenance from %s', async (_label, setup, publishConfig) => {
      const v = await verdict(setup, publishConfig);
      expect(() => checkOidcProvenance(v)).toThrow(/conflicts with oidc/);
    });

    // An .npmrc entry moves the setting off its default, so npm does not
    // auto-enable provenance; publishConfig does not, so it still does.
    it.each([
      ['provenance=false in .npmrc', { npmrc: ['provenance=false'] }, undefined, 'set to false in npm configuration'],
      ['publishConfig.provenance false', {}, { provenance: false }, 'still attaches provenance'],
      ['.npmrc true with publishConfig false', { npmrc: ['provenance=true'] }, { provenance: false }, 'set in both'],
    ] as const)('accepts %s, explaining the outcome', async (_label, setup, publishConfig, notice) => {
      const v = await verdict(setup, publishConfig);
      expect(checkOidcProvenance(v)).toContain(notice);
    });

    // Outside OIDC, what matters is whether npm will sign provenance, which
    // decides whether the publish keeps the token endpoint.
    it('reports ambient provenance a non-OIDC publish would sign', async () => {
      expect((await verdict({ npmrc: ['provenance=true'] })).provenance).toBe(true);
      expect((await verdict({}, { provenance: true })).provenance).toBe(true);
      expect((await verdict({ npmrc: ['provenance=true'] }, { provenance: false })).provenance).toBe(false);
    });
  },
);
