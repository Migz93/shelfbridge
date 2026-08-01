<!-- shared: content — keep in sync across Migz93 self-hosted apps -->

# Technical Docs

This folder is ShelfBridge's long-term technical reference area.

Use these docs for implementation details, subsystem behaviour, and architecture
notes that stay useful after the branch or issue that introduced them is long
gone. Anything that is only true for one branch or issue belongs in that issue,
not in a file here.

## Where Information Lives

| Kind of information | Where it goes |
|---|---|
| Always true, needed on every task | `AGENTS.md` |
| True only while doing a particular kind of work | the matching `docs/*.md` |
| True only for one branch or issue | that issue or PR |

## Shared Docs

These exist in every Migz93 self-hosted app. Each carries a `shared:` marker
comment on its first line saying whether its **content** is kept identical or
only its **structure**, with app-specific content underneath.

| Doc | Read it when | Shared |
|---|---|---|
| [architecture.md](architecture.md) | You need the big-picture mental model before touching the code | structure |
| [deployment.md](deployment.md) | Changing Docker, ports, bind mounts, the entrypoint, or runtime config | content |
| [workflow.md](workflow.md) | Opening a PR, cutting a release, triaging a Snyk finding, or writing logs and comments | content |
| [maintenance.md](maintenance.md) | Adding background cleanup, pruning, retention, or consistency checks | structure |
| [colour-scheme.md](colour-scheme.md) | Choosing a colour for any UI element, text, or interactive state | structure |

## ShelfBridge Docs

These are specific to this app and have no equivalent in the sibling projects.

| Doc | Read it when |
|---|---|
| [sync.md](sync.md) | Changing how data flows between services, or conflict/superseded-write logic |
| [api.md](api.md) | Adding routes, changing request/response shapes, or integrating from an external client |
| [books-and-identity.md](books-and-identity.md) | Changing book matching, identity reconciliation, the source/state tables, or the Books page filters |
| [image-caching.md](image-caching.md) | Changing cover fetch, storage, refresh, or serving behaviour |

## Maintenance Rule

When a major feature or long-lived internal behaviour changes, update the
relevant doc in this folder in the same branch/PR. If no existing doc fits, add
a new topic doc here and link it from the table above.

If you change a doc marked `shared: content`, make the same change in the sibling
projects. If you change the headings of a doc marked `shared: structure`, change
them in the siblings too — the content underneath is expected to differ.
