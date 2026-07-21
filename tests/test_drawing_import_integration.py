from hashlib import sha256
import json
from pathlib import Path
import re
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DrawingImportIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.server = (ROOT / "server" / "app.py").read_text(encoding="utf-8")
        cls.dxf_worker = (ROOT / "drawing-dxf-worker.js").read_text(encoding="utf-8")

    def test_standalone_embeds_tested_drawing_engine(self):
        match = re.search(r'<script id="vivateq-drawing-import">\s*(.*?)\s*</script>', self.html, re.S)
        self.assertIsNotNone(match)
        source = (ROOT / "drawing-import.js").read_text(encoding="utf-8").strip()
        embedded = textwrap.dedent("    " + match.group(1)).strip()
        self.assertEqual(embedded, source)

    def test_local_pdf_dxf_review_ui_is_present(self):
        for field in (
            "drawingImportFile", "drawingImportOrientation", "drawingImportPage",
            "drawingImportLayer", "drawingImportCanvas", "drawingImportDeviceType",
            "drawingCalibrationLength", "drawingWindowHeight", "drawingWindowWidth",
            "drawingHorizontalProjection", "drawingVerticalProjection",
            "drawingImportConfirm", "drawingImportApply", "drawingImportStatus",
        ):
            self.assertIn(f'id="{field}"', self.html)
        self.assertIn('accept=".dxf,.pdf,application/pdf"', self.html)
        self.assertIn('Export DWG to DXF or IFC', self.html)
        self.assertIn('processed locally in this browser', self.html)

    def test_import_requires_confirmation_and_preserves_provenance(self):
        self.assertIn('VivaTEQDrawingImport.createAuditRecord', self.html)
        self.assertIn('if (!document.getElementById(\'drawingImportConfirm\').checked)', self.html)
        self.assertIn('drawingImportAudit[dir]', self.html)
        self.assertIn('audit.reference', self.html)
        self.assertIn('invalidateDrawingMeasurements', self.html)
        self.assertIn('drawingConfirmationSignature()', self.html)
        self.assertIn("drawingImportOrientation').addEventListener('change'", self.html)
        self.assertIn('selection or measurements changed after confirmation', self.html)
        self.assertIn('Drawing-derived geometry', self.html)

    def test_pdfjs_and_dxf_parser_are_local_pinned_assets(self):
        self.assertIn("new Worker('./drawing-dxf-worker.js')", self.html)
        self.assertIn("./vendor/dxf-parser/dxf-parser.js", self.dxf_worker)
        self.assertIn("import('./vendor/pdfjs/pdf.min.mjs')", self.html)
        self.assertIn("vendor/pdfjs/pdf.worker.min.mjs", self.html)
        self.assertNotRegex(self.html, r'<script[^>]+src=["\']https?://')
        manifest = json.loads((ROOT / "vendor" / "drawing-import-manifest.json").read_text(encoding="utf-8"))
        expected = {
            "vendor/dxf-parser/dxf-parser.js": "445dd62529369a4ef32520d8b6232031ea8af01f1029b08b2d876ff6b7807b7b",
            "vendor/pdfjs/pdf.min.mjs": "4ba2f15599b03fde8755ad91349920c21dadd3e8fd6b6460a7663d46d4cf21b5",
            "vendor/pdfjs/pdf.worker.min.mjs": "2ab9e09667296dab1a618868b3ce6e6c23d5b8f48120ae7c5b34e7e335ed01fa",
        }
        listed = {}
        for dependency in manifest["dependencies"]:
            base = "vendor/dxf-parser" if dependency["name"] == "dxf-parser" else "vendor/pdfjs"
            for name, digest in dependency["files"].items():
                listed[f"{base}/{name}"] = digest
        self.assertEqual(listed, expected)
        for relative, digest in expected.items():
            self.assertEqual(sha256((ROOT / relative).read_bytes()).hexdigest(), digest)

    def test_server_delivers_drawing_import_assets_with_module_mime(self):
        for asset in (
            '/drawing-import.js', '/drawing-dxf-worker.js', '/vendor/dxf-parser/dxf-parser.js',
            '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs',
        ):
            self.assertIn(asset, self.server)
        self.assertIn('text/javascript; charset=utf-8', self.server)

    def test_resource_limits_and_fail_closed_messages_are_integrated(self):
        self.assertIn('maximumFileBytes: 50 * 1024 * 1024', (ROOT / 'drawing-import.js').read_text(encoding='utf-8'))
        self.assertIn('maximumRenderPixels', self.html)
        self.assertIn('maximumPdfTextItemsTotal', self.html)
        self.assertIn('drawingImportDxfWorker', self.html)
        self.assertIn('DXF processing was superseded by a newer drawing', self.html)
        self.assertIn('drawingImportPdfTask', self.html)
        self.assertIn('registerTask(task)', self.html)
        self.assertIn('setDrawingImportPending(true,true)', self.html)
        self.assertIn("files[0]!==state.file", self.html)
        self.assertIn('Drawing import is disabled in a direct-file copy', self.html)
        self.assertIn('getPageText(pageNumber,page)', self.html)
        self.assertIn('pageTextCache', self.html)
        self.assertNotIn('while(end<item.startAngle)', self.html)
        self.assertIn('item.sweepAngle*i/48', self.html)
        handler = self.html[self.html.index('async function handleDrawingRenderFailure'):self.html.index("document.getElementById('drawingImportPage').addEventListener")]
        self.assertLess(handler.index('drawingImportStatus'), handler.index('await state.source.destroy'), 'failure UI must commit before asynchronous cleanup so stale cleanup cannot overwrite a newer drawing')
        load_handler = self.html[self.html.index('async function loadDrawingImportFile'):self.html.index('function selectDrawingMeasureMode')]
        catch_handler = load_handler[load_handler.rindex('}catch(error){'):]
        self.assertIn("generation!==drawingImportGeneration||input.files[0]!==file", catch_handler)
        self.assertLess(catch_handler.index('drawingImportStatus'), catch_handler.index('await source.destroy'), 'initial-load failure UI must commit before asynchronous cleanup')
        self.assertIn('state.source.cancelAllPageText?.()', self.html)
        self.assertIn("if(source?.destroy)await source.destroy()", self.html)
        self.assertIn('No drawing-derived values were applied', self.html)
        self.assertIn('Scanned/raster PDF', self.html)
        self.assertIn("location.protocol==='file:'", self.html)
        self.assertIn('included local/server edition', self.html)


if __name__ == "__main__":
    unittest.main()
