// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { describe, expect, it } from 'vitest';
import { renderSummary } from '../src/summary.js';

const metadata = {
  name: '@onap/ui',
  version: '2.0.0',
  filename: 'onap-ui-2.0.0.tgz',
} as const;

describe('renderSummary', () => {
  it('names the registry for a real publish', () => {
    const summary = renderSummary(metadata, {
      dryRun: false,
      registryUrl: 'https://registry.npmjs.org/',
      tag: 'latest',
    });
    expect(summary).toContain('**Mode:** publish');
    expect(summary).toContain('**Registry:** https://registry.npmjs.org/');
    expect(summary).toContain('**Package:** @onap/ui');
    expect(summary).toContain('**Version:** 2.0.0');
    expect(summary).toContain('**Tarball:** onap-ui-2.0.0.tgz');
  });

  // A dry run has no publish destination, so there is no registry to name.
  // That is not a claim about network traffic: npm may still query the
  // registry during a dry run.
  it('omits the registry for a dry run', () => {
    const summary = renderSummary(metadata, {
      dryRun: true,
      registryUrl: 'https://registry.npmjs.org/',
      tag: 'latest',
    });
    expect(summary).toContain('**Mode:** dry run (packs and reports only)');
    expect(summary).not.toContain('**Registry:**');
  });

  it('ends with a newline so appended summaries do not run together', () => {
    const summary = renderSummary(metadata, { dryRun: true, registryUrl: '', tag: 'latest' });
    expect(summary.endsWith('\n')).toBe(true);
  });
});
