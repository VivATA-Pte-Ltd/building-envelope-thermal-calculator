const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveWindowDescriptor,
  extractIfcGeometry,
  loadIfcFile,
  transformPoint,
} = require('../ifc-loader.js');

const p = (x, y, z) => ({ x, y, z });

test('web-ifc column-major placement matrices transform vertices into model coordinates', () => {
  const matrix = [
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 1, 0,
    10, 20, 30, 1,
  ];
  assert.deepEqual(transformPoint(p(2, 3, 4), matrix), p(7, 22, 34));
});

test('window mesh becomes an area-weighted exterior sampling descriptor', () => {
  const triangles = [
    { a: p(-1, 2.1, 0), b: p(1, 2.1, 0), c: p(1, 2.1, 1) },
    { a: p(-1, 2.1, 0), b: p(1, 2.1, 1), c: p(-1, 2.1, 1) },
    { a: p(-1, 1.9, 0), b: p(1, 1.9, 1), c: p(1, 1.9, 0) },
    { a: p(-1, 1.9, 0), b: p(-1, 1.9, 1), c: p(1, 1.9, 1) },
  ];
  const descriptor = deriveWindowDescriptor(42, triangles, p(0, 0, 0), 0);
  assert.equal(descriptor.expressID, 42);
  assert.equal(descriptor.orientation, 'N');
  assert.ok(Math.abs(descriptor.area - 2) < 1e-9);
  assert.equal(descriptor.samplePoints.length, 9);
  assert.ok(descriptor.samplePoints.every(point => point.y > 2));
});

test('convex non-rectangular windows use polygon area and in-polygon samples', () => {
  const diamond = [
    { a: p(0, 2.1, 0), b: p(1, 2.1, 1), c: p(0, 2.1, 2) },
    { a: p(0, 2.1, 0), b: p(0, 2.1, 2), c: p(-1, 2.1, 1) },
  ];
  const descriptor = deriveWindowDescriptor(51, diamond, p(0, 0, 1), 0);
  assert.ok(Math.abs(descriptor.area - 2) < 1e-9);
  assert.ok(descriptor.samplePoints.every(value => Math.abs(value.x) + Math.abs(value.z - 1) <= 1 + 1e-9));
});

test('unsupported concave window footprints are rejected fail-closed', () => {
  const concave = [
    { a: p(0, 2.1, 0), b: p(2, 2.1, 0), c: p(2, 2.1, 1) },
    { a: p(0, 2.1, 0), b: p(2, 2.1, 1), c: p(1, 2.1, 1) },
    { a: p(0, 2.1, 0), b: p(1, 2.1, 1), c: p(1, 2.1, 2) },
    { a: p(0, 2.1, 0), b: p(1, 2.1, 2), c: p(0, 2.1, 2) },
  ];
  assert.throws(() => deriveWindowDescriptor(52, concave, p(0, 0, 1), 0), /unsupported non-convex/);
});

test('small coplanar gaps are rejected instead of being hidden by the convex hull', () => {
  const fragmented = [
    { a: p(0, 2.1, 0), b: p(2, 2.1, 0), c: p(2, 2.1, 2) },
    { a: p(0, 2.1, 0), b: p(1.999, 2.1, 2), c: p(0, 2.1, 2) },
  ];
  assert.throws(() => deriveWindowDescriptor(53, fragmented, p(0, 0, 1), 0), /fragmented/);
});

test('overlap cannot cancel a projected hole in fail-closed geometry validation', () => {
  const square = (x, z) => [
    { a:p(x, 2.1, z), b:p(x + 1, 2.1, z), c:p(x + 1, 2.1, z + 1) },
    { a:p(x, 2.1, z), b:p(x + 1, 2.1, z + 1), c:p(x, 2.1, z + 1) },
  ];
  const withHole = [];
  for (let x = 0; x < 3; x += 1) {
    for (let z = 0; z < 3; z += 1) {
      if (x !== 1 || z !== 1) withHole.push(...square(x, z));
    }
  }
  withHole.push(...square(0, 0));
  assert.throws(() => deriveWindowDescriptor(54, withHole, p(0, 0, 1), 0), /overlapping|physical span/);
});

test('aggregate sub-tolerance overlaps cannot compensate a hole at large coordinate scale', () => {
  const rectangle = (x1, x2, z1, z2) => [
    { a:p(x1, 2.1, z1), b:p(x2, 2.1, z1), c:p(x2, 2.1, z2) },
    { a:p(x1, 2.1, z1), b:p(x2, 2.1, z2), c:p(x1, 2.1, z2) },
  ];
  const low = 4999.999; const high = 5000.001;
  const surface = [
    ...rectangle(0, low, 0, 10000), ...rectangle(high, 10000, 0, 10000),
    ...rectangle(low, high, 0, low), ...rectangle(low, high, high, 10000),
  ];
  surface.push(...rectangle(1, 1.002, 1, 1.002));
  assert.throws(() => deriveWindowDescriptor(55, surface, p(0, 0, 1), 0), /overlapping|physical span/);
});

test('excessively complex per-window tessellation is rejected before pair scanning', () => {
  const count = 2001;
  const surface = Array.from({ length:count }, (_, index) => {
    const a = (index / count) * Math.PI * 2;
    const b = ((index + 1) / count) * Math.PI * 2;
    return { a:p(0, 2.1, 0), b:p(Math.cos(a), 2.1, Math.sin(a)), c:p(Math.cos(b), 2.1, Math.sin(b)) };
  });
  assert.throws(() => deriveWindowDescriptor(56, surface, p(0, 0, 1), 0), /2,000-triangle/);
});

test('oversized IFC files are rejected before loading the WASM parser', async () => {
  const file = { name: 'oversized.ifc', size: (251 * 1024 * 1024), arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(loadIfcFile(file), /250 MB browser safety limit/);
});

test('horizontal or degenerate IFC window geometry is rejected conservatively', () => {
  const horizontal = [{ a: p(0, 0, 1), b: p(1, 0, 1), c: p(0, 1, 1) }];
  assert.throws(() => deriveWindowDescriptor(3, horizontal, p(0, 0, 0), 0), /vertical window surface/);
});

test('extreme-aspect gap and compensating overlap are rejected fail-closed', () => {
  const rectangle = (x1, x2, z1, z2, y = 2.1) => [
    { a:p(x1, y, z1), b:p(x2, y, z1), c:p(x2, y, z2) },
    { a:p(x1, y, z1), b:p(x2, y, z2), c:p(x1, y, z2) },
  ];
  const gapStart = 0.5;
  const gapEnd = gapStart + 5e-13;
  const surface = [
    ...rectangle(0, gapStart, 0, 1e6),
    ...rectangle(gapEnd, 1, 0, 1e6),
    ...rectangle(0.1, 0.1 + 5e-13, 0, 1e6),
  ];
  assert.throws(() => deriveWindowDescriptor(57, surface, p(0, 0, 5e5), 0), /overlapping|physical span/);
});

test('complementary triangles on separated near-parallel planes are rejected', () => {
  const fragmented = [
    { a:p(0, 2.1, 0), b:p(1, 2.1, 0), c:p(1, 2.1, 1) },
    { a:p(0, 2.1001, 0), b:p(1, 2.1001, 1), c:p(0, 2.1001, 1) },
  ];
  assert.throws(() => deriveWindowDescriptor(58, fragmented, p(0, 0, 0.5), 0), /fragmented/);
});

test('total window triangle cap applies before grouping across many planes', () => {
  const surface = Array.from({ length:2001 }, (_, index) => {
    const y = 2 + (index * 0.002);
    return { a:p(0, y, 0), b:p(1, y, 0), c:p(0, y, 1) };
  });
  assert.throws(() => deriveWindowDescriptor(59, surface, p(0, 0, 0), 0), /2,000-triangle/);
});

test('global triangle option must be a finite bounded integer', () => {
  assert.throws(
    () => extractIfcGeometry({}, { IFCWINDOW:1 }, 0, { maximumTriangles:Infinity }),
    /finite bounded integer/,
  );
  assert.throws(
    () => extractIfcGeometry({}, { IFCWINDOW:1 }, 0, { northRotation:Infinity }),
    /north rotation must be finite/,
  );
  assert.throws(
    () => extractIfcGeometry({}, { IFCWINDOW:1 }, 0, { northRotation:NaN }),
    /north rotation must be finite/,
  );
});

test('raw over-limit window tessellation is rejected before vertex transformation', () => {
  const vector = values => ({ size: () => values.length, get: index => values[index] });
  let vertexReads = 0;
  const geometry = {
    GetIndexData: () => 1,
    GetIndexDataSize: () => 6003,
    GetVertexData: () => 2,
    GetVertexDataSize: () => 6,
    delete: () => {},
  };
  const api = {
    GetLineIDsWithType: () => vector([42]),
    LoadAllGeometry: () => vector([{ expressID: 42, geometries: vector([{ geometryExpressID: 7, flatTransformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]) }]),
    GetGeometry: () => geometry,
    GetIndexArray: () => new Uint32Array(6003),
    GetVertexArray: () => { vertexReads += 1; return new Float32Array(6); },
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW: 1 }, 0), /2,000-triangle/);
  assert.equal(vertexReads, 0);
});

test('window triangle cap is cumulative across repeated meshes for one IfcWindow', () => {
  const vector = values => ({ size: () => values.length, get: index => values[index] });
  const placed = { geometryExpressID: 7, flatTransformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const mesh = { expressID: 42, geometries: vector([placed]) };
  let vertexReads = 0;
  const geometry = {
    GetIndexData: () => 1,
    GetIndexDataSize: () => 3003,
    GetVertexData: () => 2,
    GetVertexDataSize: () => 6,
    delete: () => {},
  };
  const api = {
    GetLineIDsWithType: () => vector([42]),
    LoadAllGeometry: () => vector([mesh, mesh]),
    GetGeometry: () => geometry,
    GetIndexArray: () => new Uint32Array(3003),
    GetVertexArray: () => { vertexReads += 1; return new Float32Array(6); },
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW: 1 }, 0), /2,000-triangle/);
  assert.equal(vertexReads, 1);
});

test('oversized vertex buffers are rejected before vertex allocation', () => {
  const vector = values => ({ size: () => values.length, get: index => values[index] });
  let vertexReads = 0;
  const geometry = {
    GetIndexData: () => 1, GetIndexDataSize: () => 3,
    GetVertexData: () => 2, GetVertexDataSize: () => 6001 * 6, delete: () => {},
  };
  const api = {
    GetLineIDsWithType: () => vector([42]),
    LoadAllGeometry: () => vector([{ expressID:42, geometries:vector([{ geometryExpressID:7, flatTransformation:[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]) }]),
    GetGeometry: () => geometry,
    GetIndexArray: () => new Uint32Array([0, 1, 2]),
    GetVertexArray: () => { vertexReads += 1; return new Float32Array(6001 * 6); },
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW:1 }, 0), /topology limit/);
  assert.equal(vertexReads, 0);
});

test('window vertex cap is cumulative across repeated meshes for one IfcWindow', () => {
  const vector = values => ({ size:() => values.length, get:index => values[index] });
  const placed = { geometryExpressID:7, flatTransformation:[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  let vertexReads = 0;
  const geometry = { GetIndexData:() => 1, GetIndexDataSize:() => 3, GetVertexData:() => 2, GetVertexDataSize:() => 3001 * 6, delete:() => {} };
  const api = {
    GetLineIDsWithType:() => vector([42]),
    LoadAllGeometry:() => vector([
      { expressID:42, geometries:vector([placed]) },
      { expressID:42, geometries:vector([placed]) },
    ]),
    GetGeometry:() => geometry,
    GetIndexArray:() => new Uint32Array([0, 1, 2]),
    GetVertexArray:() => { vertexReads += 1; return new Float32Array(3001 * 6); },
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW:1 }, 0), /topology limit/);
  assert.equal(vertexReads, 1);
});

test('detached nonparallel window geometry is rejected fail-closed', () => {
  const geometry = [
    { a:p(0, 2, 0), b:p(2, 2, 0), c:p(2, 2, 2) },
    { a:p(0, 2, 0), b:p(2, 2, 2), c:p(0, 2, 2) },
    { a:p(10, 0, 0), b:p(10, 1, 0), c:p(10, 1, 1) },
    { a:p(10, 0, 0), b:p(10, 1, 1), c:p(10, 0, 1) },
  ];
  assert.throws(() => deriveWindowDescriptor(60, geometry, p(0, 0, 1), 0), /disconnected or unrelated/);
});

test('unrelated complete third plane cannot be discarded', () => {
  const rectangle = (x1, x2, y, z1, z2) => [
    { a:p(x1, y, z1), b:p(x2, y, z1), c:p(x2, y, z2) },
    { a:p(x1, y, z1), b:p(x2, y, z2), c:p(x1, y, z2) },
  ];
  const geometry = [...rectangle(0, 2, 2.1, 0, 2), ...rectangle(0, 2, 1.9, 0, 2), ...rectangle(10, 11, 3, 0, 1)];
  assert.throws(() => deriveWindowDescriptor(61, geometry, p(0, 0, 1), 0), /disconnected or unrelated/);
});

test('only complete rectangular edge connectors are accepted around paired window faces', () => {
  const rectangle = y => [
    { a:p(0, y, 0), b:p(2, y, 0), c:p(2, y, 2) },
    { a:p(0, y, 0), b:p(2, y, 2), c:p(0, y, 2) },
  ];
  const front = rectangle(2); const back = rectangle(2.2);
  const flap = { a:p(0, 2, 0), b:p(2, 2, 0), c:p(0, 2.2, 0) };
  const detachedInterior = { a:p(0.5, 2.1, 0.5), b:p(1, 2.1, 0.5), c:p(0.5, 2.15, 1) };
  assert.throws(() => deriveWindowDescriptor(63, [...front, ...back, flap], p(0, 0, 1), 0), /disconnected or unrelated/);
  assert.throws(() => deriveWindowDescriptor(64, [...front, ...back, detachedInterior], p(0, 0, 1), 0), /disconnected or unrelated/);
  const a = p(0, 2, 0); const b = p(2, 2, 0); const c = p(2, 2.2, 0); const d = p(0, 2.2, 0);
  const boundaryShared = [{ a, b, c }, { a, b, c:d }];
  assert.throws(() => deriveWindowDescriptor(68, [...front, ...back, ...boundaryShared], p(0, 0, 1), 0), /disconnected or unrelated/);
  const quad = (a, b, c, d) => [{ a, b, c }, { a, b:c, c:d }];
  const sides = [
    ...quad(p(0, 2, 0), p(2, 2, 0), p(2, 2.2, 0), p(0, 2.2, 0)),
    ...quad(p(2, 2, 0), p(2, 2, 2), p(2, 2.2, 2), p(2, 2.2, 0)),
    ...quad(p(2, 2, 2), p(0, 2, 2), p(0, 2.2, 2), p(2, 2.2, 2)),
    ...quad(p(0, 2, 2), p(0, 2, 0), p(0, 2.2, 0), p(0, 2.2, 2)),
  ];
  assert.equal(deriveWindowDescriptor(65, [...front, ...back, ...sides], p(0, 0, 1), 0).area, 4);
  assert.throws(() => deriveWindowDescriptor(69, [...front, ...back, ...sides, ...sides], p(0, 0, 1), 0), /disconnected or unrelated/);
});

test('malformed non-window transformed geometry invalidates the complete model', () => {
  const vector = values => ({ size: () => values.length, get: index => values[index] });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const vertices = new Float32Array([0, 2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const geometry = { GetIndexData:() => indices, GetIndexDataSize:() => indices.length, GetVertexData:() => vertices, GetVertexDataSize:() => vertices.length, delete:() => {} };
  const malformed = [...identity]; malformed[12] = NaN;
  const api = {
    GetLineIDsWithType:() => vector([1]),
    LoadAllGeometry:() => vector([
      { expressID:1, geometries:vector([{ geometryExpressID:11, flatTransformation:identity }]) },
      { expressID:2, geometries:vector([{ geometryExpressID:12, flatTransformation:malformed }]) },
    ]),
    GetGeometry:() => geometry, GetIndexArray:data => data, GetVertexArray:data => data,
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW:1 }, 0), /malformed placement transformation/);
  const excessive = [...identity]; excessive[0] = 1e50;
  api.LoadAllGeometry = () => vector([
    { expressID:1, geometries:vector([{ geometryExpressID:11, flatTransformation:identity }]) },
    { expressID:2, geometries:vector([{ geometryExpressID:12, flatTransformation:excessive }]) },
  ]);
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW:1 }, 0), /malformed placement transformation/);
});

test('coordinate-scale tolerance cannot merge visibly separated complementary triangles', () => {
  const geometry = [
    { a:p(9999998, 2, 0), b:p(9999999, 2, 0), c:p(9999999, 2, 1) },
    { a:p(9999998, 2.0000002, 0), b:p(9999999, 2.0000002, 1), c:p(9999998, 2.0000002, 1) },
  ];
  assert.throws(() => deriveWindowDescriptor(66, geometry, p(9999998.5, 0, 0.5), 0));
});

test('one invalid IfcWindow invalidates the entire model result', () => {
  const vector = values => ({ size: () => values.length, get: index => values[index] });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const makeGeometry = points => {
    const vertices = new Float32Array(points.flatMap(value => [value.x, value.y, value.z, 0, 0, 0]));
    const indices = new Uint32Array(points.map((_, index) => index));
    return {
      GetIndexData: () => indices, GetIndexDataSize: () => indices.length,
      GetVertexData: () => vertices, GetVertexDataSize: () => vertices.length, delete: () => {},
    };
  };
  const geometries = {
    11:makeGeometry([p(0, 2, 0), p(2, 2, 0), p(2, 2, 2), p(0, 2, 0), p(2, 2, 2), p(0, 2, 2)]),
    12:makeGeometry([p(0, 0, 1), p(1, 0, 1), p(0, 1, 1)]),
  };
  const api = {
    GetLineIDsWithType: () => vector([1, 2]),
    LoadAllGeometry: () => vector([
      { expressID:1, geometries:vector([{ geometryExpressID:11, flatTransformation:identity }]) },
      { expressID:2, geometries:vector([{ geometryExpressID:12, flatTransformation:identity }]) },
    ]),
    GetGeometry: (_, id) => geometries[id],
    GetIndexArray: data => data,
    GetVertexArray: data => data,
    GetGuidFromExpressId: (_, id) => `window-${id}`,
  };
  assert.throws(() => extractIfcGeometry(api, { IFCWINDOW:1 }, 0), /invalid IfcWindow geometry/);
});

test('physically implausible extreme-aspect windows fail before scale-dependent topology checks', () => {
  const geometry = [
    { a:p(0, 2, 0), b:p(1, 2, 0), c:p(1, 2, 1e12) },
    { a:p(0, 2, 0), b:p(1, 2, 1e12), c:p(0, 2, 1e12) },
  ];
  assert.throws(() => deriveWindowDescriptor(62, geometry, p(0, 0, 0), 0), /physical span|coordinate safety bounds/);
  const narrow = [
    { a:p(0, 2, 0), b:p(999, 2, 0), c:p(999, 2, 0.000011) },
    { a:p(0, 2, 0), b:p(999, 2, 0.000011), c:p(0, 2, 0.000011) },
  ];
  assert.throws(() => deriveWindowDescriptor(67, narrow, p(0, 0, 0), 0), /physical aspect ratio/);
});
