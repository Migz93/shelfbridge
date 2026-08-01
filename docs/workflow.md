<!-- shared: content — keep in sync across Migz93 self-hosted apps -->

# Workflow Reference

The mechanics of getting work onto GitHub and out as a release.

`AGENTS.md` holds the parts that apply to *every* task — the branch check, the
review gate, and the branch rules. This file holds the parts you only need at a
specific moment, so read it when you reach that moment rather than up front.

| Section | When you need it |
|---|---|
| [GitHub CLI Usage](#github-cli-usage) | Running any `gh` command |
| [AI Sign-Off For GitHub Text](#ai-sign-off-for-github-text) | Writing anything that lands on GitHub |
| [Pull Request Description Format](#pull-request-description-format) | Opening a PR |
| [Pull Request Conventions](#pull-request-conventions) | Opening or merging a PR |
| [Release Process](#release-process) | Cutting a release |
| [Snyk Findings](#snyk-findings) | Triaging a Snyk result |
| [Implementation Expectations](#implementation-expectations) | Writing new code |

---

## GitHub CLI Usage

Use `gh` for all GitHub operations:

- `gh pr create --base develop --title "..." --body "..."`
- `gh pr merge --squash --delete-branch`
- `gh release create vX.Y.Z --generate-notes`
- `gh issue create --title "..." --body "..."`

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
auth, database schema, Audiobookshelf/Hardcover/Grimmory/Chaptarr integrations, or user-visible setup.

If the work was done somewhere Docker was unavailable, say so in the test plan
rather than implying the container was rebuilt and verified.

---

## Pull Request Conventions

- PR titles are semantic and become changelog entries: `feat: add poster
  caching`, `fix: correct sync ordering`, `chore: bump to 1.2.0`
- One logical change per PR. Split unrelated work.
- Squash-merge into `develop` so each PR is one commit in the history.
- Delete the branch after merging.

---

## Release Process

When the user says it's time to release:

1. Confirm the version number with the user — patch, minor, or major
2. Create `chore/bump-version-X.Y.Z` from `develop`
3. Update the version files listed in the Project Facts table in `AGENTS.md`
4. Open a PR from that branch into `develop` and merge it
5. Open a PR from `develop` into `main`, take it through the review gate, and
   merge it
6. Push the tag `vX.Y.Z` from `main`
7. Review the release-drafter draft on GitHub and publish it

Do not invent the version — always confirm with the user if ambiguous.

**Tag format:** `vX.Y.Z` — always from `main`, never from `develop`.

---

## Snyk Findings

When working through Snyk findings:

1. **Always explain the finding first** — describe what Snyk flagged, why it
   flagged it, and whether it is a genuine issue or a false positive before
   suggesting any action.
2. **Recommend Fix or Won't Fix honestly** — if fixing the issue would require
   writing worse code (less readable, against best practice, or purely to
   satisfy static analysis), say so clearly and recommend Won't Fix instead.
3. **When recommending Won't Fix**, always provide:
   - A plain-English comment the user can paste into the Snyk GUI, explaining
     why the code is safe
   - The correct Snyk category to select: **Won't Fix** for false positives or
     deliberate decisions, **Ignore Temporarily** only if there is a genuine
     plan to revisit
4. **Never suggest a change purely to appease Snyk** if it doesn't improve
   actual security or code quality.

See [SECURITY.md](../SECURITY.md) for the scan commands and the fix-vs-ignore
philosophy.

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
