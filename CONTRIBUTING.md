# Contributing to Encargado

Encargado makes Elixir/Phoenix development environments repeatable on one Linux machine, using mise, Compose, systemd user units, and Tailscale. Bug fixes, clearer documentation, and focused improvements are welcome. Open an issue before substantial features or new dependencies so we can agree on the scope.

## Development

Use Linux, Node.js 24.12 or newer, and npm:

```sh
npm ci --ignore-scripts
./bin/encargado --help
```

Before submitting a change:

```sh
npm run check
npm test
npm run test:package
```

The package check builds a release tarball, installs it under a temporary prefix, and exercises the installed CLI and application launcher. Source checkouts run TypeScript directly; release packages contain compiled JavaScript. Commit dependency changes with `package-lock.json`.

Use disposable projects and synthetic data for reproductions. Do not attach credentials, environment files, private state, raw application logs, internal URLs, or identifying infrastructure details to public reports.

## Lifecycle changes

Keep CLI and socket operations on the same manager implementation. Match runtime resources by explicit ownership. Preserve unrelated services, shared dependencies, stored data, and existing Tailscale routes.

The default tests use isolated registries and fake runtime drivers. Add regression coverage for behavior changes, including worktree isolation, concurrency, restart recovery, and failed readiness where relevant. Tests must not stop real services or prune storage.

The optional `npm run test:live` and `npm run test:phoenix` suites need the host tools described in the [README](README.md#clients-and-development). Live tests must create and clean up only their own disposable resources; CI does not run these suites.

## Pull requests

1. Fork the repository and work on a branch.
2. Describe the problem, solution, and verification.
3. Open a pull request against `main`. CI checks Node.js 24.12 and the current Node.js 24 release. Workflows from external contributors need maintainer approval before running.
4. Resolve review conversations and wait for passing checks. Changes are squash-merged, and merged branches are deleted automatically.

Be respectful and constructive. Contributions are provided under the project's [MIT license](LICENSE). Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## Releases

Releases are published as GitHub tarball assets; the package remains marked private to prevent accidental npm registry publication. Update the version in `package.json` and `package-lock.json`, run the checks above, and wait for CI and CodeQL to pass on the release commit.

From a clean checkout of that commit, build and checksum the tarball:

```sh
release_dir=$(mktemp -d)
npm pack --pack-destination "$release_dir"
(cd "$release_dir" && sha256sum encargado-*.tgz > SHA256SUMS)
```

Create a new `v<version>` tag at the checked commit and attach the tarball and `SHA256SUMS` to its GitHub release. Document relevant changes, requirements, and verification. Existing release tags are protected against updates and deletion.
