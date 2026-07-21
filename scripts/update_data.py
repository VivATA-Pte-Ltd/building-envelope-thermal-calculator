#!/usr/bin/env python3
"""Fetch and strictly validate BCA envelope-thermal constants.

Fail closed: standards.json is replaced only after source discovery, PDF
signature/checksum, narrow extraction and deterministic validation all pass.
"""
from __future__ import annotations

import datetime as dt
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path(os.environ.get("STANDARDS_PATH", str(ROOT / "standards.json")))
SNAPSHOT = Path(os.environ.get("SNAPSHOT_PATH", str(ROOT / "data" / "latest-source.pdf")))
INDEX_URL = "https://www1.bca.gov.sg/sustainability/legislation-on-environmental-sustainability-for-buildings/new-buildings-and-existing-buildings-undergoing-major-additions-and-alterations/"
SHORT_URL = "https://go.gov.sg/bca-envl-therm-code"
ALLOWED_INDEX_HOST = "www1.bca.gov.sg"
ALLOWED_REDIRECT_HOSTS = {"go.gov.sg", "file.go.gov.sg"}
USER_AGENT = "VivaTEQ-BCA-Envelope-Standards-Updater/1.0 (+https://github.com/VivaTEQ-Pte-Ltd)"

BASELINE = {
    "limits_w_m2": {"ettv": 50.0, "retv": 25.0, "rttv": 50.0},
    "formula_coefficients": {
        "ettv": {"opaque": 12.0, "fenestration": 3.4, "solar": 211.0},
        "retv": {"opaque": 3.4, "fenestration": 1.3, "solar": 58.6},
        "rttv": {"opaque": 12.5, "skylight": 4.8, "solar": 485.0},
    },
    "cf_ettv_vertical": {"north": 0.80, "ne": 0.97, "east": 1.13, "se": 0.98, "south": 0.83, "sw": 1.06, "west": 1.23, "nw": 1.03},
    "cf_retv_vertical": {"north": 0.83, "ne": 1.01, "east": 1.18, "se": 1.02, "south": 0.86, "sw": 1.09, "west": 1.26, "nw": 1.06},
    "roof_cf_horizontal": 1.00,
    "roof_u_limits_w_m2k": {"light": 0.5, "medium": 0.8, "heavy": 1.2},
    "roof_weight_ranges_kg_m2": {"light_max_exclusive": 50.0, "medium_max_inclusive": 230.0},
    "surface_films_m2k_w": {"wall_external": 0.044, "wall_internal": 0.120, "roof_external": 0.055, "roof_internal_flat_high_emissivity": 0.162},
}


class UpdateAlreadyRunning(RuntimeError):
    pass


@contextmanager
def interprocess_lock(path: Path):
    """Hold a non-blocking cross-process lock for one updater invocation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    locked = False
    try:
        if path.stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except (BlockingIOError, OSError) as exc:
            raise UpdateAlreadyRunning("another updater process is running") from exc
        yield
    finally:
        if locked:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        handle.close()


def fetch(url: str) -> tuple[bytes, str, dict[str, str]]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("Only HTTPS sources are accepted")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/pdf"})
    with urllib.request.urlopen(req, timeout=45) as response:
        final = response.geturl()
        host = urllib.parse.urlparse(final).hostname
        allowed = {ALLOWED_INDEX_HOST} if parsed.hostname == ALLOWED_INDEX_HOST else ALLOWED_REDIRECT_HOSTS
        if host not in allowed:
            raise ValueError(f"Redirected to non-allowlisted host: {host}")
        return response.read(), final, {k.lower(): v for k, v in response.headers.items()}


def discover_source() -> str:
    body, final, _ = fetch(INDEX_URL)
    if urllib.parse.urlparse(final).hostname != ALLOWED_INDEX_HOST:
        raise ValueError("Authority index host changed")
    html = body.decode("utf-8", "ignore")
    links = set(re.findall(r'href=["\']([^"\']+)["\']', html, re.I))
    matches = [urllib.parse.urljoin(INDEX_URL, x) for x in links if "bca-envl-therm-code" in x]
    if matches != [SHORT_URL]:
        raise ValueError(f"Expected exactly one official envelope-code link; got {matches}")
    return matches[0]


def pdf_to_text(pdf: Path) -> str:
    exe = shutil.which("pdftotext")
    if not exe:
        raise RuntimeError("pdftotext is required")
    txt = pdf.with_suffix(".txt")
    subprocess.run([exe, "-layout", str(pdf), str(txt)], check=True, timeout=60)
    text = txt.read_text(encoding="utf-8", errors="replace")
    if len(text) < 50_000:
        raise ValueError("Extracted PDF text is unexpectedly short")
    return text.replace("\u00a0", " ")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def require(pattern: str, text: str, label: str) -> None:
    if not re.search(pattern, text, re.I | re.S):
        raise ValueError(f"Required code evidence missing: {label}")


def extract_and_validate(text: str) -> dict:
    c = compact(text)
    # Scope to numbered technical sections so table-of-contents text cannot satisfy checks.
    ettv = c[c.index("4 Envelope Thermal Transfer Value"):c.index("ROOF THERMAL TRANSFER VALUE (RTTV)", 500)]
    rttv = c[c.index("6 Roof Thermal Transfer Value"):c.index("RESIDENTIAL ENVELOPE TRANSMITTANCE VALUE (RETV)", 1000)]
    retv = c[c.index("8 Residential Envelope Transmittance Value"):c.index("ROOF INSULATION FOR AIR-CONDITIONED", 1000)]
    tables = c[c.index("Table C1: Solar Correction Factors"):c.index("Table C8: Solar Data")]

    require(r"ETTV\s*=\s*12\s*\(\s*1\s*-\s*WWR\s*\)\s*Uw\s*\+\s*3\.4\s*\(\s*WWR\s*\)\s*Uf\s*\+\s*211", ettv, "ETTV formula")
    require(r"maximum permissible ETTV.{0,100}?50\s*W/m2", ettv, "ETTV limit")
    require(r"RTTV\s*=\s*12\.5\s*\(\s*1\s*-\s*SKR\s*\)\s*Ur\s*\+\s*4\.8\s*\(\s*SKR\s*\)\s*Us\s*\+\s*485", rttv, "RTTV formula")
    require(r"maximum permissible RTTV.{0,100}?50\s*W/m2", rttv, "RTTV limit")
    require(r"RETV\s*=\s*3\.4\s*\(\s*1\s*-\s*WWR\s*\)\s*Uw\s*\+\s*1\.3\s*\(\s*WWR\s*\)\s*U\s*f\s*\+\s*58\.6", retv, "RETV formula")
    require(r"maximum permissible RETV.{0,100}?25\s*W/m2", retv, "RETV limit")
    require(r"WWRBldg\s*<\s*0\.3\s*and\s*SC1\s*facade\s*<\s*0\.7", retv, "RETV DTS set 1")
    require(r"applicable to buildings with external masonry walls", retv, "RETV DTS masonry condition")

    # Exact known rows; reject PDF layout drift instead of guessing.
    require(r"0\.80\s+0\.97\s+1\.13\s+0\.98\s+0\.83\s+1\.06\s+1\.23\s+1\.03", tables, "Table C1 vertical-wall CF row")
    require(r"0\.83\s+1\.01\s+1\.18\s+1\.02\s+0\.86\s+1\.09\s+1\.26\s+1\.06", tables, "Table C3 vertical-wall CF row")
    require(r"Light\s+Under 50\s+Medium\s+50 to 230\s+0\.5\s+Heavy\s+Over 230\s+0\.8\s+1\.2", tables, "Table C4 roof limits")
    require(r"Inside Surface \(Ri\)\s+0\.120.{0,160}?0\.044.{0,80}?Outside surface \(Ro\)", tables, "Table C6 wall surface films")
    require(r"Inside surface \(Ri\)\s+0\.162.{0,350}?Outside surface \(Ro\).{0,80}?0\.055", tables, "Table C6 roof surface films")

    data = json.loads(json.dumps(BASELINE))
    validate_data(data)
    return data


def validate_data(d: dict) -> None:
    if set(d["cf_ettv_vertical"]) != {"north", "ne", "east", "se", "south", "sw", "west", "nw"}:
        raise ValueError("ETTV orientation set invalid")
    if set(d["cf_retv_vertical"]) != set(d["cf_ettv_vertical"]):
        raise ValueError("RETV orientation set invalid")
    for group in (d["cf_ettv_vertical"], d["cf_retv_vertical"]):
        if not all(0.4 <= float(v) <= 2.0 for v in group.values()):
            raise ValueError("CF outside safe range")
    if d["limits_w_m2"] != {"ettv": 50.0, "retv": 25.0, "rttv": 50.0}:
        raise ValueError("Unexpected regulatory limits")
    u = d["roof_u_limits_w_m2k"]
    if not (0 < u["light"] < u["medium"] < u["heavy"] <= 2):
        raise ValueError("Roof U-value thresholds invalid")
    if d["roof_weight_ranges_kg_m2"] != {"light_max_exclusive": 50.0, "medium_max_inclusive": 230.0}:
        raise ValueError("Roof weight thresholds invalid")
    if d != BASELINE:
        raise ValueError("Manifest data differs from the extractor's validated baseline")


def validate_manifest(manifest: dict) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be a JSON object")
    required = {
        "schema_version", "status", "app_compatibility", "authority", "title",
        "source_index_url", "source_url", "source_sha256", "extractor_version", "data",
    }
    if not required.issubset(manifest):
        raise ValueError("Manifest required fields missing")
    if manifest["schema_version"] != 1 or manifest["status"] != "validated":
        raise ValueError("Manifest status or schema invalid")
    if manifest["app_compatibility"] != "4.x":
        raise ValueError("Manifest compatibility invalid")
    if manifest["source_index_url"] != INDEX_URL:
        raise ValueError("Manifest authority index invalid")
    source = urllib.parse.urlparse(str(manifest["source_url"]))
    if source.scheme != "https" or source.hostname != "file.go.gov.sg":
        raise ValueError("Manifest source URL invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", str(manifest["source_sha256"])):
        raise ValueError("Manifest source checksum invalid")
    validate_data(manifest["data"])


def atomic_write(path: Path, content: bytes) -> None:
    """Atomically replace one file using a unique temporary sibling."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{path.name}.", suffix=".tmp",
            dir=path.parent, delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temp_path.replace(path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def publish_validated(manifest: dict, pdf_bytes: bytes, manifest_path: Path, snapshot_path: Path) -> None:
    """Publish snapshot first and manifest last as the transaction commit marker."""
    validate_manifest(manifest)
    atomic_write(snapshot_path, pdf_bytes)
    encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    atomic_write(manifest_path, encoded)


def build_manifest(data: dict, source_url: str, sha: str, headers: dict[str, str]) -> dict:
    return {
        "schema_version": 1,
        "status": "validated",
        "app_compatibility": "4.x",
        "authority": "Building and Construction Authority, Singapore",
        "title": "Code on Envelope Thermal Performance for Buildings",
        "edition": "Current BCA-linked edition",
        "source_index_url": INDEX_URL,
        "source_url": source_url,
        "source_sha256": sha,
        "source_last_modified": headers.get("last-modified"),
        "extracted_at_utc": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "extractor_version": "1.0.0",
        "data": data,
    }


def update_once() -> int:
    source = discover_source()
    pdf_bytes, final_url, headers = fetch(source)
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("Official source is not a PDF")
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    existing = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else None
    if existing and existing.get("source_sha256") == sha:
        validate_manifest(existing)
        if not SNAPSHOT.exists() or SNAPSHOT.read_bytes() != pdf_bytes:
            atomic_write(SNAPSHOT, pdf_bytes)
            print("Official source checksum unchanged; repaired validated source snapshot.")
        else:
            print("Official source checksum unchanged; validated existing manifest and snapshot byte-for-byte.")
        return 0
    with tempfile.TemporaryDirectory() as td:
        pdf = Path(td) / "source.pdf"
        pdf.write_bytes(pdf_bytes)
        data = extract_and_validate(pdf_to_text(pdf))
    manifest = build_manifest(data, final_url, sha, headers)
    publish_validated(manifest, pdf_bytes, MANIFEST, SNAPSHOT)
    print(f"Published validated manifest for {final_url} ({sha})")
    return 0


def main() -> int:
    with interprocess_lock(MANIFEST.with_suffix(".update.lock")):
        return update_once()


if __name__ == "__main__":
    raise SystemExit(main())
