# Testing

ShelfBridge currently has build and type-check verification, with room for Playwright or server tests as the app settles.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Runs TypeScript checks for client and server projects |
| `npm run build` | Builds the Vite client and TypeScript server |
| `npm audit --omit=dev` | Checks production dependency advisories |

## Manual Smoke Test

For a local Docker verification:

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
docker logs shelfbridge 2>&1 | tail -5
```

Expected log line:

```text
ShelfBridge listening on port 9303
```

Then open `http://localhost:9303`, create or enter the ShelfBridge admin password, and smoke-test:

- Dashboard loads after authentication
- Settings loads and the About tab reports version/build info
- Users can be created or opened
- Credential fields never echo stored secrets back to the browser
- `/api/settings` returns `401` from an unauthenticated browser/session
- `/images/...` returns `401` without a valid session

## Adding Automated Tests

When adding automated tests, keep generated artifacts under `tests/` and ensure `.gitignore` excludes auth state, reports, and test results.
