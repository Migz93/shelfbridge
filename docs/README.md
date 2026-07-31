# Technical Docs

This folder is ShelfBridge's long-term technical reference area.

Use these docs for implementation details, subsystem behaviour, and architecture
notes that should stay useful after the branch or issue that introduced them is
long gone.

## What's Here

- [architecture.md](architecture.md) — high-level system shape, core invariants,
  deployment model, and the main subsystems that make ShelfBridge work
- [sync.md](sync.md) — sync model, data flow between services, conflict
  resolution, superseded-write detection, event types, and history storage
- [api.md](api.md) — full REST API reference: every route, its parameters,
  request bodies, and response shapes
- [deployment.md](deployment.md) — Docker image/container expectations, ports,
  bind mounts, the non-root container user, and DooD-specific rules
- [external-product-api-research.md](external-product-api-research.md) —
  integration reference notes for Grimmory, Hardcover, and Goodreads APIs
- [future.md](future.md) — small backlog of deferred technical work that is not
  implemented yet
- [chaptarr-plan.md](chaptarr-plan.md) — Chaptarr integration reference: API
  shape, matching strategy, DB columns, sync pass behaviour, and remaining
  hardening work
- [colour-scheme.md](colour-scheme.md) — the colour palette, each colour's role,
  contrast ratios, and rules for correct usage

## When To Read Which Doc

- Start with [architecture.md](architecture.md) if you need the big-picture
  mental model before touching the code.
- Read [sync.md](sync.md) when changing how data flows between Grimmory,
  Hardcover, and Goodreads, or when changing conflict/superseded logic.
- Read [api.md](api.md) when adding new routes, changing request/response shapes,
  or integrating the API from an external client.
- Read [deployment.md](deployment.md) when changing Docker, ports, bind mounts,
  the entrypoint, or runtime config.
- Read [external-product-api-research.md](external-product-api-research.md) when
  changing how ShelfBridge talks to Grimmory, Hardcover, or Goodreads.
- Read [future.md](future.md) when picking up deferred cleanup or import
  improvements that are not implemented yet.
- Read [chaptarr-plan.md](chaptarr-plan.md) when working on the Chaptarr
  integration — it has the API field reference, matching chain, and notes on
  what is not yet built.
- Read [colour-scheme.md](colour-scheme.md) when adding new UI elements or
  choosing colours for interactive states, text, or status indicators.

## Maintenance Rule

When a major feature or long-lived internal behaviour changes, update the
relevant doc in this folder in the same branch/PR. If no existing doc fits, add
a new topic doc here and link it from this index.
