// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePublishOutput } from '../src/publish-metadata.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** npm 10 placed the fields at the top level. */
const npm10 = (name: string, version: string): string =>
  JSON.stringify({
    id: `${name}@${version}`,
    name,
    version,
    filename: `${name}-${version}.tgz`,
    size: 267,
  });

/** npm 11 keys the object by package name. */
const npm11 = (name: string, version: string): string =>
  JSON.stringify({
    [name]: {
      id: `${name}@${version}`,
      name,
      version,
      filename: `${name}-${version}.tgz`,
      size: 267,
    },
  });

describe('shape normalisation', () => {
  it('reads the npm 10 flat shape', () => {
    const result = parsePublishOutput(npm10('pkg', '1.0.0'));
    expect(result).toEqual({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('reads the npm 11 keyed shape', () => {
    const result = parsePublishOutput(npm11('pkg', '1.0.0'));
    expect(result).toEqual({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('reads a scoped package key', () => {
    const result = parsePublishOutput(npm11('@onap/ui', '2.0.0'));
    expect(result).toMatchObject({ ok: true, metadata: { name: '@onap/ui' } });
  });

  // The discriminator has to be the *type* of .name, not its presence: this
  // input is the npm 11 keyed shape, but a presence test reads it as the
  // npm 10 flat shape and hands back the metadata object as the name.
  it('reads a package literally named "name" in the npm 11 shape', () => {
    const result = parsePublishOutput(npm11('name', '3.0.0'));
    expect(result).toMatchObject({
      ok: true,
      metadata: { name: 'name', version: '3.0.0', filename: 'name-3.0.0.tgz' },
    });
  });

  it('reads a package literally named "name" in the npm 10 shape', () => {
    const result = parsePublishOutput(npm10('name', '3.0.0'));
    expect(result).toMatchObject({ ok: true, metadata: { name: 'name', version: '3.0.0' } });
  });
});

describe('lifecycle script output', () => {
  // Captured from a real `npm publish --json --dry-run` whose hooks print
  // an unbalanced brace, their own valid JSON, and a stray closing brace.
  it('parses real npm output surrounded by noisy hook output', () => {
    const result = parsePublishOutput(fixture('npm11-noisy-hooks.txt'), {
      expectedVersion: '1.0.0',
    });
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        name: 'lfreleng-node-publish-action-noisy-fixture',
        version: '1.0.0',
        filename: 'lfreleng-node-publish-action-noisy-fixture-1.0.0.tgz',
      },
    });
  });

  // Hooks can bracket npm's report so the whole stream parses as one
  // object. Keeping only the outermost candidate would find a wrapper that
  // is not metadata and report nothing at all.
  it('finds npm metadata nested inside a hook-formed wrapper', () => {
    const raw = `{"hook":\n${npm11('pkg', '1.0.0')}\n}`;
    expect(JSON.parse(raw)).toBeTypeOf('object');
    expect(parsePublishOutput(raw)).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0' },
    });
  });

  it('finds npm metadata nested two wrappers deep', () => {
    const raw = `{"a":{"b":\n${npm11('pkg', '1.0.0')}\n}}`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // The npm 10 flat shape has no key to check, so a wrapped one is only
  // distinguishable from a hook's structured log line by the version it
  // reports. npm's own report always names the version being published.
  it('finds a wrapped npm 10 report when it names the published version', () => {
    const raw = `{"hook":\n${npm10('pkg', '1.0.0')}\n}`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', filename: 'pkg-1.0.0.tgz' },
    });
  });

  // Same shape, different version: this is a hook's log line, and
  // reporting it as the publish would name a package that was never
  // published.
  it('ignores a wrapped flat object naming a different version', () => {
    const raw = `{"hook":\n${npm10('pkg', '0.0.1')}\n}`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });

  it('ignores a hook printing plain text before and after', () => {
    const raw = `> build\nrunning tests...\n${npm11('pkg', '1.0.0')}\ncleanup complete\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // An unbalanced brace is the case a naive balanced scan gets wrong: it
  // swallows npm's JSON as if it were nested inside.
  it('recovers from an unbalanced opening brace in hook output', () => {
    const raw = `warning: unclosed { here\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // The npm 10 flat shape counts only when nothing encloses it, so an
  // unmatched brace left over from hook text must not read as an
  // enclosing object. Nesting is decided by candidates that actually
  // parsed, never by the raw brace stack.
  it('accepts a flat report after an unmatched opening brace', () => {
    const raw = `warning: unclosed { here\n${npm10('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('accepts a flat report after several unmatched opening braces', () => {
    const raw = `a {\nb {\nc {\n${npm10('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // A lone double quote in hook text would otherwise leave the scanner
  // "inside a string" for the rest of the stream, hiding every brace in
  // npm's report. JSON forbids a literal newline inside a string, so a
  // line break proves this was never one.
  it('recovers from an unmatched double quote in hook output', () => {
    const raw = `building "target\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('recovers from an unmatched quote before a flat report', () => {
    const raw = `building "target\n${npm10('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('recovers from an unmatched quote inside an unmatched brace', () => {
    const raw = `build { say "hello\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('recovers from an odd number of quotes across several lines', () => {
    const raw = `a "one\nb "two\nc "three\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // The line-break recovery cannot help when the hook never ends its line:
  // process.stdout.write or printf leaves the unmatched quote on the same
  // line npm's report begins. The parser retries with quotes ignored.
  it('recovers from an unmatched quote with no trailing newline', () => {
    const raw = `building "${npm11('pkg', '1.0.0')}`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('recovers from an unmatched quote inline before a flat report', () => {
    const raw = `building "${npm10('pkg', '1.0.0')}`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('recovers from an unmatched quote inside an unterminated brace line', () => {
    const raw = `build { say "${npm11('pkg', '1.0.0')}`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // The retry trigger is "nothing reports the version being published",
  // not "nothing found at all". A hook printing a metadata-shaped object
  // of its own before the unmatched quote would otherwise satisfy the
  // first pass and suppress the recovery, and npm's real report would
  // never be seen.
  it('recovers when a hook object precedes the unmatched quote', () => {
    const hook = npm10('hook-report', '0.0.1');
    const raw = `${hook}\nbuilding "${npm11('pkg', '1.0.0')}`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('recovers when a hook object precedes an inline quote before a flat report', () => {
    const hook = npm10('hook-report', '0.0.1');
    const raw = `${hook}\nbuilding "${npm10('pkg', '1.0.0')}`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0' },
    });
  });

  // The retry must not disturb output the first pass already read
  // correctly, even when a hook object sits alongside the real report.
  it('leaves an already-correct first pass alone', () => {
    const hook = npm10('hook-report', '0.0.1');
    const raw = `${hook}\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', version: '1.0.0' },
    });
  });

  // Documented limitation. Recovering from a lone inline quote means
  // ignoring quotes, which also stops braces inside genuine JSON strings
  // being ignored -- and once the quote state is lost there is no way to
  // tell the two apart. Reaching this needs a hook to emit an unmatched
  // quote with no trailing newline *and* npm's report to contain a brace
  // inside a string value, which its fields never do (id, name, version,
  // shasum, integrity and filename are all brace-free).
  //
  // What matters is that it fails safely rather than reporting the wrong
  // package: the caller still gets the do-not-retry message.
  it('fails safely when an inline quote meets braces inside strings', () => {
    const withBraces = JSON.stringify({
      name: 'pkg',
      version: '1.0.0',
      filename: 'pkg-1.0.0.tgz',
      note: 'a } brace and a { brace',
    });
    const raw = `building "${withBraces}`;
    expect(parsePublishOutput(raw)).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });

  // The same report parses normally once the hook ends its line, which is
  // what confines the limitation above to the inline case.
  it('handles braces inside strings when the quote is on its own line', () => {
    const withBraces = JSON.stringify({
      name: 'pkg',
      version: '1.0.0',
      filename: 'pkg-1.0.0.tgz',
      note: 'a } brace and a { brace',
    });
    const raw = `building "\n${withBraces}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('recovers from a stray closing brace in hook output', () => {
    const raw = `done }\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // A hook's own JSON is rejected by shape rather than by position, so it
  // does not matter whether it comes before or after npm's.
  it('ignores a hook printing its own JSON object', () => {
    const raw = `{"tool":"webpack","ok":true}\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  it('ignores a hook printing JSON after npm', () => {
    const raw = `${npm11('pkg', '1.0.0')}\n{"stats":{"time":12}}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });

  // Braces inside string literals must not affect nesting depth. This has
  // to keep working despite the newline recovery above, which is why the
  // quoted content stays on one line -- as npm's own output always does.
  it('handles braces and escapes inside strings', () => {
    const raw = `${JSON.stringify({
      name: 'pkg',
      version: '1.0.0',
      filename: 'pkg-1.0.0.tgz',
      note: 'a } brace and a \\" quote {',
    })}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
  });
});

describe('ambiguity', () => {
  // Normal npm 11 output produces two candidates: the keyed object, and
  // the inner record which reads as the npm 10 flat shape. They normalise
  // identically, so this must not register as an ambiguity.
  it('does not treat the two views of one npm 11 report as ambiguous', () => {
    expect(parsePublishOutput(npm11('pkg', '1.0.0'))).toMatchObject({
      ok: true,
      metadata: { name: 'pkg' },
    });
  });

  it('does not need a version hint for unambiguous output', () => {
    expect(parsePublishOutput(npm11('pkg', '1.0.0'), {})).toMatchObject({ ok: true });
  });
  // Two metadata-shaped objects: the requested version identifies npm's.
  it('prefers the candidate matching the requested version', () => {
    const raw = `${npm10('stale', '0.9.0')}\n${npm11('pkg', '1.0.0')}\n`;
    const result = parsePublishOutput(raw, { expectedVersion: '1.0.0' });
    expect(result).toMatchObject({ ok: true, metadata: { name: 'pkg', version: '1.0.0' } });
  });

  it('reports ambiguity when no candidate matches the requested version', () => {
    const raw = `${npm10('a', '0.9.0')}\n${npm11('b', '0.8.0')}\n`;
    const result = parsePublishOutput(raw, { expectedVersion: '1.0.0' });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'ambiguous' } });
  });

  it('reports ambiguity when no version hint is available', () => {
    const raw = `${npm10('a', '0.9.0')}\n${npm11('b', '0.8.0')}\n`;
    expect(parsePublishOutput(raw)).toMatchObject({
      ok: false,
      failure: { kind: 'ambiguous' },
    });
  });
});

describe('fan-out', () => {
  it('reports every package when npm publishes several', () => {
    const raw = JSON.stringify({
      'child-a': { name: 'child-a', version: '1.0.0', filename: 'child-a-1.0.0.tgz' },
      'child-b': { name: 'child-b', version: '1.0.0', filename: 'child-b-1.0.0.tgz' },
    });
    expect(parsePublishOutput(raw)).toEqual({
      ok: false,
      failure: { kind: 'fan-out', packages: ['child-a', 'child-b'] },
    });
  });

  // Workspace packages can carry independent versions. The keyed report
  // then fails an every() version test that its own matching inner record
  // passes, so without care the survivor looks like a clean single-package
  // success while two packages reached the registry.
  it('reports fan-out when only one child matches the requested version', () => {
    const raw = JSON.stringify({
      'child-a': { name: 'child-a', version: '1.0.0', filename: 'child-a-1.0.0.tgz' },
      'child-b': { name: 'child-b', version: '2.0.0', filename: 'child-b-2.0.0.tgz' },
    });
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toEqual({
      ok: false,
      failure: { kind: 'fan-out', packages: ['child-a', 'child-b'] },
    });
  });

  it('reports fan-out when no child matches the requested version', () => {
    const raw = JSON.stringify({
      'child-a': { name: 'child-a', version: '1.0.0', filename: 'child-a-1.0.0.tgz' },
      'child-b': { name: 'child-b', version: '2.0.0', filename: 'child-b-2.0.0.tgz' },
    });
    expect(parsePublishOutput(raw, { expectedVersion: '9.9.9' })).toMatchObject({
      ok: false,
      failure: { kind: 'fan-out' },
    });
  });

  it('reports fan-out even when hook noise surrounds the report', () => {
    const report = JSON.stringify({
      'child-a': { name: 'child-a', version: '1.0.0', filename: 'child-a-1.0.0.tgz' },
      'child-b': { name: 'child-b', version: '2.0.0', filename: 'child-b-2.0.0.tgz' },
    });
    const raw = `building... {unbalanced\n${report}\ndone }\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: false,
      failure: { kind: 'fan-out' },
    });
  });

  // A hook object that does match the requested version must not displace
  // a fan-out report that does not. Filtering on version first would pick
  // the hook object and report a clean success for one package while two
  // reached the registry.
  it('reports fan-out over a version-matching hook object', () => {
    const report = JSON.stringify({
      'child-a': { name: 'child-a', version: '1.0.0', filename: 'child-a-1.0.0.tgz' },
      'child-b': { name: 'child-b', version: '2.0.0', filename: 'child-b-2.0.0.tgz' },
    });
    const hook = JSON.stringify({
      name: 'hook-report',
      version: '1.0.0',
      filename: 'hook-report-1.0.0.tgz',
    });
    const raw = `${report}\n${hook}\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: false,
      failure: { kind: 'fan-out' },
    });
  });

  it('accepts a single keyed entry', () => {
    expect(parsePublishOutput(npm11('only', '1.0.0'))).toMatchObject({ ok: true });
  });
});

describe('truncation', () => {
  // Stopping at a limit leaves the candidate list incomplete. Selecting
  // from it could report a partial result as a whole one -- worse still,
  // deduplication can leave a single hook object standing where npm's
  // report was never reached.
  it('reports truncation rather than selecting from a partial scan', () => {
    const objects = Array.from({ length: 10_050 }, (_, i) =>
      JSON.stringify({
        name: `pkg-${String(i)}`,
        version: '1.0.0',
        filename: `pkg-${String(i)}-1.0.0.tgz`,
      }),
    ).join('\n');
    const raw = `${objects}\n${npm11('real', '1.0.0')}\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toEqual({
      ok: false,
      failure: { kind: 'truncated' },
    });
  });

  // The limit must not fire on ordinary output, however noisy.
  it('does not report truncation for output well under the limit', () => {
    const objects = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({
        name: `pkg-${String(i)}`,
        version: '0.0.1',
        filename: `pkg-${String(i)}-0.0.1.tgz`,
      }),
    ).join('\n');
    const raw = `${objects}\n${npm11('real', '1.0.0')}\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'real' },
    });
  });
});

describe('structural invariants', () => {
  // npm keys the object by the package name its value reports. Enforcing
  // that rejects hook JSON which is otherwise shaped exactly like a
  // report -- and which, on a matching version, would read as ambiguous
  // and fail a publish that had already succeeded.
  it('rejects a keyed entry whose key is not the package name', () => {
    const raw = JSON.stringify({
      build: { name: 'pkg', version: '1.0.0', filename: 'stats.json' },
    });
    expect(parsePublishOutput(raw)).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });

  it('accepts real npm output alongside such a hook object', () => {
    const hook = JSON.stringify({
      build: { name: 'pkg', version: '1.0.0', filename: 'stats.json' },
    });
    const raw = `${hook}\n${npm11('pkg', '1.0.0')}\n`;
    expect(parsePublishOutput(raw, { expectedVersion: '1.0.0' })).toMatchObject({
      ok: true,
      metadata: { name: 'pkg', filename: 'pkg-1.0.0.tgz' },
    });
  });

  it('accepts a scoped key matching its package name', () => {
    expect(parsePublishOutput(npm11('@onap/ui', '2.0.0'))).toMatchObject({
      ok: true,
      metadata: { name: '@onap/ui' },
    });
  });

  // The shell implementation failed explicitly when npm reported no
  // tarball filename. An empty value must not produce successful outputs
  // and a summary naming a tarball that does not exist.
  it.each(['name', 'version', 'filename'])('rejects an empty %s', (field) => {
    const record: Record<string, string> = {
      name: 'pkg',
      version: '1.0.0',
      filename: 'pkg-1.0.0.tgz',
    };
    record[field] = '';
    expect(parsePublishOutput(JSON.stringify(record))).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });
});

describe('resource bounds', () => {
  // Parsing happens after a successful publish, so pathological output
  // must not be able to spin until the job times out: that would withhold
  // the do-not-retry warning, the one message that matters.
  it('handles output full of unmatched opening braces quickly', () => {
    const raw = `${'{'.repeat(200_000)}\n${npm11('pkg', '1.0.0')}\n`;
    const started = Date.now();
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('handles output full of unmatched closing braces quickly', () => {
    const raw = `${'}'.repeat(200_000)}\n${npm11('pkg', '1.0.0')}\n`;
    const started = Date.now();
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('handles many small balanced objects quickly', () => {
    const raw = `${'{"a":1}\n'.repeat(100_000)}${npm11('pkg', '1.0.0')}\n`;
    const started = Date.now();
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // The byte budget counts characters parsed, not objects retained: `{}`
  // costs two characters each, so a large stream of them could accumulate
  // millions of parsed values. Discarding anything that does not normalise
  // is what keeps this bounded.
  it('handles a large stream of empty objects without exhausting memory', () => {
    const raw = `${'{}'.repeat(1_000_000)}\n${npm11('pkg', '1.0.0')}\n`;
    const started = Date.now();
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('handles a large stream of small non-metadata objects', () => {
    const raw = `${'{"a":1,"b":2}'.repeat(200_000)}\n${npm11('pkg', '1.0.0')}\n`;
    const started = Date.now();
    expect(parsePublishOutput(raw)).toMatchObject({ ok: true, metadata: { name: 'pkg' } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('no metadata', () => {
  it('reports empty output', () => {
    expect(parsePublishOutput('')).toEqual({ ok: false, failure: { kind: 'no-metadata' } });
  });

  it('reports an empty object', () => {
    expect(parsePublishOutput('{}')).toEqual({ ok: false, failure: { kind: 'no-metadata' } });
  });

  it('reports output holding only hook text', () => {
    expect(parsePublishOutput('building...\ndone\n')).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });

  // Missing any one of the three fields means npm did not report a publish,
  // so partial data must never be reported as a success.
  it.each(['name', 'version', 'filename'])('reports metadata missing %s', (field) => {
    const record: Record<string, unknown> = {
      name: 'pkg',
      version: '1.0.0',
      filename: 'pkg-1.0.0.tgz',
    };
    delete record[field];
    expect(parsePublishOutput(JSON.stringify(record))).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });

  it('rejects an array', () => {
    expect(parsePublishOutput('[1,2,3]')).toEqual({
      ok: false,
      failure: { kind: 'no-metadata' },
    });
  });
});
