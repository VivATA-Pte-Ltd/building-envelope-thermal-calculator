FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

ARG APP_GIT_SHA=unknown
ARG APP_VERSION=4.4.0
ARG APP_REPOSITORY=https://github.com/VivATA-Pte-Ltd/building-envelope-thermal-calculator

LABEL org.opencontainers.image.source="${APP_REPOSITORY}" \
      org.opencontainers.image.revision="${APP_GIT_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.description="VivaTEQ BCA ETTV, RETV and RTTV calculator server" \
      org.opencontainers.image.licenses="Proprietary"

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.html shading.js shading-data.js ifc-shading.js ifc-loader.js drawing-import.js drawing-dxf-worker.js standards.json ./
COPY vendor ./vendor
COPY data ./data
COPY scripts ./scripts
COPY server ./server

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV HOST=0.0.0.0 \
    PORT=8080 \
    UPDATE_INTERVAL_SECONDS=21600 \
    UPDATE_ON_STARTUP=true \
    STANDARDS_PATH=/app/data/standards.json \
    SNAPSHOT_PATH=/app/data/latest-source.pdf \
    APP_VERSION=${APP_VERSION} \
    APP_GIT_SHA=${APP_GIT_SHA} \
    APP_REPOSITORY=${APP_REPOSITORY} \
    PYTHONUNBUFFERED=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json,os,urllib.request; port=os.environ.get('PORT','8080'); x=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=3)); assert x['status']=='ok'"

CMD ["python", "server/app.py"]
