// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * A file's integrity in the form npm records it: Subresource Integrity,
 * `sha512-<base64>`, the value a registry reports as `dist.integrity`.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

/** Read in bounded chunks, so the archive's size does not set memory use. */
const CHUNK = 1024 * 1024;

export function sha512Integrity(file: string): string {
  const hash = createHash('sha512');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return `sha512-${hash.digest('base64')}`;
}

/**
 * The filename npm gives a packed archive: `<name>-<version>.tgz`, with a
 * scope's '@' dropped and its '/' made a '-', as libnpmpack names it.
 */
export function tarballFilename(name: string, version: string): string {
  return `${name}-${version}.tgz`.replace(/^@/, '').replace(/\//, '-');
}
