# VivaTEQ Building Envelope Thermal Calculator

A browser-based submission aid for Singapore BCA envelope thermal calculations:

- ETTV — weighted by gross exterior wall area across eight façade orientations
- External and self-shading — SC1 × SC2 workflow using BCA Tables C12–C23 values or Appendix B2.2 hourly solar-data calculations for unconventional geometry
- RETV — weighted by gross exterior wall area, including conditional DTS checks
- RTTV — roof and skylight calculation with Table C2 roof CF
- Assembly U-value calculations

## Automatic standards update

The browser loads `standards.json` every time the page opens, validates it, and applies the newest published constants. The hosted app uses its same-origin manifest; a downloaded `file://` copy uses the public VivaTEQ trial-demo manifest. Fallback order:

1. live validated manifest;
2. cached last-known-good validated manifest;
3. embedded verified baseline.

A scheduled GitHub Action checks the official BCA regulatory page and currently linked **Code on Envelope Thermal Performance for Buildings** every six hours. It publishes a change only if the PDF checksum changes and all strict extraction/tests pass. If the source structure or values become ambiguous, the workflow fails closed and retains the last-known-good manifest.

## Official sources

- Regulatory/submission page: https://www1.bca.gov.sg/sustainability/legislation-on-environmental-sustainability-for-buildings/new-buildings-and-existing-buildings-undergoing-major-additions-and-alterations/
- BCA envelope code: https://go.gov.sg/bca-envl-therm-code
- BPD_BP04 submission format: https://go.gov.sg/bca-envl-therm-bp04

## Server edition

The same repository includes a zero-dependency Python HTTP server and a Docker deployment:

- Windows: double-click `server/Start_Server.bat`
- Python: `python server/app.py`
- Docker: `docker compose up -d --build`
- Default URL: `http://localhost:8080`
- Health API: `/api/health`
- Current manifest API: `/api/standards`

The server checks BCA on startup and every six hours, retains the validated manifest if an update fails, and supports an optional bearer-token-protected manual update endpoint. See `SERVER_README.txt` for configuration and deployment notes.

## Important

This tool is a calculation and coordination aid. The QP remains responsible for project applicability, geometry, product data, current submission requirements and certification.
