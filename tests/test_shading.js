const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateCombinedSC,
  calculateEffectiveSC2,
  escapeHTML,
  parseSolarRows,
  resolveShading,
  safeSpreadsheetText,
} = require('../shading.js');

function completeRows(gByMonth = { M: 1, J: 1, D: 1 }) {
  return ['M', 'J', 'D'].flatMap(month =>
    Array.from({ length: 12 }, (_, index) => ({
      month,
      hour: index + 7,
      G: gByMonth[month],
      ID: 90,
      Id: 10,
      IT: 100,
    })),
  );
}

test('report text is escaped before insertion into generated HTML', () => {
  assert.equal(escapeHTML('<img src=x onerror=alert(1)> & "note"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;note&quot;');
});

test('spreadsheet text neutralizes formula injection after whitespace and controls', () => {
  assert.equal(safeSpreadsheetText('=HYPERLINK("https://example.com")'), '\'=HYPERLINK("https://example.com")');
  assert.equal(safeSpreadsheetText('\t =1+1'), "'\t =1+1");
  assert.equal(safeSpreadsheetText('Table C14'), 'Table C14');
});

test('combined SC multiplies glass SC1 by external-device SC2', () => {
  assert.equal(calculateCombinedSC(0.70, 0.55), 0.385);
});

test('blank SC values are rejected instead of becoming zero', () => {
  assert.throws(() => calculateCombinedSC('', 0.55), /Glass SC1 is required/);
  assert.throws(() => calculateCombinedSC(0.70, '  '), /Device SC2 is required/);
});

test('B2.2 hourly method returns one for a fully exposed window', () => {
  assert.equal(calculateEffectiveSC2(completeRows()), 1);
});

test('B2.2 method doubles March when September is represented by March data', () => {
  const sc2 = calculateEffectiveSC2(completeRows({ M: 0, J: 1, D: 1 }));
  assert.equal(sc2, 0.55);
});

test('B2.2 method requires March, June and December datasets', () => {
  assert.throws(
    () => calculateEffectiveSC2(completeRows().filter(row => row.month !== 'D')),
    /March, June and December/,
  );
});

test('B2.2 method requires 12 unique daylight hours for each month', () => {
  const missing = completeRows().filter(row => !(row.month === 'J' && row.hour === 18));
  assert.throws(() => calculateEffectiveSC2(missing), /12 unique hourly rows/);
  const duplicate = completeRows();
  duplicate[13] = { ...duplicate[12] };
  assert.throws(() => calculateEffectiveSC2(duplicate), /12 unique hourly rows/);
});

test('solar CSV parser accepts the month,hour,G,ID,Id,IT format', () => {
  const rows = parseSolarRows('month,hour,G,ID,Id,IT\nM,7,0.5,100,20,120');
  assert.deepEqual(rows[0], { month: 'M', hour: 7, G: 0.5, ID: 100, Id: 20, IT: 120 });
});

test('solar CSV parser rejects a separate September dataset because March is doubled', () => {
  assert.throws(() => parseSolarRows('S,7,0.5,100,20,120'), /Month must be M, J or D/);
});

test('solar CSV parser rejects an exposed fraction outside zero to one', () => {
  assert.throws(() => parseSolarRows('M,7,1.2,100,20,120'), /G must be between 0 and 1/);
});

test('B2.2 rows reject false low-radiation totals outside one-percent tolerance', () => {
  assert.throws(() => parseSolarRows('M,7,0,0,0,0.5'), /IT must equal ID \+ Id within 1%/);
});

test('shading resolver supports legacy, BCA table and B2.2 custom modes', () => {
  assert.equal(resolveShading({ mode: 'legacy', combinedSC: 0.42 }).combinedSC, 0.42);
  assert.equal(resolveShading({ mode: 'table', glassSC: 0.70, deviceSC2: 0.55 }).combinedSC, 0.385);
  const custom = resolveShading({ mode: 'b22', glassSC: 0.70, rows: completeRows() });
  assert.equal(custom.deviceSC2, 1);
  assert.equal(custom.combinedSC, 0.7);
});
