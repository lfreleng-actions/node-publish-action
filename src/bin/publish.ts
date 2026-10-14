// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Stamp, publish and verify, from the state file the prepare step wrote.
 * The decisions are src/publish.ts's; this entry point supplies the runner
 * protocol around them.
 *
 * Reads: STATE, GITHUB_WORKSPACE, RUNNER_TEMP and PATH.
 * Writes: the 'package_name', 'published_version' and 'tarball_name'
 * outputs, and the job summary.
 */

import * as core from '../actions-io.js';
import { parsePublishOutput } from '../publish-metadata.js';
import { publish, type Reporter } from '../publish.js';
import { removeStateDir } from '../state.js';

const reporter: Reporter = {
  info: core.info,
  notice: core.notice,
  warning: core.warning,
  setOutput: core.setOutput,
  summary: core.appendSummary,
};

/**
 * Prove this bundle loads and runs on the Node.js currently on PATH, before
 * npm publishes anything.
 *
 * node_version chooses the runtime the publish executes under, and this
 * program reads npm's result on that same runtime. A version below what the
 * bundle targets would fail to start -- and were the parser a separate
 * program, it would fail *after* npm had published. Parsing a sample
 * exercises module evaluation and the scanner rather than merely reporting
 * a version.
 */
function selfTest(): void {
  const sample = '{"pkg":{"name":"pkg","version":"1.0.0","filename":"pkg-1.0.0.tgz"}}';
  const result = parsePublishOutput(sample, { expectedVersion: '1.0.0' });
  if (!result.ok || result.metadata.name !== 'pkg') {
    throw new Error('publish-output parser self-test did not return the sample metadata');
  }
  core.info('publish self-test passed');
}

/**
 * Remove the work directory, for the action's always() cleanup step.
 *
 * Here rather than in the shell so the action needs no tool beyond bash.
 * A path that is not this action's own work directory is left alone with
 * a warning, not deleted and not failed on: the step runs after the
 * publish, and must not turn a published version into a failed run.
 */
function cleanup(statePath: string | undefined): void {
  if (statePath === undefined || statePath === '') return;
  try {
    removeStateDir(statePath, process.env['RUNNER_TEMP'] ?? '');
  } catch (cause) {
    core.warning(
      `Not removing ${statePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

try {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else if (process.argv.includes('--cleanup')) {
    cleanup(process.env['STATE']);
  } else {
    const statePath = process.env['STATE'];
    if (statePath === undefined || statePath === '') {
      throw new Error('STATE is not set');
    }
    publish(statePath, process.env, reporter);
  }
} catch (cause) {
  core.setFailed(cause instanceof Error ? cause.message : String(cause));
}
