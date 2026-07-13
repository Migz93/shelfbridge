# Security Policy

## Reporting A Vulnerability

Please do not open a public GitHub issue for security-sensitive problems.

If you find a vulnerability in ShelfBridge, report it privately through GitHub's private vulnerability reporting flow for this repository if it is enabled. If that is not available, contact the maintainer directly through a private channel before disclosing details publicly.

When reporting an issue, please include:

- a short description of the problem
- the affected version or commit if known
- clear reproduction steps
- the expected impact
- any suggested mitigation if you have one

## Scope

Security reports are especially helpful for issues involving:

- authentication or session handling
- token, API key, or secret exposure
- unsafe access to settings, logs, sync history, or cached images
- credential encryption or migration problems
- remote code execution
- container or deployment security
- unsafe default configuration

## Supported Versions

ShelfBridge is still early in development. Until a stable release policy is documented, security fixes are handled on the latest supported code line.

## Security Scanning

Useful commands from the repository root:

```bash
npm audit --omit=dev
npm run check
npm run build
```

If you use Snyk:

```bash
snyk test
snyk code test
snyk container test shelfbridge
```

## Secret Handling Notes

Do not publish `/config`, database backups, logs, `.env` files, `.claude/`, or local devcontainer files. Third-party credentials are encrypted at rest using AES-256-GCM, but the generated `/config/credential-key` must be protected because it can decrypt stored credentials.
