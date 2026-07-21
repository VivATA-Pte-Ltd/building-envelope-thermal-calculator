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

    def test_standard_geometry_and_ifc_workflows_are_available(self):
        for value in ('value="standard-auto"', 'value="ifc"'):
            self.assertIn(value, self.html)
        for suffix in (
            "_standardType",
            "_windowHeight",
            "_windowWidth",
            "_horizontalProjection",
            "_verticalProjection",
            "_deviceAngle",
        ):
            self.assertIn(f"${{dir}}{suffix}", self.html)
        for field_id in ("ifcFile", "ifcNorthRotation", "analyseIfcButton", "ifcAnalysisStatus"):
            self.assertIn(f'id="{field_id}"', self.html)
        self.assertIn("VivaTEQShading.calculateStandardSC2", self.html)
        self.assertIn("VivaTEQIfcLoader.loadIfcFile", self.html)
        self.assertIn("VivaTEQIfcShading.analyzeIfcGeometry", self.html)
        self.assertIn("IfcWindow express IDs", self.html)
        self.assertIn("generatedMetadataComplete = metadata.rejectedWindows.length === 0", self.html)

    def test_standalone_html_embeds_generated_data_and_ifc_engines(self):
        for script_id, filename in (
            ("vivateq-shading-data", "shading-data.js"),
            ("vivateq-ifc-shading-engine", "ifc-shading.js"),
            ("vivateq-ifc-loader", "ifc-loader.js"),
        ):
            match = re.search(fr'<script id="{script_id}">\s*(.*?)\s*</script>', self.html, re.S)
            self.assertIsNotNone(match, f"standalone HTML must embed {filename}")
            source = (ROOT / filename).read_text(encoding="utf-8").strip()
            embedded = textwrap.dedent("    " + match.group(1)).strip()
            self.assertEqual(embedded, source)

    def test_exports_disclose_shading_inputs_and_method(self):
        for heading in ("Glass SC1", "External-device SC2", "Combined SC", "Shading method", "Reference / assumptions"):
            self.assertIn(heading, self.html)
        self.assertIn('<th>Method</th><th>Shading device</th><th>Reference / assumptions</th>', self.html)

    def test_invalid_shading_blocks_exports_and_report_text_is_escaped(self):
        self.assertIn("invalidDirections", self.html)
        self.assertIn("if (orient.invalidDirections.length)", self.html)
        self.assertIn("staging.appendChild(element)", self.html)
        self.assertIn("position:relative; width:1200px", self.html)
        self.assertNotIn("element.style.cssText = 'position:absolute; left:-9999px", self.html)
        self.assertIn('let ifcAnalysisGeneration = 0', self.html)
        self.assertIn('const generation = ++ifcAnalysisGeneration', self.html)
        self.assertIn('generation !== ifcAnalysisGeneration || fileInput.files[0] !== file', self.html)
        self.assertIn('ifcAnalysisGeneration += 1', self.html)
        self.assertIn('function invalidateIfcAnalysis()', self.html)
        self.assertIn("document.getElementById('ifcFile').addEventListener('change', invalidateIfcAnalysis)", self.html)
        self.assertIn("document.getElementById('ifcNorthRotation').addEventListener('input', invalidateIfcAnalysis)", self.html)
        self.assertIn("Re-run IFC analysis before calculation or export", self.html)
        self.assertNotRegex(self.html, r'<script[^>]+src=["\']https?://')
        self.assertIn("connect-src 'self';", self.html)
        self.assertNotIn("connect-src 'self' http", self.html)
        self.assertNotIn('vivateq-pte-ltd.github.io/building-envelope-thermal-calculator-demo/standards.json', self.html)
        self.assertIn("object-src 'none'", self.html)
        self.assertIn('vendor/sheetjs/xlsx.full.min.js', self.html)
        self.assertIn('vendor/html2pdf/html2pdf.bundle.min.js', self.html)
        self.assertIn("VivaTEQShading.escapeHTML(layer.name)", self.html)
        self.assertIn("VivaTEQShading.escapeHTML(rttvData.drawingNo)", self.html)
        self.assertIn("VivaTEQShading.safeSpreadsheetText(layer.name)", self.html)
        self.assertIn("if (mode !== 'legacy') inp.solarFactor.value", self.html)
        self.assertIn("function sanitizeRTTVReportData", self.html)
        self.assertIn("let activeDevice", self.html)

    def test_version_is_bumped_for_drawing_import_release(self):
        self.assertIn("const VERSION = 'v4.4.0'", self.html)


if __name__ == "__main__":
    unittest.main()
