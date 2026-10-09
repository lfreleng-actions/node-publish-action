// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Decide what a finished `npm publish --json` means for the action.
 *
 * npm's exit status comes first, so that a package which reached the
 * registry is never reported as a bare failure: a caller retrying that
 * would hit EPUBLISHCONFLICT on a version that really is published.
 */

import { parsePublishOutput, type ParseFailure, type PublishMetadata } from './publish-metadata.js';

/** The character set npm package names allow. */
const PACKAGE_NAME_PATTERN = /^[@A-Za-z0-9._/-]+$/;

export type PublishOutcome =
  | { readonly ok: true; readonly metadata: PublishMetadata }
  | {
      readonly ok: false;
      readonly message: string;
      /** Whether to show npm's raw output, the only evidence of what displaced it. */
      readonly showOutput: boolean;
    };

/**
 * Lead every post-success failure with the fact that npm published.
 *
 * The action still fails, because it cannot verify what it cannot read,
 * but the operator needs to know that retrying is the wrong response.
 */
export function publishedPrefix(dryRun: boolean): string {
  return dryRun
    ? 'The dry run completed.'
    : 'npm reported a successful publish, so the package has reached the ' +
        'registry. Do not retry: a retry would fail with EPUBLISHCONFLICT ' +
        'on a version that really is published.';
}

/** How to describe a parse failure, given that npm itself succeeded. */
function describeFailure(failure: ParseFailure): string {
  switch (failure.kind) {
    case 'no-metadata':
      return (
        "No publish metadata could be found in npm's output. Lifecycle " +
        "scripts share npm's stdout, so check whether a prepublishOnly, " +
        'publish or postpublish script produced output that displaced it.'
      );
    case 'fan-out':
      return (
        `npm reported ${String(failure.packages.length)} packages ` +
        `(${failure.packages.join(', ')}), and this action verifies and ` +
        'reports one. Publish each workspace package with its own ' +
        'path_prefix rather than selecting several at once.'
      );
    case 'ambiguous':
      return (
        `npm's output held ${String(failure.candidates.length)} objects ` +
        'shaped like publish metadata, and none carried the requested ' +
        'version. A lifecycle script is most likely printing JSON of its ' +
        'own to stdout.'
      );
    case 'truncated':
      return (
        "npm's output was too large or too dense with JSON to scan " +
        'completely, so the publish metadata could not be read reliably. ' +
        'A lifecycle script is most likely writing a very large amount to ' +
        'stdout; send that to stderr or a file instead.'
      );
  }
}

/** Interpret npm's exit status and captured stdout. */
export function interpretPublish(
  raw: string,
  exitCode: number,
  {
    expectedVersion,
    dryRun,
    truncated = false,
  }: {
    readonly expectedVersion: string;
    readonly dryRun: boolean;
    /** The capture was cut short, so no conclusion can rest on it. */
    readonly truncated?: boolean;
  },
): PublishOutcome {
  // npm's own failure comes first. Anything unparsable in the output is a
  // symptom of it rather than a separate problem -- unless npm's report of
  // this very version is there. npm prints that report only once the
  // registry has accepted the upload (on every supported npm; from npm 10
  // before the publish and postpublish scripts run), so a failing script
  // can turn a completed publish into a non-zero exit. A bare failure would
  // invite a retry that cannot succeed.
  if (exitCode !== 0) {
    const reported = dryRun ? undefined : parsePublishOutput(raw, { expectedVersion });
    if (reported?.ok && reported.metadata.version === expectedVersion) {
      const { name, version } = reported.metadata;
      return {
        ok: false,
        message:
          `npm publish exited ${String(exitCode)} after reporting ${name}@${version} ` +
          'as published. npm reports a publish only once the registry has ' +
          'accepted it, so the package has most likely reached the registry ' +
          'and a publish or postpublish script then failed. Check the ' +
          'registry before retrying: a retry would fail with ' +
          'EPUBLISHCONFLICT on a version that is published.',
        showOutput: true,
      };
    }
    return { ok: false, message: `npm publish failed (exit ${String(exitCode)}) ❌`, showOutput: true };
  }

  // npm succeeded, and its output was too large to read whole.
  if (truncated) {
    return {
      ok: false,
      message: `${publishedPrefix(dryRun)} ${describeFailure({ kind: 'truncated' })}`,
      showOutput: false,
    };
  }

  const result = parsePublishOutput(raw, { expectedVersion });
  if (!result.ok) {
    return {
      ok: false,
      message: `${publishedPrefix(dryRun)} ${describeFailure(result.failure)}`,
      showOutput: true,
    };
  }

  const { name, version } = result.metadata;
  // Constrain the reported name before it reaches later commands and logs.
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `${publishedPrefix(dryRun)} npm reported an unusable package name.`,
      showOutput: false,
    };
  }
  // npm exited zero, so this too is a post-publish failure: the metadata
  // read back does not describe what was asked for, not that nothing was
  // published.
  if (version !== expectedVersion) {
    return {
      ok: false,
      message:
        `${publishedPrefix(dryRun)} The version read back does not match ` +
        `the request: npm reported ${version}, expected ${expectedVersion}. ` +
        "Check whether a lifecycle script is writing to npm's stdout.",
      showOutput: false,
    };
  }
  return { ok: true, metadata: result.metadata };
}
