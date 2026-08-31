// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { describe, expect, it } from 'vitest';
import { escapeData, formatOutput } from '../src/actions-io.js';

describe('formatOutput', () => {
  it('renders a simple value in the heredoc form', () => {
    expect(formatOutput('package_name', 'pkg', 'D')).toBe('package_name<<D\npkg\nD\n');
  });

  // The heredoc form exists for exactly this: 'name=value' cannot carry a
  // newline, and a value that could inject one would let a package name
  // forge a second output.
  it('carries a multi-line value intact', () => {
    expect(formatOutput('out', 'a\nb', 'D')).toBe('out<<D\na\nb\nD\n');
  });

  it('preserves an empty value', () => {
    expect(formatOutput('out', '', 'D')).toBe('out<<D\n\nD\n');
  });

  // A value able to reproduce the delimiter could close the heredoc early
  // and append arbitrary further outputs.
  it('refuses a value containing the delimiter', () => {
    expect(() => formatOutput('out', 'before\nDELIM\nafter', 'DELIM')).toThrow(/delimiter/);
  });

  it('refuses a name containing the delimiter', () => {
    expect(() => formatOutput('DELIM', 'value', 'DELIM')).toThrow(/delimiter/);
  });

  it('refuses a name containing a line break', () => {
    expect(() => formatOutput('a\nb', 'value', 'D')).toThrow(/line break/);
  });
});

describe('escapeData', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeData('published pkg@1.0.0')).toBe('published pkg@1.0.0');
  });

  // A newline would end the ::error:: message and let the remainder be read
  // as a fresh workflow command.
  it('escapes line breaks', () => {
    expect(escapeData('line one\nline two')).toBe('line one%0Aline two');
    expect(escapeData('carriage\rreturn')).toBe('carriage%0Dreturn');
  });

  // Percent must go first, or the escapes above would themselves be
  // re-escaped inconsistently.
  it('escapes percent signs before other substitutions', () => {
    expect(escapeData('100%')).toBe('100%25');
    expect(escapeData('%0Aliteral')).toBe('%250Aliteral');
  });
});
