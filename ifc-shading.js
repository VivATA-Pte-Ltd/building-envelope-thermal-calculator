(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VivaTEQIfcShading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ORIENTATION_AZIMUTH = Object.freeze({ N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 });
  const MONTH_WEIGHTS = Object.freeze({ M: 2, J: 1, D: 1 });

  function vector(x = 0, y = 0, z = 0) { return { x, y, z }; }
  function add(a, b) { return vector(a.x + b.x, a.y + b.y, a.z + b.z); }
  function subtract(a, b) { return vector(a.x - b.x, a.y - b.y, a.z - b.z); }
  function scale(a, amount) { return vector(a.x * amount, a.y * amount, a.z * amount); }
  function dot(a, b) { return (a.x * b.x) + (a.y * b.y) + (a.z * b.z); }
  function cross(a, b) { return vector((a.y * b.z) - (a.z * b.y), (a.z * b.x) - (a.x * b.z), (a.x * b.y) - (a.y * b.x)); }
  function length(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) {
    const magnitude = length(a);
    if (!(magnitude > 0)) throw new RangeError('Direction vector must be non-zero');
    return scale(a, 1 / magnitude);
  }

  function triangleBounds(triangle) {
    return {
      min: vector(Math.min(triangle.a.x, triangle.b.x, triangle.c.x), Math.min(triangle.a.y, triangle.b.y, triangle.c.y), Math.min(triangle.a.z, triangle.b.z, triangle.c.z)),
      max: vector(Math.max(triangle.a.x, triangle.b.x, triangle.c.x), Math.max(triangle.a.y, triangle.b.y, triangle.c.y), Math.max(triangle.a.z, triangle.b.z, triangle.c.z)),
      centroid: scale(add(add(triangle.a, triangle.b), triangle.c), 1 / 3),
    };
  }

  function combineBounds(entries) {
    const min = vector(Infinity, Infinity, Infinity);
    const max = vector(-Infinity, -Infinity, -Infinity);
    entries.forEach(entry => {
      for (const axis of ['x', 'y', 'z']) {
        min[axis] = Math.min(min[axis], entry.bounds.min[axis]);
        max[axis] = Math.max(max[axis], entry.bounds.max[axis]);
      }
    });
    return { min, max };
  }

  function buildBVH(triangles, leafSize = 12) {
    const entries = (triangles || []).map(triangle => ({ triangle, bounds: triangleBounds(triangle) }));
    function build(items) {
      if (!items.length) return null;
      const bounds = combineBounds(items);
      if (items.length <= leafSize) return { bounds, triangles: items.map(item => item.triangle), left: null, right: null };
      const spans = { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z };
      const axis = Object.keys(spans).sort((a, b) => spans[b] - spans[a])[0];
      items.sort((a, b) => a.bounds.centroid[axis] - b.bounds.centroid[axis]);
      const middle = Math.floor(items.length / 2);
      return { bounds, triangles: null, left: build(items.slice(0, middle)), right: build(items.slice(middle)) };
    }
    return { root: build(entries), triangleCount: entries.length };
  }

  function rayIntersectsBounds(origin, direction, bounds, maximum = Infinity) {
    let near = 0;
    let far = maximum;
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(direction[axis]) < 1e-12) {
        if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis]) return false;
        continue;
      }
      let first = (bounds.min[axis] - origin[axis]) / direction[axis];
      let second = (bounds.max[axis] - origin[axis]) / direction[axis];
      if (first > second) [first, second] = [second, first];
      near = Math.max(near, first);
      far = Math.min(far, second);
      if (near > far) return false;
    }
    return far > 1e-6;
  }

  function rayIntersectsTriangle(origin, direction, triangle) {
    const edge1 = subtract(triangle.b, triangle.a);
    const edge2 = subtract(triangle.c, triangle.a);
    const p = cross(direction, edge2);
    const determinant = dot(edge1, p);
    if (Math.abs(determinant) < 1e-10) return false;
    const inverse = 1 / determinant;
    const t = subtract(origin, triangle.a);
    const u = dot(t, p) * inverse;
    if (u < 0 || u > 1) return false;
    const q = cross(t, edge1);
    const v = dot(direction, q) * inverse;
    if (v < 0 || u + v > 1) return false;
    const distance = dot(edge2, q) * inverse;
    return distance > 1e-5;
  }

  function rayBlocked(origin, direction, bvh) {
    const ray = normalize(direction);
    function visit(node) {
      if (!node || !rayIntersectsBounds(origin, ray, node.bounds)) return false;
      if (node.triangles) return node.triangles.some(triangle => rayIntersectsTriangle(origin, ray, triangle));
      return visit(node.left) || visit(node.right);
    }
    return visit(bvh?.root || null);
  }

  function calculateExposure(samplePoints, direction, bvh) {
    if (!Array.isArray(samplePoints) || !samplePoints.length) throw new RangeError('At least one window sample point is required');
    const ray = normalize(direction);
    const exposed = samplePoints.reduce((count, point) => count + (rayBlocked(add(point, scale(ray, 1e-4)), ray, bvh) ? 0 : 1), 0);
    return exposed / samplePoints.length;
  }

  function normalAzimuth(normal) {
    const horizontal = normalize(vector(normal.x, normal.y, 0));
    return (Math.atan2(horizontal.x, horizontal.y) * 180 / Math.PI + 360) % 360;
  }

  function orientationFromNormal(normal, northRotation = 0) {
    const azimuth = (normalAzimuth(normal) + Number(northRotation || 0) + 360) % 360;
    const index = Math.round(azimuth / 45) % 8;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][index];
  }

  function solarDirectionForRow(orientation, row, northRotation = 0) {
    const trueAzimuth = ORIENTATION_AZIMUTH[String(orientation || '').toUpperCase()];
    if (trueAzimuth === undefined) throw new RangeError(`Unsupported façade orientation: ${orientation}`);
    const modelAzimuth = (trueAzimuth - Number(northRotation || 0)) * Math.PI / 180;
    const outward = vector(Math.sin(modelAzimuth), Math.cos(modelAzimuth), 0);
    const right = vector(Math.cos(modelAzimuth), -Math.sin(modelAzimuth), 0);
    const pairedMirror = ['S', 'W', 'NW', 'SW'].includes(String(orientation || '').toUpperCase());
    const hsa = Number(row.hsa || 0) * (pairedMirror ? -1 : 1) * Math.PI / 180;
    const vsa = Number(row.vsa || 0) * Math.PI / 180;
    return normalize(add(add(outward, scale(right, Math.tan(hsa))), vector(0, 0, Math.tan(vsa))));
  }

  function orientationGroup(orientation) {
    if (['N', 'S'].includes(orientation)) return 'NS';
    if (['E', 'W'].includes(orientation)) return 'EW';
    if (['NE', 'NW'].includes(orientation)) return 'NENW';
    if (['SE', 'SW'].includes(orientation)) return 'SESW';
    throw new RangeError(`Unsupported façade orientation: ${orientation}`);
  }

  function effectiveSC2(rows) {
    let numerator = 0;
    let denominator = 0;
    rows.forEach(row => {
      const weight = MONTH_WEIGHTS[row.month];
      numerator += weight * ((row.G * row.ID) + row.Id);
      denominator += weight * row.IT;
    });
    return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 1;
  }

  function analyzeIfcGeometry(model, shadingData, options = {}) {
    if (!shadingData?.solar) throw new TypeError('Verified BCA solar data is required');
    const windows = model?.windows || [];
    if (!windows.length) throw new RangeError('The IFC model contains no analyzable windows');
    const northRotation = Number(options.northRotation || 0);
    const bvh = buildBVH(model.triangles || []);
    const groups = {};
    windows.forEach(window => {
      const orientation = window.orientation || orientationFromNormal(window.normal, northRotation);
      if (!groups[orientation]) groups[orientation] = [];
      groups[orientation].push(window);
    });
    const byOrientation = {};
    Object.entries(groups).forEach(([orientation, facadeWindows]) => {
      const solar = shadingData.solar[orientationGroup(orientation)];
      const rows = [];
      for (const month of ['M', 'J', 'D']) {
        solar.months[month].forEach(source => {
          let G = 1;
          if (source.ID > 0 && source.hsa !== null && source.vsa !== null) {
            const direction = solarDirectionForRow(orientation, source, northRotation);
            let exposedArea = 0;
            let totalArea = 0;
            facadeWindows.forEach(window => {
              const area = Number(window.area) > 0 ? Number(window.area) : 1;
              exposedArea += area * calculateExposure(window.samplePoints, direction, bvh);
              totalArea += area;
            });
            G = totalArea > 0 ? exposedArea / totalArea : 1;
          }
          rows.push({ month, hour: source.hour, G, ID: source.ID, Id: source.Id, IT: source.IT, vsa: source.vsa, hsa: source.hsa });
        });
      }
      const totalWindowArea = facadeWindows.reduce((sum, window) => sum + (Number(window.area) > 0 ? Number(window.area) : 1), 0);
      byOrientation[orientation] = {
        sc2: effectiveSC2(rows), rows, windowCount: facadeWindows.length, totalWindowArea,
        windowExpressIDs: facadeWindows.map(window => window.expressID),
        windowGlobalIds: facadeWindows.map(window => window.globalId).filter(Boolean),
        sourceTable: solar.table,
      };
    });
    return { byOrientation, triangleCount: bvh.triangleCount, windowCount: windows.length, northRotation };
  }

  return Object.freeze({
    analyzeIfcGeometry,
    buildBVH,
    calculateExposure,
    orientationFromNormal,
    rayBlocked,
    solarDirectionForRow,
  });
});
