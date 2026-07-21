(function (root, factory) {
  const engine = root.VivaTEQIfcShading || (typeof module === 'object' && module.exports ? require('./ifc-shading.js') : null);
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VivaTEQIfcLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ifcShading) {
  'use strict';

  const WEB_IFC_VERSION = '0.0.77';
  const DEFAULT_MODULE_URL = './vendor/web-ifc/web-ifc-api.js';
  const DEFAULT_WASM_PATH = './vendor/web-ifc/';
  const MAXIMUM_FILE_BYTES = 250 * 1024 * 1024;
  const MAXIMUM_MODEL_TRIANGLES = 500000;
  const MAXIMUM_WINDOW_SURFACE_TRIANGLES = 2000;
  const MAXIMUM_MODEL_VERTEX_RECORDS = 1000000;
  const MAXIMUM_WINDOW_VERTEX_RECORDS = 6000;
  const MAXIMUM_COORDINATE_MAGNITUDE = 10000000;
  const MAXIMUM_TRANSFORMATION_COEFFICIENT = 10000000;
  const MAXIMUM_WINDOW_SPAN = 1000;
  const MAXIMUM_WINDOW_ASPECT_RATIO = 10000;

  function point(x, y, z) { return { x, y, z }; }
  function add(a, b) { return point(a.x + b.x, a.y + b.y, a.z + b.z); }
  function subtract(a, b) { return point(a.x - b.x, a.y - b.y, a.z - b.z); }
  function scale(a, amount) { return point(a.x * amount, a.y * amount, a.z * amount); }
  function dot(a, b) { return (a.x * b.x) + (a.y * b.y) + (a.z * b.z); }
  function cross(a, b) { return point((a.y * b.z) - (a.z * b.y), (a.z * b.x) - (a.x * b.z), (a.x * b.y) - (a.y * b.x)); }
  function magnitude(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) {
    const amount = magnitude(a);
    if (!(amount > 1e-12)) throw new RangeError('Cannot normalize a zero-length vector');
    return scale(a, 1 / amount);
  }

  function transformPoint(value, matrix) {
    if (!Array.isArray(matrix) && !(matrix && typeof matrix.length === 'number')) throw new TypeError('A 4×4 placement matrix is required');
    return point(
      (matrix[0] * value.x) + (matrix[4] * value.y) + (matrix[8] * value.z) + matrix[12],
      (matrix[1] * value.x) + (matrix[5] * value.y) + (matrix[9] * value.z) + matrix[13],
      (matrix[2] * value.x) + (matrix[6] * value.y) + (matrix[10] * value.z) + matrix[14],
    );
  }

  function triangleAreaNormal(triangle) {
    const raw = cross(subtract(triangle.b, triangle.a), subtract(triangle.c, triangle.a));
    const doubleArea = magnitude(raw);
    return { area: doubleArea / 2, normal: doubleArea > 1e-12 ? scale(raw, 1 / doubleArea) : point(0, 0, 0) };
  }

  function uniqueVertices(triangles) {
    const seen = new Map();
    triangles.forEach(triangle => {
      for (const vertex of [triangle.a, triangle.b, triangle.c]) {
        const key = `${vertex.x},${vertex.y},${vertex.z}`;
        if (!seen.has(key)) seen.set(key, vertex);
      }
    });
    return [...seen.values()];
  }

  function convexHull2D(points) {
    const unique = [...new Map(points.map(value => [`${value.u},${value.v}`, value])).values()]
      .sort((a, b) => a.u - b.u || a.v - b.v);
    if (unique.length < 3) return [];
    const turn = (a, b, c) => ((b.u - a.u) * (c.v - a.v)) - ((b.v - a.v) * (c.u - a.u));
    const half = values => {
      const result = [];
      values.forEach(value => {
        while (result.length >= 2 && turn(result[result.length - 2], result[result.length - 1], value) <= 0) result.pop();
        result.push(value);
      });
      return result;
    };
    return [...half(unique).slice(0, -1), ...half([...unique].reverse()).slice(0, -1)];
  }

  function polygonArea2D(polygon) {
    return Math.abs(polygon.reduce((sum, value, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + (value.u * next.v) - (next.u * value.v);
    }, 0)) / 2;
  }

  function signedPolygonArea2D(polygon) {
    return polygon.reduce((sum, value, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + (value.u * next.v) - (next.u * value.v);
    }, 0) / 2;
  }

  function projectedTriangleIntersectionArea(first, second) {
    const bounds = triangle => ({
      minU: Math.min(...triangle.map(value => value.u)), maxU: Math.max(...triangle.map(value => value.u)),
      minV: Math.min(...triangle.map(value => value.v)), maxV: Math.max(...triangle.map(value => value.v)),
    });
    const aBounds = bounds(first); const bBounds = bounds(second);
    if (Math.min(aBounds.maxU, bBounds.maxU) <= Math.max(aBounds.minU, bBounds.minU)
      || Math.min(aBounds.maxV, bBounds.maxV) <= Math.max(aBounds.minV, bBounds.minV)) return 0;
    const clip = signedPolygonArea2D(second) >= 0 ? second : [...second].reverse();
    let subject = signedPolygonArea2D(first) >= 0 ? [...first] : [...first].reverse();
    const cross2D = (a, b, p) => ((b.u - a.u) * (p.v - a.v)) - ((b.v - a.v) * (p.u - a.u));
    const intersection = (start, end, a, b) => {
      const edgeU = b.u - a.u; const edgeV = b.v - a.v;
      const moveU = end.u - start.u; const moveV = end.v - start.v;
      const denominator = (moveU * edgeV) - (moveV * edgeU);
      if (denominator === 0) return { u:(start.u + end.u) / 2, v:(start.v + end.v) / 2 };
      const t = (((a.u - start.u) * edgeV) - ((a.v - start.v) * edgeU)) / denominator;
      return { u:start.u + (t * moveU), v:start.v + (t * moveV) };
    };
    for (let edgeIndex = 0; edgeIndex < clip.length && subject.length; edgeIndex += 1) {
      const a = clip[edgeIndex]; const b = clip[(edgeIndex + 1) % clip.length];
      const input = subject; subject = [];
      for (let index = 0; index < input.length; index += 1) {
        const start = input[index]; const end = input[(index + 1) % input.length];
        const startInside = cross2D(a, b, start) >= 0;
        const endInside = cross2D(a, b, end) >= 0;
        if (startInside && endInside) subject.push(end);
        else if (startInside && !endInside) subject.push(intersection(start, end, a, b));
        else if (!startInside && endInside) {
          subject.push(intersection(start, end, a, b));
          subject.push(end);
        }
      }
    }
    return subject.length >= 3 ? polygonArea2D(subject) : 0;
  }

  function pointInConvexPolygon(pointValue, polygon) {
    let sign = 0;
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]; const b = polygon[(index + 1) % polygon.length];
      const value = ((b.u - a.u) * (pointValue.v - a.v)) - ((b.v - a.v) * (pointValue.u - a.u));
      if (value === 0) continue;
      if (!sign) sign = Math.sign(value);
      else if (Math.sign(value) !== sign) return false;
    }
    return true;
  }

  function deriveWindowDescriptor(expressID, triangles, modelCenter, northRotation = 0) {
    if (!Array.isArray(triangles) || !triangles.length) throw new RangeError(`IFC window #${expressID} has no tessellated geometry`);
    if (triangles.length > MAXIMUM_WINDOW_SURFACE_TRIANGLES) {
      throw new RangeError(`IFC window #${expressID} exceeds the ${MAXIMUM_WINDOW_SURFACE_TRIANGLES.toLocaleString()}-triangle browser topology limit`);
    }
    const vertices = uniqueVertices(triangles);
    if (vertices.some(vertex => ![vertex.x, vertex.y, vertex.z].every(Number.isFinite)
      || [vertex.x, vertex.y, vertex.z].some(value => Math.abs(value) > MAXIMUM_COORDINATE_MAGNITUDE))) {
      throw new RangeError(`IFC window #${expressID} exceeds finite coordinate safety bounds`);
    }
    const spans = ['x', 'y', 'z'].map(axis => Math.max(...vertices.map(vertex => vertex[axis])) - Math.min(...vertices.map(vertex => vertex[axis])));
    if (Math.max(...spans) > MAXIMUM_WINDOW_SPAN) {
      throw new RangeError(`IFC window #${expressID} exceeds the ${MAXIMUM_WINDOW_SPAN.toLocaleString()}-metre physical span limit`);
    }
    const centroid = scale(vertices.reduce((sum, vertex) => add(sum, vertex), point(0, 0, 0)), 1 / vertices.length);
    const candidates = triangles
      .map(triangle => ({ triangle, ...triangleAreaNormal(triangle) }))
      .filter(candidate => candidate.area > 1e-8 && Math.abs(candidate.normal.z) < 0.25);
    if (!candidates.length) throw new RangeError(`IFC window #${expressID} has no vertical window surface`);

    let normal = [...candidates].sort((a, b) => b.area - a.area)[0].normal;
    if (dot(normal, subtract(centroid, modelCenter)) < 0) normal = scale(normal, -1);
    const up = point(0, 0, 1);
    const right = normalize(cross(normal, up));

    const coordinateScale = Math.max(1, ...vertices.map(vertex => magnitude(subtract(vertex, centroid))));
    const maximumAbsoluteCoordinate = Math.max(1, ...vertices.flatMap(vertex => [Math.abs(vertex.x), Math.abs(vertex.y), Math.abs(vertex.z)]));
    const planeTolerance = Math.max(1e-8, Number.EPSILON * maximumAbsoluteCoordinate * 4);
    const planes = [];
    candidates.filter(candidate => Math.abs(dot(candidate.normal, normal)) >= 0.995).forEach(candidate => {
      const offsets = [candidate.triangle.a, candidate.triangle.b, candidate.triangle.c]
        .map(vertex => dot(subtract(vertex, centroid), normal));
      const plane = offsets.reduce((sum, value) => sum + value, 0) / 3;
      let group = planes.find(value => Math.abs(value.plane - plane) <= planeTolerance);
      if (!group) {
        group = { plane, triangles: [], projectedTriangles: [], projectedArea: 0, coplanar:true };
        planes.push(group);
      }
      if (offsets.some(value => Math.abs(value - group.plane) > planeTolerance)) group.coplanar = false;
      group.triangles.push(candidate.triangle);
      group.projectedTriangles.push([candidate.triangle.a, candidate.triangle.b, candidate.triangle.c]
        .map(vertex => ({ u:dot(subtract(vertex, centroid), right), v:dot(subtract(vertex, centroid), up) })));
      group.projectedArea += candidate.area * Math.abs(dot(candidate.normal, normal));
    });
    const completePlanes = planes.map(group => {
      const surfaceVertices = uniqueVertices(group.triangles);
      const hull = convexHull2D(surfaceVertices.map(vertex => ({ u: dot(subtract(vertex, centroid), right), v: dot(subtract(vertex, centroid), up) })));
      const hullArea = polygonArea2D(hull);
      const tolerance = Math.max(Number.MIN_VALUE, Number.EPSILON * hullArea * 128);
      let overlapArea = 0;
      if (group.projectedTriangles.length <= MAXIMUM_WINDOW_SURFACE_TRIANGLES) {
        const projected = group.projectedTriangles.map(triangle => ({
          triangle,
          minU:Math.min(...triangle.map(value => value.u)), maxU:Math.max(...triangle.map(value => value.u)),
          minV:Math.min(...triangle.map(value => value.v)), maxV:Math.max(...triangle.map(value => value.v)),
        })).sort((a, b) => a.minU - b.minU);
        let active = [];
        for (const current of projected) {
          active = active.filter(candidate => candidate.maxU > current.minU);
          for (const candidate of active) {
            if (Math.min(candidate.maxV, current.maxV) <= Math.max(candidate.minV, current.minV)) continue;
            overlapArea += projectedTriangleIntersectionArea(candidate.triangle, current.triangle);
            if (overlapArea > tolerance) break;
          }
          if (overlapArea > tolerance) break;
          active.push(current);
        }
      }
      const complete = group.projectedTriangles.length <= MAXIMUM_WINDOW_SURFACE_TRIANGLES
        && group.coplanar
        && hullArea > 1e-8
        && Math.abs(group.projectedArea - hullArea) <= tolerance
        && overlapArea <= tolerance;
      return { ...group, hull, hullArea, complete };
    }).filter(group => group.complete)
      .sort((a, b) => b.plane - a.plane);
    let supportedPlanes = [...completePlanes];
    const polygonTolerance = Math.max(1e-9, Number.EPSILON * coordinateScale * 256);
    const sameHull = (first, second) => first.hull.length === second.hull.length
      && first.hull.every(vertex => second.hull.some(other => Math.hypot(vertex.u - other.u, vertex.v - other.v) <= polygonTolerance));
    if (supportedPlanes.length > 1) {
      const matchedPlanes = supportedPlanes.filter((group, index, all) => all.some((other, otherIndex) => otherIndex !== index && sameHull(group, other)));
      if (matchedPlanes.length) supportedPlanes = matchedPlanes;
      else {
        const hasConnector = triangles.some(triangle => {
          const offsets = [triangle.a, triangle.b, triangle.c].map(vertex => dot(subtract(vertex, centroid), normal));
          const minimum = Math.min(...offsets); const maximum = Math.max(...offsets);
          return maximum - minimum > planeTolerance
            && supportedPlanes.filter(group => group.plane >= minimum - planeTolerance && group.plane <= maximum + planeTolerance).length >= 2;
        });
        if (!hasConnector) supportedPlanes = [];
      }
    }
    if (supportedPlanes.length) supportedPlanes.sort((a, b) => b.hullArea - a.hullArea || b.plane - a.plane);
    if (!supportedPlanes.length) {
      throw new RangeError(`IFC window #${expressID} has unsupported non-convex, fragmented or overlapping exterior geometry`);
    }
    const surface = supportedPlanes[0];
    const envelopePlanes = completePlanes.filter(group => sameHull(group, surface));
    const envelopeMinimum = Math.min(...envelopePlanes.map(group => group.plane));
    const envelopeMaximum = Math.max(...envelopePlanes.map(group => group.plane));
    const envelopeTriangles = new Set(envelopePlanes.flatMap(group => group.triangles));
    const connectorTriangles = triangles.filter(triangle => !envelopeTriangles.has(triangle));
    if (connectorTriangles.length) {
      if (envelopePlanes.length < 2 || envelopeMaximum - envelopeMinimum <= planeTolerance) {
        throw new RangeError(`IFC window #${expressID} has disconnected or unrelated tessellated geometry`);
      }
      const vertexDistance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
      const projectVertex = vertex => {
        const relative = subtract(vertex, centroid);
        return { u:dot(relative, right), v:dot(relative, up), depth:dot(relative, normal) };
      };
      const onEdge = (point, first, second) => {
        const edgeU = second.u - first.u; const edgeV = second.v - first.v;
        const length = Math.hypot(edgeU, edgeV);
        if (!(length > polygonTolerance)) return false;
        const cross = Math.abs(((point.u - first.u) * edgeV) - ((point.v - first.v) * edgeU));
        const along = ((point.u - first.u) * edgeU) + ((point.v - first.v) * edgeV);
        return cross <= polygonTolerance * length
          && along >= -polygonTolerance * length && along <= (length * length) + (polygonTolerance * length);
      };
      const paired = new Set();
      const pairedEdges = new Set();
      for (let index = 0; index < connectorTriangles.length; index += 1) {
        if (paired.has(index)) continue;
        const firstTriangle = connectorTriangles[index];
        const firstNormal = triangleAreaNormal(firstTriangle).normal;
        const firstVertices = [firstTriangle.a, firstTriangle.b, firstTriangle.c];
        let partner = -1;
        let partnerEdge = -1;
        for (let otherIndex = index + 1; otherIndex < connectorTriangles.length && partner < 0; otherIndex += 1) {
          if (paired.has(otherIndex)) continue;
          const secondTriangle = connectorTriangles[otherIndex];
          const secondNormal = triangleAreaNormal(secondTriangle).normal;
          const secondVertices = [secondTriangle.a, secondTriangle.b, secondTriangle.c];
          const shared = firstVertices.filter(vertex => secondVertices.some(other => vertexDistance(vertex, other) <= polygonTolerance));
          if (shared.length !== 2 || Math.abs(dot(firstNormal, secondNormal)) < 1 - 1e-8) continue;
          const unique = [];
          for (const vertex of [...firstVertices, ...secondVertices]) {
            if (!unique.some(other => vertexDistance(vertex, other) <= polygonTolerance)) unique.push(vertex);
          }
          if (unique.length !== 4) continue;
          const projected = unique.map(projectVertex);
          if (projected.some(value => Math.min(Math.abs(value.depth - envelopeMinimum), Math.abs(value.depth - envelopeMaximum)) > planeTolerance)) continue;
          for (let edgeIndex = 0; edgeIndex < surface.hull.length && partner < 0; edgeIndex += 1) {
            if (pairedEdges.has(edgeIndex)) continue;
            const edgeStart = surface.hull[edgeIndex]; const edgeEnd = surface.hull[(edgeIndex + 1) % surface.hull.length];
            if (!projected.every(value => onEdge(value, edgeStart, edgeEnd))) continue;
            const endpointSets = [edgeStart, edgeEnd].map(endpoint => projected.filter(value => Math.hypot(value.u - endpoint.u, value.v - endpoint.v) <= polygonTolerance));
            if (!endpointSets.every(values => values.some(value => Math.abs(value.depth - envelopeMinimum) <= planeTolerance)
              && values.some(value => Math.abs(value.depth - envelopeMaximum) <= planeTolerance))) continue;
            const sharedProjected = shared.map(projectVertex);
            const sharedEndpointClasses = new Set(sharedProjected.map(value => Math.hypot(value.u - edgeStart.u, value.v - edgeStart.v)
              <= Math.hypot(value.u - edgeEnd.u, value.v - edgeEnd.v) ? 0 : 1));
            const sharedDepthClasses = new Set(sharedProjected.map(value => Math.abs(value.depth - envelopeMinimum) <= planeTolerance ? 0 : 1));
            if (sharedEndpointClasses.size === 2 && sharedDepthClasses.size === 2) {
              partner = otherIndex;
              partnerEdge = edgeIndex;
            }
          }
        }
        if (partner < 0) throw new RangeError(`IFC window #${expressID} has disconnected or unrelated tessellated geometry`);
        paired.add(index); paired.add(partner); pairedEdges.add(partnerEdge);
      }
    }
    const u = surface.hull.map(vertex => vertex.u); const v = surface.hull.map(vertex => vertex.v);
    const minU = Math.min(...u); const maxU = Math.max(...u);
    const minV = Math.min(...v); const maxV = Math.max(...v);
    const width = maxU - minU;
    const height = maxV - minV;
    if (!(width > 1e-5 && height > 1e-5)) throw new RangeError(`IFC window #${expressID} has degenerate dimensions`);
    if (Math.max(width, height) / Math.min(width, height) > MAXIMUM_WINDOW_ASPECT_RATIO) {
      throw new RangeError(`IFC window #${expressID} exceeds the supported physical aspect ratio`);
    }
    const surfaceOrigin = add(centroid, scale(normal, surface.plane));
    const samplePoints = [];
    for (const uFraction of [1 / 6, 1 / 2, 5 / 6]) {
      for (const vFraction of [1 / 6, 1 / 2, 5 / 6]) {
        const projected = { u: minU + (width * uFraction), v: minV + (height * vFraction) };
        if (pointInConvexPolygon(projected, surface.hull)) {
          samplePoints.push(add(add(add(surfaceOrigin, scale(right, projected.u)), scale(up, projected.v)), scale(normal, 0.002)));
        }
      }
    }
    if (!samplePoints.length) throw new RangeError(`IFC window #${expressID} exterior polygon could not be sampled`);
    if (!ifcShading?.orientationFromNormal) throw new Error('IFC shading geometry engine is unavailable');
    return {
      expressID,
      orientation: ifcShading.orientationFromNormal(normal, northRotation),
      normal,
      centroid,
      width,
      height,
      area: surface.hullArea,
      samplePoints,
    };
  }

  function vectorValues(vector) {
    const values = [];
    if (!vector) return values;
    for (let index = 0; index < vector.size(); index += 1) values.push(vector.get(index));
    return values;
  }

  function placedMeshTriangles(ifcApi, modelID, mesh, maximumRawTriangles, maximumVertexRecords, limitMessage) {
    const triangles = [];
    let rawTriangleCount = 0;
    let vertexRecordCount = 0;
    for (let placedIndex = 0; placedIndex < mesh.geometries.size(); placedIndex += 1) {
      const placed = mesh.geometries.get(placedIndex);
      const geometry = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
      try {
        const transformation = Array.from(placed.flatTransformation || []);
        if (transformation.length !== 16 || transformation.some(value => !Number.isFinite(value)
          || Math.abs(value) > MAXIMUM_TRANSFORMATION_COEFFICIENT)) {
          throw new RangeError('IFC geometry has a malformed placement transformation');
        }
        const indexCount = Number(geometry.GetIndexDataSize());
        const vertexDataSize = Number(geometry.GetVertexDataSize());
        if (!Number.isSafeInteger(indexCount) || indexCount < 0 || indexCount % 3 !== 0
          || !Number.isSafeInteger(vertexDataSize) || vertexDataSize < 0 || vertexDataSize % 6 !== 0) {
          throw new RangeError('IFC tessellation has malformed index or vertex buffers');
        }
        if (indexCount === 0) continue;
        const geometryTriangleCount = indexCount / 3;
        const geometryVertexRecords = vertexDataSize / 6;
        if (rawTriangleCount + geometryTriangleCount > maximumRawTriangles
          || vertexRecordCount + geometryVertexRecords > maximumVertexRecords) {
          throw new RangeError(limitMessage);
        }
        rawTriangleCount += geometryTriangleCount;
        vertexRecordCount += geometryVertexRecords;
        const indices = ifcApi.GetIndexArray(geometry.GetIndexData(), indexCount);
        const vertices = ifcApi.GetVertexArray(geometry.GetVertexData(), vertexDataSize);
        if (indices.length !== indexCount || vertices.length !== vertexDataSize) {
          throw new RangeError('IFC tessellation buffers do not match their declared sizes');
        }
        const transformed = [];
        for (let index = 0; index < vertices.length; index += 6) {
          const source = point(vertices[index], vertices[index + 1], vertices[index + 2]);
          if (![source.x, source.y, source.z].every(Number.isFinite)) throw new RangeError('IFC tessellation contains a non-finite vertex');
          const transformedVertex = transformPoint(source, transformation);
          if (![transformedVertex.x, transformedVertex.y, transformedVertex.z].every(Number.isFinite)
            || [transformedVertex.x, transformedVertex.y, transformedVertex.z].some(value => Math.abs(value) > MAXIMUM_COORDINATE_MAGNITUDE)) {
            throw new RangeError('IFC transformed geometry exceeds finite coordinate safety bounds');
          }
          transformed.push(transformedVertex);
        }
        for (let index = 0; index < indices.length; index += 3) {
          if (![indices[index], indices[index + 1], indices[index + 2]].every(value => Number.isSafeInteger(value) && value >= 0 && value < transformed.length)) {
            throw new RangeError('IFC tessellation contains an out-of-range vertex index');
          }
          const a = transformed[indices[index]];
          const b = transformed[indices[index + 1]];
          const c = transformed[indices[index + 2]];
          if (triangleAreaNormal({ a, b, c }).area > 1e-10) triangles.push({ a, b, c, expressID: mesh.expressID });
        }
      } finally {
        geometry.delete?.();
      }
    }
    return { triangles, rawTriangleCount, vertexRecordCount };
  }

  function boundsCenter(trianglesByElement) {
    const minimum = point(Infinity, Infinity, Infinity);
    const maximum = point(-Infinity, -Infinity, -Infinity);
    trianglesByElement.forEach(entry => entry.triangles.forEach(triangle => {
      for (const vertex of [triangle.a, triangle.b, triangle.c]) {
        for (const axis of ['x', 'y', 'z']) {
          minimum[axis] = Math.min(minimum[axis], vertex[axis]);
          maximum[axis] = Math.max(maximum[axis], vertex[axis]);
        }
      }
    }));
    if (!Number.isFinite(minimum.x)) throw new RangeError('The IFC model contains no tessellated building geometry');
    return scale(add(minimum, maximum), 0.5);
  }

  function extractIfcGeometry(ifcApi, WebIFC, modelID, options = {}) {
    const northRotation = options.northRotation === undefined ? 0 : Number(options.northRotation);
    if (!Number.isFinite(northRotation)) throw new RangeError('IFC model north rotation must be finite');
    const requestedMaximum = options.maximumTriangles === undefined ? MAXIMUM_MODEL_TRIANGLES : Number(options.maximumTriangles);
    if (!Number.isSafeInteger(requestedMaximum) || requestedMaximum < 1 || requestedMaximum > MAXIMUM_MODEL_TRIANGLES) {
      throw new RangeError(`maximumTriangles must be a finite bounded integer from 1 to ${MAXIMUM_MODEL_TRIANGLES.toLocaleString()}`);
    }
    const maximumTriangles = requestedMaximum;
    const windowIds = new Set(vectorValues(ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCWINDOW, true)));
    if (!windowIds.size) throw new RangeError('The IFC model has no IfcWindow elements');
    const flatMeshes = ifcApi.LoadAllGeometry(modelID);
    const elements = [];
    const elementsByExpressID = new Map();
    let rawTriangleCount = 0;
    let vertexRecordCount = 0;
    const windowRawTriangleCounts = new Map();
    const windowVertexRecordCounts = new Map();
    for (let meshIndex = 0; meshIndex < flatMeshes.size(); meshIndex += 1) {
      const mesh = flatMeshes.get(meshIndex);
      const isWindow = windowIds.has(mesh.expressID);
      const remainingModelTriangles = maximumTriangles - rawTriangleCount;
      const usedWindowTriangles = windowRawTriangleCounts.get(mesh.expressID) || 0;
      const usedWindowVertices = windowVertexRecordCounts.get(mesh.expressID) || 0;
      const remainingWindowTriangles = isWindow ? MAXIMUM_WINDOW_SURFACE_TRIANGLES - usedWindowTriangles : remainingModelTriangles;
      const meshLimit = Math.min(remainingModelTriangles, remainingWindowTriangles);
      const remainingModelVertices = MAXIMUM_MODEL_VERTEX_RECORDS - vertexRecordCount;
      const remainingWindowVertices = isWindow ? MAXIMUM_WINDOW_VERTEX_RECORDS - usedWindowVertices : remainingModelVertices;
      const vertexLimit = Math.min(remainingModelVertices, remainingWindowVertices);
      const limitMessage = isWindow
        ? `IFC window #${mesh.expressID} exceeds the ${MAXIMUM_WINDOW_SURFACE_TRIANGLES.toLocaleString()}-triangle browser topology limit`
        : `IFC geometry exceeds the ${maximumTriangles.toLocaleString()}-triangle browser analysis limit`;
      const extracted = placedMeshTriangles(ifcApi, modelID, mesh, meshLimit, vertexLimit, limitMessage);
      rawTriangleCount += extracted.rawTriangleCount;
      vertexRecordCount += extracted.vertexRecordCount;
      if (isWindow) windowRawTriangleCounts.set(mesh.expressID, usedWindowTriangles + extracted.rawTriangleCount);
      if (isWindow) windowVertexRecordCounts.set(mesh.expressID, usedWindowVertices + extracted.vertexRecordCount);
      if (extracted.triangles.length) {
        const existing = elementsByExpressID.get(mesh.expressID);
        if (existing) existing.triangles.push(...extracted.triangles);
        else {
          const element = { expressID:mesh.expressID, triangles:extracted.triangles };
          elements.push(element);
          elementsByExpressID.set(mesh.expressID, element);
        }
      }
    }
    const modelCenter = boundsCenter(elements);
    const windows = [];
    const rejectedWindows = [];
    for (const expressID of windowIds) {
      const entry = elementsByExpressID.get(expressID);
      if (!entry) {
        rejectedWindows.push({ expressID, reason: 'No tessellated IfcWindow geometry' });
        continue;
      }
      try {
        const descriptor = deriveWindowDescriptor(expressID, entry.triangles, modelCenter, northRotation);
        descriptor.globalId = String(ifcApi.GetGuidFromExpressId(modelID, expressID) || '');
        windows.push(descriptor);
      } catch (error) {
        rejectedWindows.push({ expressID, reason: error.message });
      }
    }
    if (rejectedWindows.length) {
      const details = rejectedWindows.slice(0, 5).map(value => `#${value.expressID}: ${value.reason}`).join('; ');
      throw new RangeError(`IFC model contains ${rejectedWindows.length} invalid IfcWindow geometr${rejectedWindows.length === 1 ? 'y' : 'ies'}${details ? `; ${details}` : ''}`);
    }
    if (!windows.length) {
      throw new RangeError('No analyzable vertical IfcWindow geometry was found');
    }
    const triangles = elements
      .filter(element => !windowIds.has(element.expressID))
      .flatMap(element => element.triangles);
    return {
      windows,
      triangles,
      metadata: {
        webIfcVersion: ifcApi.GetVersion?.() || WEB_IFC_VERSION,
        sourceWindowCount: windowIds.size,
        analyzedWindowCount: windows.length,
        rejectedWindows,
        occluderTriangleCount: triangles.length,
        northRotation,
      },
    };
  }

  async function loadIfcFile(file, options = {}) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('Select an IFC file to analyse');
    if (!String(file.name || '').toLowerCase().endsWith('.ifc')) throw new RangeError('Only .ifc model files are accepted');
    if (Number(file.size || 0) > MAXIMUM_FILE_BYTES) throw new RangeError('IFC file exceeds the 250 MB browser safety limit');
    const moduleUrl = options.moduleUrl || DEFAULT_MODULE_URL;
    const wasmPath = options.wasmPath || DEFAULT_WASM_PATH;
    options.onProgress?.('Loading the IFC geometry engine…');
    const WebIFC = await import(moduleUrl);
    const ifcApi = new WebIFC.IfcAPI();
    let modelID = null;
    try {
      ifcApi.SetWasmPath(wasmPath, true);
      await ifcApi.Init(undefined, true);
      options.onProgress?.('Parsing IFC entities and tessellating geometry…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      modelID = ifcApi.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true, USE_FAST_BOOLS: true });
      if (!(modelID >= 0)) throw new Error('web-ifc could not open this model');
      const result = extractIfcGeometry(ifcApi, WebIFC, modelID, options);
      result.metadata.fileName = String(file.name || 'model.ifc');
      result.metadata.fileSize = Number(file.size || bytes.length);
      return result;
    } finally {
      if (modelID !== null && ifcApi.IsModelOpen?.(modelID)) ifcApi.CloseModel(modelID);
      ifcApi.Dispose?.();
    }
  }

  return Object.freeze({
    DEFAULT_MODULE_URL,
    DEFAULT_WASM_PATH,
    WEB_IFC_VERSION,
    deriveWindowDescriptor,
    extractIfcGeometry,
    loadIfcFile,
    transformPoint,
  });
});
