# VivaTEQ Building Envelope Thermal Calculator

A browser-based submission aid for Singapore BCA envelope thermal calculations:

- ETTV — weighted by gross exterior wall area across eight façade orientations
- External and self-shading — SC1 × SC2 workflow with automatic standard-device geometry, BCA Tables C12–C23 values, Appendix B2.2 hourly solar-data calculations, and browser-side IFC analysis
- RETV — weighted by gross exterior wall area, including conditional DTS checks
- RTTV — roof and skylight calculation with Table C2 roof CF
- Assembly U-value calculations

## Automatic standards update

The browser loads `standards.json` every time the page opens, validates it, and applies the newest published constants. The hosted app uses its same-origin manifest; a downloaded `file://` copy falls back to its embedded verified baseline when browser file-access policy blocks the adjacent manifest. Fallback order:

1. live validated manifest;
2. cached last-known-good validated manifest;
3. embedded verified baseline.

A scheduled GitHub Action checks the official BCA regulatory page and currently linked **Code on Envelope Thermal Performance for Buildings** every six hours. It publishes a change only if the PDF checksum changes and all strict extraction/tests pass. If the source structure or values become ambiguous, the workflow fails closed and retains the last-known-good manifest.

## Official sources

- Regulatory/submission page: https://www1.bca.gov.sg/sustainability/legislation-on-environmental-sustainability-for-buildings/new-buildings-and-existing-buildings-undergoing-major-additions-and-alterations/
- BCA envelope code: https://go.gov.sg/bca-envl-therm-code
- BPD_BP04 submission format: https://go.gov.sg/bca-envl-therm-bp04

## Shading automation

### Standard devices

For each façade, select **Automatic standard device** and enter the window and projection dimensions. The calculator derives `R1=P/H` and/or `R2=P/W`, selects the applicable paired-orientation table C12–C23, and linearly interpolates between tabulated ratios and inclinations. Inputs outside the official table bounds are rejected rather than extrapolated. The 3,060 embedded SC values are independently checked against `data/extracted/bca-shading-tables-C12-C23.csv`.

### Complex self-shading from IFC

The **All Orientations** tab accepts an `.ifc` model and processes it locally in the browser with repository-vendored, version-pinned `web-ifc` 0.0.77; the model is not transmitted to an external service. All executable browser dependencies used on this page (`web-ifc`, PDF.js, dxf-parser, SheetJS and html2pdf) are served from the repository's `vendor/` directory rather than runtime CDNs. It:

1. tessellates `IfcWindow` and model geometry;
2. converts IFC project units through `web-ifc` and applies nested placements;
3. classifies vertical windows into eight façade orientations using the entered model-to-true-north rotation;
4. casts BCA C8–C11 hourly shadow rays through a BVH using a 3×3 sampling grid per window;
5. area-weights the exposed fraction `G` and calculates Appendix B2.2 SC2; and
6. exports IFC IDs, hourly rows, assumptions and warnings in the shading audit trail.

Conservative controls: files over 250 MB are rejected before WASM loading; missing/degenerate windows and unsupported concave, fragmented, overlapping, noncoplanar or unrelated disconnected exterior geometry are rejected; any rejected `IfcWindow` invalidates the whole IFC-derived result and blocks report export. The browser enforces finite model triangle and vertex-buffer budgets, a 2,000-triangle/6,000-vertex-record limit per window, and physical coordinate/span bounds before topology processing. Convex non-rectangular windows use polygon area and in-polygon samples, opaque `IfcDoor` geometry remains an occluder, and window outward-normal signs are inferred from the model centre. The QP must verify model north and concave/courtyard façades. The pinned `web-ifc` JavaScript/WASM runtime is served from `vendor/web-ifc/`; no runtime CDN is used.

### PDF and DXF drawing measurements

The **All Orientations** tab also reads PDF and ASCII DXF details locally when the calculator is served by the included Python/Docker server. A directly opened `file://` copy cannot securely start the parser workers, so drawing import is disabled there; the ordinary standalone calculator remains usable. Pinned `pdfjs-dist` 6.1.200 renders the selected PDF page and lazily extracts only that page’s embedded text in its local worker; pinned `dxf-parser` 1.1.2 reads supported line, polyline, circle, arc, point, text and dimension entities plus layers and `$INSUNITS` in a separate, time-limited browser worker. Scanned/raster PDFs can be rendered but require manual scale calibration. Binary DXF, unsupported entities, unsafe coordinates, files over 50 MiB, excessive entities/vertices/text, PDFs over 100 pages, processing over 30 seconds and oversized renders fail closed. DWG is not parsed directly; export it to DXF or IFC.

Drawing geometry never silently changes a calculation. The user selects the façade and page/layer, calibrates if needed, measures the applicable window and projection dimensions, and confirms them before application. The calculator validates the resulting ratios against the official C12–C23 table ranges and records the file, page/layer, units/calibration and QP-verification warning in the existing shading audit trail.

## Server edition

The same repository includes a zero-dependency Python HTTP server and a Docker deployment:

- Windows: double-click `server/Start_Server.bat`
- Python: `python server/app.py`
- Docker linked to tested GitHub images: `docker compose pull && docker compose up -d --wait`
- Local Docker build: `docker compose -f compose.yml -f compose.local.yml up -d --build --wait`
- Automatic Windows image synchronization: double-click `server/Install_Automatic_GitHub_Sync.bat`
- Default URL: `http://localhost:8080`
- Health API: `/api/health`
- Current manifest API: `/api/standards`

The server checks BCA on startup and every six hours, retains the validated manifest if an update fails, and supports an optional bearer-token-protected manual update endpoint. GitHub Actions publishes the exact tested, commit-labelled server image and signs its immutable registry digest with Sigstore; `/api/health` reports that image's `git_sha`. The optional Windows scheduled synchronizer verifies and deploys that exact digest, rechecks GitHub `main` immediately before replacement, parses an exact health/SHA response, and rolls back only to a previously signed and reverified digest. See `SERVER_README.txt` for configuration and deployment notes.

## Important

This tool is a calculation and coordination aid. The QP remains responsible for project applicability, geometry, product data, current submission requirements and certification.
