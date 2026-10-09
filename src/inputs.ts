// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Validate the action's inputs as text.
 *
 * Pure functions over strings: nothing here touches the filesystem or npm,
 * so every rule is tested as a table rather than by running action.yaml.
 * Path confinement, which does need the filesystem, is in workspace.ts.
 *
 * Every pattern validates the whole string. A JavaScript `$` without the
 * `m` flag matches only at the very end, so an embedded or trailing newline
 * fails the match rather than ending a line inside it.
 */

/** Raised for an input this action refuses. The message names the input. */
export class InputError extends Error {}

/** The inputs as the runner hands them over, before any checking. */
export interface RawInputs {
  readonly publishVersion: string;
  readonly registryUrl: string;
  readonly dryRun: string;
  readonly pathPrefix: string;
  readonly tarballPath: string;
  readonly nodeVersion: string;
  readonly nodeVersionFile: string;
  readonly tag: string;
  readonly access: string;
  readonly provenance: string;
  readonly loadCredential: string;
  readonly nexusUser: string;
  readonly nexusPassword: string;
  readonly authToken: string;
  readonly oidc: string;
  readonly vaultMappingJson: string;
  readonly opServiceAccountToken: string;
}

/** The environment variable action.yaml passes each input through. */
export const INPUT_VARIABLES: Readonly<Record<keyof RawInputs, string>> = {
  publishVersion: 'INPUT_PUBLISH_VERSION',
  registryUrl: 'INPUT_REGISTRY_URL',
  dryRun: 'INPUT_DRY_RUN',
  pathPrefix: 'INPUT_PATH_PREFIX',
  tarballPath: 'INPUT_TARBALL_PATH',
  nodeVersion: 'INPUT_NODE_VERSION',
  nodeVersionFile: 'INPUT_NODE_VERSION_FILE',
  tag: 'INPUT_TAG',
  access: 'INPUT_ACCESS',
  provenance: 'INPUT_PROVENANCE',
  loadCredential: 'INPUT_LOAD_CREDENTIAL',
  nexusUser: 'INPUT_NEXUS_USER',
  nexusPassword: 'INPUT_NEXUS_PASSWORD',
  authToken: 'INPUT_AUTH_TOKEN',
  oidc: 'INPUT_OIDC',
  vaultMappingJson: 'INPUT_VAULT_MAPPING_JSON',
  opServiceAccountToken: 'INPUT_OP_SERVICE_ACCOUNT_TOKEN',
};

/** Read every input from the environment; an unset variable reads as ''. */
export function readRawInputs(env: NodeJS.ProcessEnv): RawInputs {
  const raw = {} as Record<keyof RawInputs, string>;
  for (const key of Object.keys(INPUT_VARIABLES) as (keyof RawInputs)[]) {
    raw[key] = env[INPUT_VARIABLES[key]] ?? '';
  }
  return raw;
}

export type Access = '' | 'public' | 'restricted';

/** How the publish authenticates. 'none' is valid only for a dry run. */
export type AuthMode = 'basic' | 'token' | 'oidc' | 'none';

/** The inputs once checked, in the types later stages consume. */
export interface CheckedInputs {
  readonly publishVersion: string;
  readonly registryUrl: string;
  readonly dryRun: boolean;
  readonly provenance: boolean;
  readonly loadCredential: boolean;
  readonly tag: string;
  readonly access: Access;
  readonly authMode: AuthMode;
  /** The path inputs, still unresolved; workspace.ts confines them. */
  readonly pathPrefix: string;
  readonly tarballPath: string;
  readonly nodeVersionFile: string;
}

export interface InputCheck {
  readonly inputs: CheckedInputs;
  /** Workflow notices to emit: accepted, but worth saying. */
  readonly notices: readonly string[];
}

/** A semver-shaped version: all-digit MAJOR.MINOR.PATCH, optional '-' suffix. */
const VERSION_ALLOWED = /^[0-9A-Za-z.-]+$/;
const VERSION_SHAPE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]*)?$/;
const TAG_ALLOWED = /^[A-Za-z0-9._-]+$/;
const REGISTRY_ALLOWED = /^[A-Za-z0-9.:/_-]+$/;
/** 'https://', at least one character, then a trailing '/'. */
const REGISTRY_SHAPE = /^https:\/\/.+\/$/;
const NODE_VERSION_ALLOWED = /^[A-Za-z0-9./*_-]+$/;
const NODE_VERSION_FILE_ALLOWED = /^[A-Za-z0-9./_-]+$/;

function checkBoolean(name: string, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InputError(`${name} must be 'true' or 'false'`);
}

function checkAccess(value: string): Access {
  if (value === '' || value === 'public' || value === 'restricted') return value;
  throw new InputError("invalid access. Expected: 'public', 'restricted' or unset");
}

/**
 * The value becomes an npm publish argument, so it is held to a safe set
 * as well as being non-empty.
 */
function checkTag(value: string): string {
  if (!TAG_ALLOWED.test(value)) {
    throw new InputError('invalid tag. Allowed characters: A-Z a-z 0-9 . _ -');
  }
  return value;
}

/**
 * A strict allowlist first (no shell metacharacters, no whitespace, no line
 * breaks), then the structure: three all-digit, dot-separated segments, with
 * a '-' suffix such as '-SNAPSHOT' or '-rc.1' allowed after the third.
 */
export function checkPublishVersion(value: string): string {
  if (!VERSION_ALLOWED.test(value)) {
    throw new InputError('invalid publish_version. Allowed characters: 0-9 A-Z a-z . -');
  }
  if (!VERSION_SHAPE.test(value)) {
    throw new InputError(
      'invalid publish_version. Expected a semver-style version such as ' +
        '1.2.3, 1.2.3-SNAPSHOT or 1.2.3-rc.1',
    );
  }
  return value;
}

/**
 * The registry URL is mandatory for a real publish; a dry run publishes
 * nothing, so it needs none. Any value given is held to an https scheme, a
 * non-empty host, a trailing slash, and an allowlist that excludes
 * whitespace, userinfo separators and shell metacharacters.
 */
export function checkRegistryUrl(value: string, dryRun: boolean): string {
  if (value === '') {
    if (!dryRun) throw new InputError('registry_url required unless dry_run');
    return value;
  }
  if (!REGISTRY_ALLOWED.test(value)) {
    throw new InputError('invalid registry_url characters. Allowed characters: A-Z a-z 0-9 . : / _ -');
  }
  if (!REGISTRY_SHAPE.test(value)) {
    throw new InputError('invalid registry_url. Expected https://<host>/<path>/ with a trailing slash');
  }
  if (value.startsWith('https:///')) {
    throw new InputError('registry_url must include a host');
  }
  return value;
}

/**
 * Exactly one authentication mode. Basic auth folds a password into an
 * .npmrc entry, token auth writes a bearer token, and OIDC trusted
 * publishing stores nothing at all, so accepting more than one would leave
 * the effective credential ambiguous.
 *
 * nexus_user carries no secret and selects no mode, so it never conflicts
 * with one. Callers computing it unconditionally -- matrix publishes mixing
 * Nexus and npmjs targets -- would break if this rejected it, so a token or
 * OIDC publish reports it as ignored instead.
 */
function checkAuthMode(
  raw: RawInputs,
  dryRun: boolean,
  loadCredential: boolean,
  oidc: boolean,
): {
  mode: AuthMode;
  notices: string[];
} {
  const token = raw.authToken !== '';
  const basic = loadCredential || raw.nexusPassword !== '';
  if ([oidc, token, basic].filter(Boolean).length > 1) {
    throw new InputError(
      'conflicting authentication modes. Choose one of: oidc, auth_token, ' +
        'or Basic auth (nexus_password or load_credential)',
    );
  }
  const mode: AuthMode = oidc ? 'oidc' : token ? 'token' : basic ? 'basic' : 'none';
  // A real publish needs a credential source; failing here is clearer
  // than an authentication failure mid-publish.
  if (!dryRun && mode === 'none') {
    throw new InputError(
      "no registry credential configured. Provide nexus_password, set " +
        "load_credential to 'true' (with vault_mapping_json and " +
        "op_service_account_token), provide auth_token, or set oidc to " +
        "'true' for trusted publishing",
    );
  }
  // Only emptiness is checked, never the values: these are secrets.
  if (!dryRun && loadCredential) {
    for (const [name, value] of [
      ['vault_mapping_json', raw.vaultMappingJson],
      ['op_service_account_token', raw.opServiceAccountToken],
    ] as const) {
      if (value === '') {
        throw new InputError(
          `load_credential is 'true' but ${name} is empty. Provide ${name} alongside load_credential`,
        );
      }
    }
  }
  const notices: string[] = [];
  if (raw.nexusUser !== '' && (mode === 'token' || mode === 'oidc')) {
    notices.push(
      'Ignoring nexus_user: it applies to Basic auth, and this publish ' +
        `uses ${mode === 'oidc' ? 'OIDC trusted publishing' : 'token authentication'}, ` +
        'which carries no username.',
    );
  }
  return { mode, notices };
}

/**
 * The Node.js version inputs. setup-node has already consumed them by the
 * time this runs, so the allowlists keep the action's contract rather than
 * guard that step; node_version_file's existence and confinement are
 * checked in workspace.ts.
 */
function checkNodeVersion(nodeVersion: string, nodeVersionFile: string): void {
  if (nodeVersion !== '' && !NODE_VERSION_ALLOWED.test(nodeVersion)) {
    throw new InputError('invalid node_version. Allowed characters: A-Z a-z 0-9 . * / _ -');
  }
  if (nodeVersionFile !== '' && !NODE_VERSION_FILE_ALLOWED.test(nodeVersionFile)) {
    throw new InputError('invalid node_version_file. Allowed characters: A-Z a-z 0-9 . / _ -');
  }
  if (nodeVersion === '' && nodeVersionFile === '') {
    throw new InputError('no Node.js version specified. Provide node_version or node_version_file');
  }
}

/** Check every text input. Throws {@link InputError} on the first failure. */
export function checkInputs(raw: RawInputs): InputCheck {
  const dryRun = checkBoolean('dry_run', raw.dryRun);
  const provenance = checkBoolean('provenance', raw.provenance);
  const loadCredential = checkBoolean('load_credential', raw.loadCredential);
  const oidc = checkBoolean('oidc', raw.oidc);
  const access = checkAccess(raw.access);
  const tag = checkTag(raw.tag);
  const publishVersion = checkPublishVersion(raw.publishVersion);
  const registryUrl = checkRegistryUrl(raw.registryUrl, dryRun);
  const { mode, notices } = checkAuthMode(raw, dryRun, loadCredential, oidc);
  // npm attaches provenance by itself under trusted publishing, where it
  // supports doing so, and refuses explicit provenance for a restricted
  // package. The combination signals a misunderstanding rather than a
  // harmless overlap.
  if (oidc && provenance) {
    throw new InputError(
      'provenance conflicts with oidc. Trusted publishing does not take ' +
        'the --provenance flag; npm attaches provenance by itself where it ' +
        "supports it (public package, public repository). Leave provenance at 'false'",
    );
  }
  checkNodeVersion(raw.nodeVersion, raw.nodeVersionFile);
  return {
    inputs: {
      publishVersion,
      registryUrl,
      dryRun,
      provenance,
      loadCredential,
      tag,
      access,
      authMode: mode,
      pathPrefix: raw.pathPrefix,
      tarballPath: raw.tarballPath,
      nodeVersionFile: raw.nodeVersionFile,
    },
    notices,
  };
}

/**
 * Refuse a workspace selected through the environment.
 *
 * This action publishes the single package at path_prefix and verifies one
 * version. A selector can match several packages, and npm would publish
 * them all before anything here could object. npm matches the npm_config_
 * prefix case-insensitively, and its loadEnv skips an empty value, so an
 * exported but empty selector selects nothing and is not one.
 */
export function assertNoWorkspaceSelector(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === 'npm_config_workspace' && value) {
      throw new InputError(
        `a workspace is selected through ${name}. This action publishes ` +
          'one package. Point path_prefix at the workspace package instead.',
      );
    }
  }
}
