// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import type { PublishMetadata } from './publish-metadata.js';

export interface SummaryOptions {
  readonly dryRun: boolean;
  readonly registryUrl: string;
  readonly tag: string;
}

/** Build the job summary for a completed publish. */
export function renderSummary(metadata: PublishMetadata, options: SummaryOptions): string {
  const lines = ['## 🚀 Node.js Package Publish', ''];

  if (options.dryRun) {
    lines.push('**Mode:** dry run (packs and reports only)');
  } else {
    // Named only for a real publish, because a dry run has no publish
    // destination. Not because it stays off the network: npm may still
    // query the registry during a dry run.
    lines.push('**Mode:** publish', `**Registry:** ${options.registryUrl}`);
  }

  lines.push(
    `**Package:** ${metadata.name}`,
    `**Version:** ${metadata.version}`,
    `**Tag:** ${options.tag}`,
    `**Tarball:** ${metadata.filename}`,
  );

  return `${lines.join('\n')}\n`;
}
