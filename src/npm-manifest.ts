// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Read the manifest `npm publish` reads, with the publishing npm's own
 * reader, so it is normalised exactly as npm normalises it.
 */

import path from 'node:path';

import { loadResolved, NpmInternalsError, resolveInTree, type NpmTree } from './npm-tree.js';

/** What is being published: a project directory or a packed tarball. */
export type ManifestTarget = { readonly dir: string } | { readonly tarball: string };

/** The manifest fields registry resolution reads. */
export interface Manifest {
  readonly name?: unknown;
  readonly publishConfig?: unknown;
}

/** A manifest's fields in the shapes the resolver expects. */
export function manifestFields(manifest: Manifest): {
  packageName: string;
  publishConfig: Record<string, unknown> | undefined;
} {
  return {
    packageName: typeof manifest.name === 'string' ? manifest.name : '',
    publishConfig:
      manifest.publishConfig && typeof manifest.publishConfig === 'object'
        ? (manifest.publishConfig as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Read a manifest the way this npm's `publish` command does.
 *
 * npm publish reads a directory and a tarball by different routes, and the
 * directory route changed in npm 9:
 *
 * | Target    | npm 8                | npm 9 and later                   |
 * | --------- | -------------------- | --------------------------------- |
 * | directory | read-package-json    | @npmcli/package-json `prepare()`  |
 * | tarball   | pacote, fullReadJson | pacote, fullReadJson              |
 *
 * Chosen by capability, as the module npm itself would load, and every
 * module is confined to npm's tree like the rest. None of them runs the
 * package's scripts.
 */
export async function readManifestFrom(
  tree: NpmTree,
  target: ManifestTarget,
  opts: Readonly<Record<string, unknown>>,
): Promise<Manifest> {
  const { req, npmRoot, npmVersion } = tree;
  const load = (spec: string): unknown => {
    const resolved = resolveInTree(req, spec, npmRoot);
    return resolved === undefined ? undefined : loadResolved(req, resolved, spec, npmVersion);
  };

  if ('tarball' in target) {
    const pacote = load('pacote') as
      | { manifest?: (spec: string, o: Record<string, unknown>) => Promise<Manifest> }
      | undefined;
    if (typeof pacote?.manifest !== 'function') {
      throw new NpmInternalsError(`npm ${npmVersion}: cannot load pacote from its own tree.`);
    }
    return pacote.manifest(`file:${path.resolve(target.tarball)}`, { ...opts, fullReadJson: true });
  }

  const packageJson = load('@npmcli/package-json') as
    | { prepare?: (dir: string) => Promise<{ content: Manifest }> }
    | undefined;
  if (typeof packageJson?.prepare === 'function') {
    return (await packageJson.prepare(target.dir)).content;
  }
  const readJson = load('read-package-json') as
    | ((file: string, cb: (err: Error | null, data: Manifest) => void) => void)
    | undefined;
  if (typeof readJson !== 'function') {
    throw new NpmInternalsError(
      `npm ${npmVersion}: neither @npmcli/package-json's prepare() nor ` +
        'read-package-json is available to read the manifest.',
    );
  }
  return new Promise((resolve, reject) => {
    readJson(path.join(target.dir, 'package.json'), (err, data) =>
      err ? reject(err) : resolve(data),
    );
  });
}
