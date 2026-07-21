'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DrawingImport = require('../drawing-import.js');

function mockFile(name, bytes, type = '') {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes);
  return {
    name,
    type,
    size: data.byteLength,
    async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
    async text() { return new TextDecoder().decode(data); },
  };
}

test('accepts local DXF and PDF but tells DWG users to convert first', () => {
  assert.equal(DrawingImport.fileKind({ name:'detail.DXF', type:'' }), 'dxf');
  assert.equal(DrawingImport.fileKind({ name:'plan.pdf', type:'application/pdf' }), 'pdf');
  assert.throws(() => DrawingImport.fileKind({ name:'model.dwg' }), /export.*DXF or IFC/i);
  assert.throws(() => DrawingImport.fileKind({ name:'malware.html' }), /PDF or DXF/i);
});

test('rejects blank and oversized files before parser allocation', async () => {
  assert.throws(() => DrawingImport.validateFile({ name:'empty.dxf', size:0 }), /empty/i);
  assert.throws(() => DrawingImport.validateFile({ name:'huge.pdf', size:DrawingImport.LIMITS.maximumFileBytes + 1 }), /50 MiB/i);
  const tooLargeDxf = { name:'large.dxf', size:DrawingImport.LIMITS.maximumDxfCharacters + 1, arrayBuffer(){ throw new Error('must not allocate'); } };
  await assert.rejects(() => DrawingImport.loadDxfFile(tooLargeDxf, class {}), /text size/i);
});

test('maps every DXF insertion unit code to the specified metre factor', () => {
  const expected = [null,0.0254,0.3048,1609.344,0.001,0.01,1,1000,2.54e-8,2.54e-5,0.9144,1e-10,1e-9,1e-6,0.1,10,100,1e9,149597870700,9.4607304725808e15,3.085677581491367e16];
  expected.forEach((factor, code) => assert.equal(DrawingImport.dxfUnitToMetres(code), factor, `$INSUNITS=${code}`));
  assert.equal(DrawingImport.dxfUnitToMetres(999), null);
});

test('normalises supported DXF geometry, layers, text and bounds', () => {
  const parsed = {
    header: { $INSUNITS: 4 },
    entities: [
      { type:'LINE', layer:'WINDOW', vertices:[{x:0,y:0},{x:2000,y:0}] },
      { type:'LWPOLYLINE', layer:'SHADE', shape:true, vertices:[{x:0,y:0},{x:0,y:1500},{x:2000,y:1500}] },
      { type:'CIRCLE', layer:'NOTES', center:{x:1000,y:750}, radius:100 },
      { type:'TEXT', layer:'NOTES', text:'WINDOW 2000 x 1500', startPoint:{x:100,y:100} },
    ],
  };
  const result = DrawingImport.normaliseDxf(parsed, 'detail.dxf');
  assert.equal(result.kind, 'dxf');
  assert.equal(result.unitToMetres, 0.001);
  assert.deepEqual(result.layers, ['NOTES','SHADE','WINDOW']);
  assert.equal(result.primitives.length, 3);
  assert.match(result.text, /WINDOW 2000 x 1500/);
  assert.deepEqual(result.bounds, { minX:0, minY:0, maxX:2000, maxY:1500 });
  assert.equal(result.complete, true);
});

test('fails closed for unsupported, non-finite and excessive DXF geometry', () => {
  assert.throws(() => DrawingImport.normaliseDxf({ entities:[{ type:'INSERT', layer:'0' }] }, 'blocks.dxf'), /explode.*block/i);
  assert.throws(() => DrawingImport.normaliseDxf({ entities:[{ type:'LINE', vertices:[{x:0,y:0},{x:Infinity,y:1}] }] }, 'bad.dxf'), /finite/i);
  const entities = Array.from({length:DrawingImport.LIMITS.maximumEntities + 1}, () => ({ type:'LINE', vertices:[{x:0,y:0},{x:1,y:1}] }));
  assert.throws(() => DrawingImport.normaliseDxf({ entities }, 'huge.dxf'), /entity limit/i);
  const vertices = Array.from({length:DrawingImport.LIMITS.maximumVerticesPerEntity + 1}, (_,x) => ({x,y:0}));
  assert.throws(() => DrawingImport.normaliseDxf({entities:[{type:'LWPOLYLINE',vertices}]}, 'vertices.dxf'), /vertex limit/i);
  const texts = Array.from({length:DrawingImport.LIMITS.maximumDxfTextItems + 1}, () => ({type:'TEXT',text:''}));
  assert.throws(() => DrawingImport.normaliseDxf({entities:texts}, 'text.dxf'), /text-item limit/i);
  const extremeArc={type:'ARC',center:{x:0,y:0},radius:1,startAngle:-10000000,endAngle:9999999};
  const started=Date.now();const arcs=DrawingImport.normaliseDxf({entities:Array.from({length:10000},()=>extremeArc)},'arcs.dxf');
  assert.ok(Date.now()-started<2000,'ARC normalization must be constant-time per entity');
  assert.ok(arcs.primitives.every(item=>item.startAngle>=0&&item.startAngle<Math.PI*2&&item.sweepAngle>0&&item.sweepAngle<Math.PI*2));
  assert.throws(()=>DrawingImport.normaliseDxf({entities:[{...extremeArc,startAngle:0,endAngle:Math.PI*2}]},'full-turn.dxf'),/zero or full-turn/i);
  assert.throws(() => DrawingImport.normaliseDxf({entities:[{type:'LINE',layer:'X'.repeat(DrawingImport.LIMITS.maximumDxfLayerNameCharacters+1),vertices:[{x:0,y:0},{x:1,y:1}]}]}, 'layer.dxf'), /layer name.*text safety/i);
  assert.throws(() => DrawingImport.normaliseDxf({entities:[{type:'TEXT',text:'X'.repeat(DrawingImport.LIMITS.maximumDxfMetadataCharacters+1)}]}, 'metadata.dxf'), /text safety/i);
});

test('DXF parser receives bounded text and malformed parse fails closed', async () => {
  class Parser { parseSync(text) { assert.match(text, /SECTION/); return { header:{ $INSUNITS:6 }, entities:[{type:'LINE',vertices:[{x:0,y:0},{x:1,y:0}]}] }; } }
  const result = await DrawingImport.loadDxfFile(mockFile('one.dxf', '0\nSECTION\n0\nEOF\n'), Parser);
  assert.equal(result.primitives.length, 1);
  class BadParser { parseSync() { throw new Error('broken'); } }
  await assert.rejects(() => DrawingImport.loadDxfFile(mockFile('bad.dxf', 'broken'), BadParser), /could not be parsed/i);
});

test('PDF loader validates signature, page ceiling and extracts bounded text', async () => {
  let destroyed = false;const pagesRequested=[];
  const pdf = {
    numPages:2,
    async getMetadata() { return { info:{ Title:'Façade detail' }, metadata:null }; },
    async getPage(number) { pagesRequested.push(number);return { async getTextContent() { return { items:[{str:`Page ${number}`}] }; } }; },
    async destroy() { destroyed = true; },
  };
  const pdfjs = { getDocument(options) { assert.equal(options.isEvalSupported, false); return { promise:Promise.resolve(pdf), destroy(){} }; } };
  let registered=false,released=false;
  const loaded = await DrawingImport.loadPdfFile(mockFile('detail.pdf', '%PDF-1.7\nbody', 'application/pdf'), pdfjs, {registerTask(){registered=true;return()=>{released=true;};}});
  assert.equal(registered,true);assert.equal(released,true);
  assert.equal(loaded.pageCount, 2);
  assert.deepEqual(pagesRequested,[],'unselected PDF pages must not be processed eagerly');
  assert.equal(await loaded.getPageText(2),'Page 2');
  assert.equal(await loaded.getPageText(2),'Page 2');
  assert.deepEqual(pagesRequested,[2],'bounded page text should be cached');
  await loaded.destroy();
  assert.equal(destroyed, true);

  await assert.rejects(() => DrawingImport.loadPdfFile(mockFile('fake.pdf', 'not a pdf'), pdfjs), /signature/i);
  let staleParserCalled=false;
  await assert.rejects(() => DrawingImport.loadPdfFile(mockFile('stale.pdf','%PDF-1.7'),{getDocument(){staleParserCalled=true;}},{isCurrent:()=>false}),/superseded/i);
  assert.equal(staleParserCalled,false);
  const tooMany = { ...pdf, numPages:DrawingImport.LIMITS.maximumPdfPages + 1 };
  await assert.rejects(() => DrawingImport.loadPdfFile(mockFile('many.pdf', '%PDF-1.7'), { getDocument(){ return { promise:Promise.resolve(tooMany), destroy(){} }; } }), /page limit/i);
  const itemBomb = {...pdf,numPages:1,async getPage(){return {async getTextContent(){return {items:Array.from({length:DrawingImport.LIMITS.maximumPdfTextItemsPerPage+1},()=>({str:'x'}))};}};}};
  const itemBombLoaded=await DrawingImport.loadPdfFile(mockFile('items.pdf','%PDF-1.7'),{getDocument(){return {promise:Promise.resolve(itemBomb),destroy(){}};}});
  await assert.rejects(() => itemBombLoaded.getPageText(1),/text-item limit/i);await itemBombLoaded.destroy();
});

test('PDF stream cancellation and document cleanup remain bounded', async () => {
  let cancelCalled=false,destroyed=false,cleaned=false;
  const document={numPages:1,async getMetadata(){return {info:{}};},async getPage(){return {
    streamTextContent(){return {getReader(){let read=false;return {
      async read(){if(read)return new Promise(()=>{});read=true;return {done:false,value:{items:Array.from({length:DrawingImport.LIMITS.maximumPdfTextItemsPerPage+1},()=>({str:'x'}))}};},
      cancel(){cancelCalled=true;return new Promise(()=>{});},
    };}};},cleanup(){cleaned=true;},
  };},async destroy(){destroyed=true;}};
  const started=Date.now();
  const loaded=await DrawingImport.loadPdfFile(mockFile('cancel.pdf','%PDF-1.7'),{getDocument(){return {promise:Promise.resolve(document),destroy(){}};}});
  await assert.rejects(()=>loaded.getPageText(1),/text-item limit/i);await loaded.destroy();
  assert.equal(cancelCalled,true);assert.equal(cleaned,true);assert.equal(destroyed,true);assert.ok(Date.now()-started<2000,'cleanup exceeded its bounded deadline');
});

test('superseded PDF page text readers are cancelled immediately', async () => {
  let cancelCount=0,cleaned=false;
  const page={streamTextContent(){return {getReader(){return {read(){return new Promise(()=>{});},cancel(){cancelCount+=1;return Promise.resolve();}};}};},cleanup(){cleaned=true;}};
  const document={numPages:1,async getMetadata(){return {info:{}};},async getPage(){return page;},async destroy(){}};
  const loaded=await DrawingImport.loadPdfFile(mockFile('reader.pdf','%PDF-1.7'),{getDocument(){return {promise:Promise.resolve(document),destroy(){}};}});
  const pending=loaded.getPageText(1);await new Promise(resolve=>setImmediate(resolve));
  const started=Date.now();loaded.cancelAllPageText();
  await assert.rejects(()=>pending,/superseded/i);
  assert.ok(Date.now()-started<250,'superseded text extraction did not reject promptly');
  assert.ok(cancelCount>=1);assert.equal(cleaned,true);await loaded.destroy();
});

test('cancelled PDF page extraction does not poison cumulative budgets', async () => {
  let cancelCount=0;
  const partialPage=()=>({streamTextContent(){let reads=0;return {getReader(){return {read(){reads+=1;return reads===1?Promise.resolve({done:false,value:{items:Array.from({length:4000},()=>({str:''}))}}):new Promise(()=>{});},cancel(){cancelCount+=1;return Promise.resolve();}};}};},cleanup(){}});
  const validPage={async getTextContent(){return {items:[{str:'VALID PAGE'}]};},cleanup(){}};
  const document={numPages:2,async getMetadata(){return {info:{}};},async getPage(number){return number===1?partialPage():validPage;},async destroy(){}};
  const loaded=await DrawingImport.loadPdfFile(mockFile('transactional.pdf','%PDF-1.7'),{getDocument(){return {promise:Promise.resolve(document),destroy(){}};}});
  for(let attempt=0;attempt<5;attempt+=1){const pending=loaded.getPageText(1);await new Promise(resolve=>setImmediate(resolve));loaded.cancelPageText(1);await assert.rejects(()=>pending,/superseded/i);}
  assert.equal(cancelCount,5);assert.equal(await loaded.getPageText(2),'VALID PAGE');await loaded.destroy();
});

test('processing deadlines fail closed and invoke parser cancellation', async () => {
  let cancelled = false;
  await assert.rejects(
    DrawingImport.withProcessingDeadline(new Promise(() => {}), () => { cancelled = true; }, 5),
    /exceeded 30 seconds/,
  );
  assert.equal(cancelled, true);
  assert.throws(() => DrawingImport.parseDxfBytes(new Uint8Array(), 'empty.dxf', class {}), /empty/);
});

test('measurement conversion and shading geometry validation are fail closed', () => {
  assert.equal(DrawingImport.pixelDistance({x:0,y:0},{x:3,y:4}), 5);
  assert.equal(DrawingImport.distanceInMetres({x:0,y:0},{x:100,y:0}, { metresPerCanvasUnit:0.01 }), 1);
  assert.throws(() => DrawingImport.distanceInMetres({x:0,y:0},{x:1,y:0}, {}), /calibrat/i);

  assert.deepEqual(DrawingImport.validateMeasurements('horizontal', {
    windowHeight:1.5, horizontalProjection:0.45,
  }), { type:'horizontal', windowHeight:1.5, windowWidth:null, horizontalProjection:0.45, verticalProjection:null });
  assert.throws(() => DrawingImport.validateMeasurements('eggcrate', {
    windowHeight:1.5, windowWidth:1.2, horizontalProjection:0.3,
  }), /vertical projection/i);
  assert.throws(() => DrawingImport.validateMeasurements('vertical', {
    windowWidth:'', verticalProjection:0.3,
  }), /window width/i);
});

test('audit record requires confirmed geometry and neutralises line breaks', () => {
  const audit = DrawingImport.createAuditRecord({
    fileName:'detail\nmalicious.dxf', kind:'dxf', page:null, layer:'A-WINDOW\rX',
    unitSource:'DXF $INSUNITS=4 (millimetres)', orientation:'N',
    geometry:{type:'horizontal',windowHeight:1.5,windowWidth:null,horizontalProjection:0.45,verticalProjection:null},
    confirmed:true,
  });
  assert.equal(audit.fileName, 'detail malicious.dxf');
  assert.equal(audit.layer, 'A-WINDOW X');
  assert.match(audit.reference, /user-confirmed/);
  assert.throws(() => DrawingImport.createAuditRecord({ confirmed:false }), /confirm/i);
});
