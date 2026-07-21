from pathlib import Path
import re
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ShadingIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_browser_loads_tested_shading_engine(self):
        match = re.search(r'<script id="vivateq-shading-engine">\s*(.*?)\s*</script>', self.html, re.S)
        self.assertIsNotNone(match, 'downloaded HTML must embed the tested shading engine')
        engine = (ROOT / "shading.js").read_text(encoding="utf-8").strip()
        embedded = textwrap.dedent("    " + match.group(1)).strip()
        self.assertEqual(embedded, engine)
        self.assertIn("VivaTEQShading.parseSolarRows", self.html)

    def test_each_orientation_card_has_shading_workflow_fields(self):
        for suffix in (
            "_shadingMode",
            "_glassSC",
            "_deviceSC2",
            "_shadingDevice",
            "_shadingReference",
            "_solarRows",
            "_shadingStatus",
        ):
            self.assertIn(f"${{dir}}{suffix}", self.html)

    def test_exports_disclose_shading_inputs_and_method(self):
        for heading in ("Glass SC1", "External-device SC2", "Combined SC", "Shading method", "Reference / assumptions"):
            self.assertIn(heading, self.html)
        self.assertIn('<th>Shading method</th><th>Shading device</th><th>Reference / assumptions</th>', self.html)

    def test_invalid_shading_blocks_exports_and_report_text_is_escaped(self):
        self.assertIn("invalidDirections", self.html)
        self.assertIn("if (orient.invalidDirections.length)", self.html)
        self.assertIn("VivaTEQShading.escapeHTML(layer.name)", self.html)
        self.assertIn("VivaTEQShading.escapeHTML(rttvData.drawingNo)", self.html)
        self.assertIn("VivaTEQShading.safeSpreadsheetText(layer.name)", self.html)
        self.assertIn("if (mode !== 'legacy') inp.solarFactor.value", self.html)
        self.assertIn("function sanitizeRTTVReportData", self.html)
        self.assertIn("const activeDevice", self.html)

    def test_version_is_bumped_for_shading_release(self):
        self.assertIn("const VERSION = 'v4.2.0'", self.html)


if __name__ == "__main__":
    unittest.main()
