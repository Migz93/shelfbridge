<!-- shared: content — keep in sync across Migz93 self-hosted apps -->

# Workflow Reference

The mechanics of getting work onto GitHub and out as a release.

Read the repo's `AGENTS.md` before starting any work. It holds the parts that
apply to *every* task — the branch check, the review gate, and the branch
rules — and this file assumes you've already read it. This file holds the
parts you only need at a specific moment, so read it when you reach that
moment rather than up front.

| Section | When you need it |
|---|---|
| [GitHub CLI Usage](#github-cli-usage) | Running any `gh` command |
| [AI Sign-Off For GitHub Text](#ai-sign-off-for-github-text) | Writing anything that lands on GitHub |
| [Pull Request Description Format](#pull-request-description-format) | Opening a PR |
| [Pull Request Conventions](#pull-request-conventions) | Opening or merging a PR |
| [CodeRabbit Review Process](#coderabbit-review-process) | Reviewing development changes or a release PR |
| [Release Process](#release-process) | Cutting a release |
| [Release Notes](#release-notes) | Editing a release-drafter draft before publication |
| [Security Findings](#security-findings) | Triaging a code-scanning or Dependabot alert |
| [Implementation Expectations](#implementation-expectations) | Writing new code |

---

## GitHub CLI Usage

Use `gh` for all GitHub operations:

- `gh pr create --draft --base develop --title "..." --body "..."`
- Ordinary PRs into `develop`: `gh pr merge --squash --delete-branch`
- Release and ancestry-reconciliation PRs: `gh pr merge --merge`
- Edit the release-drafter draft into the [Release Notes](#release-notes)
  format, then publish it once the tag is pushed:
  `gh release edit vX.Y.Z --draft=false`
- `gh issue create --title "..." --body "..."`

PRs are opened as drafts and only marked ready-for-review once finished (see
[Pull Request Conventions](#pull-request-conventions)).

Always confirm the base branch is correct before creating a PR. Work-branch PRs
target `develop`; only the release PR targets `main`.

---

## AI Sign-Off For GitHub Text

Any text an agent writes that lands on GitHub — PR descriptions, issue bodies,
PR comments, review responses — must be attributable. Sign off with the agent's
name at the end so a human reading the thread later knows what wrote it.

Commit messages carry a `Co-Authored-By` trailer instead; don't duplicate the
sign-off there.

---

## Pull Request Description Format

Use this structure for PR bodies:

```markdown
## Summary

One or two sentences on what this change does and why.

## Changes

- Bullet per meaningful change
- Group related edits rather than listing every file

## Test plan

- How this was verified
- Note anything that could not be verified locally
```

Keep it factual. Describe what changed and how it was checked, not how
significant it is.

Call out explicitly if the change affects: release behaviour, Docker publishing,
auth, database schema, the integrations listed under "Integrations to flag in
review" in the `AGENTS.md` Project Facts table, or user-visible setup.

If the work was done somewhere Docker was unavailable, say so in the test plan
rather than implying the container was rebuilt and verified.

---

## Pull Request Conventions

- PR titles are semantic and become changelog entries: `feat: add poster
  caching`, `fix: correct sync ordering`, `chore: bump to 1.2.0`
- One logical change per PR. Split unrelated work.
- Squash-merge feature, fix, chore, docs, CI, and version-bump PRs into
  `develop` so each PR is one commit in the history.
- Exception: use a merge commit for an ancestry-reconciliation PR and for every
  `develop` → `main` release PR: `gh pr merge --merge`. Never
  squash a release PR. The merge commit preserves `develop` ancestry on `main`,
  avoiding overlapping, non-identical history and future release conflicts.
- Delete the branch after merging an ordinary work PR.
- PRs are opened as drafts (`gh pr create --draft`). Mark ready for review only
  once the changeset is actually finished — no more fix commits expected — via
  `gh pr ready`. This includes staying in draft through any post-open fix
  cycle: if CodeRabbit's own automated PR review (or anything else) surfaces
  something after the PR is opened, fix it, push, and only call `gh pr ready`
  once nothing further is pending. If a PR was already marked ready and then
  needs more fixes, convert it back to draft (`gh pr ready --undo`) before
  pushing the fix, so the follow-up commit doesn't trigger another automatic
  review.

---

## CodeRabbit Review Process

CodeRabbit serves two distinct purposes. The existing two-branch workflow and
release mechanics remain unchanged.

| Review | Purpose | Outcome |
|---|---|---|
| Periodic CLI review | Broad review of accumulated `develop` changes | Initially triaged recommendations, then owner-approved normal issues and accepted findings |
| Release PR review | Critical release-safety check | Fix blockers only |

### Periodic CLI Review

The project owner manually requests this review when a broad check of
`develop` against `main` would be useful. It is not scheduled, automated, a
frozen testing phase, or a release gate. Do not create release branches or
release candidates for it.

Run:

```bash
coderabbit review --agent --base main -c AGENTS.md
```

First triage the output for the owner: identify important findings, group
related findings, recommend which should become normal issues, and call out
minor or optional suggestions. Clearly explain findings that are intentional,
irrelevant, false positives, or unsuitable for the project.

Do not create issues automatically. Only after the owner approves the proposed
findings, create normal GitHub issues with existing repository labels; never
introduce review-specific labels. Intentional or unwanted findings can be
accepted without an issue; record that disposition in the triage report.

### Release PR Review

When a normal `develop` → `main` release PR has been opened as a draft, trigger
CodeRabbit's PR review if necessary. Its purpose is limited to release safety. Address only
findings that could break the application, startup or deployment, cause data
loss or corruption, break a database migration, introduce a serious security
problem, seriously break a core integration listed in the Project Facts table,
or otherwise make the release unsafe.

Non-critical findings should become normal future-work issues only after the
project owner approves, or be explicitly accepted. They must not automatically
create more release PRs.

If a release-safety blocker requires code changes, create a normal fix branch
from `develop` and take its PR through the normal review gate before merging it
into `develop`. The draft release PR then includes the fix and must go through
the release PR review again before it is marked ready. Do not commit the fix
directly to `develop`, `main`, or the release PR.

---

## Release Process

When the user says it's time to release:

1. Confirm the version number with the user — patch, minor, or major
2. Create `chore/bump-version-X.Y.Z` from `develop`
3. Update the version files listed in the Project Facts table in `AGENTS.md`
4. Open a PR from that branch into `develop` and merge it
5. Open a draft PR from `develop` into `main`, take it through the narrow
   [release PR review](#release-pr-review), mark it ready (`gh pr ready`) once
   release-safety blockers are resolved or accepted, then merge it with a merge
   commit: `gh pr merge --merge`
6. Create and push the tag `vX.Y.Z` from the resulting merge commit on `main`
7. Edit the release-drafter draft into the user-facing format in
   [Release Notes](#release-notes), then publish it
   (`gh release edit vX.Y.Z --draft=false`). Don't use `gh release create`,
   which makes a second release instead of publishing the draft.

Do not invent the version — always confirm with the user if ambiguous.

**Tag format:** `vX.Y.Z` — always from `main`, never from `develop`.

---

## Release Notes

Release Drafter output is a starting point, not the finished release note. For
each future release, edit the draft into a concise explanation for users and
operators before publishing it. Do not rewrite releases that have already been
published.

Use this order, including a section only when it contains useful content:

1. A human-written opening summary.
2. Upgrade notes, when needed.
3. Features, when needed.
4. Fixes and reliability, when needed.
5. Security and maintenance, when needed.
6. Documentation, when genuinely useful.
7. Docker information.
8. A collapsed complete pull request list.

### Opening Summary

Start with one or two plain-English paragraphs that explain what the release is
mainly about, the important user-visible improvements, and any broad
operational or reliability improvement that matters. It should be useful to
someone who does not want to inspect every pull request. Avoid repeating the
same detail in the later sections.

### Upgrade Notes

Include this section only when existing users need to know about database
migrations, changed defaults, Docker permissions or startup changes,
configuration changes, surprising behaviour changes, or required manual
actions.

### Features, Fixes and Reliability

Describe new user-facing functionality in plain language. Describe important
bug fixes, reliability improvements, and meaningful behaviour corrections;
group related changes into meaningful entries rather than copying raw pull
request titles.

### Security and Maintenance

Include meaningful security fixes, runtime-image changes, rate limiting,
dependency updates, CI or security scanning, authentication hardening, and
similar operational changes. Put Docker health checks and runtime-image changes
here rather than under Features. Do not turn this into a detailed dependency
changelog.

### Documentation

Include documentation changes only when they matter to users or operators.
Minor internal documentation changes can remain in the complete pull request
list.

### Docker

Include all of the following near the end of every release note:

- A versioned `docker pull` command.
- The `latest` and versioned image tags.
- Supported architectures.
- Any important image-specific note.

### Complete Pull Request List

Put the complete pull request list last, inside a collapsed `<details>` block.
It is the release audit trail and must include every pull request in the
release: release and version-bump pull requests, test-only pull requests,
internal review-fix pull requests, documentation pull requests, and dependency
pull requests. Group the list consistently under headings such as Features,
Fixes, Maintenance, Documentation, and Dependencies.

Check the list against GitHub's compare range from the previous tag to
`vX.Y.Z`; Release Drafter omits pull requests labelled `skip-changelog`.

Do not add empty sections or a permanent "Known issues" section. Mention a
known limitation only when it is relevant to that specific release.

---

## Security Findings

Findings come from GitHub Security — Trivy and CodeQL raise code-scanning
alerts, Dependabot raises Dependabot alerts. Nothing is scanned locally; don't
suggest installing or running a scanner to "verify" a finding. When working
through a finding:

1. **Always explain the finding first** — describe what the scanner flagged,
   why it flagged it, and whether it is a genuine issue or a false positive
   before suggesting any action.
2. **Recommend fix or dismiss honestly** — if fixing the issue would require
   writing worse code (less readable, against best practice, or purely to
   satisfy static analysis), say so clearly and recommend dismissing instead.
   A base-image or package vulnerability with no fixed version available is
   usually a wait, not a code change.
3. **When recommending a dismissal**, always provide:
   - The dismissal reason to select in GitHub — for code scanning: **False
     positive**, **Won't fix**, **Used in tests** or **Mitigated**; for Dependabot:
     **Inaccurate**, **Not used**, **No bandwidth to fix**, **Risk is
     tolerable** or **Fix has already been started**
   - A plain-English comment the user can paste into the dismissal comment
     box, explaining why the code is safe or why the risk is accepted
4. **Never suggest a change purely to appease a scanner** if it doesn't improve
   actual security or code quality.

See [SECURITY.md](../SECURITY.md) for what is scanned, where alerts appear, and
the fix-vs-dismiss philosophy.

---

## Implementation Expectations

When implementing new functionality, treat logging and code clarity as part of
the feature work, not as optional polish.

### Checks

Run the checks listed in the Project Facts table in `AGENTS.md` before closing
out work. Keep any tooling changes practical and correctness-focused — do not
introduce broad style-only rule churn as part of unrelated feature work.

### Logging

- Consider logging for every new feature, workflow, integration, or background
  process where runtime visibility would help with debugging, support, or
  diagnosing failures
- Think through logging across the full implementation path, not just one layer
  — request handling, service logic, scheduled work, external API calls, and
  error paths where relevant
- Add logs that are useful and intentional: enough context to understand what
  happened, without spamming noisy or redundant messages
- Prioritise logs around important state changes, failures, retries, skipped
  work, destructive cleanup, and external-system interactions when those would
  otherwise be hard to trace
- Use the appropriate log level: `info` for normal significant events (sync
  started/completed, item matched), `warn` for recoverable failures or skipped
  work, `error` for failures that need attention, and `debug` for diagnostic
  detail
- Pass structured data as the second `meta` argument rather than interpolating
  values into the message string (e.g. `logger.info("Sync complete", { count: 5
  })` not `logger.info(\`Sync complete: 5\`)`)
- If rewriting an existing section of code that has no logging, add appropriate
  logging at that point — the absence of logs is often what made the original
  issue hard to diagnose

### Code Comments

- Add explanatory comments where they materially improve readability or
  maintainability, especially around non-obvious logic, edge cases, or decisions
  that are easy to misread later
- Comments should explain intent and reasoning, not restate what the code
  literally does
- When a future maintainer might reasonably ask "why is this written this way?",
  prefer a short comment that answers that question at the point of
  implementation
