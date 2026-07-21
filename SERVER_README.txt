# VivaTEQ Building Envelope Server

## Quick start on Windows

Double-click:

`server\Start_Server.bat`

Then open `http://localhost:8080`.

Requirements: Python 3.11+ and `pdftotext` (Poppler) for automatic source extraction. The web server still starts with its validated manifest if an update check fails.

## Docker server

```text
docker compose up -d --build
```

Open `http://localhost:8080`.

The container checks the official BCA source on startup and every six hours. It publishes a new local manifest only after the existing fail-closed extractor strictly validates the source, formulas, tables and value ranges.

## Environment variables

- `HOST` — bind address; default `0.0.0.0`
- `PORT` — HTTP port; default `8080`
- `UPDATE_INTERVAL_SECONDS` — update interval; minimum 300, default 21600
- `UPDATE_ON_STARTUP` — `true` or `false`; default `true`
- `STANDARDS_PATH` — persistent manifest path; Docker defaults to `/app/data/standards.json`
- `SNAPSHOT_PATH` — persistent official-source snapshot path; Docker defaults to `/app/data/latest-source.pdf`
- `ADMIN_UPDATE_TOKEN` — optional bearer token for manual update API; when blank the endpoint is disabled

## API

- `GET /api/health` — server and updater health
- `GET /api/standards` — currently loaded validated manifest
- `POST /api/update` — manual update; requires `Authorization: Bearer <ADMIN_UPDATE_TOKEN>`
- `GET /standards.json` — browser manifest with `Cache-Control: no-store`

Do not place the server directly on the public internet without a TLS reverse proxy. For public use, put it behind Caddy, Nginx, a managed container platform, or an HTTPS load balancer.
