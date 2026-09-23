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
 * NPM_INTERNALS_DIRS. Every supported npm (MINIMUM_NPM_MAJOR and later)
 * must report its destination, so a dry run that does not is a failure,
 * not a skip: a skip would let unverified behaviour count as supported.
 * npm 7 is below the floor. Its dry run never names a destination, and the
 * resolver must refuse it, which is tested here too.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadNpmInternals, locateNpm, NpmInternalsError } from '../src/npm-internals.js';
import { MINIMUM_NPM_MAJOR } from '../src/registry.js';
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
  // The same boundary for an empty value: before 10.5.2 it masks the flag
  // and npm falls through to its default.
  { name: 'empty publishConfig.registry against --registry', packageName: 'p', publishConfig: { registry: '' }, registryUrl: IN },
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
  // npm rejects the literal manifest string on the scoped key.
  {
    name: 'publishConfig scoped literal undefined',
    packageName: '@s/p',
    publishConfig: { '@s:registry': 'undefined' },
    registryUrl: IN,
  },
  // npm normalises the manifest before selecting: a name padded with
  // whitespace is published as the trimmed, scoped name.
  { name: 'package name with surrounding whitespace', packageName: ' @s/p ', npmrc: [`@s:registry=${SCOPED}`], registryUrl: IN },
  // A tarball publish: the archive's own manifest decides, never the
  // working directory's.
  { name: 'tarball: its scoped manifest decides', packageName: '@s/p', npmrc: [`@s:registry=${SCOPED}`], registryUrl: IN, tarball: true },
  {
    name: 'tarball: its publishConfig decides',
    packageName: '@s/p',
    publishConfig: { '@s:registry': PC },
    registryUrl: IN,
    tarball: true,
  },
  {
    name: 'tarball: a padded name is normalised too',
    packageName: ' @s/p ',
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: IN,
    tarball: true,
  },
  // A non-string publishConfig.registry beside a winning scoped key. npm
  // crashes on it (`output.endsWith is not a function`, from pacote building
  // a fetcher) whenever the key is applied, whichever key wins, and
  // succeeds only where it is filtered: from 10.5.2, when --registry is
  // passed. The resolver must follow both.
  {
    name: 'non-string publishConfig.registry, scoped key wins, with --registry',
    packageName: '@s/p',
    publishConfig: { registry: 42 },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: IN,
  },
  {
    name: 'non-string publishConfig.registry, scoped key wins, no --registry',
    packageName: '@s/p',
    publishConfig: { registry: 42 },
    npmrc: [`@s:registry=${SCOPED}`],
    registryUrl: '',
  },
];

const extra = (process.env['NPM_INTERNALS_DIRS'] ?? '')
  .split(path.delimiter)
  .filter((dir) => dir !== '');
const majorOf = (dir: string): number =>
  Number(loadNpmInternals(dir).npmVersion.split('.')[0]);
const allDirs = [locateNpm(), ...extra];
const npmDirs = allDirs.filter((dir) => majorOf(dir) >= MINIMUM_NPM_MAJOR);
// npm 6 has no @npmcli/config and is refused before this point, by the
// loader, so the below-floor case to prove here is npm 7.
const belowFloor = allDirs.filter((dir) => majorOf(dir) === MINIMUM_NPM_MAJOR - 1);

describe.each(npmDirs)('npm at %s', (npmDir) => {
  it.for(SCENARIOS.map((s) => [s.name, s] as const))('%s', async ([, scenario]) => {
    const truth = groundTruth(npmDir, scenario);
    // A supported npm must report where it publishes, or its behaviour is
    // unverified.
    expect(truth.kind).not.toBe('unreported');
    const resolving = resolveScenario(npmDir, scenario);
    if (truth.kind === 'fails') {
      // npm refuses this publish, so the resolver must refuse it too,
      // rather than report a destination npm never reaches.
      await expect(resolving).rejects.toThrow();
    } else if (truth.kind === 'publishes') {
      await expect(resolving).resolves.toMatchObject({ registry: truth.registry });
    }
  });
});

describe.each(belowFloor)('npm below the supported floor, at %s', (npmDir) => {
  it('is refused rather than resolved on unverified behaviour', async () => {
    await expect(
      resolveScenario(npmDir, { name: 'x', packageName: 'p', registryUrl: IN }),
    ).rejects.toThrow(NpmInternalsError);
  });
});
