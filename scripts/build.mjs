// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Bundle the action entry points into dist/.
 *
 * esbuild strips the TypeScript types itself, so bundling stays independent
 * of the compiler version. `tsc --noEmit` remains the type checker; nothing
 * in the build depends on it.
 *
 * Output is deterministic, which the check-dist CI job relies on: it
 * rebuilds and fails if the result differs from the committed bundle.
 */

import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

/**
 * The Node.js the *bundle* must run on.
 *
 * Deliberately far below `package.json` engines, which describes the
 * development toolchain (vitest and vite need Node 20.19+). This is a
 * different floor: the bundle runs on whatever `node_version` selected for
 * the publish, so a conservative target widens the range that works, and
 * the publish step's --selftest catches anything older before npm runs.
 */
const NODE_TARGET = 'node18';

const entryPoints = [{ in: 'src/bin/parse-publish-output.ts', outDir: 'dist/parse-publish-output' }];

for (const { in: entry, outDir } of entryPoints) {
  await build({
    entryPoints: [entry],
    outfile: `${outDir}/index.js`,
    bundle: true,
    platform: 'node',
    target: NODE_TARGET,
    format: 'esm',
    minify: true,
    legalComments: 'none',
  });

  // Mark the bundle as ESM in its own right, so it does not depend on the
  // "type" field of a package.json further up the tree.
  writeFileSync(`${outDir}/package.json`, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

  process.stdout.write(`bundled ${entry} -> ${outDir}/index.js\n`);
}
