// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/** Where the effective registry came from. Reported, not merely internal. */
export type RegistrySource =
  | 'publishConfig-scoped'
  | 'npm-config-scoped'
  | 'publishConfig-registry'
  | 'npm-config-registry'
  | 'input';
