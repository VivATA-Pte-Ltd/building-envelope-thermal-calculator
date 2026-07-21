(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VivaTEQDrawingImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    maximumFileBytes: 50 * 1024 * 1024,
    maximumDxfCharacters: 20 * 1024 * 1024,
    maximumEntities: 50000,
    maximumVerticesPerEntity: 10000,
    maximumTotalVertices: 100000,
    maximumDxfTextItems: 5000,
    maximumDxfTextCharactersTotal: 100000,
    maximumDxfLayers: 1000,
    maximumDxfLayerNameCharacters: 256,
    maximumDxfMetadataCharacters: 10000,
    maximumPdfPages: 100,
    maximumPdfTextItemsPerPage: 5000,
    maximumPdfTextItemsTotal: 20000,
    maximumTextCharactersPerPage: 20000,
    maximumPdfTextCharactersTotal: 100000,
    maximumCoordinateMagnitude: 10000000,
    maximumDimensionMetres: 1000,
    maximumRenderPixels: 20000000,
    maximumProcessingMilliseconds: 30000,
  });

  const DXF_UNIT_METRES = Object.freeze({
    1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000,
    8: 0.0000000254, 9: 0.0000254, 10: 0.9144, 11: 0.0000000001,
    12: 0.000000001, 13: 0.000001, 14: 0.1, 15: 10,
    16: 100, 17: 1000000000, 18: 149597870700, 19: 9.4607304725808e15,
    20: 3.085677581491367e16,
  });

  const DXF_UNIT_NAMES = Object.freeze({
    1:'inches', 2:'feet', 3:'miles', 4:'millimetres', 5:'centimetres', 6:'metres', 7:'kilometres',
    8:'microinches', 9:'mils', 10:'yards', 11:'angstroms', 12:'nanometres',
    13:'microns', 14:'decimetres', 15:'decametres', 16:'hectometres',
    17:'gigametres', 18:'astronomical units', 19:'light years', 20:'parsecs',
  });

  function cleanLine(value) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function boundedLine(value, label, maximumCharacters) {
    const raw = String(value ?? '');
    if (raw.length > maximumCharacters) throw new RangeError(`${label} exceeds the text safety limit`);
    return cleanLine(raw);
  }

  function fileKind(file) {
    const name = boundedLine(file?.name, 'Drawing file name', 1024).toLowerCase();
    if (name.endsWith('.dwg')) throw new RangeError('DWG is not read directly; export the drawing to DXF or IFC first');
    if (name.endsWith('.dxf')) return 'dxf';
    if (name.endsWith('.pdf') || String(file?.type || '').toLowerCase() === 'application/pdf') return 'pdf';
    throw new RangeError('Select a PDF or DXF drawing. Export DWG files to DXF or IFC first');
  }

  function validateFile(file) {
    const kind = fileKind(file);
    const size = Number(file?.size);
    if (!Number.isFinite(size) || size <= 0) throw new RangeError('The selected drawing file is empty');
    if (size > LIMITS.maximumFileBytes) throw new RangeError('Drawing files must not exceed 50 MiB');
    if (typeof file.arrayBuffer !== 'function') throw new TypeError('The selected browser file cannot be read');
    return kind;
  }

  function dxfUnitToMetres(code) {
    const value = DXF_UNIT_METRES[Number(code)];
    return Number.isFinite(value) ? value : null;
  }

  function finiteCoordinate(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError(`${label} must be finite`);
    if (Math.abs(number) > LIMITS.maximumCoordinateMagnitude) throw new RangeError(`${label} exceeds coordinate safety bounds`);
    return number;
  }

  function normaliseArcAngles(startValue, endValue, label) {
    const rawStart = finiteCoordinate(startValue, `${label} start angle`);
    const rawEnd = finiteCoordinate(endValue, `${label} end angle`);
    const turn = Math.PI * 2;
    const startAngle = ((rawStart % turn) + turn) % turn;
    const endAngle = ((rawEnd % turn) + turn) % turn;
    const sweepAngle = (endAngle - startAngle + turn) % turn;
    if (!(sweepAngle > 1e-12)) throw new RangeError(`${label} has a zero or full-turn arc sweep; use a CIRCLE entity for a full circle`);
    return { startAngle, sweepAngle };
  }

  function point(value, label) {
    if (!value || typeof value !== 'object') throw new RangeError(`${label} is missing`);
    return { x:finiteCoordinate(value.x, `${label} x`), y:finiteCoordinate(value.y, `${label} y`) };
  }

  function addPoint(bounds, value) {
    bounds.minX = Math.min(bounds.minX, value.x);
    bounds.minY = Math.min(bounds.minY, value.y);
    bounds.maxX = Math.max(bounds.maxX, value.x);
    bounds.maxY = Math.max(bounds.maxY, value.y);
  }

  function normaliseDxf(parsed, fileName = 'drawing.dxf') {
    if (!parsed || !Array.isArray(parsed.entities)) throw new RangeError('DXF has no readable ENTITIES section');
    if (parsed.entities.length === 0) throw new RangeError('DXF contains no drawing entities');
    if (parsed.entities.length > LIMITS.maximumEntities) throw new RangeError(`DXF entity limit exceeded (${LIMITS.maximumEntities})`);
    const primitives = [];
    const layers = new Set();
    const textItems = [];
    const bounds = { minX:Infinity, minY:Infinity, maxX:-Infinity, maxY:-Infinity };
    const unsupported = new Set();
    let totalVertices = 0;
    let textEntityCount = 0;
    let totalDxfTextCharacters = 0;

    for (const [index, entity] of parsed.entities.entries()) {
      const type = boundedLine(entity?.type, 'DXF entity type', 64).toUpperCase();
      const layer = boundedLine(entity?.layer || '0', 'DXF layer name', LIMITS.maximumDxfLayerNameCharacters) || '0';
      layers.add(layer);
      if (layers.size > LIMITS.maximumDxfLayers) throw new RangeError(`DXF layer limit exceeded (${LIMITS.maximumDxfLayers})`);
      const label = `DXF ${type || 'entity'} ${index + 1}`;
      if (type === 'LINE') {
        const rawVertices = Array.isArray(entity.vertices) ? entity.vertices : [];
        if (rawVertices.length > LIMITS.maximumVerticesPerEntity) throw new RangeError(`${label} vertex limit exceeded`);
        totalVertices += rawVertices.length;
        if (totalVertices > LIMITS.maximumTotalVertices) throw new RangeError(`DXF total vertex limit exceeded (${LIMITS.maximumTotalVertices})`);
        const vertices = rawVertices.map((v, i) => point(v, `${label} vertex ${i + 1}`));
        if (vertices.length < 2) throw new RangeError(`${label} requires two finite vertices`);
        const points = [vertices[0], vertices[vertices.length - 1]];
        points.forEach(v => addPoint(bounds, v));
        primitives.push({ type:'line', layer, points });
      } else if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
        const rawVertices = Array.isArray(entity.vertices) ? entity.vertices : [];
        if (rawVertices.length > LIMITS.maximumVerticesPerEntity) throw new RangeError(`${label} vertex limit exceeded`);
        totalVertices += rawVertices.length;
        if (totalVertices > LIMITS.maximumTotalVertices) throw new RangeError(`DXF total vertex limit exceeded (${LIMITS.maximumTotalVertices})`);
        const points = rawVertices.map((v, i) => point(v, `${label} vertex ${i + 1}`));
        if (points.length < 2) throw new RangeError(`${label} requires at least two finite vertices`);
        points.forEach(v => addPoint(bounds, v));
        primitives.push({ type:'polyline', layer, points, closed:Boolean(entity.shape || entity.closed) });
      } else if (type === 'CIRCLE') {
        const center = point(entity.center, `${label} centre`);
        const radius = finiteCoordinate(entity.radius, `${label} radius`);
        if (!(radius > 0)) throw new RangeError(`${label} radius must be positive`);
        addPoint(bounds, {x:center.x-radius,y:center.y-radius}); addPoint(bounds, {x:center.x+radius,y:center.y+radius});
        primitives.push({ type:'circle', layer, center, radius });
      } else if (type === 'ARC') {
        const center = point(entity.center, `${label} centre`);
        const radius = finiteCoordinate(entity.radius, `${label} radius`);
        const { startAngle, sweepAngle } = normaliseArcAngles(entity.startAngle, entity.endAngle, label);
        if (!(radius > 0)) throw new RangeError(`${label} radius must be positive`);
        addPoint(bounds, {x:center.x-radius,y:center.y-radius}); addPoint(bounds, {x:center.x+radius,y:center.y+radius});
        primitives.push({ type:'arc', layer, center, radius, startAngle, sweepAngle });
      } else if (type === 'POINT') {
        const location = point(entity.position || entity, `${label} position`);
        addPoint(bounds, location); primitives.push({ type:'point', layer, point:location });
      } else if (type === 'TEXT' || type === 'MTEXT' || type === 'DIMENSION' || type === 'ATTDEF') {
        textEntityCount += 1;
        if (textEntityCount > LIMITS.maximumDxfTextItems) throw new RangeError(`DXF text-item limit exceeded (${LIMITS.maximumDxfTextItems})`);
        const content = boundedLine(entity.text || entity.string || entity.actualMeasurement || entity.measurement || '', `${label} text`, LIMITS.maximumDxfMetadataCharacters);
        if (content) {
          totalDxfTextCharacters += content.length + 1;
          if (totalDxfTextCharacters > LIMITS.maximumDxfTextCharactersTotal) throw new RangeError(`DXF cumulative text limit exceeded (${LIMITS.maximumDxfTextCharactersTotal})`);
          textItems.push(content);
        }
        const locationValue = entity.startPoint || entity.position || entity.anchorPoint;
        if (locationValue) {
          const location = point(locationValue, `${label} position`);
          addPoint(bounds, location);
        }
      } else {
        unsupported.add(type || 'UNKNOWN');
      }
    }

    if (unsupported.size) {
      const names = [...unsupported].sort().join(', ');
      const blockHint = unsupported.has('INSERT') ? ' Explode referenced blocks before export.' : '';
      throw new RangeError(`Unsupported DXF entities: ${names}.${blockHint}`);
    }
    if (!primitives.length) throw new RangeError('DXF contains no supported measurable geometry');
    if (![bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].every(Number.isFinite)) throw new RangeError('DXF drawing bounds must be finite');
    if (!(bounds.maxX > bounds.minX || bounds.maxY > bounds.minY)) throw new RangeError('DXF drawing has zero measurable extent');
    const unitCode = Number(parsed.header?.$INSUNITS ?? 0);
    const unitToMetres = dxfUnitToMetres(unitCode);
    return Object.freeze({
      kind:'dxf', fileName:boundedLine(fileName, 'DXF file name', 1024), primitives:Object.freeze(primitives),
      layers:Object.freeze([...layers].sort()), text:textItems.join('\n').slice(0, LIMITS.maximumTextCharactersPerPage),
      bounds:Object.freeze(bounds), unitCode, unitToMetres,
      unitSource:unitToMetres ? `DXF $INSUNITS=${unitCode} (${DXF_UNIT_NAMES[unitCode] || 'supported units'})` : 'DXF units unspecified — calibration required',
      complete:true,
    });
  }

  function parseDxfBytes(bytesValue, fileName, ParserClass) {
    if (typeof ParserClass !== 'function') throw new TypeError('The pinned DXF parser is unavailable');
    const bytes = bytesValue instanceof Uint8Array ? bytesValue : new Uint8Array(bytesValue || 0);
    if (!bytes.byteLength) throw new RangeError('The selected drawing file is empty');
    if (bytes.byteLength > LIMITS.maximumDxfCharacters) throw new RangeError('DXF text size exceeds the parser safety limit');
    if (bytes.includes(0)) throw new RangeError('Binary DXF is not supported; export an ASCII DXF file');
    const text = new TextDecoder('utf-8', { fatal:false }).decode(bytes);
    let parsed;
    try { parsed = new ParserClass().parseSync(text); }
    catch (error) { throw new RangeError(`DXF could not be parsed: ${cleanLine(error?.message || error)}`); }
    return normaliseDxf(parsed, fileName);
  }

  async function loadDxfFile(file, ParserClass) {
    validateFile(file);
    if (fileKind(file) !== 'dxf') throw new RangeError('Select a DXF file');
    if (file.size > LIMITS.maximumDxfCharacters) throw new RangeError('DXF text size exceeds the parser safety limit');
    return parseDxfBytes(new Uint8Array(await file.arrayBuffer()), file.name, ParserClass);
  }

  async function withProcessingDeadline(promise, onTimeout, milliseconds = LIMITS.maximumProcessingMilliseconds) {
    let timer;
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      Promise.resolve(promise).catch(() => {});
      try { onTimeout?.(); } catch (_) { /* best-effort parser cancellation */ }
      throw new RangeError(`Drawing processing exceeded ${LIMITS.maximumProcessingMilliseconds / 1000} seconds`);
    }
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { onTimeout?.(); } catch (_) { /* best-effort parser cancellation */ }
            reject(new RangeError(`Drawing processing exceeded ${LIMITS.maximumProcessingMilliseconds / 1000} seconds`));
          }, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function boundedCleanup(callback) {
    try {
      const cleanup = Promise.resolve().then(callback);
      await Promise.race([cleanup, new Promise(resolve => setTimeout(resolve, 1000))]);
    } catch (_) { /* cleanup must not conceal the original result */ }
  }

  async function loadPdfFile(file, pdfjs, options = {}) {
    validateFile(file);
    if (fileKind(file) !== 'pdf') throw new RangeError('Select a PDF file');
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') throw new TypeError('The pinned PDF.js reader is unavailable');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (typeof options.isCurrent === 'function' && !options.isCurrent()) throw new RangeError('PDF processing was superseded by a newer drawing');
    const signature = new TextDecoder('ascii').decode(bytes.slice(0, 5));
    if (signature !== '%PDF-') throw new RangeError('The selected file does not have a valid PDF signature');
    const task = pdfjs.getDocument({ data:bytes, isEvalSupported:false, disableAutoFetch:true, disableStream:true, stopAtErrors:true });
    const releaseTask = typeof options.registerTask === 'function' ? (options.registerTask(task) || (() => {})) : (() => {});
    const deadline = Date.now() + LIMITS.maximumProcessingMilliseconds;
    const bounded = promise => withProcessingDeadline(promise, () => task.destroy?.(), deadline - Date.now());
    let document;
    try {
      document = await bounded(task.promise);
      if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new RangeError('PDF contains no readable pages');
      if (document.numPages > LIMITS.maximumPdfPages) throw new RangeError(`PDF page limit exceeded (${LIMITS.maximumPdfPages})`);
      let title = '';
      try { title = boundedLine((await bounded(document.getMetadata()))?.info?.Title || '', 'PDF title', LIMITS.maximumDxfMetadataCharacters); }
      catch (error) { if (error instanceof RangeError) throw error; }
      const pageTextCache = new Map();
      const pageTextPending = new Map();
      let totalTextItems = 0;
      let totalTextCharacters = 0;
      const getPageText = async (numberValue, pageProxy = null) => {
        const number = Number(numberValue);
        if (!Number.isInteger(number) || number < 1 || number > document.numPages) throw new RangeError('Select a valid PDF page');
        if (pageTextCache.has(number)) return pageTextCache.get(number);
        if (pageTextPending.has(number)) return pageTextPending.get(number).promise;
        let activeReader = null;
        let readerCancellationStarted = false;
        let cancelled = false;
        let rejectCancellation;
        const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          rejectCancellation(new RangeError('PDF page-text extraction was superseded'));
          if (activeReader && !readerCancellationStarted) {
            readerCancellationStarted = true;
            const readerToCancel = activeReader;
            void boundedCleanup(() => readerToCancel.cancel());
          }
        };
        const extraction = (async () => {
          const pageDeadline = Date.now() + LIMITS.maximumProcessingMilliseconds;
          const pageBounded = promise => withProcessingDeadline(Promise.race([promise, cancellation]), () => task.destroy?.(), pageDeadline - Date.now());
          const ownsPage = !pageProxy;
          const page = pageProxy || await pageBounded(document.getPage(number));
          try {
            const chunks = [];
            let pageCharacters = 0;
            let pageTextItems = 0;
            const consumeItems = items => {
              if (!Array.isArray(items)) throw new RangeError(`PDF page ${number} returned invalid text content`);
              pageTextItems += items.length;
              if (pageTextItems > LIMITS.maximumPdfTextItemsPerPage) throw new RangeError(`PDF page ${number} text-item limit exceeded (${LIMITS.maximumPdfTextItemsPerPage})`);
              if (totalTextItems + pageTextItems > LIMITS.maximumPdfTextItemsTotal) throw new RangeError(`PDF cumulative text-item limit exceeded (${LIMITS.maximumPdfTextItemsTotal})`);
              for (const item of items) {
                const raw = String(item?.str ?? '');
                if (raw.length > LIMITS.maximumTextCharactersPerPage) throw new RangeError(`PDF page ${number} contains an excessive text item`);
                const value = cleanLine(raw);
                if (!value) continue;
                const nextPageCharacters = pageCharacters + value.length + 1;
                const nextTotalCharacters = totalTextCharacters + nextPageCharacters;
                if (nextPageCharacters > LIMITS.maximumTextCharactersPerPage) throw new RangeError(`PDF page ${number} text-character limit exceeded (${LIMITS.maximumTextCharactersPerPage})`);
                if (nextTotalCharacters > LIMITS.maximumPdfTextCharactersTotal) throw new RangeError(`PDF cumulative text-character limit exceeded (${LIMITS.maximumPdfTextCharactersTotal})`);
                chunks.push(value);pageCharacters=nextPageCharacters;
              }
            };
            if (typeof page.streamTextContent === 'function') {
              const reader = page.streamTextContent({ disableNormalization:false }).getReader();
              activeReader = reader;
              let finished = false;
              try {
                while (!finished) {
                  const result = await pageBounded(reader.read());finished=Boolean(result.done);
                  if (!finished) consumeItems(result.value?.items);
                }
              } finally {
                if (!finished && !readerCancellationStarted) {
                  readerCancellationStarted = true;
                  await boundedCleanup(() => reader.cancel());
                }
                if (activeReader === reader) activeReader = null;
              }
            } else {
              const content = await pageBounded(page.getTextContent({ disableNormalization:false }));
              consumeItems(content?.items);
            }
            const text = chunks.join(' ');
            if (totalTextItems + pageTextItems > LIMITS.maximumPdfTextItemsTotal) throw new RangeError(`PDF cumulative text-item limit exceeded (${LIMITS.maximumPdfTextItemsTotal})`);
            if (totalTextCharacters + pageCharacters > LIMITS.maximumPdfTextCharactersTotal) throw new RangeError(`PDF cumulative text-character limit exceeded (${LIMITS.maximumPdfTextCharactersTotal})`);
            totalTextItems += pageTextItems;
            totalTextCharacters += pageCharacters;
            pageTextCache.set(number, text);
            return text;
          } finally {
            if (ownsPage && typeof page.cleanup === 'function') page.cleanup();
          }
        })();
        pageTextPending.set(number, { promise:extraction, cancel });
        try { return await extraction; }
        finally { pageTextPending.delete(number); }
      };
      const cancelPageText = number => pageTextPending.get(Number(number))?.cancel();
      const cancelAllPageText = () => pageTextPending.forEach(active => active.cancel());
      const destroy = async () => boundedCleanup(() => {
        cancelAllPageText();
        if (document && typeof document.destroy === 'function') return document.destroy();
        if (task && typeof task.destroy === 'function') return task.destroy();
      });
      return Object.freeze({ kind:'pdf', fileName:boundedLine(file.name, 'PDF file name', 1024), pageCount:document.numPages, title, document, getPageText, cancelPageText, cancelAllPageText, destroy });
    } catch (error) {
      await boundedCleanup(() => {
        if (document && typeof document.destroy === 'function') return document.destroy();
        if (task && typeof task.destroy === 'function') return task.destroy();
      });
      if (error instanceof RangeError) throw error;
      throw new RangeError(`PDF could not be read safely: ${cleanLine(error?.message || error)}`);
    } finally {
      releaseTask();
    }
  }

  function pixelDistance(a, b) {
    const ax = finiteCoordinate(a?.x, 'First point x'); const ay = finiteCoordinate(a?.y, 'First point y');
    const bx = finiteCoordinate(b?.x, 'Second point x'); const by = finiteCoordinate(b?.y, 'Second point y');
    return Math.hypot(bx - ax, by - ay);
  }

  function distanceInMetres(a, b, scale) {
    const metresPerCanvasUnit = Number(scale?.metresPerCanvasUnit);
    if (!Number.isFinite(metresPerCanvasUnit) || metresPerCanvasUnit <= 0) throw new RangeError('Calibrate the drawing scale before measuring geometry');
    const value = pixelDistance(a, b) * metresPerCanvasUnit;
    if (!(value > 0) || value > LIMITS.maximumDimensionMetres) throw new RangeError('Measured dimension is outside the supported physical range');
    return value;
  }

  function positiveDimension(value, label) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) throw new TypeError(`${label} is required`);
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > LIMITS.maximumDimensionMetres) throw new RangeError(`${label} must be greater than zero and no more than ${LIMITS.maximumDimensionMetres} m`);
    return number;
  }

  function validateMeasurements(typeValue, input) {
    const type = cleanLine(typeValue).toLowerCase();
    if (!['horizontal','vertical','eggcrate'].includes(type)) throw new RangeError('Select a supported standard shading-device type');
    const geometry = { type, windowHeight:null, windowWidth:null, horizontalProjection:null, verticalProjection:null };
    if (type === 'horizontal' || type === 'eggcrate') {
      geometry.windowHeight = positiveDimension(input?.windowHeight, 'Window height');
      geometry.horizontalProjection = positiveDimension(input?.horizontalProjection, 'Horizontal projection');
    }
    if (type === 'vertical' || type === 'eggcrate') {
      geometry.windowWidth = positiveDimension(input?.windowWidth, 'Window width');
      geometry.verticalProjection = positiveDimension(input?.verticalProjection, 'Vertical projection');
    }
    return geometry;
  }

  function createAuditRecord(input) {
    if (!input?.confirmed) throw new RangeError('Confirm the drawing-derived geometry before applying it');
    const geometry = validateMeasurements(input.geometry?.type, input.geometry || {});
    const fileName = cleanLine(input.fileName);
    const kind = cleanLine(input.kind).toUpperCase();
    const orientation = cleanLine(input.orientation).toUpperCase();
    const layer = cleanLine(input.layer || 'all supported layers');
    const page = input.page == null ? null : Number(input.page);
    if (!fileName || !['DXF','PDF'].includes(kind) || !orientation) throw new RangeError('Drawing source, type and target orientation are required');
    if (page !== null && (!Number.isInteger(page) || page < 1 || page > LIMITS.maximumPdfPages)) throw new RangeError('PDF page number is invalid');
    const sourcePart = kind === 'PDF' ? `${fileName}, page ${page}` : `${fileName}, layer ${layer}`;
    const unitSource = cleanLine(input.unitSource || 'user calibration');
    return Object.freeze({
      fileName, kind:kind.toLowerCase(), page, layer, orientation, unitSource, geometry, confirmed:true,
      device:`${geometry.type} device measured from ${sourcePart}`,
      reference:`Drawing-derived geometry; ${unitSource}; user-confirmed; QP to verify against the issued drawing`,
    });
  }

  return Object.freeze({
    LIMITS, cleanLine, fileKind, validateFile, dxfUnitToMetres, normaliseDxf, parseDxfBytes, loadDxfFile,
    loadPdfFile, withProcessingDeadline, pixelDistance, distanceInMetres, validateMeasurements, createAuditRecord,
  });
});
