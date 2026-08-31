// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Turn captured `npm publish --json` output into action outputs.
 *
 * Invoked from action.yaml with npm's exit status, so that a package which
 * reached the registry is never reported as a bare failure: a caller
 * retrying that would hit EPUBLISHCONFLICT on a version that really is
 * published.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import * as core from '../actions-io.js';
import { parsePublishOutput } from '../publish-metadata.js';
import { renderSummary } from '../summary.js';
import type { ParseFailure } from '../publish-metadata.js';

/** The character set npm package names allow. */
const PACKAGE_NAME_PATTERN = /^[@A-Za-z0-9._/-]+$/;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Prove this bundle loads and runs on the Node.js currently on PATH.
 *
 * `node_version`/`node_version_file` choose the runtime the publish executes
 * under, and this program runs on that same runtime. A version below what
 * the bundle targets would fail to start -- *after* npm had published,
 * which is precisely the unsafe failure this file exists to prevent.
 *
 * The publish step runs this immediately before invoking npm, so an
 * unsupported runtime costs nothing. Parsing a sample exercises module
 * evaluation and the scanner rather than merely reporting a version, so it
 * tests the artefact that will actually run.
 */
function selfTest(): void {
  const sample = '{"pkg":{"name":"pkg","version":"1.0.0","filename":"pkg-1.0.0.tgz"}}';
  const result = parsePublishOutput(sample, { expectedVersion: '1.0.0' });
  if (!result.ok || result.metadata.name !== 'pkg') {
    throw new Error('publish-output parser self-test did not return the sample metadata');
  }
  core.info('publish-output parser self-test passed');
}

/**
 * Lead every post-success failure with the fact that npm published.
 *
 * The action still fails, because it cannot verify what it cannot read,
 * but the operator needs to know that retrying is the wrong response.
 */
function publishedPrefix(dryRun: boolean): string {
  return dryRun
    ? 'The dry run completed.'
    : 'npm reported a successful publish, so the package has reached the ' +
        'registry. Do not retry: a retry would fail with EPUBLISHCONFLICT ' +
        'on a version that really is published.';
}

/**
 * How to describe a parse failure, given that npm itself succeeded.
 */
function describeFailure(failure: ParseFailure, dryRun: boolean): string {
  const situation = publishedPrefix(dryRun);

  const detail = ((): string => {
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
  })();

  return `${situation} ${detail}`;
}

function run(): void {
  const outputFile = required('PUBLISH_OUTPUT_FILE');
  const expectedVersion = required('PUBLISH_VERSION');
  const exitCode = Number.parseInt(process.env['PUBLISH_EXIT_CODE'] ?? '0', 10);
  const dryRun = process.env['DRY_RUN'] === 'true';

  let raw: string;
  try {
    raw = readFileSync(outputFile, 'utf8');
  } catch (error) {
    core.setFailed(`Could not read the captured npm output: ${String(error)}`);
    return;
  }

  // npm's own failure comes first and is unambiguous. Anything unparsable
  // in the output is a symptom of that failure, not a separate problem.
  if (exitCode !== 0) {
    if (raw.trim() !== '') {
      core.info(raw);
    }
    core.setFailed(`npm publish failed (exit ${String(exitCode)}) ❌`);
    return;
  }

  const result = parsePublishOutput(raw, { expectedVersion });

  if (!result.ok) {
    // Surface the raw output; with hooks in play it is the only way to see
    // what displaced the metadata.
    core.info(raw);
    core.setFailed(describeFailure(result.failure, dryRun));
    return;
  }

  const { name, version, filename } = result.metadata;

  // Constrain the reported name before it reaches later commands and logs.
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    core.setFailed(`${publishedPrefix(dryRun)} npm reported an unusable package name.`);
    return;
  }

  // npm exited zero, so this too is a post-publish failure: the mismatch
  // means the metadata read back does not describe what was asked for,
  // not that nothing was published. Without the prefix it reads as an
  // ordinary failure and invites a retry that cannot succeed.
  if (version !== expectedVersion) {
    core.setFailed(
      `${publishedPrefix(dryRun)} The version read back does not match ` +
        `the request: npm reported ${version}, expected ${expectedVersion}. ` +
        "Check whether a lifecycle script is writing to npm's stdout.",
    );
    return;
  }

  core.setOutput('package_name', name);
  core.setOutput('published_version', version);
  core.setOutput('tarball_name', filename);

  const summary = renderSummary(result.metadata, {
    dryRun,
    registryUrl: process.env['REGISTRY_URL'] ?? '',
    tag: process.env['TAG'] ?? '',
  });
  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile !== undefined && summaryFile !== '') {
    appendFileSync(summaryFile, summary, 'utf8');
  }

  core.info(`Published ${name}@${version} ✅`);
}

try {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else {
    run();
  }
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
