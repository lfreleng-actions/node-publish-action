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

import { readFileSync } from 'node:fs';
import path from 'node:path';

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
import {
  assertNoStoredCredential,
  assertOidcEndpoint,
  assertToolchain,
  checkOidcProvenance,
  needsIdTokenEndpoint,
  PROVENANCE_EXCHANGE_NOTICE,
  provenanceVerdict,
} from './oidc.js';
import { definedHooks, PUBLISH_HOOKS } from './publish-command.js';
import { publishFlags } from './publish-options.js';
import { assertSupportedNpm, resolveEffectiveRegistry, type RegistryResolution } from './registry.js';
import { makeWorkDir, removeWorkDir, writeState } from './state.js';
import {
  confineNodeVersionFile,
  confineProject,
  printable,
  resolveTarball,
  runnerDirs,
  stageTarball,
} from './workspace.js';

export interface PrepareResult {
  readonly inputs: CheckedInputs;
  /** The resolved project directory. */
  readonly projectDir: string;
  /** The staged archive in the work directory, or '' when packing the project. */
  readonly tarball: string;
  readonly resolution: RegistryResolution;
  /** The npm whose code made the decisions. */
  readonly npmVersion: string;
  /** The state file the publish step reads. */
  readonly statePath: string;
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
 * `load` is the npm loader and `nodeVersion` the Node.js running the
 * publish; tests pass their own.
 */
export async function prepare(
  env: NodeJS.ProcessEnv,
  load: () => NpmInternals = loadNpmInternals,
  nodeVersion: string = process.versions.node,
): Promise<PrepareResult> {
  assertNoWorkspaceSelector(env);
  const dirs = runnerDirs(env);
  const checked = checkInputs(readRawInputs(env));
  const { inputs } = checked;
  const notices = [...checked.notices];
  const oidc = inputs.authMode === 'oidc';
  // A rehearsal needs no token, so a dry run is not held to the grant.
  if (oidc && !inputs.dryRun) assertOidcEndpoint(env);
  confineNodeVersionFile(inputs.nodeVersionFile, dirs);
  const projectDir = confineProject(inputs.pathPrefix, dirs);
  const source = inputs.tarballPath === '' ? '' : resolveTarball(inputs.tarballPath, dirs);

  // The npm on PATH is the one the publish step runs, so its own code
  // decides. Found from the executable, not from 'npm root -g', whose
  // answer is itself configuration.
  const internals = load();
  // Before anything else of npm's is asked, so an old toolchain fails for
  // what it is. Dry runs too: a rehearsal that passed on a toolchain the
  // real publish would refuse defeats the point of rehearsing.
  if (oidc) assertToolchain(internals.npmVersion, nodeVersion);
  const config = await loadConfig(internals, projectDir, inputs.registryUrl, env);

  const workDir = makeWorkDir(dirs.runnerTemp);
  try {
    const tarball = source === '' ? '' : stageTarball(source, workDir);
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
    const provenance = provenanceVerdict(config, internals.npmVersion, publishConfig);
    if (oidc) {
      const notice = checkOidcProvenance(provenance);
      if (notice !== null) notices.push(notice);
      // Checked against the registry npm will publish to, which a scoped
      // package can move away from registry_url. A dry run exchanges
      // nothing, so has nothing to fall back from.
      if (!inputs.dryRun) assertNoStoredCredential(config, resolution.registry);
      // Hooks run inside npm publish, after this check, and are repository
      // code: one can introduce a scope this resolution never saw, or write
      // a credential of its own. Nothing checked beforehand binds them;
      // a tarball publish runs none.
      if (!inputs.dryRun && tarball === '') {
        const hooks = definedHooks(
          readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
          PUBLISH_HOOKS,
        );
        if (hooks.length > 0) {
          notices.push(
            `This trusted publish runs lifecycle script(s): ${hooks.join(', ')}. ` +
              'The stored-credential check ran before them, for the registry ' +
              'resolved now; a script that changes the scope or writes ' +
              'credentials acts after it. Publish through tarball_path, which ' +
              'runs no scripts, to rule that out.',
          );
        }
      }
    }
    const keepEndpoint = needsIdTokenEndpoint(
      inputs.dryRun,
      oidc,
      inputs.provenance || provenance.provenance,
    );
    if (keepEndpoint && !oidc) notices.push(PROVENANCE_EXCHANGE_NOTICE);
    const statePath = writeState(workDir, {
      schema: 1,
      npmVersion: internals.npmVersion,
      npmDir: internals.npmDir,
      projectDir,
      tarball,
      publishVersion: inputs.publishVersion,
      dryRun: inputs.dryRun,
      tag: inputs.tag,
      access: inputs.access,
      provenance: inputs.provenance,
      // The effective setting, not the input alone: an .npmrc, an
      // npm_config_ variable or publishConfig can enable provenance too,
      // and withholding the endpoint from that publish would break it.
      idTokenEndpoint: keepEndpoint,
      registry: resolution.registry,
      scopes: resolution.scopes,
    });
    return {
      inputs,
      projectDir,
      tarball,
      resolution,
      npmVersion: internals.npmVersion,
      statePath,
      notices,
    };
  } catch (cause) {
    // The cleanup step keys off this step's state output, which a failure
    // never writes, so the work directory is removed here.
    removeWorkDir(workDir);
    throw cause;
  }
}
