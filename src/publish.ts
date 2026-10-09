// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Stamp, publish and verify, from the state the prepare step wrote.
 *
 * Everything that crossed the step boundary arrives in one state file,
 * checked against one schema (state.ts), so nothing here re-validates an
 * input. What is re-checked is what can change underneath: the project
 * directory, which is repository content, and the npm on PATH.
 *
 * Reporting goes through a {@link Reporter} and npm through an
 * {@link NpmRunner}, so the sequence is tested whole; src/bin/publish.ts
 * supplies the real ones.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { locateNpm } from './npm-locate.js';
import { npmRunner, type NpmRunner } from './npm-run.js';
import {
  AFTER_UPLOAD_HOOKS,
  definedHooks,
  PUBLISH_HOOKS,
  publishArgs,
  stampArgs,
  VERSION_HOOKS,
  viewArgs,
} from './publish-command.js';
import type { PublishMetadata } from './publish-metadata.js';
import { interpretPublish, publishedPrefix } from './publish-result.js';
import { readState, type PublishState } from './state.js';
import { renderSummary } from './summary.js';
import { assertStillConfined, printable, runnerDirs } from './workspace.js';

/** Raised when the publish step fails; the message is the whole report. */
export class PublishError extends Error {}

export interface Reporter {
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  /** Append to the job summary. */
  summary(markdown: string): void;
}

/** The output file npm's publish stdout is captured in, in the work dir. */
const PUBLISH_OUTPUT = 'publish.json';

function readManifestText(projectDir: string): string {
  return readFileSync(path.join(projectDir, 'package.json'), 'utf8');
}

/**
 * Refuse to run an npm other than the one whose code resolved the
 * registry. Both are found from PATH in the same job, so a difference
 * means something changed PATH in between.
 */
function assertSameNpm(state: PublishState, pathEnv: string | undefined): void {
  const found = realpathSync(locateNpm(pathEnv));
  if (found !== realpathSync(state.npmDir)) {
    throw new PublishError(
      `The npm on PATH (${found}) is not npm ${state.npmVersion} at ` +
        `${state.npmDir}, which resolved the registry. Refusing to publish ` +
        'with an npm whose behaviour was not the one checked.',
    );
  }
}

function stamp(state: PublishState, npm: NpmRunner, env: NodeJS.ProcessEnv, io: Reporter): void {
  const { projectDir, publishVersion } = state;
  // --ignore-scripts means anything these would have done is absent from
  // the published package, which is otherwise silent.
  const hooks = definedHooks(readManifestText(projectDir), VERSION_HOOKS);
  if (hooks.length > 0) {
    io.notice(
      `Skipped npm version lifecycle script(s): ${hooks.join(', ')}. Release ` +
        'lanes stamp without installing dependencies, so these do not run; ' +
        'anything they write into the package is absent from the published artefact.',
    );
  }
  const result = npm(stampArgs(publishVersion), { cwd: projectDir, env, stderr: 'pipe' });
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`;
    if (output.trim() !== '') io.info(output);
    // A workspace *selector* in an .npmrc conflicts with --no-workspaces
    // rather than being overridden by it, and npm reports that nothing
    // earlier can detect. Failing here is the safe side: nothing has
    // published yet.
    throw new PublishError(
      output.includes('--no-workspaces and --workspace')
        ? 'a workspace is selected in npm configuration. This action ' +
            'publishes one package, so it stamps and publishes with ' +
            'workspaces disabled. Remove the workspace setting and point ' +
            'path_prefix at the package instead.'
        : `npm version failed (exit ${String(result.status)}) ❌`,
    );
  }
  let stamped: unknown;
  try {
    stamped = (JSON.parse(readManifestText(projectDir)) as { version?: unknown }).version;
  } catch {
    stamped = undefined;
  }
  if (stamped !== publishVersion) {
    throw new PublishError(
      `version stamp verification failed: package.json version is ` +
        `${printable(String(stamped))}, expected ${publishVersion}`,
    );
  }
  io.info(`Stamped version ${publishVersion} into package.json ✅`);
}

/**
 * Warn when a directory publish defines a hook that can rewrite the
 * manifest npm re-reads. The pins fix the registry for every scope known
 * now; a hook can introduce a scope that did not exist when they were
 * built. A notice, not a failure: these hooks are ordinary, and most do
 * not touch the name.
 */
function warnPublishHooks(state: PublishState, io: Reporter): void {
  if (state.tarball !== '') return;
  const hooks = definedHooks(readManifestText(state.projectDir), PUBLISH_HOOKS);
  if (hooks.length === 0) return;
  io.notice(
    `This publish runs lifecycle script(s): ${hooks.join(', ')}. They execute ` +
      'inside npm publish, after the registry was resolved, so one that ' +
      'changes the package name or publishConfig.scope can select a scoped ' +
      'registry these pins do not cover -- leaving the summary and ' +
      'verification describing another destination. Pack first and publish ' +
      'through tarball_path to remove the possibility; a tarball publish ' +
      'runs no lifecycle scripts.',
  );
}

/**
 * Best-effort confirmation. Some registries restrict anonymous reads or
 * index asynchronously, so an unreadable package is a warning; a readable
 * one at the wrong version fails the action.
 */
function verify(
  state: PublishState,
  metadata: PublishMetadata,
  npm: NpmRunner,
  env: NodeJS.ProcessEnv,
  io: Reporter,
): void {
  const { name, version } = metadata;
  const result = npm(viewArgs(name, version, state), {
    cwd: state.projectDir,
    env,
    stderr: 'ignore',
  });
  if (result.status !== 0) {
    io.warning(
      `could not confirm ${name}@${version} on the registry (anonymous ` +
        'reads may be restricted, or indexing may lag)',
    );
    return;
  }
  const seen = result.stdout.replace(/\n+$/, '');
  if (seen !== version) {
    // npm succeeded, so this is a post-publish failure like the others,
    // and must not read as an invitation to retry.
    throw new PublishError(
      `${publishedPrefix(false)} The registry then reported an unexpected ` +
        `version: ${printable(seen)}, expected ${version}.`,
    );
  }
  io.info(`Registry confirmed ${name}@${version} ✅`);
  io.summary(`Registry confirmed ${name}@${version} ✅\n`);
}

/** Run the publish step from the state file at `statePath`. */
export function publish(
  statePath: string,
  env: NodeJS.ProcessEnv,
  io: Reporter,
  runner?: NpmRunner,
): PublishMetadata {
  const dirs = runnerDirs(env);
  const state = readState(statePath, dirs.runnerTemp);
  let npm = runner;
  if (npm === undefined) {
    assertSameNpm(state, env['PATH']);
    npm = npmRunner(state.npmDir);
  }

  // Lifecycle scripts run between here and the verification, and the
  // directory is repository content, so it is re-checked at each use.
  assertStillConfined(state.projectDir, dirs.boundary);
  if (state.tarball === '') stamp(state, npm, env, io);
  warnPublishHooks(state, io);

  if (state.dryRun) {
    io.info('Publishing in dry-run mode (packs and reports only; npm performs no publish)');
  }
  // Read before npm runs, since its scripts can rewrite the manifest. A
  // tarball publish runs none.
  const scriptsAfterUpload =
    state.tarball === '' &&
    definedHooks(readManifestText(state.projectDir), AFTER_UPLOAD_HOOKS).length > 0;
  const result = npm(publishArgs(state), {
    cwd: state.projectDir,
    env,
    stdoutFile: path.join(path.dirname(statePath), PUBLISH_OUTPUT),
    stderr: 'inherit',
  });
  const outcome = interpretPublish(result.stdout, result.status, {
    expectedVersion: state.publishVersion,
    dryRun: state.dryRun,
    truncated: result.truncated === true,
    scriptsAfterUpload,
  });
  if (!outcome.ok) {
    // With hooks in play, the raw output is the only way to see what
    // displaced the metadata.
    if (outcome.showOutput && result.stdout.trim() !== '') io.info(result.stdout);
    throw new PublishError(outcome.message);
  }

  const { metadata } = outcome;
  // npm has succeeded from here on, so every failure -- reporting the
  // result included, such as an unwritable GITHUB_OUTPUT -- must lead with
  // that, or it reads as an invitation to retry.
  try {
    io.setOutput('package_name', metadata.name);
    io.setOutput('published_version', metadata.version);
    io.setOutput('tarball_name', metadata.filename);
    io.summary(
      renderSummary(metadata, { dryRun: state.dryRun, registryUrl: state.registry, tag: state.tag }),
    );
    io.info(`Published ${metadata.name}@${metadata.version} ✅`);

    if (!state.dryRun) {
      try {
        assertStillConfined(state.projectDir, dirs.boundary);
      } catch (cause) {
        throw new PublishError(
          `${publishedPrefix(false)} It cannot be verified: ${(cause as Error).message}`,
        );
      }
      verify(state, metadata, npm, env, io);
    }
  } catch (cause) {
    if (cause instanceof PublishError) throw cause;
    throw new PublishError(
      `${publishedPrefix(state.dryRun)} Reporting the result then failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return metadata;
}
