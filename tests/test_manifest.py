import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_data", ROOT / "scripts" / "update_data.py")
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ManifestTests(unittest.TestCase):
    def test_published_manifest(self):
        m = json.loads((ROOT / "standards.json").read_text(encoding="utf-8"))
        self.assertEqual(m["schema_version"], 1)
        self.assertEqual(m["status"], "validated")
        self.assertEqual(len(m["source_sha256"]), 64)
        self.assertTrue(m["source_url"].startswith("https://file.go.gov.sg/"))
        mod.validate_data(m["data"])

    def test_known_values(self):
        d = mod.BASELINE
        self.assertEqual(d["formula_coefficients"]["ettv"]["solar"], 211.0)
        self.assertEqual(d["formula_coefficients"]["rttv"]["solar"], 485.0)
        self.assertEqual(d["cf_ettv_vertical"]["north"], 0.80)
        self.assertEqual(d["cf_retv_vertical"]["west"], 1.26)
        self.assertEqual(d["surface_films_m2k_w"]["roof_external"], 0.055)

    def test_invalid_limit_rejected(self):
        d = copy.deepcopy(mod.BASELINE)
        d["limits_w_m2"]["ettv"] = 500
        with self.assertRaises(ValueError):
            mod.validate_data(d)

    def test_invalid_cf_rejected(self):
        d = copy.deepcopy(mod.BASELINE)
        d["cf_ettv_vertical"]["north"] = 9
        with self.assertRaises(ValueError):
            mod.validate_data(d)

    def test_invalid_threshold_order_rejected(self):
        d = copy.deepcopy(mod.BASELINE)
        d["roof_u_limits_w_m2k"]["medium"] = 0.1
        with self.assertRaises(ValueError):
            mod.validate_data(d)

    def test_manifest_semantics_are_validated(self):
        manifest = json.loads((ROOT / "standards.json").read_text(encoding="utf-8"))
        mod.validate_manifest(manifest)
        broken = copy.deepcopy(manifest)
        broken["data"]["limits_w_m2"]["ettv"] = 500
        with self.assertRaises(ValueError):
            mod.validate_manifest(broken)

    def test_unchanged_checksum_still_validates_existing_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            manifest_path = Path(td) / "standards.json"
            broken = json.loads((ROOT / "standards.json").read_text(encoding="utf-8"))
            broken["status"] = "untrusted"
            pdf = b"%PDF-test"
            broken["source_sha256"] = hashlib.sha256(pdf).hexdigest()
            manifest_path.write_text(json.dumps(broken), encoding="utf-8")
            with (
                patch.object(mod, "MANIFEST", manifest_path),
                patch.object(mod, "discover_source", return_value=mod.SHORT_URL),
                patch.object(mod, "fetch", return_value=(pdf, "https://file.go.gov.sg/bca-envl-therm-code.pdf", {})),
                self.assertRaises(ValueError),
            ):
                mod.main()

    def test_unchanged_checksum_repairs_missing_or_stale_snapshot(self):
        pdf = b"%PDF-repairable-source"
        source_sha = hashlib.sha256(pdf).hexdigest()
        manifest = mod.build_manifest(
            copy.deepcopy(mod.BASELINE),
            "https://file.go.gov.sg/bca-envl-therm-code.pdf",
            source_sha,
            {"etag": "etag", "last-modified": "last-modified"},
        )
        for initial_snapshot in (None, b"%PDF-stale"):
            with self.subTest(initial_snapshot=initial_snapshot), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                manifest_path = root / "standards.json"
                snapshot_path = root / "data" / "latest-source.pdf"
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                if initial_snapshot is not None:
                    snapshot_path.parent.mkdir(parents=True)
                    snapshot_path.write_bytes(initial_snapshot)
                with (
                    patch.object(mod, "MANIFEST", manifest_path),
                    patch.object(mod, "SNAPSHOT", snapshot_path),
                    patch.object(mod, "discover_source", return_value="https://go.gov.sg/bca-envl-therm-code"),
                    patch.object(
                        mod,
                        "fetch",
                        return_value=(
                            pdf,
                            "https://file.go.gov.sg/bca-envl-therm-code.pdf",
                            {"ETag": "etag", "Last-Modified": "last-modified"},
                        ),
                    ),
                ):
                    self.assertEqual(mod.main(), 0)
                self.assertEqual(snapshot_path.read_bytes(), pdf)

    def test_snapshot_failure_does_not_publish_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            manifest_path = Path(td) / "standards.json"
            snapshot_path = Path(td) / "data" / "latest.pdf"
            manifest_path.write_text("old\n", encoding="utf-8")
            manifest = json.loads((ROOT / "standards.json").read_text(encoding="utf-8"))
            with patch.object(mod, "atomic_write", side_effect=OSError("snapshot failed")):
                with self.assertRaises(OSError):
                    mod.publish_validated(manifest, b"%PDF-test", manifest_path, snapshot_path)
            self.assertEqual(manifest_path.read_text(encoding="utf-8"), "old\n")

    def test_interprocess_lock_rejects_overlap(self):
        with tempfile.TemporaryDirectory() as td:
            lock_path = Path(td) / "update.lock"
            with mod.interprocess_lock(lock_path):
                with self.assertRaises(mod.UpdateAlreadyRunning):
                    with mod.interprocess_lock(lock_path):
                        pass


if __name__ == "__main__":
    unittest.main()
