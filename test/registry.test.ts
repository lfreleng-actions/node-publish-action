// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * The resolver's labelling, cross-check and validation, through real npm.
 *
 * Every case loads the npm on PATH's own configuration and pickRegistry.
 * Values reach npm as configuration: an .npmrc where one can hold them, and
 * an npm_config_* variable where it cannot (a newline, a NUL).
 *
 * Only behaviour that is the same on every supported npm is asserted here.
 * Anything that varies by release -- publishConfig.registry against
 * --registry, or `registry=undefined` in an .npmrc -- is judged per npm
 * against `npm publish --dry-run`, in registry.parity.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadNpmInternals, NpmInternalsError } from '../src/npm-internals.js';
import { publishFlags } from '../src/publish-options.js';
import { RegistryError, resolveEffectiveRegistry, scopeOf } from '../src/registry.js';
import { isolatedEnv, makeProject, type Scenario } from './support/ground-truth.js';
import { resolveScenario } from './support/resolve.js';

const INPUT = 'https://nexus3.example.org/repository/npm.release/';
const SCOPED = 'https://registry.npmjs.org/';

const internals = loadNpmInternals();
const major = Number(internals.npmVersion.split('.')[0]);

interface Overrides {
  packageName?: string;
  publishConfig?: Record<string, unknown>;
  /** Lines for the project .npmrc. */
  npmrc?: string[];
  /** Shorthand: '@onap:registry' as configuration, via the environment. */
  scopedRegistry?: string;
  env?: Record<string, string>;
  registryUrl?: string;
}

function resolve(overrides: Overrides = {}) {
  const { scopedRegistry, env, ...rest } = overrides;
  const scenario: Scenario = {
    name: 'unit',
    packageName: '@onap/ui-common',
    registryUrl: INPUT,
    ...rest,
    env: {
      ...(scopedRegistry === undefined ? {} : { 'npm_config_@onap:registry': scopedRegistry }),
      ...env,
    },
  };
  return resolveScenario(internals.npmDir, scenario);
}

/** The message a rejected resolution carries. */
async function messageOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (cause) {
    return (cause as Error).message;
  }
  throw new Error('expected the resolution to be refused');
}

describe('scopeOf', () => {
  it('reads the scope from a scoped name', () => {
    expect(scopeOf('@onap/ui-common')).toBe('@onap');
  });

  it('returns null for an unscoped name', () => {
    expect(scopeOf('ui-common')).toBeNull();
  });

  it.each(['@onap', '@/thing', 'onap/ui-common'])('treats %s as unscoped', (name) => {
    // npm's spec parsing accepts none of these as scoped, and treating
    // any of them as scoped would look up a nonsense config key and
    // silently miss a real override.
    expect(scopeOf(name)).toBeNull();
  });
});

describe('resolveEffectiveRegistry', () => {
  it('falls back to registry_url when nothing overrides', async () => {
    await expect(resolve()).resolves.toMatchObject({
      registry: INPUT,
      source: 'input',
      overridden: false,
    });
  });

  it('reports the consulted scopes even when nothing overrides', async () => {
    // The publish and verification commands pin these keys, so a later
    // publishConfig -- one written by prepublishOnly -- cannot move the
    // destination after resolution.
    expect((await resolve()).scopes).toEqual(['@onap']);
  });

  it('prefers a scoped registry from .npmrc over registry_url', async () => {
    await expect(resolve({ npmrc: [`@onap:registry=${SCOPED}`] })).resolves.toMatchObject({
      registry: SCOPED,
      source: 'npm-config-scoped',
      scope: '@onap',
      overridden: true,
    });
  });

  it('attributes a scoped registry from the environment to npm config', async () => {
    await expect(resolve({ scopedRegistry: SCOPED })).resolves.toMatchObject({
      registry: SCOPED,
      source: 'npm-config-scoped',
    });
  });

  it('prefers a scoped registry from publishConfig over registry_url', async () => {
    await expect(resolve({ publishConfig: { '@onap:registry': SCOPED } })).resolves.toMatchObject({
      registry: SCOPED,
      source: 'publishConfig-scoped',
    });
  });

  it('prefers publishConfig over .npmrc for the same scope', async () => {
    const result = await resolve({
      publishConfig: { '@onap:registry': SCOPED },
      npmrc: ['@onap:registry=https://registry.example.com/'],
    });
    expect(result).toMatchObject({ registry: SCOPED, source: 'publishConfig-scoped' });
  });

  it('ignores a scoped setting for an unscoped package', async () => {
    await expect(
      resolve({ packageName: 'ui-common', npmrc: [`@onap:registry=${SCOPED}`] }),
    ).resolves.toMatchObject({ registry: INPUT, source: 'input' });
  });

  it('reports overridden false when an override equals registry_url', async () => {
    expect((await resolve({ npmrc: [`@onap:registry=${INPUT}`] })).overridden).toBe(false);
  });

  describe("pickRegistry's configured-scope fallback", () => {
    it('applies a configured scope to an unscoped package', async () => {
      const result = await resolve({
        packageName: 'ui-common',
        npmrc: ['scope=@onap', `@onap:registry=${SCOPED}`],
      });
      expect(result).toMatchObject({ registry: SCOPED, source: 'npm-config-scoped', scope: '@onap' });
      expect(result.scopes).toEqual(['@onap']);
    });

    it('honours publishConfig.scope for an unscoped package', async () => {
      const result = await resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '@other', '@other:registry': SCOPED },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
    });

    it('prefers publishConfig.scope over the configured scope', async () => {
      const result = await resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '@other' },
        npmrc: ['scope=@onap', '@onap:registry=https://wrong.example.org/', `@other:registry=${SCOPED}`],
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
    });

    it('lets an empty publishConfig.scope mask the configured scope', async () => {
      const result = await resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '' },
        npmrc: ['scope=@onap', `@onap:registry=${SCOPED}`],
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
      expect(result.scopes).toEqual([]);
    });

    it('keeps a scope containing whitespace intact', async () => {
      // npm accepts 'scope=@a b' and publishes to '@a b:registry', so
      // the scope has to survive as one name. The consumers serialise
      // this list one per line for the same reason: a space-separated
      // form word-splits it and pins two keys npm never consults.
      const result = await resolve({
        packageName: 'ui-common',
        npmrc: ['scope=@a b', `@a b:registry=${SCOPED}`],
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@a b' });
      expect(result.scopes).toEqual(['@a b']);
    });

    it('accepts a configured scope without its leading @', async () => {
      const result = await resolve({
        packageName: 'ui-common',
        npmrc: ['scope=onap', `@onap:registry=${SCOPED}`],
      });
      expect(result.registry).toBe(SCOPED);
    });

    it("prefers the package's own scope over the configured one", async () => {
      const result = await resolve({
        npmrc: ['scope=@other', `@onap:registry=${SCOPED}`, '@other:registry=https://wrong.example.org/'],
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@onap' });
      expect(result.scopes).toEqual(['@onap', '@other']);
    });

    it('falls through to the configured scope when the package scope has none', async () => {
      const result = await resolve({ npmrc: ['scope=@other', `@other:registry=${SCOPED}`] });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
      // Both scopes are reported, not only the winner. The package's own
      // scope is consulted first by pickRegistry, so leaving it unpinned
      // lets a prepublishOnly script claim it -- and npm view, which does
      // not load publishConfig, would see a .npmrc key the manifest had
      // masked.
      expect(result.scopes).toEqual(['@onap', '@other']);
    });
  });

  describe('publishConfig.registry', () => {
    it('decides when no registry_url is passed at all', async () => {
      // A dry run may pass no --registry, and nothing is then filtered.
      // (Against --registry the winner depends on the npm release; see
      // the parity tests.)
      const result = await resolve({
        packageName: 'ui-common',
        publishConfig: { registry: SCOPED },
        registryUrl: '',
      });
      expect(result).toMatchObject({ registry: SCOPED, source: 'publishConfig-registry' });
    });

    it('loses to a scoped setting even with no registry_url', async () => {
      const result = await resolve({
        publishConfig: { registry: 'https://wrong.example.org/', '@onap:registry': SCOPED },
        registryUrl: '',
      });
      expect(result.registry).toBe(SCOPED);
    });
  });

  describe('a present but empty publishConfig key', () => {
    it('masks the .npmrc value rather than deferring to it', async () => {
      const result = await resolve({
        publishConfig: { '@onap:registry': '' },
        npmrc: ['@onap:registry=https://npmrc.example.org/'],
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
    });

    it('still allows a later candidate scope to decide', async () => {
      const result = await resolve({
        publishConfig: { '@onap:registry': '' },
        npmrc: ['scope=@other', '@onap:registry=https://npmrc.example.org/', `@other:registry=${SCOPED}`],
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
      expect(result.scopes).toEqual(['@onap', '@other']);
    });

    it.each(['undefined', 'null', '   '])(
      'selects a literal %o from the manifest rather than ignoring it',
      async (literal) => {
        // npm copies the manifest string into its options verbatim; only
        // '' is falsey there. It selects the literal and then fails, so
        // the resolver must refuse rather than pin a fallback.
        await expect(resolve({ publishConfig: { '@onap:registry': literal } })).rejects.toThrow(
          RegistryError,
        );
      },
    );

    it('rejects a truthy non-string, as npm does', async () => {
      await expect(
        resolve({ publishConfig: { '@onap:registry': 42 }, scopedRegistry: SCOPED }),
      ).rejects.toThrow(RegistryError);
    });

    it('names the key and type, never the value', async () => {
      const message = await messageOf(
        resolve({ publishConfig: { '@onap:registry': { token: 'sup3rsecret' } } }),
      );
      expect(message).toContain('@onap:registry');
      expect(message).toContain('object');
      expect(message).not.toContain('sup3rsecret');
    });

    it('reports an array as an array', async () => {
      await expect(resolve({ publishConfig: { '@onap:registry': ['x'] } })).rejects.toThrow(/array/);
    });

    it('refuses a non-string publishConfig.scope before npm dereferences it', async () => {
      await expect(resolve({ publishConfig: { scope: 42 } })).rejects.toThrow(/\(scope\) is a number/);
    });

    it('masks with a falsey non-string, then falls through', async () => {
      const result = await resolve({
        publishConfig: { '@onap:registry': null },
        scopedRegistry: SCOPED,
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
    });
  });

  describe('with no registry_url, as a dry run may have', () => {
    it('reports the fallback as an override, so the notice fires', async () => {
      const result = await resolve({
        registryUrl: '',
        npmrc: ['registry=https://configured.example.org/'],
      });
      expect(result.overridden).toBe(true);
    });

    it("falls back to npm's configured registry", async () => {
      // npm does not publish to "no registry": with no --registry it
      // uses its own configured value. Reporting '' would name no
      // destination while npm quietly contacted one.
      await expect(
        resolve({ registryUrl: '', npmrc: ['registry=https://configured.example.org/'] }),
      ).resolves.toMatchObject({
        registry: 'https://configured.example.org/',
        source: 'npm-config-registry',
      });
    });

    it("falls back to npm's built-in default when nothing is configured", async () => {
      await expect(resolve({ registryUrl: '' })).resolves.toMatchObject({
        registry: 'https://registry.npmjs.org/',
        source: 'npm-config-registry',
      });
    });

    it('lets an empty publishConfig.registry mask the configured value', async () => {
      // The empty entry supplies no URL of its own, so npm's default
      // applies -- and the manifest is not reported as the source.
      const result = await resolve({
        packageName: 'ui-common',
        publishConfig: { registry: '' },
        registryUrl: '',
        npmrc: ['registry=https://configured.example.org/'],
      });
      expect(result).toMatchObject({
        registry: 'https://registry.npmjs.org/',
        source: 'npm-config-registry',
      });
    });
  });

  describe('refuses an unusable registry', () => {
    it.each([
      ['http', 'http://registry.example.org/'],
      ['uppercase scheme', 'HTTPS://registry.example.org/'],
      ['an empty authority', 'https:///npm/'],
      ['a bare scheme', 'https://'],
      ['not a URL', 'registry.example.org'],
    ])('rejects a scoped override over %s', async (_label, value) => {
      await expect(resolve({ scopedRegistry: value })).rejects.toThrow(RegistryError);
    });

    it('rejects an empty authority rather than adopting the normalised host', async () => {
      await expect(resolve({ scopedRegistry: 'https:///npm/' })).rejects.toThrow(/has no host/);
    });

    it.each([
      ['lowercase', 'https:///user:sup3rsecret@registry.example/'],
      ['uppercase', 'HTTPS:///user:sup3rsecret@registry.example/'],
      ['mixed case', 'HttpS:///user:sup3rsecret@registry.example/'],
    ])('never echoes an empty-authority value (%s scheme)', async (_label, value) => {
      const message = await messageOf(resolve({ scopedRegistry: value }));
      expect(message).toMatch(/has no host/);
      expect(message).not.toContain('sup3rsecret');
    });

    it.each([
      ['a newline', 'https://host/\n## forged'],
      ['a carriage return', 'https://host/\r## forged'],
      ['a NUL', 'https://host/\u0000truncated'],
      ['an embedded TAB', 'https://host/\u0009mid/'],
      ['an ESC', 'https://host/\u001b[31mred'],
      ['a DEL', 'https://host/\u007fmid/'],
      ['a vertical tab', 'https://host/\u000bmid/'],
    ])('rejects %s, which URL parsing would strip or normalise', async (_label, value) => {
      await expect(resolve({ scopedRegistry: value })).rejects.toThrow(/control character/);
    });

    it('names the control character by code point without echoing it', async () => {
      const message = await messageOf(resolve({ scopedRegistry: 'https://host/\u001b[31m' }));
      expect(message).toContain('U+001B');
      expect(message).not.toContain('\u001b');
    });

    it('names the source in the error', async () => {
      await expect(
        resolve({ publishConfig: { '@onap:registry': 'http://x.example/' } }),
      ).rejects.toThrow(/publishConfig/);
    });

    it('rejects a registry embedding credentials', async () => {
      await expect(
        resolve({ scopedRegistry: 'https://user:token@registry.example.org/' }),
      ).rejects.toThrow(/embeds credentials/);
    });

    it('rejects a username with no password', async () => {
      await expect(resolve({ scopedRegistry: 'https://user@registry.example.org/' })).rejects.toThrow(
        /embeds credentials/,
      );
    });

    it('never echoes the credentials it rejects', async () => {
      const message = await messageOf(
        resolve({ scopedRegistry: 'https://user:sup3rsecret@registry.example.org/' }),
      );
      expect(message).not.toContain('sup3rsecret');
      expect(message).not.toContain('user:');
    });

    it('redacts credentials when rejecting for another reason', async () => {
      const message = await messageOf(
        resolve({ scopedRegistry: 'http://user:sup3rsecret@registry.example.org/' }),
      );
      expect(message).not.toContain('sup3rsecret');
      expect(message).toContain('***@registry.example.org/');
    });

    it('withholds a credential-bearing value that has no authority', async () => {
      const message = await messageOf(
        resolve({ scopedRegistry: 'https:user:sup3rsecret@registry.example/' }),
      );
      expect(message).not.toContain('sup3rsecret');
      expect(message).toContain('withheld');
    });

    it.each([
      ['a query string', 'https://registry.example/?token=sup3rsecret'],
      ['a fragment', 'https://registry.example/#sup3rsecret'],
      ['both', 'https://registry.example/?a=sup3rsecret#b'],
    ])('rejects %s without echoing it', async (_label, value) => {
      const message = await messageOf(resolve({ scopedRegistry: value }));
      expect(message).toMatch(/query string|fragment/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('refuses a query string before the protocol complaint', async () => {
      const message = await messageOf(
        resolve({ scopedRegistry: 'http://registry.example/?token=sup3rsecret' }),
      );
      expect(message).toMatch(/query string/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('never echoes a value that fails to parse', async () => {
      const message = await messageOf(resolve({ scopedRegistry: 'https://?token=sup3rsecret' }));
      expect(message).toMatch(/not a URL/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('requires a trailing slash, matching registry_url and the .npmrc action', async () => {
      await expect(
        resolve({ scopedRegistry: 'https://registry.example.org/repository/npm' }),
      ).rejects.toThrow(/must end with "\/"/);
    });

    it('rejects an unsafe configured registry on the no-input path', async () => {
      await expect(
        resolve({ registryUrl: '', npmrc: ['registry=http://configured.example/'] }),
      ).rejects.toThrow(RegistryError);
    });

    it('leaves a credential-free value intact in the message', async () => {
      await expect(resolve({ scopedRegistry: 'http://registry.example.org/' })).rejects.toThrow(
        /http:\/\/registry\.example\.org\//,
      );
    });
  });

  describe("npm's own refusals", () => {
    it.runIf(major >= 9)(
      'refuses configuration npm rejects, naming no value',
      async () => {
        // npm 9 and later refuse an unparsable registry outright. npm's
        // own error carries the value verbatim, credentials included, so
        // it must not be what reaches the log.
        const message = await messageOf(
          resolve({
            registryUrl: '',
            env: { npm_config_registry: 'https://user:sup3rsecret@bad host/' },
          }),
        );
        expect(message).toMatch(/rejects its configuration \(ERR_INVALID_URL\)/);
        expect(message).not.toContain('sup3rsecret');
      },
    );

    it('fails closed when attribution disagrees with npm', async () => {
      // Guards the one place this module restates pickRegistry's order: if
      // npm ever chose differently, the source would be mislabelled.
      const project = makeProject({ name: 'x', packageName: '@onap/ui-common', registryUrl: INPUT });
      const home = mkdtempSync(path.join(tmpdir(), 'registry-test-home-'));
      try {
        const config = await internals.loadConfig!({
          cwd: project.dir,
          flags: publishFlags(INPUT),
          env: isolatedEnv(home),
        });
        expect(() =>
          resolveEffectiveRegistry({
            packageName: '@onap/ui-common',
            publishConfig: undefined,
            registryUrl: INPUT,
            config,
            npmVersion: internals.npmVersion,
            pickRegistry: () => 'https://elsewhere.example/',
          }),
        ).toThrow(NpmInternalsError);
      } finally {
        project.remove();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
