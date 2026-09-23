// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Parity: the resolver against `npm publish --dry-run`, on the same npm.
 *
 * The resolver's answer is only worth reporting if it is where npm really
 * publishes, and that differs between npm releases. Before 10.5.2, for
 * instance, publishConfig.registry beats --registry. So precedence is not
 * asserted from a table here; for every scenario and every npm, the
 * expected answer is whatever that npm's dry run reports.
 *
 * Always runs against the npm on PATH. CI adds npm 7 to 11 through
 * NPM_INTERNALS_DIRS. npm 7 has no ground truth, because its dry run
 * never names a destination, so its cases are skipped rather than passed.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadNpmInternals, locateNpm } from '../src/npm-internals.js';
import { groundTruth, type Scenario } from './support/ground-truth.js';
import { resolveScenario } from './support/resolve.js';

const IN = 'https://input.invalid/';
const SCOPED = 'https://scoped.invalid/';
const PC = 'https://pc.invalid/';
const RC = 'https://rc.invalid/';
const OTHER = 'https://other.invalid/';

export const SCENARIOS: readonly Scenario[] = [
  { name: 'unscoped, nothing configured', packageName: 'p', registryUrl: IN },
  { name: 'scoped registry from .npmrc', packageName: '@s/p', npmrc: [`@s:registry=${SCOPED}`], registryUrl: IN },
  { name: 'scoped registry from publishConfig', packageName: '@s/p', publishConfig: { '@s:registry': PC }, registryUrl: IN },
  {
    name: 'publishConfig over .npmrc for the same scope',
    packageName: '@s/p',
    publishConfig: { '@s:registry': PC },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: IN,
  },
  { name: 'unscoped package ignores a scoped key', packageName: 'p', npmrc: [`@s:registry=${SCOPED}`], registryUrl: IN },
  { name: 'configured scope redirects an unscoped package', packageName: 'p', npmrc: ['scope=@s', `@s:registry=${SCOPED}`], registryUrl: IN },
  {
    name: 'publishConfig.scope redirects an unscoped package',
    packageName: 'p',
    publishConfig: { scope: '@s' },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: IN,
  },
  {
    name: 'publishConfig.scope over the configured scope',
    packageName: 'p',
    publishConfig: { scope: '@o' },
    npmrc: ['scope=@s', `@s:registry=${SCOPED}`, `@o:registry=${OTHER}`],
    registryUrl: IN,
  },
  {
    name: 'empty publishConfig.scope masks the configured scope',
    packageName: 'p',
    publishConfig: { scope: '' },
    npmrc: ['scope=@s', `@s:registry=${SCOPED}`],
    registryUrl: IN,
  },
  {
    name: 'package scope over the configured scope',
    packageName: '@s/p',
    npmrc: ['scope=@o', `@s:registry=${SCOPED}`, `@o:registry=${OTHER}`],
    registryUrl: IN,
  },
  {
    name: 'configured scope when the package scope has no registry',
    packageName: '@s/p',
    npmrc: ['scope=@o', `@o:registry=${OTHER}`],
    registryUrl: IN,
  },
  // The row that differs by release: npm filters CLI keys only from 10.5.2.
  { name: 'publishConfig.registry against --registry', packageName: 'p', publishConfig: { registry: PC }, registryUrl: IN },
  { name: 'publishConfig.registry with no --registry', packageName: 'p', publishConfig: { registry: PC }, registryUrl: '' },
  {
    name: 'scoped key over publishConfig.registry',
    packageName: '@s/p',
    publishConfig: { registry: PC },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: '',
  },
  {
    name: 'empty scoped publishConfig masks .npmrc',
    packageName: '@s/p',
    publishConfig: { '@s:registry': '' },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: IN,
  },
  {
    name: 'masked scope lets a later candidate decide',
    packageName: '@s/p',
    publishConfig: { '@s:registry': '' },
    npmrc: ['scope=@o', `@s:registry=${SCOPED}`, `@o:registry=${OTHER}`],
    registryUrl: IN,
  },
  { name: 'no --registry: the configured registry', packageName: 'p', npmrc: [`registry=${RC}`], registryUrl: '' },
  { name: "no --registry: npm's default", packageName: 'p', registryUrl: '' },
  {
    name: 'empty publishConfig.registry masks the configured one',
    packageName: 'p',
    publishConfig: { registry: '' },
    npmrc: [`registry=${RC}`],
    registryUrl: '',
  },
  { name: 'configured scope without its @', packageName: 'p', npmrc: ['scope=s', `@s:registry=${SCOPED}`], registryUrl: IN },
  {
    name: 'configured scope containing whitespace',
    packageName: 'p',
    npmrc: ['scope=@a b', '@a b:registry=https://space.invalid/'],
    registryUrl: IN,
  },
  // Literals that `npm config get` printed ambiguously. npm's own
  // configuration has no such ambiguity, and these pin its behaviour.
  { name: '.npmrc @s:registry=undefined', packageName: '@s/p', npmrc: ['@s:registry=undefined'], registryUrl: IN },
  { name: '.npmrc @s:registry=null', packageName: '@s/p', npmrc: ['@s:registry=null'], registryUrl: IN },
  { name: '.npmrc @s:registry of spaces', packageName: '@s/p', npmrc: ['@s:registry=   '], registryUrl: IN },
  { name: '.npmrc @s:registry empty', packageName: '@s/p', npmrc: ['@s:registry='], registryUrl: IN },
  { name: '.npmrc scope=undefined', packageName: 'p', npmrc: ['scope=undefined', `@undefined:registry=${SCOPED}`], registryUrl: IN },
  // npm 8 honours this as a scope; later releases discard it.
  { name: '.npmrc scope=null', packageName: 'p', npmrc: ['scope=null', `@null:registry=${SCOPED}`], registryUrl: IN },
  // npm 9 and later refuse these; npm 8 drops them and uses its default.
  { name: '.npmrc registry=undefined, no --registry', packageName: 'p', npmrc: ['registry=undefined'], registryUrl: '' },
  { name: '.npmrc registry=null, no --registry', packageName: 'p', npmrc: ['registry=null'], registryUrl: '' },
  // npm selects a literal manifest string and then fails on it.
  {
    name: 'publishConfig scoped literal undefined',
    packageName: '@s/p',
    publishConfig: { '@s:registry': 'undefined' },
    registryUrl: IN,
  },
];

const extra = (process.env['NPM_INTERNALS_DIRS'] ?? '')
  .split(path.delimiter)
  .filter((dir) => dir !== '');
const npmDirs = [locateNpm(), ...extra].filter(
  (dir) => Number(loadNpmInternals(dir).npmVersion.split('.')[0]) >= 7,
);

describe.each(npmDirs)('npm at %s', (npmDir) => {
  it.for(SCENARIOS.map((s) => [s.name, s] as const))('%s', async ([, scenario], context) => {
    const truth = groundTruth(npmDir, scenario);
    if (truth.kind === 'unreported') {
      context.skip();
      return;
    }
    const resolving = resolveScenario(npmDir, scenario);
    if (truth.kind === 'fails') {
      // npm refuses this publish, so the resolver must refuse it too,
      // rather than report a destination npm never reaches.
      await expect(resolving).rejects.toThrow();
    } else {
      await expect(resolving).resolves.toMatchObject({ registry: truth.registry });
    }
  });
});
