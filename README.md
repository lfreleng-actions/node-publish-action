<!--
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 The Linux Foundation
-->

# 🚀 Node.js Package Publish Action

<!-- prettier-ignore-start -->
<!-- markdownlint-disable-next-line MD013 -->
[![Linux Foundation](https://img.shields.io/badge/Linux-Foundation-blue)](https://linuxfoundation.org/) [![Source Code](https://img.shields.io/badge/GitHub-100000?logo=github&logoColor=white&color=blue)](https://github.com/lfreleng-actions/node-publish-action) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![pre-commit.ci status badge]][pre-commit.ci results page] [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lfreleng-actions/node-publish-action/badge)](https://scorecard.dev/viewer/?uri=github.com/lfreleng-actions/node-publish-action)
<!-- prettier-ignore-end -->

Stamps a version into `package.json` and publishes the package to an
npm registry, such as a Linux Foundation Nexus instance.

## node-publish-action

The action wraps the production-proven Linux Foundation publish flow:

```text
npm version <X> --no-git-tag-version && npm publish
```

It composes
[node-create-npmrc-action](https://github.com/lfreleng-actions/node-create-npmrc-action)
for registry authentication, keeping publish `run:` logic out of
calling workflows. Versions get stamped at publish time, matching the
merge-driven release model where committed metadata (such as
`version.properties`), not the committed `package.json`, provides the
version.

## Usage Example

<!-- markdownlint-disable MD046 -->

```yaml
steps:
  - name: "Publish npm package"
    id: publish
    uses: lfreleng-actions/node-publish-action@main
    with:
      publish_version: '1.2.3-SNAPSHOT'
      registry_url: 'https://nexus3.example.org/repository/npm.snapshot/'
      load_credential: 'true'
      vault_mapping_json: ${{ secrets.VAULT_MAPPING_JSON }}
      op_service_account_token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

<!-- markdownlint-enable MD046 -->

## Requirements

The action needs `jq`, `realpath` (GNU coreutils, including `-m`
support), `mktemp` and `tr` on the runner. GitHub-hosted Ubuntu
runners include these tools; minimal self-hosted or non-Linux runners
must provide them. The action checks for them up front and fails with
a clear error naming any missing tool. It installs Node.js and npm via
the pinned `actions/setup-node` action, without dependency caching.
Real publishes need egress to the target registry; dry-run mode
publishes nothing and writes no credential.

## Inputs

<!-- markdownlint-disable MD013 -->

| Name                     | Required | Default  | Description                                                                                  |
| ------------------------ | -------- | -------- | -------------------------------------------------------------------------------------------- |
| publish_version          | True     |          | Version to stamp and publish, such as `1.2.3` or `1.2.3-SNAPSHOT`                            |
| registry_url             | False    | `''`     | Target npm registry URL ending with `/`; required unless `dry_run` is `'true'`               |
| dry_run                  | False    | `false`  | Pack and verify without publishing (npm may still read the registry); skips credential setup |
| path_prefix              | False    | `.`      | Project directory; must resolve within the workspace                                         |
| node_version             | False    | `22`     | Node.js version to set up, such as `22`, `22.x` or `lts/*`                                   |
| node_version_file        | False    | `''`     | File containing the Node.js version, such as `.nvmrc`; overrides `node_version`              |
| tag                      | False    | `latest` | npm distribution tag                                                                         |
| access                   | False    | `''`     | Package access: `public`, `restricted` or unset                                              |
| provenance               | False    | `false`  | Generate registry-native provenance; needs registry and OIDC support                         |
| nexus_user               | False    | `''`     | Basic auth username (default: calling repository name); ignored by token auth                |
| nexus_password           | False    | `''`     | Registry password for Basic auth; required for real publishes unless another mode            |
| auth_token               | False    | `''`     | Bearer token written as `_authToken`; for registries rejecting Basic auth                    |
| load_credential          | False    | `false`  | Fetch the password from 1Password via credential-load-action                                 |
| vault_mapping_json       | False    | `''`     | JSON mapping repository owner to 1Password vault (with `load_credential`)                    |
| op_service_account_token | False    | `''`     | 1Password service account token (with `load_credential`)                                     |
| scope                    | False    | `''`     | npm scope for the auth entry (for example `@onap`)                                           |

<!-- markdownlint-enable MD013 -->

### Input Character Allowlists

The action checks free-text inputs against strict whole-string
character allowlists before use, rejecting shell metacharacters and
embedded newlines:

<!-- markdownlint-disable MD013 -->

| Input           | Allowed                | Structure                                                         |
| --------------- | ---------------------- | ----------------------------------------------------------------- |
| publish_version | `0-9 A-Za-z . -`       | All-digit `MAJOR.MINOR.PATCH` segments plus an optional `-`suffix |
| registry_url    | `A-Za-z 0-9 . : / _ -` | `https://` scheme, non-empty host, trailing `/`, no userinfo      |
| tag             | `A-Za-z 0-9 . _ -`     | Non-empty                                                         |
| node_version    | `A-Za-z 0-9 . * / _ -` | Follows setup-node version syntax                                 |

<!-- markdownlint-enable MD013 -->

The `nexus_user`, `scope` and credential inputs pass through to
`node-create-npmrc-action`, which applies its own validation.

## Outputs

<!-- markdownlint-disable MD013 -->

| Name              | Description                                        |
| ----------------- | -------------------------------------------------- |
| published_version | Version stamped into `package.json` and published  |
| package_name      | Package name from the publish metadata             |
| tarball_name      | Tarball filename from the publish metadata         |

<!-- markdownlint-enable MD013 -->

## Behaviour

1. **Check inputs**: tests every input against its allowlist; real
   publishes need `registry_url` and a credential source as well,
   failing fast with a clear error otherwise. With
   `load_credential: 'true'`, real publishes need non-empty
   `vault_mapping_json` and `op_service_account_token` values too
2. **Authenticate** (real publishes): `node-create-npmrc-action`
   writes an authenticated `.npmrc` into the project directory
3. **Stamp**: `npm version <X> --no-git-tag-version
   --allow-same-version --ignore-scripts --no-workspaces` updates
   `package.json`, with the result read back and verified. A
   `::notice::` names any `preversion`/`version`/`postversion`
   scripts the project defines, since `--ignore-scripts` means they
   do not run
4. **Publish**: `npm publish --json --no-workspaces` with the
   configured tag, access and provenance flags. The action then
   recovers npm's metadata from the captured output and checks the
   published version against the request. See
   [Publish Output Parsing](#publish-output-parsing)
5. **Verify** (real publishes): `npm view <name>@<version>` against
   the target registry confirms availability; an unreadable package
   downgrades to a warning (registries may restrict anonymous reads
   or index asynchronously), while a readable package with the wrong
   version fails the action

## Publish Output Parsing

npm runs lifecycle scripts with inherited stdio, so whatever
`prepublishOnly`, `publish` and `postpublish` print lands in the same
stream as npm's `--json` output. That stream seldom holds a bare JSON
document, and it can contain unbalanced braces or JSON objects the
hooks produced themselves.

The action locates npm's object structurally, restarting at every
opening brace so an unbalanced one cannot swallow the rest, and then
selects by **shape**: an object counts as publish metadata when it
carries `name`, `version` and `filename` as strings, in either npm
generation's layout. npm 10 placed those at the top level; npm 11
keys the object by package name.

If npm's exit status is non-zero, the action reports a publish
failure. If npm **succeeded** and the action still cannot read the
metadata, it says so explicitly and states that the package reached
the registry, because retrying that publish cannot succeed — it fails
with `EPUBLISHCONFLICT` on a version that the registry already holds.

> [!NOTE]
> The action tolerates hooks that print to stdout, but stdout is the
> channel npm reports through. A hook printing an object carrying
> `name`, `version` and `filename` as strings looks like npm's own
> report in every respect but the version, so prefer stderr for hook
> diagnostics.

## Dry-Run Mode

With `dry_run: 'true'` the action runs `npm publish --dry-run`, which
packs the package and reports the metadata without publishing. npm
may still consult the registry while doing so. Dry-run mode skips the
`.npmrc`/credential steps entirely, so it needs no `registry_url` and
no credential inputs.

CI holds no registry credentials and completes no publish, so the
testing workflow uses dry-run mode wherever the path under test
allows it. One case cannot: the token pass-through test inspects the
generated `.npmrc`, which dry-run mode never writes, and then fails
against a registry host that does not exist.

## Authentication Modes

Two mutually exclusive modes. Supplying both fails the action rather
than picking a winner, since the effective credential would otherwise
be ambiguous.

### Basic auth (Nexus)

Pass `nexus_password` directly, or set `load_credential: 'true'` with
`vault_mapping_json` and `op_service_account_token` to fetch it from
1Password. `node-create-npmrc-action` writes an `_auth` entry holding
`base64(username:password)`.

### Bearer token

Pass `auth_token`. Written as an `_authToken` entry. Registries that
reject Basic auth for publishing, notably `registry.npmjs.org`,
require this form.

`nexus_user` plays no part in token publishing, since a bearer token
carries no username. Setting it alongside `auth_token` is inert
rather than an error — callers that compute it unconditionally, such
as a matrix publishing to both Nexus and npmjs.org, would otherwise
have to strip it per target. The action emits a `::notice::` naming
it as ignored.

> [!NOTE]
> OIDC trusted publishing, which stores no credential at all, is
> tracked separately in
> [issue #28](https://github.com/lfreleng-actions/node-publish-action/issues/28).

## Workspaces

This action publishes the single package at `path_prefix`. Both
`npm version` and `npm publish` are workspace aware, so the action
passes `--no-workspaces` to each: without it, stamping rewrites every
*sibling* manifest and leaves the target at its committed version,
and publishing fans out across the whole workspace while the action
verifies and reports a single package.

To publish more than one workspace package, call the action once per
package with its own `path_prefix`.

A workspace selected through `npm_config_workspace` fails validation.
One selected through a `workspace=` entry in an `.npmrc` fails at the
stamp instead, before anything reaches the registry: npm exposes such
a selection through neither `npm config get workspace` nor `npm config
list`, so nothing can catch it earlier.

Which `.npmrc` holds that entry changes when it applies. For real
publishes the credential step writes the project `.npmrc` before the
stamp runs, truncating whatever it replaces, so a project-level
selector never survives to affect the publish. A selector at any
other config level — the user `~/.npmrc`, for instance — does
survive, and stops the run at the stamp. Dry runs skip the credential
step, so a project-level selector reaches the stamp there too.

## Credential Handling

`node-create-npmrc-action` masks the credential material, writes the
`.npmrc` with restrictive permissions and registers a guaranteed
post-job step that scrubs the file again — including when later steps
fail. This action adds no duplicate cleanup logic.

## Provenance

The `provenance` input passes `--provenance` to npm, generating
registry-native Sigstore provenance. This works against registries
with provenance support (npmjs.org) and requires an OIDC token
(`id-token: write` permission). Nexus has no provenance support, so
leave the input at `false` for Nexus targets; generate GitHub
artifact attestations for the packed tarball instead.

## Path Constraints

Relative values for `path_prefix` resolve against `GITHUB_WORKSPACE`,
not the current working directory, so behaviour stays deterministic
when a calling workflow sets a custom working directory. The project
directory must resolve within `GITHUB_WORKSPACE` and contain a
`package.json`; the boundary check re-runs in every later step that
touches the path. Paths that escape the workspace fail the action.

## Notes

- The action performs no dependency caching, in line with the
  organisation's cache-poisoning stance
- `--allow-same-version` keeps re-stamping idempotent when the
  committed `package.json` version already matches the request
- Stamping uses `--ignore-scripts`, so `preversion`, `version` and
  `postversion` do not run. No release lane installs dependencies
  before stamping, so a hook invoking the test or build script could
  not succeed; suppressing them keeps the merge-driven and tag-driven
  lanes producing the same tree. The action emits a `::notice::`
  naming the skipped scripts, because a dependency-free `version`
  hook (writing the version into a source constant, say) would
  otherwise go missing from the published package with no signal
- Publishing runs `prepublishOnly`/`prepack`/`prepare` scripts when
  the project defines them; run builds beforehand (for example via
  [node-build-action](https://github.com/lfreleng-actions/node-build-action))
  so the packed content is complete

## Development

The action remains a composite action, so it can call
`actions/setup-node` to select the Node.js version the publish runs
under. Logic that needs real testing lives in TypeScript under `src/`
and runs as a small Node program invoked from `action.yaml`.

```bash
npm ci          # install the toolchain
npm run typecheck
npm test        # vitest
npm run build   # bundle src/ into dist/ with esbuild
```

esbuild strips the TypeScript types itself, so bundling stays
independent of the compiler version; `tsc --noEmit` handles type
checking. The build output is deterministic, which the `check-dist`
job depends on.

Two different Node.js floors apply, and they are not the same number:

- **The development toolchain** needs the version in `engines`
  (`^20.19.0 || >=22.12.0`), which vitest and vite require. It governs
  `npm ci` and the commands above
- **The bundle** targets `node18`, because it runs on whatever
  `node_version` selected for the publish rather than on the toolchain.
  The publish step runs it with `--selftest` ahead of npm, so a runtime
  too old to load it fails the run while nothing has yet reached the
  registry

The repository **commits** `dist/`. GitHub runs an action straight
from the repository and offers no build step, so the bundle has to be
present. The `check-dist` CI job rebuilds it and fails when the result
differs from what the repository holds, so it cannot drift from
`src/`. Run `npm run build` and commit the result alongside any source
change.

The bundle carries no third-party runtime dependencies.
`src/actions-io.ts` implements the slice of the Actions runner
protocol this action needs — outputs, workflow commands and their
escaping — with unit tests, which keeps the committed bundle small
enough to review.

[pre-commit.ci results page]: https://results.pre-commit.ci/latest/github/lfreleng-actions/node-publish-action/main
[pre-commit.ci status badge]: https://results.pre-commit.ci/badge/github/lfreleng-actions/node-publish-action/main.svg
