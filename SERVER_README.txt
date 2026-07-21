# VivaTEQ Building Envelope Server

## Quick start on Windows

Double-click:

`server\Start_Server.bat`

Then open `http://localhost:8080`.

Requirements: Python 3.11+ and `pdftotext` (Poppler) for automatic source extraction. The web server still starts with its validated manifest if an update check fails.

## Docker server linked to GitHub

```text
docker compose pull
docker compose up -d --wait
```

Open `http://localhost:8080`.

The default Compose deployment pulls `server-latest` from the repository's GitHub Container Registry package. GitHub Actions builds the image once, tests that exact artifact, publishes a guarded full-commit `server-<40-character-SHA>` locator plus `server-latest`, and signs the immutable registry digest with Sigstore keyless identity. The digest—not a mutable tag—is the deployment authority. Its Git commit is returned by `GET /api/health` as `git_sha`.

For automatic synchronization on a Windows server, double-click:

`server\Install_Automatic_GitHub_Sync.bat`

This installs Sigstore Cosign through Windows Package Manager when needed, then creates a 15-minute Task Scheduler check. The synchronizer pins the exact digest pulled before verification, verifies that digest's signature belongs to this repository's `main` workflow, reads and rechecks the current `main` commit directly from GitHub, requires the pulled image's baked `APP_GIT_SHA` to match it, replaces the container by immutable digest, parses `/api/health` and requires an exact status/SHA match, and restores only a previous digest whose approved signature, image identity, health and SHA can all be reverified. Activity is written to `server\github-sync.log`.

For the one-time migration from a legacy unsigned container, stop and remove that old Compose container before the first signed synchronization. The scheduled updater deliberately refuses to replace an existing unsigned image because it could not serve as a verified rollback target. After the first signed deployment, every subsequent rollback target is reverified before use.

GitHub Container Registry visibility is controlled by the VivATA organization. If the package is private, run `docker login ghcr.io` once on the server with an account/token that has package-read permission, under the same Windows account that installs and runs the scheduled task. The synchronizer leaves the existing server untouched when authentication or image pulling fails.

For a local source build instead of the GitHub image:

```text
docker compose -f compose.yml -f compose.local.yml up -d --build --wait
```

The container checks the official BCA source on startup and every six hours. This standards-data update is separate from application-image synchronization. It publishes a new local manifest only after the existing fail-closed extractor strictly validates the source, formulas, tables and value ranges.

## Environment variables

- `HOST` — bind address; default `0.0.0.0`
- `PORT` — HTTP port; default `8080`
- `UPDATE_INTERVAL_SECONDS` — update interval; minimum 300, default 21600
- `UPDATE_ON_STARTUP` — `true` or `false`; default `true`
- `STANDARDS_PATH` — persistent manifest path; Docker defaults to `/app/data/standards.json`
- `SNAPSHOT_PATH` — persistent official-source snapshot path; Docker defaults to `/app/data/latest-source.pdf`
- `ADMIN_UPDATE_TOKEN` — optional bearer token for manual update API; when blank the endpoint is disabled
- `APP_VERSION` — application release version baked into the image
- `APP_GIT_SHA` — tested Git commit baked into the image and exposed by `/api/health`
- `APP_REPOSITORY` — source repository URL baked into the image

## API

- `GET /api/health` — server and updater health
- `GET /api/standards` — currently loaded validated manifest
- `POST /api/update` — manual update; requires `Authorization: Bearer <ADMIN_UPDATE_TOKEN>`
- `GET /standards.json` — browser manifest with `Cache-Control: no-store`

Do not place the server directly on the public internet without a TLS reverse proxy. For public use, put it behind Caddy, Nginx, a managed container platform, or an HTTPS load balancer.
