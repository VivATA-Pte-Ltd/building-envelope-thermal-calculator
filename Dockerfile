FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

LABEL org.opencontainers.image.source="https://github.com/VivaTEQ-Pte-Ltd/building-envelope-thermal-calculator" \
      org.opencontainers.image.description="VivaTEQ BCA ETTV, RETV and RTTV calculator server" \
      org.opencontainers.image.licenses="Proprietary"

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.html shading.js standards.json ./
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
    PYTHONUNBUFFERED=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json,os,urllib.request; port=os.environ.get('PORT','8080'); x=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=3)); assert x['status']=='ok'"

CMD ["python", "server/app.py"]
