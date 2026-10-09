// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * npm OIDC trusted publishing.
 *
 * npm exchanges a GitHub OIDC token for a short-lived publish token at
 * publish time, so nothing is stored. What this module adds around that
 * exchange is what npm leaves to its caller:
 *
 * - **Toolchain floors.** npm 11.5.2 and Node.js 22.14.0.
 * - **No silent fallback.** npm's exchange is best effort: when it fails,
 *   npm publishes with whatever credential it can find. A stored one would
 *   then publish under a long-lived token while the caller believes no
 *   token exists. So one is refused, found by npm's own lookup.
 * - **Provenance precedence.** npm attaches provenance under trusted
 *   publishing only while the `provenance` setting is at its default, and
 *   refuses explicit provenance for a restricted package.
 * - **Mode isolation, both ways.** npm attempts an exchange whenever the
 *   OIDC variables are present, so they are withheld from every npm run
 *   that is not a trusted publish or a provenance-signing one.
 *
 * Every question about configuration is put to the publishing npm's own
 * code (npm-internals.ts) rather than answered by reading .npmrc files.
 */

import { InputError } from './inputs.js';
import type { LoadedConfig } from './npm-internals.js';
import { meetsVersion, publishOptions } from './publish-options.js';

type Floor = readonly [number, number, number];

/**
 * The npm release trusted publishing needs. OIDC publishing landed in
 * 11.5.0, but 11.5.1 auto-enables provenance before checking package
 * visibility, so it fails a restricted publish outright instead of
 * publishing without an attestation; npm/cli#8467 fixed that in 11.5.2.
 */
export const OIDC_NPM_FLOOR: Floor = [11, 5, 2];

/** The Node.js release npm's trusted publishing documentation requires. */
export const OIDC_NODE_FLOOR: Floor = [22, 14, 0];

/**
 * Whether `version` is at or above `floor`, semver-aware where it matters:
 * a prerelease of the floor itself precedes it, so 11.5.2-pre.0 does not
 * clear 11.5.2. A prerelease of a later release does.
 */
export function meetsFloor(version: string, floor: Floor): boolean {
  if (!meetsVersion(version, floor)) return false;
  const [base, ...pre] = version.split('-');
  return pre.length === 0 || base !== floor.join('.');
}

/**
 * Refuse a toolchain below either floor, naming every shortfall at once.
 *
 * The remedy accounts for this action running setup-node itself: by the
 * time this runs, PATH holds the selected Node.js and the npm it bundles,
 * so a global npm upgrade made under another Node.js installation is
 * invisible here. Advising that alone would send the caller round a loop.
 * Node 22 ships npm 10, and even Node 24.0.0 ships npm 11.3.0.
 */
export function assertToolchain(npmVersion: string, nodeVersion: string): void {
  const problems: string[] = [];
  const npmFloor = OIDC_NPM_FLOOR.join('.');
  const nodeFloor = OIDC_NODE_FLOOR.join('.');
  if (!meetsFloor(npmVersion, OIDC_NPM_FLOOR)) {
    problems.push(
      `npm ${npmVersion} is below the ${npmFloor} required for OIDC trusted ` +
        'publishing. Raise the Node.js version this action selects, through ' +
        'node_version or the file named by node_version_file, to a release ' +
        'bundling a new enough npm; current Node 24 releases clear the ' +
        'floor. To keep the current version, upgrade npm after selecting ' +
        'the same version this action uses: run actions/setup-node with it, ' +
        "then 'npm install -g npm@^11', before this action. Upgrading npm " +
        'under a different Node.js installation has no effect here, because ' +
        'this action runs setup-node first and picks up its bundled npm.',
    );
  }
  if (!meetsFloor(nodeVersion, OIDC_NODE_FLOOR)) {
    problems.push(
      `Node.js ${nodeVersion} is below the ${nodeFloor} required for OIDC ` +
        'trusted publishing. Raise node_version, or the version in the file ' +
        'named by node_version_file.',
    );
  }
  if (problems.length > 0) throw new InputError(problems.join(' '));
}

/**
 * Refuse an OIDC publish with no token endpoint. It appears only when the
 * job grants `id-token: write`; under workflow_call the grant is needed on
 * both the calling and the called workflow. npm needs both variables, so
 * accepting a lone URL would pass here and fail after the stamp.
 */
export function assertOidcEndpoint(env: NodeJS.ProcessEnv): void {
  if (env['ACTIONS_ID_TOKEN_REQUEST_URL'] && env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']) return;
  throw new InputError(
    "OIDC requested but no token endpoint. Grant 'id-token: write' to the " +
      'job calling this action. Using a reusable workflow? Grant it on both ' +
      'the caller and the called workflow.',
  );
}

/**
 * Refuse a stored credential npm would fall back to if the exchange fails.
 *
 * This is npm's own question, asked of npm's own code: `npm publish` calls
 * `getCredentialsByURI` on the registry it picked and treats the result as
 * usable exactly when this test passes. It reads the merged configuration,
 * npm_config_* variables included, and one exact key per credential, with
 * no ancestor-path lookup. publishConfig is not part of it, and cannot
 * carry a fallback credential.
 *
 * No value is ever named, only which kind was found.
 */
export function assertNoStoredCredential(config: LoadedConfig, registry: string): void {
  const creds = config.getCredentialsByURI(registry);
  const found: string[] = [];
  if (creds.token) found.push('a bearer token (_authToken)');
  if (creds.username) found.push('a username and password (_auth, or username with _password)');
  if (creds.certfile && creds.keyfile) found.push('a client certificate (certfile with keyfile)');
  if (found.length === 0) return;
  throw new InputError(
    `stored npm credentials would shadow OIDC for ${registry}: ` +
      `${found.join('; ')}. npm falls back to them when the trusted ` +
      'publisher exchange fails, so the publish could use a long-lived ' +
      'credential instead. Remove them, or drop oidc and publish with that ' +
      'credential deliberately.',
  );
}

export interface ProvenanceVerdict {
  /** npm's effective `provenance` option, publishConfig applied. */
  readonly provenance: boolean;
  /** Whether a provenance-file supplies a bundle instead. */
  readonly provenanceFile: boolean;
  /** For a trusted publish, a notice explaining an opt-out; else null. */
  readonly notice: string | null;
}

/**
 * Where provenance stands for this publish, from every source npm reads.
 *
 * The sources do not combine simply. An .npmrc entry or npm_config_
 * variable lands in npm's live configuration, and takes `provenance` off
 * its default; publishConfig is flattened into the publish options only,
 * over the configuration's value, so it decides the value without moving
 * the setting off its default. npm's trusted publishing enables provenance
 * itself only while the setting is at its default -- and overwrites the
 * option when it does. So publishConfig.provenance=false does not prevent
 * an attestation, while the same entry in an .npmrc does.
 *
 * A provenance-file is explicit provenance too, by another route.
 */
export function provenanceVerdict(
  config: LoadedConfig,
  npmVersion: string,
  publishConfig: Readonly<Record<string, unknown>> | undefined,
): ProvenanceVerdict {
  const { opts, applied } = publishOptions(config, npmVersion, publishConfig);
  const inConfig = !config.isDefault('provenance');
  const inManifest = applied.has('provenance');
  let notice: string | null = null;
  if (inConfig && inManifest) {
    notice =
      'provenance is set in both npm configuration and publishConfig. The ' +
      'configuration entry takes the setting off its default, so trusted ' +
      'publishing does not attach provenance automatically, and ' +
      'publishConfig then supplies the value npm uses. This publish ' +
      'carries no attestation.';
  } else if (inConfig) {
    notice =
      'provenance is set to false in npm configuration (.npmrc or ' +
      'npm_config_provenance). npm attaches provenance under trusted ' +
      'publishing only when that setting is at its default, so this ' +
      'publish carries no attestation.';
  } else if (inManifest) {
    notice =
      'publishConfig.provenance is false, but npm flattens publishConfig ' +
      'into the publish options rather than its configuration, so trusted ' +
      'publishing still attaches provenance to a public package. Set ' +
      'provenance in .npmrc to opt out.';
  }
  return {
    provenance: Boolean(opts['provenance']),
    provenanceFile: Boolean(opts['provenanceFile']),
    notice,
  };
}

/**
 * Refuse explicit provenance under trusted publishing, from any source, and
 * return the notice explaining an opt-out, if there is one. An ambient
 * setting adds nothing there, since npm attaches provenance itself where it
 * supports it, and for a restricted package npm refuses it outright.
 */
export function checkOidcProvenance(verdict: ProvenanceVerdict): string | null {
  if (verdict.provenance || verdict.provenanceFile) {
    throw new InputError(
      'provenance is enabled by npm configuration or package.json ' +
        'publishConfig (provenance or provenance-file), which conflicts with ' +
        'oidc. Trusted publishing attaches provenance itself where it ' +
        'supports it, and npm refuses explicit provenance for a restricted ' +
        'package. Remove that setting.',
    );
  }
  return verdict.notice;
}

/** The variables npm reads to obtain an OIDC token. */
const ID_TOKEN_REQUEST = ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];

/**
 * The environment an npm run sees.
 *
 * npm attempts a trusted-publish exchange whenever the token endpoint is
 * reachable, so a job granting `id-token: write` for some other step could
 * have its Basic or token credential silently replaced by an OIDC one. The
 * endpoint is passed through only when `keepEndpoint` -- a real trusted
 * publish, or a real publish signing provenance with the workflow identity.
 *
 * NPM_ID_TOKEN goes unconditionally. npm reads it ahead of GitHub's
 * request-based flow, so an ambient or stale value would publish under an
 * identity the endpoint check never inspected.
 */
export function npmEnv(env: NodeJS.ProcessEnv, keepEndpoint: boolean): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Compared case-insensitively: on Windows environment names are, so
    // 'npm_id_token' reaches npm as NPM_ID_TOKEN.
    const upper = name.toUpperCase();
    if (upper === 'NPM_ID_TOKEN') continue;
    if (!keepEndpoint && ID_TOKEN_REQUEST.includes(upper)) continue;
    result[name] = value;
  }
  return result;
}

/**
 * Say what keeping the endpoint for a provenance-signing Basic or token
 * publish means. Sigstore signing and npm's trusted-publish exchange read
 * the same endpoint, and npm attempts the exchange whenever it is present,
 * so they cannot be separated within one npm run: where the package has a
 * trusted publisher configured, npm authenticates through it rather than
 * the stored credential. Refusing the combination would break a supported
 * path, so it is stated rather than hidden.
 */
export const PROVENANCE_EXCHANGE_NOTICE =
  'Provenance is enabled for a Basic or token publish, so npm sees the ' +
  'OIDC token endpoint it signs with. npm also attempts a trusted-publisher ' +
  'exchange whenever that endpoint is present: if this package has a ' +
  'trusted publisher configured, npm authenticates through it instead of ' +
  "the stored credential. Use oidc: 'true' to make that the declared mode, " +
  'or disable provenance to publish with the stored credential alone.';

/**
 * Whether the publish needs the token endpoint: a real trusted publish
 * does by definition, and so does a real publish with provenance, which
 * signs with the workflow identity. A dry run never does -- npm generates
 * no provenance for it -- and keeping the endpoint would still permit an
 * exchange during a rehearsal.
 */
export function needsIdTokenEndpoint(
  dryRun: boolean,
  oidc: boolean,
  provenance: boolean,
): boolean {
  return !dryRun && (oidc || provenance);
}
