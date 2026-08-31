// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Locating npm publish reports inside arbitrary captured output.
 *
 * Separated from the parsing entry point so that the scanning and shape
 * rules -- which carry most of the reasoning about what hook output can do
 * -- can be read on their own.
 */

import type { PublishMetadata } from './publish-metadata.js';

/**
 * Ceiling on the total characters handed to `JSON.parse`.
 *
 * Deeply nested output would otherwise cost O(n^2): every closing brace
 * parses a substring reaching back to its partner. Hook output is arbitrary
 * and this parse runs *after* a successful publish, so an adversarial or
 * merely enormous build log must not be able to spin until the job times
 * out -- that would withhold the do-not-retry warning, which is the one
 * message that matters here.
 *
 * Real npm output is a few kilobytes; this leaves several orders of
 * magnitude of headroom. Exhausting it degrades to a reported failure,
 * which is the safe direction.
 */
const MAX_PARSE_BUDGET = 16 * 1024 * 1024;

/**
 * Ceiling on retained candidates.
 *
 * The byte budget alone does not bound *allocations*: a stream of `{}`
 * spends two characters per parsed object, so it could retain millions and
 * exhaust the heap while sorting them -- after publication, and before the
 * do-not-retry warning. Discarding objects that do not normalise (below)
 * removes most of that exposure; this caps what remains.
 *
 * Even a workspace fan-out reports one entry per package, so anything
 * approaching this is not npm output. Exceeding it stops collection, which
 * degrades to a reported failure -- the safe direction.
 */
const MAX_CANDIDATES = 10_000;

/**
 * A candidate that normalised as a report, with its span and shape.
 *
 * Only normalising candidates are retained. An arbitrary parsed object is
 * of no interest on its own, and the sole reason to know about an
 * *enclosing* object is to tell whether it is a keyed report -- so
 * everything else can be discarded as it is found rather than accumulated.
 */
export interface Normalised {
  readonly entries: readonly PublishMetadata[];
  /** True for npm 11's keyed shape, false for npm 10's flat one. */
  readonly keyed: boolean;
  /**
   * Position of the brace enclosing this object, if any.
   *
   * Resolved against the set of braces that never closed, so an unmatched
   * `{` left by hook text does not count as an enclosure.
   */
  readonly enclosingOpen: number | undefined;
}

/**
 * The outcome of one scan.
 *
 * `truncated` records that a limit stopped the scan short. The candidate
 * list is then incomplete, and selecting from it could report a partial
 * result as a whole one, so callers must treat it as a failure rather than
 * as "nothing more to find".
 */
interface ScanResult {
  readonly candidates: readonly Normalised[];
  readonly truncated: boolean;
}

/**
 * Every substring that parses as a JSON object, with its nesting.
 *
 * A single pass keeps a stack of unclosed brace positions and attempts a
 * parse at each closing brace, innermost first. Three properties of hook
 * output drive the details.
 *
 * **Unmatched opening braces cost nothing.** Their positions stay on the
 * stack, so `echo "building... {"` cannot swallow npm's report the way a
 * restart-on-failure scan would, and the degenerate case stays linear.
 *
 * **Nested candidates survive.** Hooks printing `{"hook":` and a matching
 * `}` around npm's report make the whole stream one valid object; the
 * wrapper is recorded *and* so is npm's report inside it.
 *
 * **A line break ends any string.** JSON forbids a literal control
 * character inside a string, so a raw newline proves the scanner was never
 * in a JSON string at all -- it was in hook text containing a lone quote,
 * such as `echo 'building "target'`. Without this, one unbalanced quote
 * would make every brace after it invisible and lose npm's report
 * entirely. Escapes and quoted braces within a single line still behave,
 * because npm never emits a string spanning lines.
 *
 * A hook writing without a trailing newline -- `process.stdout.write('a
 * "')` -- puts its unmatched quote on the *same* line as npm's report, so
 * the line break cannot rescue it. `honourQuotes` exists for that: see
 * {@link parsePublishOutput}, which retries with quotes ignored when the
 * first pass finds nothing.
 */
function jsonObjectCandidates(raw: string, honourQuotes: boolean): ScanResult {
  const found: Normalised[] = [];
  const openPositions: number[] = [];
  let budget = MAX_PARSE_BUDGET;
  let truncated = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (ch === '\n' || ch === '\r') {
      // Cannot have been a JSON string; recover rather than treat the
      // rest of the stream as quoted.
      inString = false;
      escaped = false;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' && honourQuotes) {
      inString = true;
      continue;
    }
    if (ch === '{') {
      openPositions.push(i);
      continue;
    }
    if (ch !== '}') {
      continue;
    }

    const start = openPositions.pop();
    if (start === undefined) {
      // A closing brace with no partner, such as `echo "done }"`.
      continue;
    }

    const length = i + 1 - start;
    if (length > budget) {
      // Skipping silently would let a later hook object stand in for a
      // report never examined, so the whole scan is unreliable from here.
      truncated = true;
      break;
    }
    budget -= length;

    try {
      const parsed: unknown = JSON.parse(raw.slice(start, i + 1));
      const normalised = normalise(parsed, openPositions[openPositions.length - 1]);
      if (normalised) {
        found.push(normalised);
        if (found.length >= MAX_CANDIDATES) {
          truncated = true;
          break;
        }
      }
    } catch {
      // Not JSON: hook text that happens to balance, most likely.
    }
  }

  // Braces still open at the end never closed, so they were hook text
  // rather than enclosing objects. Without this an unmatched `{` would
  // make every later report look wrapped.
  const unclosed = new Set(openPositions);
  return {
    truncated,
    candidates: found.map((candidate) => ({
      ...candidate,
      enclosingOpen:
        candidate.enclosingOpen !== undefined && !unclosed.has(candidate.enclosingOpen)
          ? candidate.enclosingOpen
          : undefined,
    })),
  };
}

/**
 * A parsed value as a report, if it is one, in either npm generation's shape.
 *
 * Returning `undefined` for anything else is what keeps memory bounded: a
 * stream of `{}` or `{"a":1}` allocates during the parse but retains
 * nothing.
 */
function normalise(value: unknown, enclosingOpen: number | undefined): Normalised | undefined {
  const keyed = keyedEntries(value);
  if (keyed) {
    return { entries: keyed, keyed: true, enclosingOpen };
  }
  const flat = asMetadata(value);
  if (flat) {
    return { entries: [flat], keyed: false, enclosingOpen };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * The metadata fields, if this object carries all three as non-empty strings.
 *
 * Requiring all three rejects a hook's own JSON: an object has to look
 * specifically like npm publish metadata, not merely like an object.
 *
 * Requiring them to be *non-empty* preserves an invariant the shell
 * implementation enforced separately. An empty `filename` would otherwise
 * produce successful outputs and a summary naming a tarball that does not
 * exist.
 */
function asMetadata(value: unknown): PublishMetadata | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const { name, version, filename } = record;
  if (typeof name !== 'string' || name === '') {
    return undefined;
  }
  if (typeof version !== 'string' || version === '') {
    return undefined;
  }
  if (typeof filename !== 'string' || filename === '') {
    return undefined;
  }
  return { name, version, filename };
}

/**
 * The entries of npm 11's keyed shape, if this object is one.
 *
 * npm keys the object by the package name its value reports, so that is
 * enforced rather than assumed. It is a cheap structural invariant that
 * rejects hook output such as `{"build": {"name": "pkg", ...}}`, which a
 * shape test alone accepts.
 *
 * The discriminator against npm 10's flat shape is the *type* of `.name`,
 * never its presence: a package legitimately called `name` produces
 * `{"name": {...}}` here, which a presence test misreads as flat.
 */
function keyedEntries(value: unknown): readonly PublishMetadata[] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const pairs = Object.entries(record);
  if (pairs.length === 0) {
    return undefined;
  }

  const entries: PublishMetadata[] = [];
  for (const [key, entryValue] of pairs) {
    const entry = asMetadata(entryValue);
    if (!entry || entry.name !== key) {
      return undefined;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Every distinct report found in the output, tagged by shape.
 *
 * A flat object with something enclosing it is ambiguous evidence. It can
 * be npm 10's report bracketed by hooks -- `{"hook":` before, `}` after --
 * or one of npm 11's own inner records, or a hook's structured log line
 * such as `{"build": {"name": "pkg", "filename": "stats.json"}}`. Nothing
 * structural separates them.
 *
 * So such an object counts only when it reports the version being
 * published. A real report always does; a hook would have to name the exact
 * version by coincidence. Without a version to check against, it is
 * discarded -- reporting a hook's log line as the publish would be worse
 * than reporting nothing, because the caller would believe a wrong package
 * and tarball had been published.
 *
 * An admitted inner record of an npm 11 report is harmless: for a single
 * package it carries identical content to the keyed object and
 * deduplicates against it, and for several packages
 * {@link parsePublishOutput} settles fan-out before any of this is
 * consulted.
 */
export function collectMatches(
  raw: string,
  honourQuotes: boolean,
  expectedVersion: string | undefined,
): { matches: Normalised[]; truncated: boolean } {
  const { candidates, truncated } = jsonObjectCandidates(raw, honourQuotes);

  // Deduplicated by content: distinct objects reporting the same publish
  // are one result, not an ambiguity.
  const distinct = new Map<string, Normalised>();

  for (const candidate of candidates) {
    if (!candidate.keyed && candidate.enclosingOpen !== undefined) {
      const entry = candidate.entries[0];
      if (expectedVersion === undefined || entry?.version !== expectedVersion) {
        continue;
      }
    }
    const key = JSON.stringify(candidate.entries);
    const existing = distinct.get(key);
    // Keep the keyed view when the same report arrives in both shapes:
    // npm 11's inner record closes first and reads as npm 10's flat
    // shape, and dropping the keyed one would discard the stronger
    // evidence used to break ties later.
    if (!existing || (candidate.keyed && !existing.keyed)) {
      distinct.set(key, candidate);
    }
  }

  return { matches: [...distinct.values()], truncated };
}
