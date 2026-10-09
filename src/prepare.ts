// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Everything the action decides before it touches credentials: check the
 * inputs, confine the paths, stage a pre-packed tarball, and resolve the
 * registry npm will publish to.
 *
 * One step rather than two, because they share their most expensive input.
 * The registry and the tarball's version both come from the manifest npm
 * will publish, read once, by the publishing npm's own reader -- so the
 * version checked is the version npm sends, normalised exactly as npm
 * normalises it.
 *
 * Returns a result rather than writing outputs, so the whole sequence is
 * tested as a function; src/bin/prepare.ts does the IO.
 */

import {
  assertNoWorkspaceSelector,
  checkInputs,
  InputError,
  readRawInputs,
  type CheckedInputs,
} from './inputs.js';
import {
  loadNpmInternals,
  manifestFields,
  NpmInternalsError,
  type LoadedConfig,
  type Manifest,
  type NpmInternals,
} from './npm-internals.js';
import { publishFlags } from './publish-options.js';
import { assertSupportedNpm, resolveEffectiveRegistry, type RegistryResolution } from './registry.js';
import {
  confineNodeVersionFile,
  confineProject,
  printable,
  removeStaged,
  resolveTarball,
  runnerDirs,
  stageTarball,
} from './workspace.js';

export interface PrepareResult {
  readonly inputs: CheckedInputs;
  /** The resolved project directory. */
  readonly projectDir: string;
  /** The staged archive in RUNNER_TEMP, or '' when packing the project. */
  readonly tarball: string;
  readonly resolution: RegistryResolution;
  /** The npm whose code made the decisions. */
  readonly npmVersion: string;
  /** Notices to emit: accepted, but worth saying. */
  readonly notices: readonly string[];
}

/** Read the manifest a tarball carries, describing failure in its terms. */
async function readTarballManifest(
  internals: NpmInternals,
  tarball: string,
  opts: Readonly<Record<string, unknown>>,
): Promise<Manifest> {
  try {
    return await internals.readManifest({ tarball }, opts);
  } catch (cause) {
    // A broken npm installation is not a broken archive. Reporting it as
    // one would send the caller to repack a valid tarball.
    if (cause instanceof NpmInternalsError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === 'EJSONPARSE') {
      throw new InputError('package.json in the tarball is not valid JSON');
    }
    throw new InputError(
      'cannot read package.json from the tarball. Expected an npm pack ' +
        'archive containing package/',
    );
  }
}

/**
 * The tarball carries its own version, and the stamp is skipped for it, so
 * publish_version no longer decides what ships. Compared rather than left
 * decorative: a stale artefact would otherwise publish under a version the
 * caller never asked for, and the verification would look up the wrong one.
 */
function assertTarballVersion(manifest: Manifest, publishVersion: string): string {
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '') {
    throw new InputError('tarball package.json declares no version');
  }
  if (version !== publishVersion) {
    throw new InputError(
      `tarball version does not match publish_version (tarball: ` +
        `${printable(version)}, publish_version: ${publishVersion}). Pack ` +
        'the tarball at the version being published',
    );
  }
  return version;
}

async function loadConfig(
  internals: NpmInternals,
  cwd: string,
  registryUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<LoadedConfig> {
  // Checked before loading configuration, so an old npm fails for what it
  // is rather than for a missing module.
  assertSupportedNpm(internals.npmVersion);
  if (!internals.loadConfig) {
    throw new NpmInternalsError(`npm ${internals.npmVersion} did not provide @npmcli/config.`);
  }
  // Configured exactly as the publish step invokes npm: the same project
  // directory, environment and configuration flags.
  return internals.loadConfig({ cwd, flags: publishFlags(registryUrl), env });
}

/**
 * Run every check and resolution, in the order a failure is cheapest:
 * text first, then paths, then npm.
 *
 * `load` is the npm loader; tests pass one bound to a specific npm.
 */
export async function prepare(
  env: NodeJS.ProcessEnv,
  load: () => NpmInternals = loadNpmInternals,
): Promise<PrepareResult> {
  assertNoWorkspaceSelector(env);
  const dirs = runnerDirs(env);
  const { inputs, notices } = checkInputs(readRawInputs(env));
  confineNodeVersionFile(inputs.nodeVersionFile, dirs);
  const projectDir = confineProject(inputs.pathPrefix, dirs);
  const source = inputs.tarballPath === '' ? '' : resolveTarball(inputs.tarballPath, dirs);

  // The npm on PATH is the one the publish step runs, so its own code
  // decides. Found from the executable, not from 'npm root -g', whose
  // answer is itself configuration.
  const internals = load();
  const config = await loadConfig(internals, projectDir, inputs.registryUrl, env);

  const tarball = source === '' ? '' : stageTarball(source, dirs.runnerTemp);
  try {
    // The manifest npm will publish. For a tarball that is the one *inside
    // the archive*, not the working directory's: its scope and
    // publishConfig decide the registry, and its version is what ships.
    let manifest: Manifest;
    if (tarball === '') {
      try {
        manifest = await internals.readManifest({ dir: projectDir }, config.flat);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
        throw new InputError(`cannot read package.json in the project directory: ${reason}`);
      }
    } else {
      manifest = await readTarballManifest(internals, tarball, config.flat);
      assertTarballVersion(manifest, inputs.publishVersion);
    }
    const { packageName, publishConfig } = manifestFields(manifest);
    const resolution = resolveEffectiveRegistry({
      packageName,
      publishConfig,
      registryUrl: inputs.registryUrl,
      config,
      npmVersion: internals.npmVersion,
      pickRegistry: internals.pickRegistry,
    });
    return { inputs, projectDir, tarball, resolution, npmVersion: internals.npmVersion, notices };
  } catch (cause) {
    // The cleanup step keys off this step's tarball output, which a
    // failure never writes, so the staged copy is removed here.
    if (tarball !== '') removeStaged(tarball);
    throw cause;
  }
}
