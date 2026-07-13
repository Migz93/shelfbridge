# Agent Guidelines — Docker Outside of Docker

You are running inside a VS Code devcontainer. Read this file before doing any Docker-related work.

> If a `LOCAL.md` file exists in this directory, read it — it contains environment-specific setup details for this machine. If it doesn't exist, ignore this note.

## Your environment

- You are inside a devcontainer, not on the host machine directly.
- You have access to the host's Docker daemon via Docker-outside-of-Docker (DooD). You can run `docker` and `docker compose` commands normally.
- You **cannot** browse the host filesystem. Paths like `/opt/...` that you reference in Docker configs exist on the host, not inside this container. Do not try to read or write them — just reference them correctly in your Docker configuration.

## Host filesystem conventions

`/opt` paths exist on the **host only**. The agent runs inside a devcontainer and cannot read, list, or inspect anything under `/opt` — do not attempt to `ls`, `cat`, or browse those paths.

Everything for an app lives under a single directory on the host:

```
/opt/shelfbridge/
```

All files the app needs — config, database, logs, whatever — go directly in there. Do not create subdirectories like `config/`, `data/`, or `logs/` unless the app itself requires a specific path inside the container. Keep it flat.

## Docker naming conventions

When building images or creating containers for this app, use the app name directly — do not suffix with `-app`, `-container`, `-service`, or similar.

| Thing | Correct | Incorrect |
|---|---|---|
| Image name | `shelfbridge` | `shelfbridge-app`, `shelfbridge-image` |
| Container name | `shelfbridge` | `shelfbridge-app`, `shelfbridge-container` |
| Compose service name | `shelfbridge` | `app`, `shelfbridge-service` |

If the app has multiple distinct services (e.g. a frontend and an API), use `shelfbridge-frontend`, `shelfbridge-api` etc.

## Bind mounts

Bind-mount the entire app directory from the host into the container as a single volume. Do not use named Docker volumes — the user needs to be able to inspect and edit files directly on the host.

Example docker-compose service:

```yaml
services:
  shelfbridge:
    image: shelfbridge
    container_name: shelfbridge
    volumes:
      - /opt/shelfbridge:/config
    restart: unless-stopped
```

Map `/opt/shelfbridge` on the host to `/config` inside the container (the app reads `DATA_DIR=/config`).

## Where your app code is

Your workspace is mounted at `/workspaces/shelfbridge` inside this container. This is the same directory as `app/` on the host at `/opt/vscode/node/shelfbridge/app/`.

## Networking

Always use bridge networking — it is the only mode that works reliably with DooD on this host.

- `docker run`: include `--network bridge`
- Compose services: set `network_mode: bridge`
- `docker build`: do **not** pass `--network`

Do not use `host`, `none`, or custom named networks unless explicitly requested.

## Port

ShelfBridge runs on port **9303**. Always map `9303:9303` — do not change the port unless the user explicitly asks.

## Summary checklist before creating any container

- [ ] Image name matches the app name (`shelfbridge`)
- [ ] Container name matches the app name (`shelfbridge`)
- [ ] `/opt/shelfbridge` on the host bind-mounted as `/config`
- [ ] `--network bridge` / `network_mode: bridge` set
- [ ] Port `9303:9303` mapped

---

## Rebuilding The Container After Code Changes

Any change to source code requires rebuilding the Docker image and recreating the container. The app is not hot-reloaded inside the container — the image bakes in a production build at `docker build` time.

**When a rebuild is required:**
- Any edit to files under `src/`
- Changes to `package.json`, `package-lock.json`, or `Dockerfile`
- Any change that would affect the running server or UI

**Standard rebuild sequence (run from `/workspaces/shelfbridge`):**

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

This produces exactly the same container configuration every time:
- Image: `shelfbridge`
- Container: `shelfbridge`
- Port: `9303:9303`
- Config/data volume: `/opt/shelfbridge` → `/config`
- Network: `bridge`
- Restart policy: `unless-stopped`

After the container starts, confirm it is healthy with:

```bash
docker logs shelfbridge 2>&1 | tail -5
```

You should see: `ShelfBridge listening on port 9303`.

---

## GitHub Workflow And Release Process

> **Early development note:** This GitHub/branch workflow can be skipped for now. ShelfBridge is still early in development and is not actually on GitHub yet, so agents may work directly in the current workspace until the repository is published.

### Before Starting Any Work — Branch Check (Mandatory)

Before writing or editing any code, **always check the current branch** with `git branch --show-current`. Then act on what you find:

| Current branch | Situation | Action |
|---|---|---|
| `develop` | On the integration branch | Create a new `type/description` branch from `develop` and switch to it |
| `main` | On the stable branch | Create a new `type/description` branch from `develop` (not main) and switch to it |
| `feat/*`, `fix/*`, `chore/*` etc. | Already on a work branch | Continue work here — no new branch needed |
| Something unexpected | Unfamiliar branch | Ask the user before proceeding |

Do this **before** making any edits, installs, or file changes. Never start work and then create the branch after the fact.

---

### The Full Development Flow

This is the required workflow for all changes. Follow it every time, in order:

```
type/branch-name branch → PR into develop → develop → chore/bump-version → PR into develop → PR into main → tag → release
```

**Step by step:**

1. **Start a new branch** from `develop` for every piece of work — features, bug fixes, chores, CI changes, everything. Never commit new work directly to `develop` or `main`.
   - Branch naming: `feat/short-description`, `fix/short-description`, `chore/short-description`, `ci/short-description`, `docs/short-description`

2. **Do the work** on that branch. Commit as many times as needed. Push the branch to GitHub.

3. **Open a PR** from that branch into `develop` using `gh pr create`. This is what feeds the release notes — the PR title becomes the changelog entry. Use a semantic title (`feat:`, `fix:`, `chore:`, etc.).

4. **Merge the PR** into `develop`. Delete the branch after merging.

5. **Repeat** steps 1–4 for each piece of work. `develop` accumulates all the merged PRs.

6. **When ready to release**, create a `chore/bump-version-X.Y.Z` branch from `develop`.

7. **Bump the version** in `package.json`, `package-lock.json`, and `src/server/routes/settings.ts` (hardcoded in the `/about` endpoint), open a PR from that branch into `develop`, and merge it.

8. **Open a PR** from `develop` into `main`. Merge it.

9. **Tag `main`** with `vX.Y.Z` and push the tag.

10. **Publish the GitHub release** — review the auto-generated draft and publish it.

---

### How The Agent Should Interpret The User's Instructions

The user will not always use precise git terminology. They may say things like:

- *"that's ready, push it"* — this means push the current branch to GitHub if not already pushed, then open a PR from it into `develop`
- *"commit that to develop"* — this means open a PR into `develop`, not a direct commit
- *"let's get this into develop"* — same as above, open a PR
- *"merge develop into main"* or *"push to main"* — this is a release step, see release flow above

**When the user's instruction is ambiguous**, the agent should either:
- Interpret it charitably as the correct workflow step and proceed, explaining what it's doing, or
- Push back briefly if genuinely unclear ("just to check — did you want me to open a PR into develop, or push directly? Your workflow normally uses PRs.")

**Never silently commit directly to `develop` or `main`** when the user is describing work on a feature or fix. That bypasses PRs and breaks the release notes.

---

### GitHub CLI Usage

For all GitHub-related work, use `gh` as the default tool. Use it for:

- opening PRs (`gh pr create`)
- checking PR status, checks, and mergeability
- merging PRs (`gh pr merge`)
- inspecting workflow runs and CodeQL alerts
- creating and publishing releases

Prefer `gh` over inferring GitHub state from local git — it gives the authoritative picture of what is open, merged, or failing on GitHub.

### AI Sign-Off For GitHub Text

Any text the agent sends to GitHub or stores in git history as authored output must end with an explicit AI sign-off.

This applies to **body text and comments only** — never to titles or subjects:

- commit messages
- pull request descriptions (body)
- issue comments
- pull request comments
- pull request reviews
- any other agent-authored text posted to GitHub

**Do not** append the sign-off to PR titles, issue titles, or any other subject/headline field.

Use the sign-off that matches the agent:

- `🤖 Generated with Codex`
- `🤖 Generated with Claude Code`

If the user explicitly asks for a different agent label, follow that request. Otherwise, always append the correct sign-off at the end of the text.

---

### Pull Request Description Format

Every PR description must follow this structure. Sparse descriptions (a few bullets with no detail) are not acceptable — include enough information that a reviewer can understand what changed and how to verify it without reading the diff first.

```
## Summary

A short paragraph or bullet list explaining what this PR does and why. Mention the user-facing or system-level effect, not just the implementation detail.

## Changes

A file-by-file or component-by-component breakdown of what was modified and what each change does. Group related changes together. This section should give a reviewer a map of the diff before they open it.

## Test plan

A markdown checklist of concrete steps to verify the change works correctly. Each item should be specific enough that someone unfamiliar with the code can follow it — not just "test the feature" but "open Settings → Jobs, change the interval, trigger a sync, and confirm the log shows the updated value".

🤖 Generated with [Agent Name]
```

**Minimum bar:** every PR must have all three sections. A test plan with only one item is fine if the change is small; a changes section with a single file is fine too. What is not acceptable is omitting sections or writing placeholder text like "verify it works".

**Issue linking:** if the PR was prompted by an open GitHub issue, include a `Closes #<number>` line in the description body (not the title). GitHub will automatically close the issue when the PR merges. For example:

```
Closes #42
```

---

### Branch Rules Summary

| Branch | Purpose | How things get in |
|--------|---------|-------------------|
| `feat/*`, `fix/*`, `chore/*` etc. | Active work | Direct commits |
| `develop` | Integration | PRs from `feat/*`, `fix/*`, `chore/*`, `ci/*`, `docs/*` etc. |
| `main` | Stable/released | PRs from `develop` only |

- Do not push new feature or fix work directly to `develop` or `main`
- Do not open PRs directly from feature branches into `main`

---

### Pull Request Conventions

- Use semantic PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `ci:`
- Follow the PR description format defined above (Summary / Changes / Test plan)
- Call out explicitly if the change affects: release behaviour, Docker publishing, auth, database schema, or user-visible setup

---

### Release Process

When the user says it's time to release:

1. Confirm the version bump size — ask for patch / minor / major if not stated
2. Create a `chore/bump-version-X.Y.Z` branch from `develop`
3. Update the version in all version files:
   - `package.json` — `"version"` field
   - `package-lock.json` — `"version"` and package metadata
   - `src/server/routes/settings.ts` — the hardcoded `"0.1.0"` string in the `/about` endpoint
4. Open a PR from that branch into `develop` and merge it
5. Open a PR from `develop` into `main` and merge it
6. Push the tag `vX.Y.Z` from `main`
7. Publish the GitHub release

**Tag format:** `vX.Y.Z` — always from `main`, never from `develop`.

Do not invent the version — always confirm with the user if ambiguous.

---

### Agent Behaviour — Snyk

When working through Snyk findings:

1. **Always explain the finding first** — describe what Snyk flagged, why it flagged it, and whether it is a genuine issue or a false positive before suggesting any action.

2. **Recommend Fix or Won't Fix honestly** — if fixing the issue would require writing worse code (less readable, against best practice, or purely to satisfy static analysis), say so clearly and recommend Won't Fix instead.

3. **When recommending Won't Fix**, always provide:
   - A plain-English comment the user can paste into the Snyk GUI explaining why the code is safe
   - The correct Snyk category to select: **Won't Fix** for false positives or deliberate decisions, **Ignore Temporarily** only if there is a genuine plan to revisit

4. **Never suggest a change purely to appease Snyk** if it doesn't improve actual security or code quality.

See `SECURITY.md` for the full Snyk tooling guide, scan commands, and philosophy.

---

## Implementation Expectations — Logging And Comments

When implementing new functionality, treat logging and code clarity as part of the feature work, not as optional polish.

### Logging

- Consider logging for every new feature, workflow, integration, or background process where runtime visibility would help with debugging, support, or diagnosing failures
- Think through logging across the full implementation path, not just one layer — for example request handling, service logic, scheduled work, external API calls, and error paths where relevant
- Add logs that are useful and intentional: enough context to understand what happened, without spamming noisy or redundant messages
- Prioritise logs around important state changes, failures, retries, skipped work, and external-system interactions when those would otherwise be hard to trace
- Use the appropriate log level: `info` for normal significant events (sync started/completed, item matched), `warn` for recoverable failures or skipped work, `error` for failures that need attention, and `debug` for diagnostic detail
- Pass structured data as the second `meta` argument rather than interpolating values into the message string (e.g. `logger.info("Sync complete", { count: 5 })` not a template string like `Sync complete: ${count}`)
- If rewriting an existing section of code that has no logging, add appropriate logging at that point — the absence of logs is often what made the original issue hard to diagnose

### Code comments

- Add explanatory comments where they materially improve readability or maintainability, especially around non-obvious logic, edge cases, or decisions that are easy to misread later
- Keep comments clear and purposeful; do not add comments that only restate what the code already says
- When a future maintainer might reasonably ask "why is this written this way?", prefer a short comment that answers that question at the point of implementation

### Technical docs

- Treat technical documentation as part of the implementation for major or long-lived changes, not optional follow-up work
- If a change affects architecture, sync flow, persistence, external integrations, or runtime behaviour in a lasting way, update the relevant file under `docs/` in the same branch/PR
- Start from `docs/README.md` when deciding where documentation belongs
- If no existing doc fits the change cleanly, add a new topic doc under `docs/` and link it from `docs/README.md`

---

### End-to-End Tests

See `TESTING.md` for the current verification guide. ShelfBridge does not yet have the same Playwright suite as Hubarr, but browser-level tests should follow the same process once they are added:

- Keep end-to-end test files under `tests/playwright/` as `*.spec.ts`
- Run them against a live running ShelfBridge instance rather than a mocked app
- Store any local auth/session setup in gitignored files such as `.env.playwright` and `tests/playwright/.auth/storageState.json`
- Keep Playwright reports and test artifacts under `tests/` so the repo root stays tidy
- Document new test files and what they cover in `TESTING.md`

**When implementing a new feature**, before closing out the work consider whether an end-to-end test makes sense for it. If it does, suggest it to the user — describe what you'd test and ask if they want it added. Don't add browser tests silently; always check first. When a test is agreed and written, add a row for it in the relevant table in `TESTING.md`.

---

## Agent Behaviour Expectations

Actively guide the workflow rather than waiting for perfect instructions:

- When the user starts new work: create a branch from `develop` automatically
- When the user says the work is ready: open a PR to `develop`, don't push directly
- When the user asks about releasing: confirm whether they mean prep, tag, or both
- When the user asks for a version bump: confirm patch/minor/major if not stated
- When the user's language conflicts with the workflow: interpret charitably or push back clearly — never silently do the wrong thing
