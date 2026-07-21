const test = require('node:test');
const assert = require('node:assert/strict');
const shadingData = require('../shading-data.js');
const {
  analyzeIfcGeometry,
  buildBVH,
  calculateExposure,
  orientationFromNormal,
  solarDirectionForRow,
} = require('../ifc-shading.js');

function point(x, y, z) { return { x, y, z }; }

const northFacingWindow = {
  expressID: 10,
  orientation: 'N',
  area: 1,
  normal: point(0, 1, 0),
  samplePoints: [point(0, 0, 0)],
};

test('BVH ray casting distinguishes exposed and obstructed window samples', () => {
  const blocker = [{ a: point(-2, 1, -2), b: point(2, 1, -2), c: point(0, 1, 2) }];
  assert.equal(calculateExposure(northFacingWindow.samplePoints, point(0, 1, 0), buildBVH([])), 1);
  assert.equal(calculateExposure(northFacingWindow.samplePoints, point(0, 1, 0), buildBVH(blocker)), 0);
});

test('IFC window normals map to the eight façade orientations with model north rotation', () => {
  assert.equal(orientationFromNormal(point(0, 1, 0), 0), 'N');
  assert.equal(orientationFromNormal(point(1, 0, 0), 0), 'E');
  assert.equal(orientationFromNormal(point(1, 1, 0), 0), 'NE');
  assert.equal(orientationFromNormal(point(0, 1, 0), 90), 'E');
});

test('BCA shadow angles become a normalized world-space ray direction', () => {
  const direction = solarDirectionForRow('N', { hsa: 0, vsa: 45 }, 0);
  assert.ok(Math.abs(direction.x) < 1e-9);
  assert.ok(Math.abs(direction.y - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(direction.z - Math.SQRT1_2) < 1e-9);
});

test('paired western and southern façades mirror BCA HSA signs', () => {
  const east = solarDirectionForRow('E', { hsa: 30, vsa: 0 }, 0);
  const west = solarDirectionForRow('W', { hsa: 30, vsa: 0 }, 0);
  assert.ok(east.x > 0 && west.x < 0);
  assert.ok(east.y < 0 && west.y < 0, 'both paired paths must track the same southern solar side');

  const north = solarDirectionForRow('N', { hsa: 30, vsa: 0 }, 0);
  const south = solarDirectionForRow('S', { hsa: 30, vsa: 0 }, 0);
  assert.ok(north.x > 0 && south.x > 0, 'paired north/south paths must mirror HSA');
});

test('IFC analysis generates B2.2 SC2 values from imported window exposure', () => {
  const clear = analyzeIfcGeometry({ windows: [northFacingWindow], triangles: [] }, shadingData);
  assert.equal(clear.byOrientation.N.sc2, 1);
  assert.equal(clear.byOrientation.N.rows.length, 36);
  assert.equal(clear.byOrientation.N.windowCount, 1);
  assert.deepEqual(clear.byOrientation.N.windowExpressIDs, [10]);

  const enclosure = [
    { a: point(-100, 0.5, -100), b: point(100, 0.5, -100), c: point(0, 0.5, 100) },
  ];
  const shaded = analyzeIfcGeometry({ windows: [northFacingWindow], triangles: enclosure }, shadingData);
  assert.ok(shaded.byOrientation.N.sc2 < 1);
  assert.ok(shaded.byOrientation.N.rows.some(row => row.ID > 0 && row.G === 0));
});

test('IFC exposure is weighted by imported window area', () => {
  const smallBlocked = { ...northFacingWindow, expressID: 1, area: 1, samplePoints: [point(0, 0, 0)] };
  const largeClear = { ...northFacingWindow, expressID: 2, area: 3, samplePoints: [point(10, 0, 0)] };
  const blocker = [
    { a: point(-5, 1, -100), b: point(5, 1, -100), c: point(5, 1, 100) },
    { a: point(-5, 1, -100), b: point(5, 1, 100), c: point(-5, 1, 100) },
  ];
  const result = analyzeIfcGeometry({ windows: [smallBlocked, largeClear], triangles: blocker }, shadingData);
  const directRow = result.byOrientation.N.rows.find(row => row.ID > 0);
  assert.equal(directRow.G, 0.75);
});
