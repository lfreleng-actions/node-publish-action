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
support) and `mktemp` on the runner. GitHub-hosted Ubuntu runners
include these tools; minimal self-hosted or non-Linux runners must
provide them. The action checks for them up front and fails with a
clear error naming any missing tool. It installs Node.js and npm via
the pinned `actions/setup-node` action, without dependency caching.
Real publishes need egress to the target registry; dry-run mode
performs no registry interaction.

## Inputs

<!-- markdownlint-disable MD013 -->

| Name                     | Required | Default  | Description                                                                          |
| ------------------------ | -------- | -------- | ------------------------------------------------------------------------------------ |
| publish_version          | True     |          | Version to stamp and publish, such as `1.2.3` or `1.2.3-SNAPSHOT`                    |
| registry_url             | False    | `''`     | Target npm registry URL ending with `/`; required unless `dry_run` is `'true'`       |
| dry_run                  | False    | `false`  | Pack and verify without registry interaction; skips credential setup                 |
| path_prefix              | False    | `.`      | Project directory; must resolve within the workspace                                 |
| node_version             | False    | `22`     | Node.js version to set up, such as `22`, `22.x` or `lts/*`                           |
| node_version_file        | False    | `''`     | File containing the Node.js version, such as `.nvmrc`; overrides `node_version`      |
| tag                      | False    | `latest` | npm distribution tag                                                                 |
| access                   | False    | `''`     | Package access: `public`, `restricted` or unset                                      |
| provenance               | False    | `false`  | Generate registry-native provenance; needs registry and OIDC support                 |
| nexus_user               | False    | `''`     | Registry username (default: calling repository name)                                 |
| nexus_password           | False    | `''`     | Registry password/token; required for real publishes unless `load_credential`        |
| load_credential          | False    | `false`  | Fetch the password from 1Password via credential-load-action                         |
| vault_mapping_json       | False    | `''`     | JSON mapping repository owner to 1Password vault (with `load_credential`)            |
| op_service_account_token | False    | `''`     | 1Password service account token (with `load_credential`)                             |
| scope                    | False    | `''`     | npm scope for the auth entry (for example `@onap`)                                   |

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
   --allow-same-version` updates `package.json`, with the result
   read back and verified
4. **Publish**: `npm publish --json` with the configured tag, access
   and provenance flags; the action parses the JSON metadata and
   verifies the published version matches the request
5. **Verify** (real publishes): `npm view <name>@<version>` against
   the target registry confirms availability; an unreadable package
   downgrades to a warning (registries may restrict anonymous reads
   or index asynchronously), while a readable package with the wrong
   version fails the action

## Dry-Run Mode

With `dry_run: 'true'` the action runs `npm publish --dry-run`, which
packs the package and reports the metadata without any registry
interaction. Dry-run mode skips the `.npmrc`/credential steps
entirely, so it needs no `registry_url` and no credential inputs.
Every test in this repository's testing workflow runs in dry-run
mode; CI holds no registry credentials.

## Credential Handling

`node-create-npmrc-action` masks the credential material, writes the
`.npmrc` with restrictive permissions and registers a guaranteed
post-job step that scrubs the file again — including when later steps
fail. This action adds no duplicate cleanup logic. Credential supply
follows the organisation's model: pass `nexus_password` directly, or
set `load_credential: 'true'` with `vault_mapping_json` and
`op_service_account_token` to fetch the password from 1Password.

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
- Publishing runs `prepublishOnly`/`prepack`/`prepare` scripts when
  the project defines them; run builds beforehand (for example via
  [node-build-action](https://github.com/lfreleng-actions/node-build-action))
  so the packed content is complete

[pre-commit.ci results page]: https://results.pre-commit.ci/latest/github/lfreleng-actions/node-publish-action/main
[pre-commit.ci status badge]: https://results.pre-commit.ci/badge/github/lfreleng-actions/node-publish-action/main.svg
