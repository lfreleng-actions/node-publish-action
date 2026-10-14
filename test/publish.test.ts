// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The publish step end to end. Dry runs go through the real npm on PATH,
 * offline, as the action runs them; verification, which needs a registry,
 * goes through a scripted runner.
 *
 * Replaces running the stamp step's shell, extracted from action.yaml,
 * against workspace fixtures.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NpmResult, NpmRunner } from '../src/npm-run.js';
import { prepare } from '../src/prepare.js';
import { publish, PublishError, type Reporter } from '../src/publish.js';
import { makeWorkDir, readState, STATE_NAME, writeState } from '../src/state.js';
import { isolatedEnv } from './support/ground-truth.js';

let root: string;
let workspace: string;
let runnerTemp: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'publish-test-')));
  workspace = path.join(root, 'ws');
  runnerTemp = path.join(root, 'temp');
  home = path.join(root, 'home');
  for (const dir of [workspace, runnerTemp, home]) mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const file = path.join(workspace, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function version(relative: string): unknown {
  return (JSON.parse(readFileSync(path.join(workspace, relative), 'utf8')) as { version?: unknown })
    .version;
}

function env(inputs: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...isolatedEnv(home),
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    INPUT_PUBLISH_VERSION: '7.7.7',
    INPUT_REGISTRY_URL: 'https://registry.example.invalid/',
    INPUT_DRY_RUN: 'true',
    INPUT_PATH_PREFIX: 'proj',
    INPUT_NODE_VERSION: '22',
    INPUT_TAG: 'latest',
    INPUT_PROVENANCE: 'false',
    INPUT_LOAD_CREDENTIAL: 'false',
    ...inputs,
  };
}

/** Records what the step reports. */
function recorder() {
  const log: { kind: string; text: string }[] = [];
  const outputs: Record<string, string> = {};
  const io: Reporter = {
    info: (text) => log.push({ kind: 'info', text }),
    notice: (text) => log.push({ kind: 'notice', text }),
    warning: (text) => log.push({ kind: 'warning', text }),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    summary: (text) => log.push({ kind: 'summary', text }),
  };
  const of = (kind: string) => log.filter((entry) => entry.kind === kind).map((e) => e.text);
  return { io, outputs, of };
}

/** Prepare, then publish, as the action's two bundled steps do. */
async function run(inputs: Record<string, string> = {}) {
  const prepared = await prepare(env(inputs));
  const rec = recorder();
  const metadata = publish(prepared.statePath, env(inputs), rec.io);
  return { prepared, metadata, ...rec };
}

describe('publish: a dry run through real npm', () => {
  it('stamps, packs and reports the package', async () => {
    write('proj/package.json', '{"name":"lfreleng-publish-test","version":"1.0.0"}');
    const { outputs, of } = await run();
    expect(version('proj/package.json')).toBe('7.7.7');
    expect(outputs).toEqual({
      package_name: 'lfreleng-publish-test',
      published_version: '7.7.7',
      tarball_name: 'lfreleng-publish-test-7.7.7.tgz',
    });
    expect(of('summary').join('')).toContain('**Mode:** dry run');
  });

  it('does not run version hooks, and says so', async () => {
    write(
      'proj/package.json',
      JSON.stringify({
        name: 'hook-project',
        version: '1.0.0',
        scripts: { preversion: 'touch pre.marker', version: 'touch v.marker', postversion: 'touch post.marker' },
      }),
    );
    const { of } = await run();
    for (const marker of ['pre', 'v', 'post']) {
      expect(existsSync(path.join(workspace, 'proj', `${marker}.marker`))).toBe(false);
    }
    expect(of('notice')).toEqual([
      expect.stringContaining('Skipped npm version lifecycle script(s): postversion, preversion, version'),
    ]);
  });

  it('warns that directory publish hooks run after resolution', async () => {
    write(
      'proj/package.json',
      JSON.stringify({ name: 'hook-project', version: '1.0.0', scripts: { prepack: 'true' } }),
    );
    const { of } = await run();
    expect(of('notice')).toEqual([expect.stringContaining('lifecycle script(s): prepack')]);
  });

  describe('stamping a workspace root touches no sibling', () => {
    beforeEach(() => {
      write(
        'proj/package.json',
        '{"name":"ws-root","version":"1.0.0","private":true,"workspaces":["packages/*"]}',
      );
      write('proj/packages/a/package.json', '{"name":"ws-child","version":"1.0.0"}');
    });

    it.each([
      ['with no npm configuration', ''],
      ['with workspaces=true', 'workspaces=true\n'],
    ])('%s', async (_label, npmrc) => {
      write('proj/.npmrc', npmrc);
      // A private root cannot publish, so this stops at npm publish, after
      // the stamp: what matters here is which manifests it rewrote.
      await run().catch(() => undefined);
      expect(version('proj/package.json')).toBe('7.7.7');
      expect(version('proj/packages/a/package.json')).toBe('1.0.0');
    });

    // A selector in an .npmrc conflicts with --no-workspaces, and nothing
    // can detect it earlier. It must fail at the stamp, before anything
    // publishes, and say what to do.
    it('fails at the stamp when an .npmrc selects a workspace', async () => {
      write('proj/.npmrc', 'workspace=packages/a\n');
      await expect(run()).rejects.toThrow('a workspace is selected in npm configuration');
      expect(version('proj/packages/a/package.json')).toBe('1.0.0');
    });
  });

  it('publishes a staged tarball without stamping anything', async () => {
    write('proj/package.json', '{"name":"decoy","version":"0.0.1"}');
    const staging = path.join(root, 'pack', 'package');
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, 'package.json'), '{"name":"packed-package","version":"7.7.7"}');
    spawnSync('tar', ['-czf', path.join(workspace, 'packed.tgz'), '-C', path.dirname(staging), 'package']);

    const { outputs } = await run({ INPUT_TARBALL_PATH: 'packed.tgz' });
    expect(outputs['package_name']).toBe('packed-package');
    expect(version('proj/package.json')).toBe('0.0.1');
  });
});

describe('publish: the state and the npm it runs', () => {
  it('refuses a state file the prepare step did not write', () => {
    const elsewhere = path.join(root, STATE_NAME);
    writeFileSync(elsewhere, '{}');
    expect(() => publish(elsewhere, env(), recorder().io)).toThrow('not one the prepare step wrote');
  });

  it('refuses to run an npm other than the one that resolved the registry', async () => {
    write('proj/package.json', '{"name":"p","version":"1.0.0"}');
    const { statePath } = await prepare(env());
    const state = readState(statePath, runnerTemp);
    const other = makeWorkDir(runnerTemp);
    const forged = writeState(other, { ...state, npmDir: home });
    expect(() => publish(forged, env(), recorder().io)).toThrow('is not npm');
  });
});

describe('publish: verification', () => {
  const REPORT = '{"p":{"name":"p","version":"7.7.7","filename":"p-7.7.7.tgz"}}';

  /** A runner answering the publish with `REPORT` and the view with `view`. */
  function scripted(view: NpmResult): { runner: NpmRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: NpmRunner = (args, options) => {
      calls.push([...args]);
      if (args[0] === 'version') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'publish') {
        if (options.stdoutFile) writeFileSync(options.stdoutFile, REPORT);
        return { status: 0, stdout: REPORT, stderr: '' };
      }
      return view;
    };
    return { runner, calls };
  }

  async function realPublish(view: NpmResult) {
    write('proj/package.json', '{"name":"p","version":"7.7.7"}');
    const inputs = { INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't' };
    const { statePath } = await prepare(env(inputs));
    const rec = recorder();
    const { runner, calls } = scripted(view);
    const result = () => publish(statePath, env(inputs), rec.io, runner);
    return { result, calls, ...rec };
  }

  it('confirms the version on the resolved registry', async () => {
    const { result, calls, of } = await realPublish({ status: 0, stdout: '7.7.7\n', stderr: '' });
    result();
    expect(calls.map((c) => c[0])).toEqual(['version', 'publish', 'view']);
    expect(calls[2]).toContain('https://registry.example.invalid/');
    expect(of('summary').join('')).toContain('Registry confirmed p@7.7.7 ✅');
  });

  it('downgrades an unreadable package to a warning', async () => {
    const { result, of } = await realPublish({ status: 1, stdout: '', stderr: 'E404' });
    expect(() => result()).not.toThrow();
    expect(of('warning')).toEqual([expect.stringContaining('could not confirm p@7.7.7')]);
  });

  it('fails when the registry reports another version', async () => {
    const { result } = await realPublish({ status: 0, stdout: '7.7.6\n', stderr: '' });
    expect(() => result()).toThrow(PublishError);
    expect(() => result()).toThrow('The registry then reported an unexpected version');
    // npm succeeded, so this must not read as an invitation to retry.
    expect(() => result()).toThrow('Do not retry');
  });

  // Reporting can fail too -- an unwritable GITHUB_OUTPUT, a full disk --
  // and npm has published by then.
  it.each(['setOutput', 'summary'] as const)(
    'reports a failing %s after the publish as do-not-retry',
    async (method) => {
      const { result, io } = await realPublish({ status: 0, stdout: '7.7.7\n', stderr: '' });
      io[method] = () => {
        throw new Error('ENOSPC: no space left on device');
      };
      expect(() => result()).toThrow(/Do not retry.*Reporting the result then failed: ENOSPC/s);
    },
  );

  // The manifest is read before npm runs; a postpublish failure with no
  // report (npm 8 and 9) must not read as a plain, retryable failure.
  it('warns against a retry when a post-upload script is defined and npm fails', async () => {
    write('proj/package.json', '{"name":"p","version":"7.7.7","scripts":{"postpublish":"exit 1"}}');
    const inputs = { INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't' };
    const { statePath } = await prepare(env(inputs));
    const failing: NpmRunner = (args) =>
      args[0] === 'publish'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    expect(() => publish(statePath, env(inputs), recorder().io, failing)).toThrow(
      'Check the registry before retrying',
    );
  });

  // After npm published, failing to verify must not read as "retry".
  it('reports a project directory gone after the publish as do-not-retry', async () => {
    write('proj/package.json', '{"name":"p","version":"7.7.7"}');
    const inputs = { INPUT_DRY_RUN: 'false', INPUT_AUTH_TOKEN: 't' };
    const { statePath } = await prepare(env(inputs));
    const projectDir = path.join(workspace, 'proj');
    // A postpublish script removing the directory, say.
    const removing: NpmRunner = (args, options) => {
      if (args[0] === 'publish') {
        if (options.stdoutFile) writeFileSync(options.stdoutFile, REPORT);
        rmSync(projectDir, { recursive: true });
        return { status: 0, stdout: REPORT, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(() => publish(statePath, env(inputs), recorder().io, removing)).toThrow('Do not retry');
  });
});
