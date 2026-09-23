// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { describe, expect, it } from 'vitest';

import type { LoadedConfig } from '../src/npm-internals.js';
import {
  meetsVersion,
  CLI_FILTER_SINCE,
  publishFlags,
  publishOptions,
} from '../src/publish-options.js';

/** A configuration whose flatten simply copies keys, as npm's does for these. */
function config(flat: Record<string, unknown>, cliKeys: string[] = []): LoadedConfig {
  return {
    get: (key) => flat[key],
    find: () => null,
    flat,
    cliKeys: new Set(cliKeys),
    flatten: (source, target) => Object.assign(target, source),
    validate: () => undefined,
  };
}

describe('meetsVersion', () => {
  it.each([
    ['10.5.2', true],
    ['10.5.3', true],
    ['10.6.0', true],
    ['11.0.0', true],
    ['10.5.1', false],
    ['10.4.9', false],
    ['9.9.4', false],
    ['10.5.2-pre.1', true],
    ['not-a-version', false],
  ])('compares %s against the 10.5.2 floor', (version, expected) => {
    expect(meetsVersion(version, CLI_FILTER_SINCE)).toBe(expected);
  });

  it('compares numerically, not as text', () => {
    expect(meetsVersion('10.10.0', [10, 9, 0])).toBe(true);
  });
});

describe('publishFlags', () => {
  it('always disables workspaces, as the publish step does', () => {
    expect(publishFlags('')).toEqual(['--no-workspaces']);
  });

  it('adds --registry only when one is given, trimmed', () => {
    expect(publishFlags(' https://r.example/ ')).toEqual([
      '--no-workspaces',
      '--registry=https://r.example/',
    ]);
  });
});

describe('publishOptions', () => {
  it('applies every publishConfig key before 10.5.2, CLI flags included', () => {
    const { opts, applied } = publishOptions(
      config({ registry: 'https://cli.example/' }, ['registry']),
      '10.5.1',
      { registry: 'https://manifest.example/' },
    );
    expect(opts['registry']).toBe('https://manifest.example/');
    expect(applied.has('registry')).toBe(true);
  });

  it('skips keys set on the command line from 10.5.2', () => {
    const { opts, applied } = publishOptions(
      config({ registry: 'https://cli.example/' }, ['registry']),
      '10.5.2',
      { registry: 'https://manifest.example/', '@s:registry': 'https://s.example/' },
    );
    expect(opts['registry']).toBe('https://cli.example/');
    expect(applied.has('registry')).toBe(false);
    // Only the flag's own key is filtered.
    expect(opts['@s:registry']).toBe('https://s.example/');
    expect(applied.has('@s:registry')).toBe(true);
  });

  it("never mutates npm's cached options", () => {
    // npm reuses the flat object; a publishConfig merged into it would
    // leak into every later use of the same configuration.
    const flat = { registry: 'https://cli.example/' };
    const shared = config(flat);
    publishOptions(shared, '11.0.0', { '@s:registry': 'https://manifest.example/' });
    expect(flat).toEqual({ registry: 'https://cli.example/' });

    const second = publishOptions(shared, '11.0.0', undefined);
    expect(second.opts['@s:registry']).toBeUndefined();
  });

  it('applies nothing without a publishConfig', () => {
    const { opts, applied } = publishOptions(config({ registry: 'https://r/' }), '11.0.0', undefined);
    expect(opts).toEqual({ registry: 'https://r/' });
    expect(applied.size).toBe(0);
  });
});
