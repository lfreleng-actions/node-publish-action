// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Whether the registry already holds the version being published, and if
 * so, whether it holds these exact bytes.
 *
 * Asked before the upload, with `npm view <name>@<version> dist.integrity`
 * against the registry npm will publish to, every consulted scope pinned.
 * npm 8 to 12 report a missing version and a missing package alike: exit 1
 * with E404 (measured against registry.npmjs.org).
 */

import type { NpmResult } from './npm-run.js';

export type Existing =
  | { readonly kind: 'absent' }
  | { readonly kind: 'identical'; readonly integrity: string }
  | { readonly kind: 'different'; readonly integrity: string }
  /** Anything else: the question could not be answered. */
  | { readonly kind: 'unknown'; readonly detail: string };

/** npm's error code on its stderr, either generation's format. */
function errorCode(stderr: string): string | undefined {
  return /\bcode (E[A-Z0-9]+)\b/.exec(stderr)?.[1];
}

/** Classify npm view's answer against the staged archive's `integrity`. */
export function classifyExisting(result: NpmResult, integrity: string): Existing {
  if (result.status !== 0) {
    const code = errorCode(result.stderr);
    if (code === 'E404') return { kind: 'absent' };
    return { kind: 'unknown', detail: code ?? `exit ${String(result.status)}` };
  }
  const reported = result.stdout.trim();
  // A registry that answers without the field cannot be compared, and a
  // match must not be assumed.
  if (!reported.startsWith('sha512-')) {
    return {
      kind: 'unknown',
      detail: reported === '' ? 'no integrity reported' : 'no sha512 integrity reported',
    };
  }
  return reported === integrity
    ? { kind: 'identical', integrity: reported }
    : { kind: 'different', integrity: reported };
}
