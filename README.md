# ShelfBridge

![ShelfBridge logo](./public/logo.webp)

[![GitHub Activity][commits-shield]][commits]
[![License][license-shield]][license]
[![Project Maintainer][maintainer-shield]][user_profile]
[![Buy me a coffee][buymecoffeebadge]][buymecoffee]

ShelfBridge is a self-hosted reading companion that keeps book metadata, reading state, progress, shelves, and sync health aligned across your reading services.

It connects Grimmory, Hardcover, Goodreads, Chaptarr, and Audiobookshelf through a simple web UI, giving you one place to manage profiles, review matches, track sync history, and run scheduled or manual syncs.

## What ShelfBridge Does

- Imports books and reading state from Grimmory, Hardcover, Goodreads, Chaptarr, and Audiobookshelf where configured
- Tracks per-profile reading status, progress, ratings, shelves, and sync health
- Matches books across services using IDs, ISBNs, ASINs, file paths, titles, authors, and stored cross-references
- Highlights missing matches, ID mismatches, probable duplicates, and download/review actions
- Writes selected status, progress, shelf, tag, and external ID updates back to supported services
- Stores third-party credentials encrypted at rest in the app data directory

## Preview

ShelfBridge is still early in development. Preview screenshots will be added once the UI settles.

## Key Features

- Local password-protected web UI
- Per-profile Grimmory, Hardcover, Goodreads, and Audiobookshelf configuration
- Optional Chaptarr integration for requested/downloaded book state
- Book and audiobook views with sync health, match confidence, source IDs, and action filters
- Three-way audiobook progress sync between Audiobookshelf, Grimmory, and Hardcover
- Goodreads shelf import into Grimmory shelves
- Hardcover list import into Grimmory shelves
- Manual sync runs, scheduled sync jobs, sync history, and log viewer
- AES-256-GCM credential storage for API keys, tokens, and passwords
- Reverse proxy support with a Trust Proxy setting for forwarded client IPs

## How It Works

ShelfBridge uses a few background jobs:

- **Profile Sync** imports each enabled profile's configured sources, reconciles matching books, and writes enabled changes back to supported services
- **Maintenance** prunes old sync history and keeps local state tidy
- **Image Cache Refresh** refreshes stale cover images, including authenticated Grimmory covers that need a live token

Together, that means ShelfBridge can keep reading state current across services while still giving you a review layer for mismatches, missing downloads, and books that need manual attention.

## Quick Start

### Requirements

- A Grimmory instance if you want on-disk book/library state
- Optional Hardcover API tokens for Hardcover sync
- Optional Goodreads user IDs for Goodreads import
- Optional Chaptarr instance for requested/downloaded book state
- Optional Audiobookshelf instance and per-user API keys for audiobook progress sync

### Docker

```bash
docker run -d \
  --name shelfbridge \
  --network bridge \
  -p 9303:9303 \
  -v /opt/shelfbridge:/config \
  --restart unless-stopped \
  ghcr.io/migz93/shelfbridge:latest
```

You can then open `http://localhost:9303` and create the initial ShelfBridge password in the browser.

### Docker Compose

```yaml
services:
  shelfbridge:
    image: ghcr.io/migz93/shelfbridge:latest
    container_name: shelfbridge
    network_mode: bridge
    restart: unless-stopped
    ports:
      - "9303:9303"
    volumes:
      - /opt/shelfbridge:/config
    environment:
      - NODE_ENV=production
      - DATA_DIR=/config
      - TZ=UTC
```

```bash
docker compose up -d
```

### Configuration

ShelfBridge is configured through its web UI after first run. The main things you may want to adjust in your Docker setup before starting:

- **Port** — change the left side of `9303:9303` to expose ShelfBridge on a different host port (e.g. `8080:9303`)
- **Data directory** — change the left side of `/opt/shelfbridge:/config` to store ShelfBridge's database, logs, credential key, and image cache wherever you prefer on your host
- **Timezone** — set `TZ` to your preferred timezone if you do not want UTC

If ShelfBridge is served through a reverse proxy such as Nginx, Traefik, or Caddy, enable **Settings → General → Network → Trust Proxy** and restart the container so rate limiting uses the real client IP from forwarded headers.

### First Setup

1. Create the initial ShelfBridge password
2. Configure your global service URLs in Settings
3. Add one or more profiles from Users
4. Add each profile's service credentials or IDs
5. Run a sync, or wait for the scheduled jobs to start working

## Important Limitations

### Service Write Support

ShelfBridge is deliberately conservative about writes:

- **Goodreads is read-only.** Goodreads shelves can be imported into ShelfBridge and mapped into Grimmory, but ShelfBridge does not write back to Goodreads.
- **Chaptarr is read-only.** Chaptarr is used to understand requested/downloaded state, but ShelfBridge does not create requests or change Chaptarr records yet.
- **Writes are opt-in.** Status, progress, shelf, tag, and external ID writes depend on profile settings and available credentials.

### Early Development

ShelfBridge is still early in development. Database schema, sync behavior, UI layout, and supported integrations may change before a stable release.

## Security Notes

ShelfBridge requires a local password before the UI can be used. Sessions are stored server-side and sent to the browser as signed, HTTP-only cookies.

Stored third-party credentials are encrypted with AES-256-GCM using `SHELFBRIDGE_CREDENTIAL_KEY` or the generated `/config/credential-key` file. Back up this key with the database; losing it means stored credentials must be re-entered.

Do not expose `/config`, database backups, logs, `.env` files, `.claude/`, or the generated credential key publicly.

## AI Transparency

ShelfBridge was created with heavy AI assistance.

Claude, Codex, and related tools have been used throughout the project for design exploration, implementation help, refactoring, explanation, and iteration. The intent is not to hide that. ShelfBridge has been built by combining hands-on product direction with a lot of AI-assisted development work.

## Credits And Inspiration

ShelfBridge was shaped in part by studying projects that solve adjacent problems well, especially Grimmory, Hardcover, Goodreads, Chaptarr, and Audiobookshelf.

Those projects and services were helpful references for thinking about user experience, sync design, metadata matching, logging ideas, and operational workflows. ShelfBridge is its own app with its own scope, but it would be unfair not to acknowledge the influence those projects had while this one was being built.

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/Migz93/hubarr">Hubarr</a>
    </td>
    <td align="center">
      <a href="https://hardcover.app">Hardcover</a>
    </td>
    <td align="center">
      <a href="https://www.audiobookshelf.org">Audiobookshelf</a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/Migz93/hubarr">
        <img src="https://raw.githubusercontent.com/Migz93/hubarr/refs/heads/main/public/logo.png" alt="Hubarr logo" width="72" height="72" />
      </a>
    </td>
    <td align="center">
      <a href="https://hardcover.app">
        <img src="https://assets.hardcover.app/static/android-chrome-512x512.png" alt="Hardcover logo" width="72" height="72" />
      </a>
    </td>
    <td align="center">
      <a href="https://www.audiobookshelf.org">
        <img src="https://www.audiobookshelf.org/Logo.png" alt="Audiobookshelf logo" width="72" height="72" />
      </a>
    </td>
  </tr>
</table>

[buymecoffee]: https://www.buymeacoffee.com/Migz93
[buymecoffeebadge]: https://img.shields.io/badge/buy%20me%20a%20coffee-donate-yellow.svg?style=for-the-badge
[commits-shield]: https://img.shields.io/github/commit-activity/y/Migz93/shelfbridge.svg?style=for-the-badge
[commits]: https://github.com/Migz93/shelfbridge/commits/main
[license]: https://github.com/Migz93/shelfbridge/blob/main/LICENSE
[license-shield]: https://img.shields.io/github/license/Migz93/shelfbridge.svg?style=for-the-badge
[maintainer-shield]: https://img.shields.io/badge/maintainer-Migz93-blue.svg?style=for-the-badge
[user_profile]: https://github.com/Migz93
