<!-- shared: content — keep in sync across Migz93 self-hosted apps; only Project Facts values differ -->

# Agent Guidelines

Read this file before doing any work in this repo.

Everything here is **always relevant** — environment, conventions, and the gates
you have to stop at. Material that only matters at a particular moment (opening
a PR, cutting a release, triaging a security finding) lives in `docs/` instead, and
the table below says when to go and read it.

> If a `LOCAL.md` file exists in this directory, read it — it contains
> environment-specific setup details for this machine. If it doesn't exist,
> ignore this note.

## Project Facts

The guidance in this file is shared across Hubarr, Pacearr and Shelfbridge.
Use the values in this table wherever a rule refers to the app name, port,
data directory, workspace or version files.

| | |
|---|---|
| App name | `shelfbridge` |
| Port | `9303` |
| Host data directory | `/opt/shelfbridge` |
| Container data directory | `/config` |
| Workspace path | `/workspaces/shelfbridge` |
| Version files | `package.json` and `package-lock.json` |
| Checks to run before closing out work | `npm run check` |
| Test suite | Server tests — `npm test` (also run in CI). Playwright end-to-end suite — `npm run test:e2e` (needs a live instance). |
| Integrations to flag in review | Audiobookshelf, Hardcover, Grimmory, Chaptarr |

## Before You Start — What To Read

If the task you're about to do appears here, open the matching file **first**.
Don't guess at these — they contain conventions you will otherwise get wrong.

| If you're about to… | Read |
|---|---|
| Open a PR, or write PR/issue text | [docs/workflow.md](docs/workflow.md) |
| Cut a release or bump a version | [docs/workflow.md](docs/workflow.md) |
| Act on a security finding (code scanning or Dependabot) | [docs/workflow.md](docs/workflow.md) |
| Add logging or comments to new code | [docs/workflow.md](docs/workflow.md) |
| Add or change tests | [TESTING.md](TESTING.md) |
| Change the database schema | [docs/architecture.md](docs/architecture.md) |
| Pick a colour for any UI element | [docs/colour-scheme.md](docs/colour-scheme.md) |
| Change Docker, ports, or bind mounts | [docs/deployment.md](docs/deployment.md) |
| Add background cleanup or retention | [docs/maintenance.md](docs/maintenance.md) |

[docs/README.md](docs/README.md) indexes everything else, including the docs that
are specific to this app.

**Where new information belongs**, when you learn something worth writing down:

| Kind of information | Where it goes |
|---|---|
| Always true, needed on every task | this file |
| True only while doing a particular kind of work | the matching `docs/*.md` |
| True only for one branch or issue | that issue or PR, not a file |

## Where You're Running

For implementation work, check the branch, dirty state and concurrent use,
then start the app's devcontainer using the commands in `LOCAL.md` when present.
Edit source, install dependencies, and run application checks and tests inside
the devcontainer as its development user. Run authenticated Git operations
and CodeRabbit outside the devcontainer from the checkout you are working in.
Run Docker builds and container management on the intended Docker host.

Before deployment work, identify the deployment host from `LOCAL.md` or the
owner's instructions. If the host is unclear or its Docker daemon is
unreachable, stop the affected step and report it. Never create the live data
directory on another host or count type checking alone as container validation.
For browser tests, use a [URL reachable from the devcontainer](TESTING.md#reaching-the-app-from-a-devcontainer).

The development image definition is `.devcontainer/Dockerfile`. The devcontainer
mounts the checkout at the workspace path in Project Facts. Keep machine-specific
paths and launcher commands in the ignored `LOCAL.md`.

On a fresh checkout without a local launcher, use a Dev Container client on the
Docker host. If `.devcontainer/devcontainer.json` is absent, copy
`.devcontainer/devcontainer.json.example` to that path. Open the checkout in the
container. The example uses BuildKit to build the repository's Dockerfile and
installs dependencies and Chromium on creation.

To migrate an existing local config, compare it with the example. Replace the
old `image` entry with the example's `build` settings. Remove any fixed
`--name` argument so the Dev Container client can name each checkout's
container. Remove Docker socket mounts and any Docker-outside-of-Docker
feature, then adopt the disposable `node_modules` volume and setup command.
Set `remoteUser` to `node` and verify that its UID and GID allow it to write to
the checkout. Preserve unrelated local settings
and point the volume at `node_modules` under your workspace folder. Check for
concurrent use, then rebuild the devcontainer so the new mounts and image take
effect. When removing a container manually, stop it first and use `docker rm -v`
to remove its disposable dependency volume.

## Live Container Conventions

- Use the app name for the image, container and Compose service.
- Use the default bridge for standalone containers and the port from Project
  Facts. Preserve existing Compose networking. For Docker builds, use the
  default build network.
- Bind the host data directory as a single mount at the container data directory.
  Keep the data directory flat apart from subdirectories created by the app.
- Inspect existing runtime settings before live replacement. Preserve the data
  mount, port mapping, network, restart policy and overrides. Keep Compose-managed
  deployments under Compose. See [live replacement](TESTING.md#live-replacement-and-verification).
- For disposable containers, follow [TESTING.md](TESTING.md) and use fresh
  storage with a unique name.

## Rebuilding The Container After Code Changes

For implementation changes to the running app or image, use the
[Manual Smoke Test](TESTING.md#manual-smoke-test) procedure. Build a uniquely
tagged candidate on the Docker host and verify it in a disposable container
with fresh storage. After the required checks and disposable startup and health
checks pass, the owner's default is to replace the running app with the
**exact tested image** and verify it. An instruction to stop at validation or skip deployment
takes precedence. Preserve live data and runtime settings.

Documentation-only and review-only tasks do not trigger this deployment flow.
The PR and review gates below still apply.

---

## GitHub Workflow

The gates below are mandatory and apply on every piece of work. The mechanical
detail — PR body format, `gh` commands, release steps, security findings —
lives in [docs/workflow.md](docs/workflow.md).

### Before Starting Any Work — Branch Check (Mandatory)

Before writing or editing any code, **always check the current branch** with
`git branch --show-current`. Then act on what you find:

| Current branch | Situation | Action |
|---|---|---|
| `develop` | On the integration branch | Create a new `type/description` branch from `develop` and switch to it |
| `main` | On the stable branch | Create a new `type/description` branch from `develop` (not main) and switch to it |
| `feat/*`, `fix/*`, `chore/*` etc. | Already on a work branch | Continue work here — no new branch needed |
| Something unexpected | Unfamiliar branch | Ask the user before proceeding |

Do this **before** making any edits, installs, or file changes. Never start work
and then create the branch after the fact.

---

### The Full Development Flow

This is the required workflow for all changes. Follow it every time, in order:

```
type/branch-name branch → PR into develop → develop → chore/bump-version → PR into develop → PR into main → tag → release
```

**Step by step:**

1. **Start a new branch** from `develop` for every piece of work — features, bug
   fixes, chores, CI changes, everything — unless the branch check above found
   you already on this work's branch. Never commit new work directly to
   `develop` or `main`.
   - Branch naming: `feat/short-description`, `fix/short-description`,
     `chore/short-description`, `ci/short-description`, `docs/short-description`
2. **Do the work** on that branch. Commit as many times as needed.
3. **Stop at the review gate.** When the work is complete, do not open the PR —
   go to "The Review Gate" below and ask the user how they want to proceed.
4. **Open a PR** from that branch into `develop`. This is what feeds the release
   notes — the PR title becomes the changelog entry. Use a semantic title
   (`feat:`, `fix:`, `chore:`, etc.). Open it as a draft; see
   [docs/workflow.md](docs/workflow.md)'s Pull Request Conventions for when to
   mark it ready for review.
5. **Merge an ordinary work PR** into `develop` with a squash merge
   (`gh pr merge --squash --delete-branch`). Delete the branch after merging.
   Use a merge commit for ancestry-reconciliation PRs; do not delete their
   branch automatically.
6. **Repeat** steps 1–5 for each piece of work. `develop` accumulates all the
   merged PRs.
7. **When ready to release**, create a `chore/bump-version-X.Y.Z` branch from
   `develop`, bump the version files, open a PR into `develop`, and squash-merge
   it. A version bump does not go through the review gate — see below.
8. **Open a draft PR** from `develop` into `main`, then take it through the
   narrow [Release PR Review](#release-pr-review). Mark it ready only once
   release-safety blockers are resolved or accepted and no further fixes are
   pending. Merge it with a merge commit (`gh pr merge --merge`),
   never a squash merge. This preserves `develop` ancestry on `main` and avoids
   future release conflicts. This triggers the release-drafter to generate
   release notes from all the PR titles since the last release.
9. **Tag the resulting release merge commit on `main`** with `vX.Y.Z` and push
   the tag. This triggers the Docker build workflow.
10. **Publish the GitHub release** — review the auto-generated draft and publish
    it.

---

### The Review Gate (Mandatory)

Work is written and iterated on locally. When the implementer believes the work
is complete **and** the user has confirmed they're happy with it, the agent must
stop and ask the user which way to go. It must never pick on the user's behalf,
and must never open the PR without asking.

For a work-branch PR, the prompt offers three options:

> Everything's implemented. Do you want to:
> 1. Go to the cross-AI review (the other agent reviews this diff)
> 2. Run a CodeRabbit CLI review
> 3. Push and open the PR now

Option 3 is always available and always legitimate. Review budgets are finite
and the user is the one who knows what's left — the gate exists so they can
choose, not so reviews become compulsory.

**This gate applies to:** the work-branch PR (step 3 above).

The `develop` → `main` release PR follows the [Release PR
Review](#release-pr-review) after it is opened as a draft (step 8), because the
narrow review runs on that PR.

**This gate does not apply to:** the version-bump PR in step 7. It's a version
number in two files with no logic to review — open it directly.

#### Ordering rules

- The cross-AI review is the cheap, repeatable one. For work branches,
  CodeRabbit CLI is the expensive, rate-limited option; prefer cross-AI review
  first and use CodeRabbit sparingly. Release PRs use the narrow release PR
  review instead.
- Any CodeRabbit CLI review for a work branch that results in code changes sends
  the work **back to the cross-AI review**, which must reach a clean full pass
  again before another CodeRabbit CLI review is considered.
- After any review completes, re-prompt with the options that still make sense —
  never silently proceed to the next step.

---

#### The Cross-AI Review

The app is worked on by two AI agents — Claude and Codex — usually in separate
chat sessions, with the user relaying messages between them. The changeset goes
through a review pass by the *other* agent.

**Roles are relative, not fixed to a specific AI.** Whichever agent wrote the
code is "the implementer"; the other agent is "the reviewer." If Codex
implemented, Claude reviews, and vice versa — this section applies symmetrically
regardless of which agent is reading it right now.

**The review loop** (the implementer drives this state machine — never wait for
the user to ask "what's next" or "can you do a full review"):

| Last review was... | Result | Next step |
|---|---|---|
| Full | Clean | The changeset is cleared — return to the review gate and offer the remaining options |
| Full | Findings | Resolve each finding (see below), then request a **delta review** scoped to just the fix/disposition |
| Delta | Clean | Automatically request a new **full review** from scratch — a clean delta is never the finish line |
| Delta | Findings | Resolve each finding (see below), then request another **delta review** |

In words: the first review of a changeset is always a full review of the whole
diff. From there, keep alternating — a delta review after every round of fixes,
and once a delta review comes back clean, immediately trigger one more full
review from scratch, offered without being asked, before considering the
changeset done. Only a **full** review pass coming back clean clears it; a clean
delta review alone is never sufficient. Keep alternating full ⇄ delta-until-clean
until a full pass finds nothing new. This catches things a narrow delta view
misses (e.g. the same unsafe pattern repeated elsewhere in the codebase) while
keeping most rounds cheap.

**A review result is tied to the exact commit and base it reviewed, not to the
branch in general.** Always state the commit SHA being reviewed *and* the base
commit it was diffed against, in both the review request and the response. If
either moves before the PR is opened — a new commit is pushed, or the base
shifts because more work merged into `develop` — the prior result is void, even
if it was "Clean." Request a new review: a delta review if only expected fix
commits were added, a full review if the base itself changed underneath the
changeset.

**What counts as a finding (and what doesn't):** a finding is something
incorrect, inconsistent with the rest of the codebase, or likely to mislead a
future reader. Purely optional suggestions — stylistic preference, an
alternative phrasing with no material difference, a nice-to-have that doesn't
fix an actual problem — are not findings. The reviewer should call these out as
optional explicitly; the implementer can take or leave them freely, and doing
either does not block a "Clean" result or require a delta review.

**Resolving a finding:** "findings" doesn't mean every suggestion must be
applied as-is. If the implementer agrees, fix it. If the implementer disagrees,
it should respond to the reviewer with its reasoning and evidence instead of
silently applying (or silently ignoring) the suggestion. The reviewer
re-evaluates against that reasoning. If they still disagree after that exchange,
surface it to the user for a decision — neither agent unilaterally overrides the
other. Whatever the outcome — a code change or a deliberate no-change — send it
through the next delta review like any other resolved finding, so the reviewer
confirms the final state before the next full pass.

**Minimal effort for the user:** their job is only to paste the prompt into the
other agent's chat and paste the response back here. The implementer tracks
review state (was the last request a delta or a full pass? did it come back
clean?) and always produces the next prompt proactively.

Push the branch to GitHub whenever the reviewer needs to see it — the diff can
also be pasted directly into the prompt. Pushing early is fine. What matters is
that the **PR itself** is not opened until the gate says so.

---

#### The CodeRabbit CLI Review

Run from the host checkout with `--agent`, which produces structured output intended for an AI agent
rather than the interactive terminal UI:

```bash
coderabbit review --agent --base develop
```

This CLI review is for work-branch changes against `develop`. Pass `-c
AGENTS.md` to give the reviewer this file as context. The separate manual
periodic review below is the only broad `develop`-against-`main` CLI review;
the `develop` → `main` release PR instead follows the narrow
[Release PR Review](#release-pr-review).

**Runs are slow and silent.** A review can take 10–15 minutes with no output —
it looks stuck, but it's working. Check in every 5 minutes; if nothing has
happened after 30 minutes, tell the user.

**Budget: aim for two CLI reviews per changeset or manually requested periodic
review.** This is not a hard cap. After the second review, the agent must stop
and ask before running another:

> You've used 2 CodeRabbit CLI reviews for this changeset or periodic review.
> Do you want me to run another, or proceed without one?

Never run a third without an explicit yes. Track the count and state it when
reporting results. The counter resets when a new changeset or periodic review
starts.

**After a CodeRabbit review that changed code**, go back to the cross-AI review
and take it to a clean full pass before offering CodeRabbit again. CodeRabbit is
the scarce resource — the cross-AI loop should have caught everything cheap
first, so a CodeRabbit run finding a lot usually means the cross-AI loop was cut
short.

---

### Periodic Develop-to-Main Review

This is a manual, broad review of the accumulated `develop` changes against
`main`. It is **not** scheduled, automated, a release gate, or a replacement
for the normal review gate above. Only start it when the project owner asks.

Run it with the shared guidance as context:

```bash
coderabbit review --agent --base main -c AGENTS.md
```

The two-review target in [The CodeRabbit CLI Review](#the-coderabbit-cli-review)
also applies to each periodic review.

Initially triage the findings and report recommendations to the project owner
before creating any GitHub issues. Identify important findings, group related
ones, suggest which should become normal issues, and distinguish minor or
optional findings from intentional, irrelevant, false-positive, or unsuitable
ones. Explain the reasoning for each disposition.

Do not create issues automatically. After the owner approves the proposed
follow-up work, create normal GitHub issues using the repository's existing
labels. Do not add review-specific labels. Intentional or unwanted findings may
be accepted without an issue; record that disposition in the triage report.

---

### Release PR Review

The CodeRabbit review on a normal `develop` → `main` release PR is a separate,
narrow release-safety check. Trigger it on the PR when necessary, and only act
on findings that could make the release unsafe: application failure, failed
startup or deployment, data loss or corruption, a broken database migration, a
serious security problem, or a serious failure in a core integration listed in
the `Integrations to flag in review` row of the Project Facts table.

Non-critical findings are not release blockers. After project-owner approval,
turn them into normal future-work issues or explicitly accept them; do not
automatically open additional release PRs for them.

If a release-safety blocker requires code changes, use the normal work-branch
flow: create a fix branch from `develop`, take its PR through the review gate,
and merge it into `develop`. The draft release PR then includes the fix; repeat
the release PR review before marking it ready. Do not commit the fix directly
to `develop`, `main`, or the release PR.

---

### Close Out Finished Or Cancelled Work

After the work PR merges or the owner cancels the work, check that the task
checkout is clean and available for cleanup. Switch back to the integration
branch and fast-forward it. Delete leftover branches
for this task on the server, GitHub and available clients once you have
verified the work was merged or the owner explicitly discarded it. Check
squash merges against the reviewed PR head. A PR closed without merging
requires confirmation that its work was discarded before deleting its branch.
Preserve unrelated branches and unsynchronized work. Report any cleanup that
needs to happen on a disconnected client.

When the PR closes or the owner cancels, check for concurrent use before
removing any task resource, including when a PR closes without merging.
Defer cleanup for resources another chat or process is using. Follow
[disposable test cleanup](TESTING.md#disposable-test-cleanup) for leftovers.

Remove the devcontainer and its disposable dependency volume with the local
launcher when available. Otherwise, find it through the Dev Container client
or filter by its `devcontainer.local_folder` label using the absolute checkout
path. Verify the workspace mount, stop that container, and remove it with
`docker rm -v`. Preserve the checkout and live deployment. Create the
devcontainer again when starting the next implementation task.

### Branch Rules Summary

| Branch | Purpose | Direct commits? |
|---|---|---|
| `main` | Stable, released code | Never |
| `develop` | Integration branch | Never — PRs only |
| `feat/*` | New features | Yes, this is where work happens |
| `fix/*` | Bug fixes | Yes |
| `chore/*` | Maintenance, version bumps, dependencies | Yes |
| `ci/*` | CI/workflow changes | Yes |
| `docs/*` | Documentation only | Yes |

---

### How The Agent Should Interpret The User's Instructions

The user will not always use precise git terminology. They may say things like:

- *"that's ready, push it"* — this means push the current branch to GitHub if
  not already pushed, then go to the review gate
- *"commit that to develop"* — this means open a PR into `develop`, not a direct
  commit
- *"let's get this into develop"* — same as above, open a PR
- *"merge develop into main"* or *"push to main"* — this is a release step, see
  the release flow in [docs/workflow.md](docs/workflow.md)

**When the user's instruction is ambiguous**, the agent should either:

- Interpret it charitably as the correct workflow step and proceed, explaining
  what it's doing ("your workflow says we open a PR to develop from this branch,
  so I'll do that now"), or
- Push back briefly if genuinely unclear ("just to check — did you want me to
  open a PR into develop, or push directly? Your workflow normally uses PRs.")

**Never silently commit directly to `develop` or `main`** when the user is
describing work on a feature or fix. That bypasses PRs and breaks the release
notes. If the user explicitly asks for a direct push, that's their call — do it
without re-litigating, but say what you're doing.

---

### Technical Docs Are Part Of The Work

- Treat technical documentation as part of the implementation for major or
  long-lived changes, not optional follow-up work
- If a change affects architecture, sync flow, persistence, external
  integrations, cleanup/deletion behaviour, or runtime behaviour in a lasting
  way, update the relevant file under `docs/` in the same branch/PR
- Start from `docs/README.md` when deciding where documentation belongs
- If no existing technical doc fits the change cleanly, add a new topic doc
  under `docs/` and link it from `docs/README.md`
- Keep `docs/` files to operational facts — tables, short steps, commands.
  Detailed rationale belongs in code comments next to the code, not in prose
- A doc whose first line carries a `shared: content` marker is kept identical
  across hubarr, pacearr and shelfbridge — change it in all of them, or not at all

---

### Tests

`TESTING.md` is the source of truth for what this repo's test setup is, how to
run it, and what each test covers. Read it rather than assuming — the three
projects do not have identical test infrastructure.

There are two layers, and they catch different things:

| Layer | Catches | Needs |
|---|---|---|
| **Server tests** | Failures that are invisible in the UI — the wrong rows deleted, a dry-run leaking a real write, a failed API call mistaken for "the library is empty", a migration corrupting data | Nothing running. A throwaway SQLite database that the test seeds itself, plus `fetch` or the source adapters swapped for fakes |
| **Playwright** | What the user sees — routes loading, filters applying, live refresh, auth redirects | A live, fully configured instance |

They are not redundant and neither substitutes for the other. Reach for a server
test when the failure would be **silent and destructive**; reach for Playwright
when the failure would be **visible**.

**When implementing a new feature**, before closing out the work consider
whether a test makes sense for it, at either layer. If it does, suggest it to
the user — describe what you'd test and which layer it belongs at, then ask if
they want it added. Don't add tests silently; always check first. When a test is
agreed and written, add a row for it in the relevant table in `TESTING.md`.

If the layer that fits is one this repo has not wired up yet, say so and point at
the issue tracking it. Do not force the test into the other layer to avoid the
gap — a UI test standing in for a logic test proves much less than it appears to.

---

### Agent Behaviour Expectations

Actively guide the workflow rather than waiting for perfect instructions:

- When the user starts new work: create a branch from `develop` automatically
- When the work is complete: stop at the review gate and offer the three options
- When a review pass finishes: report the result and re-prompt with what's left
- When the user asks about releasing: confirm whether they mean prep, tag, or
  both
- When the user asks for a version bump: confirm patch/minor/major if not stated
- Track review state yourself — which pass was last, whether it was clean, how
  many CodeRabbit runs have been used
