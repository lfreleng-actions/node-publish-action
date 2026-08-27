// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The small slice of the Actions runner protocol this action needs.
 *
 * Written out rather than taking a dependency on `@actions/core`: the
 * bundle is committed to the repository, so every kilobyte of third-party
 * code in it has to be reviewed and trusted. The surface used here is four
 * functions, and the formatting rules are stable and testable.
 *
 * Protocol reference:
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Render one `GITHUB_OUTPUT` entry using the heredoc form.
 *
 * The heredoc form is used unconditionally rather than only for multi-line
 * values: `name=value` cannot represent a value containing a newline, and
 * choosing between the two forms per value is an easy place to introduce an
 * injection bug.
 */
export function formatOutput(name: string, value: string, delimiter: string): string {
  if (name.includes(delimiter) || value.includes(delimiter)) {
    throw new Error(`Output ${name} contains the generated delimiter`);
  }
  if (name.includes('\n') || name.includes('\r')) {
    throw new Error(`Output name ${JSON.stringify(name)} contains a line break`);
  }
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/**
 * Escape a value for use inside a `::command::` workflow message.
 *
 * Without this a value containing a newline could close the message and
 * forge a further workflow command.
 */
export function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function writeCommand(command: string, message: string): void {
  process.stdout.write(`::${command}::${escapeData(message)}\n`);
}

export function setOutput(name: string, value: string): void {
  const file = process.env['GITHUB_OUTPUT'];
  if (file === undefined || file === '') {
    throw new Error('GITHUB_OUTPUT is not set');
  }
  appendFileSync(file, formatOutput(name, value, `ghadelimiter_${randomUUID()}`), 'utf8');
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function error(message: string): void {
  writeCommand('error', message);
}

export function notice(message: string): void {
  writeCommand('notice', message);
}

/** Report failure and set a non-zero exit status, as `core.setFailed` does. */
export function setFailed(message: string): void {
  error(message);
  process.exitCode = 1;
}
