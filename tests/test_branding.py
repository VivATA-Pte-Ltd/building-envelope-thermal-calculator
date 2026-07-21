from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BrandingTests(unittest.TestCase):
    def test_deployable_text_uses_vivateq_brand(self):
        files = [
            "index.html",
            "shading.js",
            "README.md",
            "scripts/update_data.py",
            "server/Start_Server.bat",
        ]
        combined = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in files)
        self.assertIn("VivaTEQ", combined)
        self.assertNotIn("VivATA", combined)
        self.assertNotIn("vivata-pte-ltd", combined.lower())

    def test_vivata_owns_repository_and_vivateq_remains_product_brand(self):
        deployment = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in [
            "Dockerfile", "compose.yml", "server/app.py", "SERVER_README.txt",
        ])
        self.assertIn("VivATA-Pte-Ltd", deployment)
        self.assertIn("ghcr.io/vivata-pte-ltd", deployment.lower())
        self.assertIn("VivaTEQ", deployment)

    def test_downloaded_calculator_uses_only_local_or_embedded_manifest(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("const manifestBase='./standards.json'", html)
        self.assertNotIn("fetch('http", html)
        self.assertIn("connect-src 'self';", html)

    def test_private_source_has_no_pages_workflow(self):
        self.assertFalse((ROOT / ".github" / "workflows" / "pages.yml").exists())


if __name__ == "__main__":
    unittest.main()
