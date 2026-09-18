// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

import { describe, expect, it } from 'vitest';

import { RegistryError, resolveEffectiveRegistry, scopeOf } from '../src/registry.js';

const INPUT = 'https://nexus3.example.org/repository/npm.release/';
const SCOPED = 'https://registry.npmjs.org/';

interface Overrides {
  packageName?: string;
  publishConfig?: Record<string, unknown>;
  /** Shorthand for the '@onap:registry' config key. */
  scopedRegistry?: string;
  npmConfigScopedRegistry?: Record<string, string | undefined>;
  npmConfigScope?: string;
  npmConfigRegistry?: string;
  registryUrl?: string;
}

function resolve(overrides: Overrides = {}) {
  const { scopedRegistry, ...rest } = overrides;
  return resolveEffectiveRegistry({
    packageName: '@onap/ui-common',
    publishConfig: undefined,
    npmConfigScopedRegistry:
      rest.npmConfigScopedRegistry ??
      (scopedRegistry === undefined ? {} : { '@onap:registry': scopedRegistry }),
    npmConfigScope: undefined,
    npmConfigRegistry: undefined,
    registryUrl: INPUT,
    ...rest,
  });
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
  it('falls back to registry_url when nothing overrides', () => {
    expect(resolve()).toMatchObject({ registry: INPUT, source: 'input', overridden: false });
  });

  it('reports the consulted scopes even when nothing overrides', () => {
    // The publish and verification commands pin these keys, so a later
    // publishConfig -- one written by prepublishOnly -- cannot move the
    // destination after resolution.
    expect(resolve().scopes).toEqual(['@onap']);
  });

  it('prefers a scoped registry from .npmrc over registry_url', () => {
    expect(resolve({ scopedRegistry: SCOPED })).toMatchObject({
      registry: SCOPED,
      source: 'npm-config-scoped',
      scope: '@onap',
      overridden: true,
    });
  });

  it('prefers a scoped registry from publishConfig over registry_url', () => {
    expect(resolve({ publishConfig: { '@onap:registry': SCOPED } })).toMatchObject({
      registry: SCOPED,
      source: 'publishConfig-scoped',
    });
  });

  it('prefers publishConfig over .npmrc for the same scope', () => {
    // npm flattens publishConfig over the resolved options, so it wins.
    // Verified against npm 11.19.0.
    const result = resolve({
      publishConfig: { '@onap:registry': SCOPED },
      scopedRegistry: 'https://registry.example.com/',
    });
    expect(result).toMatchObject({ registry: SCOPED, source: 'publishConfig-scoped' });
  });

  it('ignores a scoped setting for an unscoped package', () => {
    expect(resolve({ packageName: 'ui-common', scopedRegistry: SCOPED })).toMatchObject({
      registry: INPUT,
      source: 'input',
    });
  });

  describe("pickRegistry's configured-scope fallback", () => {
    it('applies a configured scope to an unscoped package', () => {
      // pickRegistry consults opts.scope after the spec's own scope, so
      // 'scope=@onap' plus '@onap:registry' redirects a package that is
      // not itself scoped. Verified against npm 11.19.0.
      const result = resolve({
        packageName: 'ui-common',
        npmConfigScope: '@onap',
        scopedRegistry: SCOPED,
      });
      expect(result).toMatchObject({ registry: SCOPED, source: 'npm-config-scoped', scope: '@onap' });
      expect(result.scopes).toEqual(['@onap']);
    });

    // What npm itself does with each rendering, measured on npm 11.19.0
    // by publishing against an '@<scope>:registry' entry for each. The
    // resolver has to agree, or it pins keys npm never consults -- or
    // misses ones it does.
    it.each([
      ['@undefined', '@undefined'],
      ['@NULL', '@NULL'],
      ['@onap', '@onap'],
    ])('honours a configured scope of %o, as npm does', (configured, expected) => {
      const result = resolve({
        packageName: 'ui-common',
        npmConfigScope: configured,
        npmConfigScopedRegistry: { [`${expected}:registry`]: SCOPED },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: expected });
    });

    it.each(['null', 'undefined', '', '   '])(
      'discards a configured scope of %o, as npm does',
      (configured) => {
        // npm prefixes '@' to anything it honours, so these unprefixed
        // renderings are the ones it discards itself. 'scope=null' really
        // does publish to --registry rather than '@null:registry'.
        const result = resolve({
          packageName: 'ui-common',
          npmConfigScope: configured,
          npmConfigScopedRegistry: { '@null:registry': SCOPED, '@undefined:registry': SCOPED },
        });
        expect(result).toMatchObject({ registry: INPUT, source: 'input' });
      },
    );

    it('honours publishConfig.scope for an unscoped package', () => {
      // npm flattens publishConfig.scope into opts.scope before
      // pickRegistry reads it. Measured on npm 11.19.0: an unscoped
      // package with publishConfig.scope '@other' published to
      // '@other:registry'.
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '@other', '@other:registry': SCOPED },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
    });

    it('prefers publishConfig.scope over the configured scope', () => {
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '@other' },
        npmConfigScope: '@onap',
        npmConfigScopedRegistry: {
          '@onap:registry': 'https://wrong.example.org/',
          '@other:registry': SCOPED,
        },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
    });

    it.each(['undefined', 'null'])(
      'treats a publishConfig.scope of %o as a real scope, unlike npm config output',
      (literal) => {
        // The manifest is not `npm config get` stdout, so its sentinels do
        // not apply: npm flattens the string through and consults
        // '@undefined:registry'. Discarding it would pin a different key.
        const result = resolve({
          packageName: 'ui-common',
          publishConfig: { scope: literal },
          npmConfigScopedRegistry: { [`@${literal}:registry`]: SCOPED },
        });
        expect(result).toMatchObject({ registry: SCOPED, scope: `@${literal}` });
      },
    );

    it('lets an empty publishConfig.scope mask the configured scope', () => {
      // Measured: publishConfig.scope "" beside .npmrc scope=@onap fell
      // through to --registry rather than consulting @onap:registry.
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { scope: '' },
        npmConfigScope: '@onap',
        npmConfigScopedRegistry: { '@onap:registry': SCOPED },
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
      expect(result.scopes).toEqual([]);
    });

    it('keeps a scope containing whitespace intact', () => {
      // npm accepts 'scope=@a b' and publishes to '@a b:registry', so
      // the scope has to survive as one name. The consumers serialise
      // this list one per line for the same reason: a space-separated
      // form word-splits it and pins two keys npm never consults.
      const result = resolve({
        packageName: 'ui-common',
        npmConfigScope: '@a b',
        npmConfigScopedRegistry: { '@a b:registry': SCOPED },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@a b' });
      expect(result.scopes).toEqual(['@a b']);
    });

    it('accepts a configured scope without its leading @', () => {
      // npm accepts 'scope=onap'; treating it literally would look up
      // 'onap:registry' and miss the setting.
      const result = resolve({
        packageName: 'ui-common',
        npmConfigScope: 'onap',
        scopedRegistry: SCOPED,
      });
      expect(result.registry).toBe(SCOPED);
    });

    it("prefers the package's own scope over the configured one", () => {
      const result = resolve({
        npmConfigScope: '@other',
        npmConfigScopedRegistry: {
          '@onap:registry': SCOPED,
          '@other:registry': 'https://wrong.example.org/',
        },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@onap' });
      expect(result.scopes).toEqual(['@onap', '@other']);
    });

    it('falls through to the configured scope when the package scope has none', () => {
      const result = resolve({
        npmConfigScope: '@other',
        npmConfigScopedRegistry: { '@other:registry': SCOPED },
      });
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
    it('loses to registry_url, because npm filters CLI-supplied keys', () => {
      // Verified against npm 11.19.0: with --registry on the command
      // line, publishConfig.registry is filtered out entirely. Selecting
      // it here would actively redirect a publish npm would have sent to
      // the caller's registry.
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { registry: SCOPED },
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
    });

    it('decides when no registry_url is passed at all', () => {
      // A dry run may pass no --registry, and nothing is then filtered.
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { registry: SCOPED },
        registryUrl: '',
      });
      expect(result).toMatchObject({ registry: SCOPED, source: 'publishConfig-registry' });
    });

    it('loses to a scoped setting even with no registry_url', () => {
      const result = resolve({
        publishConfig: { registry: 'https://wrong.example.org/', '@onap:registry': SCOPED },
        registryUrl: '',
      });
      expect(result.registry).toBe(SCOPED);
    });
  });

  describe('a present but empty publishConfig key', () => {
    it('masks the .npmrc value rather than deferring to it', () => {
      // npm flattens the empty string over the resolved options, so
      // opts['@onap:registry'] is falsy and pickRegistry moves past it.
      // Ignoring the manifest key instead would select the .npmrc
      // registry and rewrite --registry to the wrong destination.
      const result = resolve({
        publishConfig: { '@onap:registry': '' },
        scopedRegistry: 'https://npmrc.example.org/',
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
    });

    it('still allows a later candidate scope to decide', () => {
      const result = resolve({
        publishConfig: { '@onap:registry': '' },
        npmConfigScope: '@other',
        npmConfigScopedRegistry: {
          '@onap:registry': 'https://npmrc.example.org/',
          '@other:registry': SCOPED,
        },
      });
      expect(result).toMatchObject({ registry: SCOPED, scope: '@other' });
      expect(result.scopes).toEqual(['@onap', '@other']);
    });

    it.each(['undefined', 'null', '   '])(
      'selects a literal %o from the manifest rather than ignoring it',
      (literal) => {
        // npm copies the manifest string into flatOptions verbatim; only
        // '' is falsey there. Treating these as empty would pin the
        // fallback registry and publish where npm would have failed.
        expect(() =>
          resolve({ publishConfig: { '@onap:registry': literal } }),
        ).toThrow(RegistryError);
      },
    );

    it('rejects a truthy non-string, as npm does', () => {
      // npm's flatten copies the entry across without checking its
      // type, so truthiness decides. Measured on npm 11.19.0: a scoped
      // entry of 42 makes npm reject the publish outright. Falling back
      // to the .npmrc URL here would publish where npm refused.
      expect(() =>
        resolve({ publishConfig: { '@onap:registry': 42 }, scopedRegistry: SCOPED }),
      ).toThrow(RegistryError);
    });

    it('names the key and type, never the value', () => {
      // An object would otherwise be serialised into the message,
      // publishing whatever manifest fields it carried to the job log.
      let message = '';
      try {
        resolve({ publishConfig: { '@onap:registry': { token: 'sup3rsecret' } } });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toContain('@onap:registry');
      expect(message).toContain('object');
      expect(message).not.toContain('sup3rsecret');
    });

    it('reports an array as an array', () => {
      expect(() => resolve({ publishConfig: { '@onap:registry': ['x'] } })).toThrow(/array/);
    });

    it('masks with a falsey non-string, then falls through', () => {
      // A falsey entry is copied across too, where it is falsey for
      // pickRegistry -- so it hides the .npmrc key and the search moves
      // on rather than selecting it.
      const result = resolve({
        publishConfig: { '@onap:registry': null },
        scopedRegistry: SCOPED,
      });
      expect(result).toMatchObject({ registry: INPUT, source: 'input' });
    });
  });

  it.each(['undefined', 'null', '', '   '])('treats %o from npm config as unset', (value) => {
    // `npm config get` prints 'undefined' for a missing key rather than
    // writing nothing, so an unguarded read publishes to a registry
    // literally named 'undefined'.
    expect(resolve({ scopedRegistry: value })).toMatchObject({ registry: INPUT, source: 'input' });
  });

  it('trims surrounding whitespace from a config value', () => {
    expect(resolve({ scopedRegistry: `  ${SCOPED}\n` }).registry).toBe(SCOPED);
  });

  it('reports overridden false when an override equals registry_url', () => {
    expect(resolve({ scopedRegistry: INPUT }).overridden).toBe(false);
  });

  describe('with no registry_url, as a dry run may have', () => {
    it('reports the fallback as an override, so the notice fires', () => {
      // The caller passed no registry and npm chose one anyway; that is
      // precisely what they need telling.
      const result = resolve({
        registryUrl: '',
        npmConfigRegistry: 'https://configured.example.org/',
      });
      expect(result.overridden).toBe(true);
    });

    it("falls back to npm's configured registry", () => {
      // npm does not publish to "no registry": with no --registry it
      // uses its own configured value. Reporting '' would name no
      // destination while npm quietly contacted one.
      const result = resolve({
        registryUrl: '',
        npmConfigRegistry: 'https://configured.example.org/',
      });
      expect(result).toMatchObject({
        registry: 'https://configured.example.org/',
        source: 'npm-config-registry',
      });
    });

    it("falls back to npm's built-in default when nothing is configured", () => {
      expect(resolve({ registryUrl: '' })).toMatchObject({
        registry: 'https://registry.npmjs.org/',
        source: 'npm-config-registry',
      });
    });

    it('lets an empty publishConfig.registry mask the configured value', () => {
      // Measured on npm 11.19.0: the empty manifest entry masks the
      // configured registry and npm's built-in default applies.
      const result = resolve({
        packageName: 'ui-common',
        publishConfig: { registry: '' },
        registryUrl: '',
        npmConfigRegistry: 'https://configured.example.org/',
      });
      expect(result.registry).toBe('https://registry.npmjs.org/');
    });
  });

  describe('refuses an unusable registry', () => {
    it.each([
      ['http', 'http://registry.example.org/'],
      ['uppercase scheme', 'HTTPS://registry.example.org/'],
      ['an empty authority', 'https:///npm/'],
      ['a bare scheme', 'https://'],
      ['not a URL', 'registry.example.org'],
    ])('rejects a scoped override over %s', (_label, value) => {
      expect(() => resolve({ scopedRegistry: value })).toThrow(RegistryError);
    });

    it('rejects an empty authority rather than adopting the normalised host', () => {
      expect(() => resolve({ scopedRegistry: 'https:///npm/' })).toThrow(/has no host/);
    });

    it.each([
      ['lowercase', 'https:///user:sup3rsecret@registry.example/'],
      ['uppercase', 'HTTPS:///user:sup3rsecret@registry.example/'],
      ['mixed case', 'HttpS:///user:sup3rsecret@registry.example/'],
    ])('never echoes an empty-authority value (%s scheme)', (_label, value) => {
      // The check must not be tied to a lowercase scheme: an uppercase
      // one would slip past, parse, and reach the scheme error -- whose
      // message names the value, and whose redaction cannot help, since
      // redact() looks for userinfo inside an authority.
      let message = '';
      try {
        resolve({ scopedRegistry: value });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toMatch(/has no host/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('never echoes an empty-authority value, which redact cannot cover', () => {
      let message = '';
      try {
        resolve({ scopedRegistry: 'https:///user:sup3rsecret@registry.example/' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toMatch(/has no host/);
      expect(message).not.toContain('sup3rsecret');
    });

    it.each([
      ['a newline', 'https://host/\n## forged'],
      ['a carriage return', 'https://host/\r## forged'],
      ['a NUL', 'https://host/\u0000truncated'],
      // A trailing control character that trim() would remove is not a
      // case this needs to catch; an embedded one is.
      ['an embedded TAB', 'https://host/\u0009mid/'],
      ['an ESC', 'https://host/\u001b[31mred'],
      ['a DEL', 'https://host/\u007fmid/'],
      ['a vertical tab', 'https://host/\u000bmid/'],
    ])('rejects %s, which URL parsing would strip or normalise', (_label, value) => {
      expect(() => resolve({ scopedRegistry: value })).toThrow(/control character/);
    });

    it('names the control character by code point without echoing it', () => {
      let message = '';
      try {
        resolve({ scopedRegistry: 'https://host/\u001b[31m' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toContain('U+001B');
      expect(message).not.toContain('\u001b');
    });

    it('names the source in the error', () => {
      expect(() => resolve({ publishConfig: { '@onap:registry': 'http://x.example/' } })).toThrow(
        /publishConfig/,
      );
    });

    it('rejects a registry embedding credentials', () => {
      expect(() => resolve({ scopedRegistry: 'https://user:token@registry.example.org/' })).toThrow(
        /embeds credentials/,
      );
    });

    it('rejects a username with no password', () => {
      expect(() => resolve({ scopedRegistry: 'https://user@registry.example.org/' })).toThrow(
        /embeds credentials/,
      );
    });

    it('never echoes the credentials it rejects', () => {
      let message = '';
      try {
        resolve({ scopedRegistry: 'https://user:sup3rsecret@registry.example.org/' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).not.toContain('sup3rsecret');
      expect(message).not.toContain('user:');
    });

    it('redacts credentials when rejecting for another reason', () => {
      let message = '';
      try {
        resolve({ scopedRegistry: 'http://user:sup3rsecret@registry.example.org/' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).not.toContain('sup3rsecret');
      expect(message).toContain('***@registry.example.org/');
    });

    it('withholds a credential-bearing value that has no authority', () => {
      // 'https:user:token@host/' parses as https and fails the lowercase
      // prefix check, whose message names the value -- and redact()
      // cannot locate the userinfo without a '://' to anchor on.
      let message = '';
      try {
        resolve({ scopedRegistry: 'https:user:sup3rsecret@registry.example/' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).not.toContain('sup3rsecret');
      expect(message).toContain('withheld');
    });

    it.each([
      ['a query string', 'https://registry.example/?token=sup3rsecret'],
      ['a fragment', 'https://registry.example/#sup3rsecret'],
      ['both', 'https://registry.example/?a=sup3rsecret#b'],
    ])('rejects %s without echoing it', (_label, value) => {
      // registry_url's allowlist has no '?' or '#', so only an override
      // can carry them -- and a query string is where a token hides.
      let message = '';
      try {
        resolve({ scopedRegistry: value });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toMatch(/query string|fragment/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('refuses a query string before the protocol complaint', () => {
      // An http URL carrying one must not take the protocol path, whose
      // message names the value.
      let message = '';
      try {
        resolve({ scopedRegistry: 'http://registry.example/?token=sup3rsecret' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toMatch(/query string/);
      expect(message).not.toContain('sup3rsecret');
    });

    it.each(['undefined', 'null'])(
      'rejects a configured registry of %o on the no-input path, as npm does',
      (literal) => {
        // Unlike a scoped key, `registry` is never printed as 'undefined'
        // when unset -- npm prints its default -- so this is a value the
        // user configured, and npm rejects the publish on it. Treating it
        // as unset would publish to the default where npm refused.
        expect(() => resolve({ registryUrl: '', npmConfigRegistry: literal })).toThrow(
          RegistryError,
        );
      },
    );

    it('never echoes a value that fails to parse', () => {
      // 'https://?token=...' throws in new URL(), and redact() finds no
      // authority to work with -- so the parse-failure message must not
      // carry the value at all.
      let message = '';
      try {
        resolve({ scopedRegistry: 'https://?token=sup3rsecret' });
      } catch (cause) {
        message = (cause as Error).message;
      }
      expect(message).toMatch(/not a URL/);
      expect(message).not.toContain('sup3rsecret');
    });

    it('requires a trailing slash, matching registry_url and the .npmrc action', () => {
      // The resolved value is handed to node-create-npmrc-action, whose
      // registry_url contract rejects a URL without one -- so an override
      // lacking it would resolve here and fail during authentication.
      expect(() => resolve({ scopedRegistry: 'https://registry.example.org/repository/npm' })).toThrow(
        /must end with "\/"/,
      );
    });

    it('rejects an unsafe configured registry on the no-input path', () => {
      // The fallback goes through the same validation; without it a
      // project- or user-configured http registry would be contacted
      // while the summary reported it as resolved.
      expect(() =>
        resolve({ registryUrl: '', npmConfigRegistry: 'http://configured.example/' }),
      ).toThrow(RegistryError);
    });

    it('leaves a credential-free value intact in the message', () => {
      expect(() => resolve({ scopedRegistry: 'http://registry.example.org/' })).toThrow(
        /http:\/\/registry\.example\.org\//,
      );
    });
  });
});
