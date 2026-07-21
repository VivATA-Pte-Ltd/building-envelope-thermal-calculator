'use strict';
importScripts('./vendor/dxf-parser/dxf-parser.js', './drawing-import.js');

self.onmessage = event => {
  try {
    const bytes = new Uint8Array(event.data?.bytes || 0);
    const result = self.VivaTEQDrawingImport.parseDxfBytes(bytes, event.data?.fileName || 'drawing.dxf', self.DxfParser);
    self.postMessage({ ok:true, result });
  } catch (error) {
    self.postMessage({ ok:false, error:self.VivaTEQDrawingImport.cleanLine(error?.message || error) });
  }
};
