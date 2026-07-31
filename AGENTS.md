# Agent Guidelines — Docker Outside of Docker

You are running inside a VS Code devcontainer. Read this file before doing any
Docker-related work.

> If a `LOCAL.md` file exists in this directory, read it — it contains
> environment-specific setup details for this machine. If it doesn't exist,
> ignore this note.

## Project Facts

Everything below this table is identical across shelfbridge, hubarr and pacearr.
This table is the only place the projects differ — when a rule below refers to
"the port" or "the version files", it means the value here.

| | |
|---|---|
| App name | `shelfbridge` |
| Port | `9303` |
| Host data directory | `/opt/shelfbridge` |
| Container data directory | `/config` |
| Workspace path | `/workspaces/shelfbridge` (same as `app/` on the host at `/opt/vscode/node/shelfbridge/app/`) |
| Version files | `package.json` and `package-lock.json` |
| Checks to run before closing out work | `npm run check` |
| Test suite | Server tests — `npm test`. No Playwright suite. |
| Integrations to flag in review | Audiobookshelf, Hardcover, Grimmory, Chaptarr |

> **Until [#54](https://github.com/Migz93/shelfbridge/issues/54) lands**, a version bump also has to update the hardcoded literal in
> `src/server/routes/settings.ts`. That issue removes the literal so this table becomes accurate on its own.

## Your environment

- You are inside a devcontainer, not on the host machine directly.
- You have access to the host's Docker daemon via Docker-outside-of-Docker
  (DooD). You can run `docker` and `docker compose` commands normally.
- You **cannot** browse the host filesystem. Paths like `/opt/...` that you
  reference in Docker configs exist on the host, not inside this container. Do
  not try to read or write them — just reference them correctly in your Docker
  configuration.

## Host filesystem conventions

`/opt` paths exist on the **host only**. The agent runs inside a devcontainer
and cannot read, list, or inspect anything under `/opt` — do not attempt to
`ls`, `cat`, or browse those paths.

Everything for ShelfBridge lives under a single directory on the host:

```
/opt/shelfbridge/
```

All files the app needs — config, database, logs, whatever — go directly in
there. Do not create subdirectories like `config/`, `data/`, or `logs/` unless
the app itself requires a specific path inside the container. Keep it flat.

## Docker naming conventions

When building images or creating containers for this app, use the app name
directly — do not suffix with `-app`, `-container`, `-service`, or similar.

| Thing | Correct | Incorrect |
|---|---|---|
| Image name | `shelfbridge` | `shelfbridge-app`, `shelfbridge-image` |
| Container name | `shelfbridge` | `shelfbridge-app`, `shelfbridge-container` |
| Compose service name | `shelfbridge` | `app`, `shelfbridge-service` |

If the app gains multiple distinct services (e.g. a frontend and an API), use
`shelfbridge-frontend`, `shelfbridge-api` etc.

## Bind mounts

Bind-mount the entire app directory from the host into the container as a single
volume. Do not use named Docker volumes — the user needs to be able to inspect
and edit files directly on the host.

Map `/opt/shelfbridge` on the host to `/config` inside the container (the app
reads `DATA_DIR=/config`).

Example docker-compose service:

```yaml
services:
  shelfbridge:
    image: shelfbridge
    container_name: shelfbridge
    network_mode: bridge
    ports:
      - "9303:9303"
    volumes:
      - /opt/shelfbridge:/config
    restart: unless-stopped
```

## Where your app code is

Your workspace is mounted at `/workspaces/shelfbridge` inside this container. This
is the same directory as `app/` on the host at `/opt/vscode/node/shelfbridge/app/`.

## Networking

Always use bridge networking — it is the only mode that works reliably with DooD
on this host.

- `docker run`: include `--network bridge`
- Compose services: set `network_mode: bridge`
- `docker build`: do **not** pass `--network`

Do not use `host`, `none`, or custom named networks unless explicitly requested.

## Port

ShelfBridge runs on port **9303**. Always map `9303:9303` — do not
change the port unless the user explicitly asks.

## Summary checklist before creating any container

- [ ] Image name matches the app name
- [ ] Container name matches the app name
- [ ] `/opt/shelfbridge` on the host bind-mounted as a single volume
- [ ] Host directory documented or created in setup steps
- [ ] `--network bridge` / `network_mode: bridge` set

## Rebuilding The Container After Code Changes

Any change to source code requires rebuilding the Docker image and recreating
the container. The app is not hot-reloaded inside the container — the image
bakes in a production build at `docker build` time.

Workspace checks are useful, but they do not verify the running deployment.
Whenever implementation changes need end-to-end verification, rebuild from the
current workspace and recreate the live container from it.

Standard rebuild sequence (run from `/workspaces/shelfbridge`):

```bash
docker build -t shelfbridge .
docker stop shelfbridge && docker rm shelfbridge
docker run -d \
  --name shelfbridge \
  --network bridge \
  -p 9303:9303 \
  -v /opt/shelfbridge:/config \
  --restart unless-stopped \
  shelfbridge
```

Keep the image and container name as `shelfbridge`, use bridge networking, and
preserve the `/opt/shelfbridge:/config` bind mount so configuration, database, and
logs remain intact while the container is recreated.

After the container starts, confirm it is healthy with:

```bash
docker logs shelfbridge 2>&1 | tail -5
```

You should see: `ShelfBridge listening on port 9303`.

---

## GitHub Workflow And Release Process

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
   fixes, chores, CI changes, everything. Never commit new work directly to
   `develop` or `main`.
   - Branch naming: `feat/short-description`, `fix/short-description`,
     `chore/short-description`, `ci/short-description`, `docs/short-description`
2. **Do the work** on that branch. Commit as many times as needed.
3. **Stop at the review gate.** When the work is complete, do not open the PR —
   go to "The Review Gate" below and ask the user how they want to proceed.
4. **Open a PR** from that branch into `develop` using `gh pr create`. This is
   what feeds the release notes — the PR title becomes the changelog entry. Use
   a semantic title (`feat:`, `fix:`, `chore:`, etc.).
5. **Merge the PR** into `develop`. Delete the branch after merging.
6. **Repeat** steps 1–5 for each piece of work. `develop` accumulates all the
   merged PRs.
7. **When ready to release**, create a `chore/bump-version-X.Y.Z` branch from
   `develop`, bump the version files, open a PR into `develop`, and merge it. A
   version bump does not go through the review gate — see below.
8. **Open a PR** from `develop` into `main`. This one **does** go through the
   review gate first. Merge it. This triggers the release-drafter to generate
   release notes from all the PR titles since the last release.
9. **Tag `main`** with `vX.Y.Z` and push the tag. This triggers the Docker build
   workflow.
10. **Publish the GitHub release** — review the auto-generated draft and publish
    it.

---

### The Review Gate (Mandatory)

Work is written and iterated on locally. When the implementer believes the work
is complete **and** the user has confirmed they're happy with it, the agent must
stop and ask the user which way to go. It must never pick on the user's behalf,
and must never open the PR without asking.

The prompt offers three options every time:

> Everything's implemented. Do you want to:
> 1. Go to the cross-AI review (the other agent reviews this diff)
> 2. Run a CodeRabbit CLI review
> 3. Push and open the PR now

Option 3 is always available and always legitimate. Review budgets are finite
and the user is the one who knows what's left — the gate exists so they can
choose, not so reviews become compulsory.

**This gate applies to:** the work-branch PR (step 3 above) and the
`develop` → `main` release PR (step 8, where the changeset is everything
accumulated on `develop` since the last release).

**This gate does not apply to:** the version-bump PR in step 7. It's a version
number in two files with no logic to review — open it directly.

#### Ordering rules

- The cross-AI review is the cheap, repeatable one. CodeRabbit CLI is the
  expensive, rate-limited one. Prefer the cross-AI review first and use
  CodeRabbit sparingly.
- Any CodeRabbit review that results in code changes sends the work **back to
  the cross-AI review**, which must reach a clean full pass again before
  CodeRabbit is considered a second time.
- After any review completes, re-prompt with the options that still make sense —
  never silently proceed to the next step.

---

#### The Cross-AI Review

ShelfBridge is worked on by two AI agents — Claude and Codex — usually in separate
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

Run with `--agent`, which produces structured output intended for an AI agent
rather than the interactive terminal UI:

```bash
coderabbit review --agent --base develop
```

For the `develop` → `main` release PR, use `--base main`. Pass `-c AGENTS.md` to
give the reviewer this file as context.

**Budget: two CLI reviews per changeset.** After the second one on the same
branch, the agent must stop and ask before running another:

> You've used 2 CodeRabbit CLI reviews on this branch. Do you want me to run
> another, or push to the PR?

Never run a third without an explicit yes. Track the count and state it when
reporting results. The counter resets when a new changeset starts.

**After a CodeRabbit review that changed code**, go back to the cross-AI review
and take it to a clean full pass before offering CodeRabbit again. CodeRabbit is
the scarce resource — the cross-AI loop should have caught everything cheap
first, so a CodeRabbit run finding a lot usually means the cross-AI loop was cut
short.

---

### How The Agent Should Interpret The User's Instructions

The user will not always use precise git terminology. They may say things like:

- *"that's ready, push it"* — this means push the current branch to GitHub if
  not already pushed, then go to the review gate
- *"commit that to develop"* — this means open a PR into `develop`, not a direct
  commit
- *"let's get this into develop"* — same as above, open a PR
- *"merge develop into main"* or *"push to main"* — this is a release step, see
  release flow above

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

### GitHub CLI Usage

Use `gh` for all GitHub operations:

- `gh pr create --base develop --title "..." --body "..."`
- `gh pr merge --squash --delete-branch`
- `gh release create vX.Y.Z --generate-notes`
- `gh issue create --title "..." --body "..."`

Always confirm the base branch is correct before creating a PR. Work-branch PRs
target `develop`; only the release PR targets `main`.

---

### AI Sign-Off For GitHub Text

Any text an agent writes that lands on GitHub — PR descriptions, issue bodies,
PR comments, review responses — must be attributable. Sign off with the agent's
name at the end so a human reading the thread later knows what wrote it.

Commit messages carry a `Co-Authored-By` trailer instead; don't duplicate the
sign-off there.

---

### Pull Request Description Format

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

- Call out explicitly if the change affects: release behaviour, Docker
  publishing, auth, database schema, Audiobookshelf/Hardcover/Grimmory/Chaptarr integrations, or user-visible
  setup

---

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

### Pull Request Conventions

- PR titles are semantic and become changelog entries: `feat: add poster
  caching`, `fix: correct sync ordering`, `chore: bump to 1.2.0`
- One logical change per PR. Split unrelated work.
- Squash-merge into `develop` so each PR is one commit in the history.
- Delete the branch after merging.

---

### Release Process

When the user says it's time to release:

1. Confirm the version number with the user — patch, minor, or major
2. Create `chore/bump-version-X.Y.Z` from `develop`
3. Update the version files listed in Project Facts
4. Open a PR from that branch into `develop` and merge it
5. Open a PR from `develop` into `main`, take it through the review gate, and
   merge it
6. Push the tag `vX.Y.Z` from `main`
7. Review the release-drafter draft on GitHub and publish it

Do not invent the version — always confirm with the user if ambiguous.

**Tag format:** `vX.Y.Z` — always from `main`, never from `develop`.

---

### Agent Behaviour — Snyk

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

See `SECURITY.md` for the full Snyk tooling guide, scan commands, and
philosophy.

---

### Implementation Expectations — Logging And Comments

When implementing new functionality, treat logging and code clarity as part of
the feature work, not as optional polish.

#### Checks

Run the checks listed in Project Facts before closing out work. Keep any tooling
changes practical and correctness-focused — do not introduce broad style-only
rule churn as part of unrelated feature work.

#### Logging

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

#### Code comments

- Add explanatory comments where they materially improve readability or
  maintainability, especially around non-obvious logic, edge cases, or decisions
  that are easy to misread later
- Comments should explain intent and reasoning, not restate what the code
  literally does
- When a future maintainer might reasonably ask "why is this written this way?",
  prefer a short comment that answers that question at the point of
  implementation

#### Technical docs

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

---

### Tests

`TESTING.md` is the source of truth for what this repo's test setup is, how to
run it, and what each test covers. Read it rather than assuming — the three
projects do not have identical test infrastructure.

**When implementing a new feature**, before closing out the work consider
whether a test makes sense for it. If it does, suggest it to the user — describe
what you'd test and ask if they want it added. Don't add tests silently; always
check first. When a test is agreed and written, add a row for it in the relevant
table in `TESTING.md`.

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
