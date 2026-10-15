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
import { loadNpmInternals, NpmInternalsError, type NpmInternals } from '../src/npm-internals.js';
import { meetsFloor, OIDC_NPM_FLOOR, provenanceVerdict } from '../src/oidc.js';
import { prepare } from '../src/prepare.js';
import { publishArgs } from '../src/publish-command.js';
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
    INPUT_IF_EXISTS: 'fail',
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

  // npm resolves a relative userconfig against the directory it runs in,
  // which for the publish is the project, not the workspace.
  it.runIf(npmClears)('finds a credential in a userconfig relative to the project', async () => {
    writeFileSync(
      path.join(workspace, 'project', 'publish.npmrc'),
      `//registry.example.invalid/:_authToken=${SHADOW_TOKEN}\n`,
    );
    await expect(
      prepare(env({ ...OIDC, npm_config_userconfig: './publish.npmrc' }), loadNpmInternals, NODE),
    ).rejects.toThrow('stored npm credentials would shadow OIDC');
  });
});

describe('prepare: the token endpoint outside OIDC', () => {
  const TOKEN = { INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't' };

  it('withholds it from a token publish', async () => {
    const result = await prepare(env(TOKEN));
    expect(readState(result.statePath, runnerTemp).idTokenEndpoint).toBe(false);
  });

  // The opt-out notice asks npm's isDefault, which npm 8.1 lacks; only a
  // trusted publish, on npm 11.5.2 or later, needs it.
  it('prepares a token publish on an npm without isDefault', async () => {
    const real = loadNpmInternals();
    const realLoad = real.loadConfig;
    if (!realLoad) throw new Error('no @npmcli/config');
    const npm81 = (): NpmInternals => ({
      ...real,
      npmVersion: '8.1.0',
      loadConfig: async (options) => {
        const config = await realLoad(options);
        return {
          ...config,
          flat: config.flat,
          isDefault: () => {
            throw new NpmInternalsError('npm 8.1.0: @npmcli/config has no isDefault.');
          },
        };
      },
    });
    const result = await prepare(env(TOKEN), npm81);
    expect(readState(result.statePath, runnerTemp).provenance).toBe(false);
  });

  // Resolved where npm publishes from, the project, and pinned absolute.
  it('resolves a relative provenance bundle against the project', async () => {
    const result = await prepare(env({ ...TOKEN, npm_config_provenance_file: './bundle.json' }));
    expect(readState(result.statePath, runnerTemp).provenanceFile).toBe(
      path.join(workspace, 'project', 'bundle.json'),
    );
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

  // The .npmrc step replaces the project's .npmrc between prepare and the
  // publish. Whatever provenance npm resolves *after* that, from the
  // publish's real command line, must be what the endpoint was decided
  // for: signing without it fails, and keeping it unsigned permits an
  // exchange nobody asked for.
  const project = path.join('project', '.npmrc');
  it.each([
    ['nothing sets provenance', {}, {}, false],
    ['the input enables it', { INPUT_PROVENANCE: 'true' }, {}, true],
    ['only the project .npmrc enables it', {}, { [project]: 'provenance=true\n' }, true],
    [
      'the project .npmrc masks a user-level enable',
      {},
      { [project]: 'provenance=false\n', '.npmrc': 'provenance=true\n' },
      false,
    ],
    ['the user-level .npmrc enables it', {}, { '.npmrc': 'provenance=true\n' }, true],
  ] as const)(
    'keeps provenance across the .npmrc replacement when %s',
    async (_label, inputs, files, expected) => {
      for (const [file, text] of Object.entries(files)) {
        writeFileSync(file === project ? path.join(workspace, file) : path.join(home, file), text);
      }
      const result = await prepare(env({ ...TOKEN, ...inputs }));
      const state = readState(result.statePath, runnerTemp);
      expect(state.provenance).toBe(expected);
      expect(state.idTokenEndpoint).toBe(expected);

      // What the .npmrc step leaves: a credential keyed to the registry.
      writeFileSync(
        path.join(workspace, project),
        '//registry.example.invalid/:_authToken=placeholder-not-a-secret\n',
      );
      const npm = loadNpmInternals();
      if (!npm.loadConfig) throw new Error('no @npmcli/config');
      const config = await npm.loadConfig({
        cwd: state.projectDir,
        flags: publishArgs(state),
        env: env({ ...TOKEN, ...inputs }),
      });
      expect(provenanceVerdict(config, npm.npmVersion, undefined).provenance).toBe(expected);
    },
  );

  // Bundles and the boolean across the replacement, from each source and
  // their mixtures. A configuration bundle is carried, since npm refuses
  // it alongside an explicit provenance. A publishConfig bundle stays in
  // the manifest, where npm applies it after loading configuration. The
  // endpoint follows whether npm will sign, which a bundle does not stop.
  const BUNDLE = '/bundles/provenance.sigstore.json';
  const IN_PROJECT = { [project]: `provenance-file=${BUNDLE}\n` };
  const MANIFEST_BUNDLE = { 'provenance-file': BUNDLE };
  interface Case {
    files?: Record<string, string>;
    ambient?: Record<string, string>;
    publishConfig?: Record<string, unknown>;
    /** The state: the bundle carried, the boolean enforced, the endpoint. */
    carried: string;
    enforced: boolean | null;
    signs: boolean;
    /** The bundle npm publishes with after the replacement. */
    bundle: string;
  }
  it.each<[string, Case]>([
    ['a project .npmrc bundle', { files: IN_PROJECT, carried: BUNDLE, enforced: null, signs: false, bundle: BUNDLE }],
    [
      'a user-level .npmrc bundle',
      { files: { '.npmrc': `provenance-file=${BUNDLE}\n` }, carried: BUNDLE, enforced: null, signs: false, bundle: BUNDLE },
    ],
    [
      'npm_config_provenance_file',
      { ambient: { npm_config_provenance_file: BUNDLE }, carried: BUNDLE, enforced: null, signs: false, bundle: BUNDLE },
    ],
    [
      'an .npmrc bundle with publishConfig.provenance true',
      { files: IN_PROJECT, publishConfig: { provenance: true }, carried: BUNDLE, enforced: null, signs: true, bundle: BUNDLE },
    ],
    ['a publishConfig bundle', { publishConfig: MANIFEST_BUNDLE, carried: '', enforced: false, signs: false, bundle: BUNDLE }],
    [
      'a publishConfig bundle with user-level provenance=false',
      {
        files: { '.npmrc': 'provenance=false\n' },
        publishConfig: MANIFEST_BUNDLE,
        carried: '',
        enforced: false,
        signs: false,
        bundle: BUNDLE,
      },
    ],
    [
      'publishConfig.provenance "true", a string',
      { publishConfig: { provenance: 'true' }, carried: '', enforced: false, signs: false, bundle: '' },
    ],
    // publishConfig's bundle ships, but the configuration's still rules
    // out an explicit provenance.
    [
      'a user-level .npmrc bundle overridden by a publishConfig one',
      {
        files: { '.npmrc': 'provenance-file=/user/bundle.json\n' },
        publishConfig: MANIFEST_BUNDLE,
        carried: '',
        enforced: null,
        signs: false,
        bundle: BUNDLE,
      },
    ],
    [
      'a project .npmrc bundle overridden by a publishConfig one',
      {
        files: { [project]: 'provenance-file=/project/bundle.json\n' },
        publishConfig: MANIFEST_BUNDLE,
        carried: '',
        enforced: null,
        signs: false,
        bundle: BUNDLE,
      },
    ],
  ])('carries %s across the replacement', async (_label, c) => {
    for (const [file, text] of Object.entries(c.files ?? {})) {
      writeFileSync(file === project ? path.join(workspace, file) : path.join(home, file), text);
    }
    const manifest = { name: 'working-directory', version: '0.0.0', publishConfig: c.publishConfig };
    writeFileSync(path.join(workspace, 'project', 'package.json'), JSON.stringify(manifest));
    const result = await prepare(env({ ...TOKEN, ...c.ambient }));
    const state = readState(result.statePath, runnerTemp);
    expect(state).toMatchObject({ provenance: c.enforced, provenanceFile: c.carried, idTokenEndpoint: c.signs });

    writeFileSync(
      path.join(workspace, project),
      '//registry.example.invalid/:_authToken=placeholder-not-a-secret\n',
    );
    const npm = loadNpmInternals();
    if (!npm.loadConfig) throw new Error('no @npmcli/config');
    const config = await npm.loadConfig({
      cwd: state.projectDir,
      flags: publishArgs(state),
      env: env({ ...TOKEN, ...c.ambient }),
    });
    expect(provenanceVerdict(config, npm.npmVersion, c.publishConfig)).toMatchObject({
      provenance: c.signs,
      provenanceFile: c.bundle,
    });
  });

  // A project .npmrc can select the user configuration file, and the
  // .npmrc step replacing it would otherwise fall back to ~/.npmrc: here
  // one naming a bundle, which npm refuses beside --no-provenance.
  // npm_config_userconfig is unset, as on a runner, so npm takes the
  // default.
  it('keeps the user configuration a project .npmrc selected', async () => {
    const clean = path.join(root, 'clean.npmrc');
    writeFileSync(clean, '\n');
    writeFileSync(path.join(home, '.npmrc'), 'provenance-file=/bundles/default.json\n');
    writeFileSync(path.join(workspace, project), `userconfig=${clean}\n`);
    // Fresh for each load: npm writes what it resolves back into the
    // environment it is given.
    const runnerEnv = (): NodeJS.ProcessEnv => {
      const result = env(TOKEN);
      delete result['npm_config_userconfig'];
      return result;
    };
    const result = await prepare(runnerEnv());
    const state = readState(result.statePath, runnerTemp);
    expect(state).toMatchObject({ userconfig: clean, provenance: false, provenanceFile: '' });

    writeFileSync(
      path.join(workspace, project),
      '//registry.example.invalid/:_authToken=placeholder-not-a-secret\n',
    );
    const npm = loadNpmInternals();
    if (!npm.loadConfig) throw new Error('no @npmcli/config');
    const config = await npm.loadConfig({ cwd: state.projectDir, flags: publishArgs(state), env: runnerEnv() });
    expect(config.get('userconfig')).toBe(clean);
    expect(provenanceVerdict(config, npm.npmVersion, undefined).configBundle).toBe('');
  });

  // A user or global file can name another as userconfig or globalconfig
  // without npm loading it. Pinning that value would load a file prepare
  // never checked; here one holding a token, which the publish would then
  // see. The pin is the file npm loaded. userconfig is left unset, as on a
  // runner, so npm loads ~/.npmrc; the default global file lies under
  // npm's own prefix, so the global case selects one through the variable.
  it.each([
    ['userconfig', '.npmrc', 'user'],
    ['globalconfig', 'npmrc-global', 'global'],
  ] as const)('pins the %s file npm loaded, not one it names', async (key, file, layer) => {
    const other = path.join(root, 'other.npmrc');
    writeFileSync(other, '//registry.example.invalid/:_authToken=placeholder-not-a-secret\n');
    const loaded = path.join(home, file);
    writeFileSync(loaded, `${key}=${other}\n`);
    // Fresh for each load: npm writes what it resolves back into the
    // environment it is given.
    const runnerEnv = (): NodeJS.ProcessEnv => {
      const result = env(TOKEN);
      delete result['npm_config_userconfig'];
      return result;
    };
    const result = await prepare(runnerEnv());
    const state = readState(result.statePath, runnerTemp);
    expect(state[key]).toBe(loaded);

    const npm = loadNpmInternals();
    if (!npm.loadConfig) throw new Error('no @npmcli/config');
    const config = await npm.loadConfig({ cwd: state.projectDir, flags: publishArgs(state), env: runnerEnv() });
    expect(config.loadedFiles[layer]).toBe(loaded);
    expect(config.getCredentialsByURI('https://registry.example.invalid/').token).toBeUndefined();
  });

  // npm reads dry-run from its configuration, where nothing else this
  // action decides looks: the token endpoint, the credential guard and the
  // .npmrc step all follow the input. The publish's command line must
  // therefore make npm agree with it, against any ambient setting.
  it.each([
    ['an .npmrc', { [project]: 'dry-run=true\n' }, {}],
    ['npm_config_dry_run', {}, { npm_config_dry_run: 'true' }],
  ] as const)('overrides an ambient dry run from %s', async (_label, files, ambient) => {
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(workspace, file), text);
    const result = await prepare(env({ ...TOKEN, ...ambient }));
    const state = readState(result.statePath, runnerTemp);
    expect(state.dryRun).toBe(false);
    const npm = loadNpmInternals();
    if (!npm.loadConfig) throw new Error('no @npmcli/config');
    const config = await npm.loadConfig({
      cwd: state.projectDir,
      flags: publishArgs(state),
      env: env({ ...TOKEN, ...ambient }),
    });
    expect(config.get('dry-run')).toBe(false);
  });
});
