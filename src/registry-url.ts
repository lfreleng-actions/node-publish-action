// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

/**
 * Decide whether a registry URL is one this action will use.
 *
 * Separate from the selection rules in registry.ts: this answers "is this
 * usable", that answers "which one does npm pick". Every value the
 * selection lands on passes through here, whichever source it came from,
 * so a project-supplied override gets the same scrutiny as registry_url.
 */

import type { RegistrySource } from './registry-source.js';

/** Raised for a registry this action refuses to use. */
export class RegistryError extends Error {}


/**
 * Blank out anything that may be credentials before a value is logged.
 *
 * Error messages name the offending value so it can be corrected, and an
 * override arrives from files this action does not control. Echoing it
 * verbatim would put `https://user:token@host/` into the job log, which is
 * the leak the userinfo check exists to prevent.
 */
export function redact(value: string): string {
  const scheme = value.indexOf('://');
  const at = value.indexOf('@');
  // Withhold whenever an '@' sits outside a recognisable authority.
  //
  // Two shapes reach here: no '://' at all ('https:user:token@host/'),
  // and an '@' *before* the '://' ('user:token@https://host/', which
  // parses with protocol 'user:'). In both the text before the '@' may
  // be a credential and there is no authority to anchor on, so the
  // value is not shown rather than guessed at.
  if (at !== -1 && (scheme === -1 || at < scheme)) {
    return '(withheld; it contains an "@")';
  }
  if (scheme === -1) {
    return value;
  }
  const authorityEnd = value.indexOf('/', scheme + 3);
  const authority =
    authorityEnd === -1 ? value.slice(scheme + 3) : value.slice(scheme + 3, authorityEnd);
  const inAuthority = authority.lastIndexOf('@');
  if (inAuthority === -1) {
    return value;
  }
  return `${value.slice(0, scheme + 3)}***@${value.slice(scheme + 3 + inAuthority + 1)}`;
}

function describe(source: RegistrySource, scope: string | null): string {
  switch (source) {
    case 'input':
      return 'registry_url';
    case 'npm-config-scoped':
      return `npm config ${scope}:registry`;
    case 'publishConfig-scoped':
      return `package.json publishConfig (${scope}:registry)`;
    case 'publishConfig-registry':
      return 'package.json publishConfig (registry)';
    case 'npm-config-registry':
      return 'npm config registry';
  }
}

/**
 * The checks that must run on the raw text, before parsing.
 *
 * Each is here because parsing would destroy the evidence: WHATWG parsing
 * strips control characters and reinterprets an empty authority, so a
 * check afterwards would inspect a sanitised value and pass the original.
 */
function assertTextUsable(registry: string, where: string): void {

  // Control characters are rejected before parsing, not after. WHATWG
  // parsing strips or normalises several of them while this function
  // returns the original string, so the value that reaches an ::error::,
  // a step output or the job summary is the unsanitised one.
  //
  // CR and LF are the obvious pair -- 'https://host/\n## forged' would
  // otherwise inject summary lines -- but they are not the only ones a
  // project-controlled value may carry: NUL truncates, ESC begins a
  // terminal escape sequence, and the rest are meaningless in a URL. The
  // whole C0 range and DEL are refused rather than an enumerated few.
  const control = /[\u0000-\u001f\u007f]/.exec(registry);
  if (control) {
    // The offending character is named by code point, and the value is
    // not shown: a control character is exactly what would corrupt the
    // line reporting it.
    const code = control[0].codePointAt(0) ?? 0;
    throw new RegistryError(
      `${where} contains a control character (U+${code
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}). Remove it: the registry is written to the ` +
        'job summary and step outputs.',
    );
  }

  // An empty authority is a misconfiguration with a surprising outcome:
  // WHATWG parsing reinterprets the first path segment as the host, so
  // 'https:///npm/' silently becomes 'https://npm/' and publishes somewhere
  // the caller never named.
  //
  // Matched on any scheme and any case, not just lowercase https. A value
  // such as 'HTTPS:///user:token@host/' would otherwise slip past here,
  // parse, and fail the scheme check below -- whose message names the
  // value, and whose redaction cannot help, because redact() looks for
  // userinfo inside an authority and this shape has none.
  //
  // The value is deliberately absent from this message for the same reason.
  if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(registry)) {
    throw new RegistryError(`${where} has no host. Expected https://host/path/`);
  }
}

/**
 * Reject a registry this action will not publish to or verify against.
 *
 * https only, and lowercase: credentials cross this connection, and under a
 * trusted-publishing exchange the OIDC token is sent to it. registry_url is
 * already held to this in the validate step; an override arrives from the
 * project's own files and has had no such check.
 */
export function assertUsable(registry: string, source: RegistrySource, scope: string | null): void {
  const where = describe(source, scope);
  assertTextUsable(registry, where);

  let parsed: URL;
  try {
    parsed = new URL(registry);
  } catch {
    // Not echoed, even redacted. A value that fails to parse has no
    // authority for redact() to locate userinfo in, yet may still carry a
    // secret: 'https://?token=...' throws here, and its query string
    // would otherwise land in the log verbatim.
    throw new RegistryError(`${where} is not a URL. Expected https://host/path/`);
  }
  // A query string or fragment is refused before the protocol check, so
  // an http URL carrying one cannot leak it through that message either.
  //
  // registry_url's own allowlist has no '?' or '#', so the input cannot
  // reach here with either; an override from the project's files has had
  // no such check. npm derives its credential key from the registry URL,
  // and a query string is where a token would hide --
  // 'https://registry.example/?token=...' would otherwise be written
  // verbatim to the step outputs, the override notice and the summary.
  //
  // The value is not echoed, for that reason.
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new RegistryError(
      `${where} carries a ${parsed.search !== '' ? 'query string' : 'fragment'}. ` +
        'A registry URL is a path; npm keys credentials on it, so anything ' +
        'after "?" or "#" belongs in .npmrc instead.',
    );
  }
  // No hostname check follows: for a special scheme such as https the URL
  // parser rejects an absent host outright ('https://' throws).
  if (parsed.protocol !== 'https:' || !registry.startsWith('https://')) {
    throw new RegistryError(
      `${where} must begin with a lowercase "https://": ${redact(registry)}. ` +
        'Credentials must never cross a cleartext connection.',
    );
  }
  // A registry URL ends in '/'. registry_url requires it, and so does the
  // .npmrc action the resolved value is now handed to -- an override
  // without one would resolve here and then fail during authentication,
  // which the dry-run tests never reach. npm also derives its credential
  // key from the path, and a missing slash changes that key. Rejected
  // rather than normalised, so the URL npm sees is the one the caller
  // wrote.
  if (!registry.endsWith('/')) {
    throw new RegistryError(
      `${where} must end with "/": ${redact(registry)}. npm derives its ` +
        'credential key from the path, and a missing slash changes that key.',
    );
  }
  // registry_url's own allowlist has no '@', so it cannot carry userinfo; an
  // override has had no such check. The resolved value reaches the step
  // outputs, the override notice and the job summary, so embedded
  // credentials would be published to the log. Deliberately not echoed.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RegistryError(
      `${where} embeds credentials in the URL. Remove the user info and ` +
        'authenticate through .npmrc, so the registry can be logged safely.',
    );
  }
}
