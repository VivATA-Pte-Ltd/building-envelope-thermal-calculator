const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const data = require('../shading-data.js');

test('official standard shading data reproduces the BCA Table C15 examples', () => {
  assert.equal(data.source.sha256, 'fefc5a6e197022801aa47803789b9b486b4fbe50b3e0ce86be01e6c1de12776c');
  const table = data.standard.horizontal.SESW;
  assert.equal(table.values[table.ratios.indexOf(0.5)][table.angles.indexOf(0)], 0.6981);
  assert.equal(table.values[table.ratios.indexOf(0.4)][table.angles.indexOf(30)], 0.6692);
});

test('official data includes complete standard and B2.2 datasets', () => {
  for (const family of ['horizontal', 'vertical', 'eggcrate']) {
    for (const group of ['NS', 'EW', 'NENW', 'SESW']) {
      assert.ok(data.standard[family][group]);
    }
  }
  assert.equal(Object.keys(data.standard.eggcrate.SESW.values).length, 81);
  for (const group of ['NS', 'EW', 'NENW', 'SESW']) {
    for (const month of ['M', 'J', 'D']) {
      assert.equal(data.solar[group].months[month].length, 12);
    }
  }
});

test('all 3,060 embedded SC values match the independently extracted official CSV', () => {
  const csv = fs.readFileSync(path.join(__dirname, '../data/extracted/bca-shading-tables-C12-C23.csv'), 'utf8').trim().split(/\r?\n/);
  const groups = {
    'North & South': 'NS',
    'East & West': 'EW',
    'North-East & North-West': 'NENW',
    'South-East & South-West': 'SESW',
  };
  assert.equal(csv.length - 1, 3060);
  for (const line of csv.slice(1)) {
    const [table, device, orientation, rawR1, rawR2, rawAngle, rawSC] = line.split(',');
    const family = { horizontal_projection:'horizontal', vertical_projection:'vertical', egg_crate:'eggcrate' }[device];
    const record = data.standard[family][groups[orientation]];
    assert.equal(record.table, table);
    const angleIndex = record.angles.indexOf(Number(rawAngle));
    let embedded;
    if (family === 'horizontal') embedded = record.values[record.ratios.indexOf(Number(rawR1))][angleIndex];
    else if (family === 'vertical') embedded = record.values[record.ratios.indexOf(Number(rawR2))][angleIndex];
    else embedded = record.values[`${Number(rawR1).toFixed(1)},${Number(rawR2).toFixed(1)}`][angleIndex];
    assert.equal(embedded, Number(rawSC), `${table} R1=${rawR1} R2=${rawR2} angle=${rawAngle}`);
  }
});
