// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The npm command lines the publish step runs, built from the state the
 * prepare step checked. Pure functions, so every flag is asserted in a unit
 * test rather than by searching action.yaml's shell for a string.
 */

import type { PublishState } from './state.js';

/** Hooks `npm version` would run; --ignore-scripts suppresses them. */
export const VERSION_HOOKS: readonly string[] = ['preversion', 'version', 'postversion'];

/**
 * Hooks that run inside `npm publish` for a directory, after the registry
 * was resolved, and can rewrite the manifest npm re-reads.
 */
export const PUBLISH_HOOKS: readonly string[] = ['prepack', 'prepare', 'prepublishOnly'];

/**
 * Hooks that run inside `npm publish` for a directory *after* the upload.
 * A failure in one exits non-zero with the package already published.
 */
export const AFTER_UPLOAD_HOOKS: readonly string[] = ['publish', 'postpublish'];

/**
 * Which of `hooks` a package.json defines, sorted. Empty when the manifest
 * cannot be parsed: npm reports that itself, in its own terms.
 */
export function definedHooks(manifestText: string, hooks: readonly string[]): string[] {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(manifestText) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.keys(scripts)
    .filter((name) => hooks.includes(name))
    .sort();
}

/**
 * `npm version`, confined to the one package.
 *
 * --allow-same-version keeps re-stamping idempotent: versions are stamped
 * at publish time in the merge-driven model, so the committed version is
 * not the source of truth.
 *
 * --ignore-scripts because no release lane installs dependencies before
 * stamping, so a hook invoking the test or build script cannot succeed.
 *
 * --no-workspaces because `npm version` is workspace aware. With
 * workspaces enabled in configuration it stamps every workspace package
 * and leaves this one alone.
 */
export function stampArgs(version: string): string[] {
  return [
    'version',
    version,
    '--no-git-tag-version',
    '--allow-same-version',
    '--ignore-scripts',
    '--no-workspaces',
  ];
}

/** Pin the resolved registry under every consulted scope. */
function pins(state: Pick<PublishState, 'registry' | 'scopes'>): string[] {
  return state.scopes.map((scope) => `--${scope}:registry=${state.registry}`);
}

/**
 * `npm publish`.
 *
 * - A pre-packed tarball is a positional argument, which npm accepts only
 *   straight after the subcommand. npm then packs nothing.
 * - --no-workspaces: the action publishes the single package at
 *   path_prefix; fanning out would publish several and verify one.
 * - --registry applies to a dry run too. npm still queries the registry
 *   for existing metadata, so omitting it would send that lookup to npm's
 *   default while the summary names the resolved one.
 * - Every consulted scope is pinned. npm re-reads the manifest after
 *   prepublishOnly, and from 10.5.2 skips any publishConfig key already
 *   given on the command line, so a pin stops a script redirecting the
 *   publish after it was resolved.
 */
export function publishArgs(state: PublishState): string[] {
  const args = ['publish'];
  if (state.tarball !== '') args.push(state.tarball);
  args.push('--json', '--tag', state.tag, '--no-workspaces');
  if (state.access !== '') args.push('--access', state.access);
  if (state.provenance) args.push('--provenance');
  if (state.registry !== '') args.push('--registry', state.registry, ...pins(state));
  if (state.dryRun) args.push('--dry-run');
  return args;
}

/**
 * `npm view` for the version just published.
 *
 * --registry alone does not decide where this looks: pickRegistry prefers
 * a scoped setting, and `npm view` does not load publishConfig at all, so
 * a key the manifest masked is live again here. Every consulted scope is
 * pinned, as for the publish.
 */
export function viewArgs(
  name: string,
  version: string,
  state: Pick<PublishState, 'registry' | 'scopes'>,
): string[] {
  // --no-json: a configured json=true would print "1.2.3", quoted, and
  // a successful publish would then fail verification.
  return [
    'view',
    `${name}@${version}`,
    'version',
    '--no-json',
    '--registry',
    state.registry,
    ...pins(state),
  ];
}
