// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The prepare step end to end, through the npm on PATH: inputs, paths,
 * staging, the tarball's manifest and the registry, in the order the step
 * runs them. Replaces running the validate step's shell, extracted from
 * action.yaml, against each tarball case.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputError } from '../src/inputs.js';
import { loadNpmInternals, NpmInternalsError } from '../src/npm-internals.js';
import { meetsFloor, OIDC_NPM_FLOOR } from '../src/oidc.js';
import { prepare } from '../src/prepare.js';
import { readState, STAGED_NAME, STATE_NAME } from '../src/state.js';
import { isolatedEnv } from './support/ground-truth.js';

let root: string;
let workspace: string;
let runnerTemp: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'prepare-test-')));
  workspace = path.join(root, 'ws');
  runnerTemp = path.join(root, 'temp');
  home = path.join(root, 'home');
  for (const dir of [workspace, runnerTemp, home]) mkdirSync(dir);
  mkdirSync(path.join(workspace, 'project'));
  writeFileSync(
    path.join(workspace, 'project', 'package.json'),
    '{"name":"working-directory","version":"0.0.0"}',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Pack `manifest` as an npm archive at `name` inside the workspace. */
function pack(name: string, manifest: string): string {
  const staging = mkdtempSync(path.join(root, 'pack-'));
  mkdirSync(path.join(staging, 'package'));
  writeFileSync(path.join(staging, 'package', 'package.json'), manifest);
  const out = path.join(workspace, name);
  const result = spawnSync('tar', ['-czf', out, '-C', staging, 'package']);
  if (result.status !== 0) throw new Error(`could not pack ${name}`);
  return name;
}

/** The step's environment: isolated from ambient npm config, dry run by default. */
function env(inputs: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...isolatedEnv(home),
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    INPUT_PUBLISH_VERSION: '3.2.1',
    INPUT_REGISTRY_URL: 'https://registry.example.invalid/',
    INPUT_DRY_RUN: 'true',
    INPUT_PATH_PREFIX: 'project',
    INPUT_NODE_VERSION: '22',
    INPUT_TAG: 'latest',
    INPUT_PROVENANCE: 'false',
    INPUT_LOAD_CREDENTIAL: 'false',
    INPUT_OIDC: 'false',
    ...inputs,
  };
}

describe('prepare: packing the project directory', () => {
  it('resolves the project and emits no tarball', async () => {
    const result = await prepare(env());
    expect(result.projectDir).toBe(path.join(workspace, 'project'));
    expect(result.tarball).toBe('');
    expect(result.resolution.registry).toBe('https://registry.example.invalid/');
    expect(result.resolution.source).toBe('input');
    // The state the publish step reads, and nothing else, in a private
    // work directory.
    const state = readState(result.statePath, runnerTemp);
    expect(state).toMatchObject({
      projectDir: path.join(workspace, 'project'),
      tarball: '',
      publishVersion: '3.2.1',
      dryRun: true,
      tag: 'latest',
      registry: 'https://registry.example.invalid/',
      scopes: [],
    });
    expect(readdirSync(path.dirname(result.statePath))).toEqual([STATE_NAME]);
  });

  it('carries the input notices through', async () => {
    const result = await prepare(
      env({ INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't', INPUT_NEXUS_USER: 'u' }),
    );
    expect(result.notices).toEqual([expect.stringContaining('Ignoring nexus_user')]);
  });

  it('refuses a workspace selector before anything else', async () => {
    await expect(prepare(env({ NPM_CONFIG_WORKSPACE: 'packages/a' }))).rejects.toThrow(
      'a workspace is selected',
    );
  });

  it('refuses an escaping project directory', async () => {
    await expect(prepare(env({ INPUT_PATH_PREFIX: '/etc' }))).rejects.toThrow(
      'project directory escapes the workspace',
    );
  });

  it('refuses an escaping node_version_file', async () => {
    writeFileSync(path.join(root, '.nvmrc'), '22\n');
    await expect(prepare(env({ INPUT_NODE_VERSION_FILE: '../.nvmrc' }))).rejects.toThrow(
      'node_version_file escapes the workspace',
    );
  });

  it('refuses a scoped override the registry_url rules would refuse', async () => {
    writeFileSync(
      path.join(workspace, 'project', 'package.json'),
      JSON.stringify({
        name: '@onap/ui-common',
        version: '1.0.0',
        publishConfig: { '@onap:registry': 'http://evil.example/' },
      }),
    );
    await expect(prepare(env())).rejects.toThrow('lowercase "https://"');
  });
});

describe('prepare: publishing a pre-packed tarball', () => {
  it('stages the archive and checks its version', async () => {
    const tarball = pack('ok.tgz', '{"name":"packed-package","version":"3.2.1"}');
    const result = await prepare(env({ INPUT_TARBALL_PATH: tarball }));
    expect(result.tarball).toBe(path.join(path.dirname(result.statePath), STAGED_NAME));
    expect(existsSync(result.tarball)).toBe(true);
    expect(readState(result.statePath, runnerTemp).tarball).toBe(result.tarball);
  });

  // The version compared is the one npm sends, normalised as npm
  // normalises it, so a 'v' prefix in the archive publishes as the bare
  // version requested.
  it('compares the version npm will publish', async () => {
    const tarball = pack('vprefix.tgz', '{"name":"packed-package","version":"v3.2.1"}');
    await expect(prepare(env({ INPUT_TARBALL_PATH: tarball }))).resolves.toBeDefined();
  });

  // The archive's manifest decides, not the working directory's.
  it('resolves the registry from the manifest inside the archive', async () => {
    const tarball = pack(
      'scoped.tgz',
      JSON.stringify({
        name: '@onap/from-tarball',
        version: '3.2.1',
        publishConfig: { '@onap:registry': 'https://from-tarball.example.invalid/' },
      }),
    );
    const result = await prepare(env({ INPUT_TARBALL_PATH: tarball }));
    expect(result.resolution.registry).toBe('https://from-tarball.example.invalid/');
    expect(result.resolution.source).toBe('publishConfig-scoped');
    expect(result.resolution.scopes).toEqual(['@onap']);
  });

  it.each([
    ['version mismatch', () => pack('ok.tgz', '{"name":"p","version":"3.2.1"}'), '9.9.9', 'does not match publish_version'],
    ['not an npm archive', () => {
      writeFileSync(path.join(workspace, 'broken.tgz'), 'not a tarball');
      return 'broken.tgz';
    }, '3.2.1', 'cannot read package.json from the tarball'],
    ['manifest is not JSON', () => pack('badjson.tgz', '{ not json'), '3.2.1', 'not valid JSON'],
    ['manifest has no version', () => pack('noversion.tgz', '{"name":"no-version"}'), '3.2.1', 'declares no version'],
  ])('refuses %s, and removes the work directory', async (_label, make, version, message) => {
    const tarball = make();
    const failure = prepare(env({ INPUT_TARBALL_PATH: tarball, INPUT_PUBLISH_VERSION: version }));
    await expect(failure).rejects.toThrow(InputError);
    await expect(failure).rejects.toThrow(message);
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  // A broken npm installation is not a broken archive: reporting it as
  // one would send the caller to repack a valid tarball.
  it('reports an npm loader failure as itself, not as a bad archive', async () => {
    const tarball = pack('ok.tgz', '{"name":"p","version":"3.2.1"}');
    const broken = () => ({
      ...loadNpmInternals(),
      readManifest: () => Promise.reject(new NpmInternalsError('npm 11.0.0: cannot load pacote')),
    });
    const failure = prepare(env({ INPUT_TARBALL_PATH: tarball }), broken);
    await expect(failure).rejects.toThrow(NpmInternalsError);
    await expect(failure).rejects.toThrow('cannot load pacote');
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  it('refuses a path rejection before making a work directory', async () => {
    await expect(prepare(env({ INPUT_TARBALL_PATH: 'nope.tgz' }))).rejects.toThrow(
      'cannot resolve tarball_path',
    );
    expect(readdirSync(runnerTemp)).toEqual([]);
  });
});

describe('prepare: OIDC trusted publishing', () => {
  const ENDPOINT = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example.invalid/',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  };
  const OIDC = { INPUT_OIDC: 'true', INPUT_DRY_RUN: 'false', ...ENDPOINT };
  // The floors apply to the npm and Node.js running the publish; tests on
  // an older toolchain pass a Node.js that clears them, and skip where npm
  // itself is below 11.5.2.
  const npm = loadNpmInternals();
  const npmClears = meetsFloor(npm.npmVersion, OIDC_NPM_FLOOR);
  const NODE = '24.0.0';
  // A test literal, not a credential.
  const SHADOW_TOKEN = 'placeholder-not-a-secret';

  it('refuses a real trusted publish without the id-token grant', async () => {
    await expect(prepare(env({ INPUT_OIDC: 'true', INPUT_DRY_RUN: 'false' }))).rejects.toThrow(
      "Grant 'id-token: write'",
    );
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  it('holds a dry run to the toolchain floor, but not to the grant', async () => {
    await expect(
      prepare(env({ INPUT_OIDC: 'true' }), loadNpmInternals, '22.13.0'),
    ).rejects.toThrow('Node.js 22.13.0 is below the 22.14.0');
  });

  it.runIf(npmClears)('refuses a stored credential before anything is stamped', async () => {
    writeFileSync(
      path.join(workspace, 'project', '.npmrc'),
      `//registry.example.invalid/:_authToken=${SHADOW_TOKEN}\n`,
    );
    await expect(prepare(env(OIDC), loadNpmInternals, NODE)).rejects.toThrow(
      'stored npm credentials would shadow OIDC',
    );
    expect(readdirSync(runnerTemp)).toEqual([]);
  });

  it.runIf(npmClears)('refuses ambient provenance from publishConfig', async () => {
    writeFileSync(
      path.join(workspace, 'project', 'package.json'),
      '{"name":"p","version":"1.0.0","publishConfig":{"provenance":true}}',
    );
    await expect(prepare(env(OIDC), loadNpmInternals, NODE)).rejects.toThrow('conflicts with oidc');
  });

  it.runIf(npmClears)('keeps the endpoint for a real trusted publish only', async () => {
    const real = await prepare(env(OIDC), loadNpmInternals, NODE);
    expect(readState(real.statePath, runnerTemp).idTokenEndpoint).toBe(true);
    const rehearsal = await prepare(env({ ...OIDC, INPUT_DRY_RUN: 'true' }), loadNpmInternals, NODE);
    expect(readState(rehearsal.statePath, runnerTemp).idTokenEndpoint).toBe(false);
  });

  // Hooks run after the guard and are repository code; the caller is told
  // the limit, and how to remove it.
  it.runIf(npmClears)('names publish hooks the guard cannot bind', async () => {
    writeFileSync(
      path.join(workspace, 'project', 'package.json'),
      '{"name":"p","version":"1.0.0","scripts":{"prepare":"tsc"}}',
    );
    const result = await prepare(env(OIDC), loadNpmInternals, NODE);
    expect(result.notices).toEqual([expect.stringContaining('lifecycle script(s): prepare')]);
  });

  it.runIf(npmClears)('notices an opt-out that leaves the publish unattested', async () => {
    writeFileSync(path.join(workspace, 'project', '.npmrc'), 'provenance=false\n');
    const result = await prepare(env(OIDC), loadNpmInternals, NODE);
    expect(result.notices).toEqual([expect.stringContaining('carries no attestation')]);
  });
});

describe('prepare: the token endpoint outside OIDC', () => {
  const TOKEN = { INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't' };

  it('withholds it from a token publish', async () => {
    const result = await prepare(env(TOKEN));
    expect(readState(result.statePath, runnerTemp).idTokenEndpoint).toBe(false);
  });

  // Provenance signs with the workflow identity, so a publish requesting
  // it keeps the endpoint -- whether the input or the project asked.
  // npm also attempts a trusted-publisher exchange with that endpoint, and
  // the two cannot be separated, so the caller is told rather than left to
  // believe the stored credential is the only route.
  it.each([
    ['the provenance input', { INPUT_PROVENANCE: 'true' }, undefined],
    ['an .npmrc', {}, 'provenance=true\n'],
  ])('keeps it when %s enables provenance, and says what that allows', async (_label, inputs, npmrc) => {
    if (npmrc) writeFileSync(path.join(workspace, 'project', '.npmrc'), npmrc);
    const result = await prepare(env({ ...TOKEN, ...inputs }));
    expect(readState(result.statePath, runnerTemp).idTokenEndpoint).toBe(true);
    expect(result.notices).toEqual([expect.stringContaining('trusted publisher configured')]);
  });
});
