// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Parsing for the output of `npm publish --json`.
 *
 * Two things make this harder than `JSON.parse`:
 *
 * 1. npm runs lifecycle scripts with inherited stdio, so `prepublishOnly`,
 *    `publish` and `postpublish` output lands in the same stream as npm's
 *    JSON. The captured text is therefore rarely a bare JSON document.
 * 2. npm 10 put `name`/`version`/`filename` at the top level, while npm 11
 *    keys the object by package name.
 *
 * Hook output is arbitrary. It can contain unbalanced braces, its own valid
 * JSON, or both, so candidates are located structurally and then validated
 * by *shape* rather than by position.
 */

/** The fields the action reports and verifies. */
export interface PublishMetadata {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
}

export type ParseFailure =
  /** No object in the output looked like npm publish metadata. */
  | { readonly kind: 'no-metadata' }
  /** npm reported several packages; this action publishes and verifies one. */
  | { readonly kind: 'fan-out'; readonly packages: readonly string[] }
  /** Several distinct objects looked like metadata and none could be preferred. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly PublishMetadata[] }
  /** A limit stopped the scan, so nothing found can be trusted as complete. */
  | { readonly kind: 'truncated' };

export type ParseResult =
  | { readonly ok: true; readonly metadata: PublishMetadata }
  | { readonly ok: false; readonly failure: ParseFailure };

export interface ParseOptions {
  /**
   * The version the action asked npm to publish. Used only to break a tie
   * when hook output happens to contain a metadata-shaped object of its own.
   */
  readonly expectedVersion?: string | undefined;
}


import { collectMatches } from './publish-scan.js';
import type { Normalised } from './publish-scan.js';

/**
 * Whether any match reports the version the action asked npm to publish.
 *
 * With no version to check against there is nothing to be sure of, so an
 * empty result is the only thing that counts as "not found".
 */
function carriesExpected(
  matches: readonly Normalised[],
  expectedVersion: string | undefined,
): boolean {
  if (expectedVersion === undefined) {
    return matches.length > 0;
  }
  return matches.some((m) => m.entries.every((e) => e.version === expectedVersion));
}

/**
 * Locate and normalise npm's publish metadata within captured output.
 *
 * Fan-out is reported rather than resolved: this action publishes the single
 * package at `path_prefix`, so several entries mean several packages reached
 * the registry while only one would be verified and reported.
 */
export function parsePublishOutput(raw: string, options: ParseOptions = {}): ParseResult {
  const { expectedVersion } = options;
  let { matches, truncated } = collectMatches(raw, true, expectedVersion);

  if (!truncated && !carriesExpected(matches, expectedVersion)) {
    // Honouring quotes is right for JSON and wrong for hook text. A hook
    // emitting a lone quote without a trailing newline -- via
    // `process.stdout.write` or `printf` -- leaves the scanner inside a
    // string exactly where npm's report begins, hiding every brace in it.
    //
    // The trigger is "nothing here reports the version being published",
    // not "nothing here at all". A hook can print a metadata-shaped
    // object of its own *before* the unmatched quote, and that lone
    // candidate would otherwise suppress the recovery and be reported as
    // a version mismatch on a publish that succeeded.
    //
    // The retry cannot invent a report: every candidate still has to
    // parse as JSON and normalise as metadata. Both passes are linear,
    // and the result is kept only when it does better than the first --
    // so ordinary output, where the first pass already found the report,
    // never reaches this.
    //
    // The retry cannot distinguish a brace inside a JSON string from a
    // structural one, because the quote state that would tell them apart
    // is the very thing in doubt. Reaching that needs npm's report to
    // carry a brace inside a string value on the same line as an
    // unmatched hook quote; none of the fields npm emits (id, name,
    // version, shasum, integrity, filename) contains one. If it ever
    // happens the parse fails, which still yields the do-not-retry
    // message rather than a wrong package.
    const retry = collectMatches(raw, false, expectedVersion);
    if (carriesExpected(retry.matches, expectedVersion) || matches.length === 0) {
      ({ matches, truncated } = retry);
    }
  }

  // A limit stopped the scan, so the candidate list is incomplete.
  // Selecting from it could report a partial result as a whole one --
  // deduplication can even leave a single hook object standing where
  // npm's report was never reached.
  if (truncated) {
    return { ok: false, failure: { kind: 'truncated' } };
  }

  if (matches.length === 0) {
    return { ok: false, failure: { kind: 'no-metadata' } };
  }

  // A keyed report listing several packages is npm saying it published
  // them. Settle that before any version filtering: with mixed versions
  // the multi-entry report fails an every() test that a single matching
  // record passes, which would turn a fan-out into a false single-package
  // success.
  const fanOut = matches.find((m) => m.keyed && m.entries.length > 1);
  if (fanOut) {
    return {
      ok: false,
      failure: { kind: 'fan-out', packages: fanOut.entries.map((entry) => entry.name) },
    };
  }

  const selected = matches.length === 1 ? matches[0]! : disambiguate(matches, expectedVersion);
  if (!selected) {
    return {
      ok: false,
      failure: { kind: 'ambiguous', candidates: matches.map((m) => m.entries[0]!) },
    };
  }

  if (selected.entries.length > 1) {
    return {
      ok: false,
      failure: { kind: 'fan-out', packages: selected.entries.map((entry) => entry.name) },
    };
  }

  return { ok: true, metadata: selected.entries[0]! };
}

/**
 * Pick npm's own report from several metadata-shaped objects.
 *
 * Reaching here means hook output carried something shaped like a report,
 * so the choice rests on two signals, in order: the version the action
 * asked npm to publish, then npm 11's keyed shape, whose key-equals-name
 * invariant is stronger evidence than a bare object found loose in hook
 * output.
 *
 * Returns `undefined` when neither settles it, which the caller reports as
 * an ambiguity rather than guessing.
 */
function disambiguate(
  matches: readonly Normalised[],
  expectedVersion: string | undefined,
): Normalised | undefined {
  if (expectedVersion === undefined) {
    return undefined;
  }

  let remaining = matches.filter((m) => m.entries.every((e) => e.version === expectedVersion));

  if (remaining.length > 1) {
    const keyed = remaining.filter((m) => m.keyed);
    if (keyed.length > 0) {
      remaining = keyed;
    }
  }

  return remaining.length === 1 ? remaining[0] : undefined;
}
