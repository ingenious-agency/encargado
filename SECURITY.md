# Security policy

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/ingenious-agency/encargado/security/advisories/new). Please report new vulnerabilities privately before posting public issues or pull requests with exploit details.

Include:

- The affected version or commit.
- The impact and required access or configuration.
- Reproduction steps using synthetic data.
- A suggested fix, if available.

Do not include real credentials, environment files, private state, raw application logs, or identifying infrastructure details.

## Supported versions

Security fixes target the current `main` branch and latest release. Older releases are not maintained separately. Responses and fixes are best effort; there is no guaranteed response time.

## Execution and access

Encargado runs trusted project recipes with the current user's permissions. Docker and service-management access can carry substantial authority. Project recipes are not a sandbox for untrusted code.

The Unix socket and state directory are private to the local user. Resolved launch recipes may contain environment-file secrets; protect the state directory and its backups. Log redaction is best effort, and application-generated output can still contain sensitive data.

Remote Start access relies on the configured Tailscale gateway and allowed users. Review the [Tailscale trust boundary](docs/tailscale.md) before enabling remote access.
