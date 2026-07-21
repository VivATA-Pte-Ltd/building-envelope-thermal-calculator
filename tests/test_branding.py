from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BrandingTests(unittest.TestCase):
    def test_deployable_text_uses_vivateq_brand(self):
        files = [
            "index.html",
            "shading.js",
            "README.md",
            "SERVER_README.txt",
            "Dockerfile",
            "compose.yml",
            "scripts/update_data.py",
            "server/app.py",
            "server/Start_Server.bat",
            ".github/workflows/server-ci.yml",
            ".github/workflows/update-data.yml",
        ]
        combined = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in files)
        self.assertIn("VivaTEQ", combined)
        self.assertNotIn("VivATA", combined)
        self.assertNotIn("vivata-pte-ltd", combined.lower())

    def test_downloaded_calculator_uses_public_vivateq_demo_manifest(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn(
            "https://vivateq-pte-ltd.github.io/building-envelope-thermal-calculator-demo/standards.json",
            html,
        )

    def test_private_source_has_no_pages_workflow(self):
        self.assertFalse((ROOT / ".github" / "workflows" / "pages.yml").exists())


if __name__ == "__main__":
    unittest.main()
