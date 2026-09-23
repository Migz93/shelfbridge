<!-- shared: content — keep in sync across Migz93 self-hosted apps; only the app name differs -->

# Security Policy

## Reporting A Vulnerability

Please do not open a public GitHub issue for security-sensitive problems.

If you find a vulnerability in ShelfBridge, report it privately through GitHub's
private vulnerability reporting flow for this repository if it is enabled. If
that is not available, contact the maintainer directly through a private channel
before disclosing details publicly.

When reporting an issue, please include:

- a short description of the problem
- the affected version or commit if known
- clear reproduction steps
- the expected impact
- any suggested mitigation if you have one

## Disclosure Expectations

- Please allow time for the issue to be investigated and fixed before public
  disclosure.
- I will try to acknowledge reports promptly and keep you updated on the status.
- Once a fix is available, the goal is to disclose the issue responsibly with
  enough detail for users to protect themselves.

## Scope

Security reports are especially helpful for issues involving:

- authentication or session handling
- token or secret exposure
- privilege escalation
- remote code execution
- container or deployment security
- unsafe default configuration

## Supported Versions

ShelfBridge is still early in development. Until a stable release policy is
documented, security fixes are handled on the latest supported code line.

---

## Security Scanning

Scanning runs on GitHub, not locally. Every scanner reports to the repository's
**Security** tab.

| What's scanned | Scanner | Where it runs | Where findings appear |
|---|---|---|---|
| Docker image (AMD64 and ARM64) | Trivy — HIGH and CRITICAL vulnerabilities that have a fix | `develop.yml` and `release.yml`, after each image is published | Code scanning alerts (categories `trivy-linux-amd64`, `trivy-linux-arm64`) |
| Source code and workflows | CodeQL | `codeql.yml` — pushes and PRs to `main`/`develop`, plus weekly | Code scanning alerts |
| npm packages and GitHub Actions | Dependabot | Alerts from GitHub's dependency graph; update PRs from `.github/dependabot.yml` — daily, targeting `develop` | Dependabot alerts, and Dependabot PRs |

There is nothing to install or run locally. To check a fix, let the workflow run
again — merging to `develop` re-runs Trivy on the development image, and CodeQL
runs on the PR itself.

### Philosophy — Fix Vs Dismiss

We take security seriously, but we don't fix things for the sake of fixing them.

**Fix it** if:

- It's a genuine vulnerability with a realistic attack path
- The fix improves code quality or correctness
- It's straightforward to address without compromising readability or best
  practice

**Dismiss it** if:

- The scanner can't trace through your validation logic but the code is
  demonstrably safe (false positive)
- The "fix" would require writing worse code purely to satisfy static analysis
- The issue requires a contorted workaround that obscures intent more than it
  improves security

When in doubt, ask whether fixing it actually makes the code safer — or just
makes the scanner happy. Those aren't the same thing.

### Dismissing An Alert

Dismiss the alert in GitHub's Security tab with a reason and a comment
explaining the decision. Don't leave a deliberate decision as an open alert.

| Alert type | Reasons |
|---|---|
| Code scanning (Trivy, CodeQL) | **False positive**, **Won't fix**, **Used in tests**, **Mitigated** |
| Dependabot | **Inaccurate**, **Not used**, **No bandwidth to fix**, **Risk is tolerable**, **Fix has already been started** |

The comment is what tells a future reader why the alert was dismissed, so write
it for someone who hasn't seen this conversation.

See [docs/workflow.md](docs/workflow.md) for how an agent handles these decisions
and what it will provide when recommending a dismissal.
