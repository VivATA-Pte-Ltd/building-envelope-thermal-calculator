(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VivaTEQShading = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MONTH_WEIGHTS = Object.freeze({ M: 2, J: 1, D: 1 });

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeSpreadsheetText(value) {
    const text = String(value ?? '');
    return /^[\s\x00-\x1f]*[=+\-@]/.test(text) ? `'${text}` : text;
  }

  function finiteNumber(value, label) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      throw new TypeError(`${label} is required`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
    return number;
  }

  function unitInterval(value, label) {
    const number = finiteNumber(value, label);
    if (number < 0 || number > 1) throw new RangeError(`${label} must be between 0 and 1`);
    return number;
  }

  function calculateCombinedSC(glassSC, deviceSC2) {
    return unitInterval(glassSC, 'Glass SC1') * unitInterval(deviceSC2, 'Device SC2');
  }

  function normaliseMonth(value) {
    const month = String(value || '').trim().toUpperCase();
    if (['M', 'MAR', 'MARCH'].includes(month)) return 'M';
    if (['J', 'JUN', 'JUNE'].includes(month)) return 'J';
    if (['D', 'DEC', 'DECEMBER'].includes(month)) return 'D';
    throw new RangeError(`Month must be M, J or D (received ${value})`);
  }

  function validateSolarRow(row, lineLabel = 'row') {
    const month = normaliseMonth(row.month);
    const hour = finiteNumber(row.hour, 'Hour');
    if (!Number.isInteger(hour) || hour < 7 || hour > 18) {
      throw new RangeError(`${lineLabel}: hour must be an integer from 7 to 18`);
    }
    const G = unitInterval(row.G, 'G');
    const ID = finiteNumber(row.ID, 'ID');
    const Id = finiteNumber(row.Id, 'Id');
    const IT = finiteNumber(row.IT, 'IT');
    if (ID < 0 || Id < 0 || IT <= 0) throw new RangeError(`${lineLabel}: ID and Id must be non-negative and IT must be positive`);
    if (Math.abs((ID + Id) - IT) > IT * 0.01) {
      throw new RangeError(`${lineLabel}: IT must equal ID + Id within 1%`);
    }
    return { month, hour, G, ID, Id, IT };
  }

  function calculateEffectiveSC2(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new RangeError('At least one B2.2 solar-data row is required');
    const validated = rows.map((row, index) => validateSolarRow(row, `Row ${index + 1}`));
    const present = new Set(validated.map(row => row.month));
    if (!['M', 'J', 'D'].every(month => present.has(month))) {
      throw new RangeError('B2.2 data must include March, June and December');
    }
    for (const month of ['M', 'J', 'D']) {
      const hours = validated.filter(row => row.month === month).map(row => row.hour);
      if (hours.length !== 12 || new Set(hours).size !== 12 || hours.some(hour => hour < 7 || hour > 18)) {
        throw new RangeError(`B2.2 month ${month} must include exactly 12 unique hourly rows from 7 to 18`);
      }
    }
    let numerator = 0;
    let denominator = 0;
    for (const row of validated) {
      const weight = MONTH_WEIGHTS[row.month];
      numerator += weight * ((row.G * row.ID) + row.Id);
      denominator += weight * row.IT;
    }
    if (!(denominator > 0)) throw new RangeError('B2.2 total radiation must be positive');
    return Math.min(1, Math.max(0, numerator / denominator));
  }

  function parseSolarRows(text) {
    const lines = String(text || '').split(String.fromCharCode(10)).map(line => line.replace(String.fromCharCode(13), '').trim()).filter(Boolean);
    const rows = [];
    lines.forEach((line, index) => {
      if (/^month\s*[,\t]/i.test(line)) return;
      const fields = line.split(/[\t,]/).map(value => value.trim());
      if (fields.length !== 6) throw new RangeError(`Line ${index + 1}: expected month,hour,G,ID,Id,IT`);
      rows.push(validateSolarRow({ month: fields[0], hour: fields[1], G: fields[2], ID: fields[3], Id: fields[4], IT: fields[5] }, `Line ${index + 1}`));
    });
    return rows;
  }

  function orientationGroup(orientation) {
    const value = String(orientation || '').trim().toUpperCase();
    if (['N', 'S'].includes(value)) return 'NS';
    if (['E', 'W'].includes(value)) return 'EW';
    if (['NE', 'NW'].includes(value)) return 'NENW';
    if (['SE', 'SW'].includes(value)) return 'SESW';
    throw new RangeError(`Unsupported façade orientation: ${orientation}`);
  }

  function positiveNumber(value, label) {
    const number = finiteNumber(value, label);
    if (!(number > 0)) throw new RangeError(`${label} must be greater than zero`);
    return number;
  }

  function axisBounds(axis, value, label) {
    const tolerance = 1e-9;
    const minimum = axis[0];
    const maximum = axis[axis.length - 1];
    if (value < minimum - tolerance || value > maximum + tolerance) {
      throw new RangeError(`${label} must be within ${minimum} and ${maximum}`);
    }
    const exact = axis.findIndex(item => Math.abs(item - value) <= tolerance);
    if (exact >= 0) return { lower: exact, upper: exact, fraction: 0 };
    const upper = axis.findIndex(item => item > value);
    const lower = upper - 1;
    return { lower, upper, fraction: (value - axis[lower]) / (axis[upper] - axis[lower]) };
  }

  function interpolate(a, b, fraction) {
    return a + ((b - a) * fraction);
  }

  function table2D(table, ratio, angle, ratioLabel) {
    const rb = axisBounds(table.ratios, ratio, ratioLabel);
    const ab = axisBounds(table.angles, angle, 'Inclination angle');
    const low = interpolate(table.values[rb.lower][ab.lower], table.values[rb.lower][ab.upper], ab.fraction);
    const high = interpolate(table.values[rb.upper][ab.lower], table.values[rb.upper][ab.upper], ab.fraction);
    return {
      value: interpolate(low, high, rb.fraction),
      interpolated: rb.lower !== rb.upper || ab.lower !== ab.upper,
    };
  }

  function eggcrateValue(table, r1, r2, angle) {
    const r1b = axisBounds(table.r1, r1, 'R1');
    const r2b = axisBounds(table.r2, r2, 'R2');
    const ab = axisBounds(table.angles, angle, 'Inclination angle');
    const at = (i, j, k) => table.values[`${table.r1[i].toFixed(1)},${table.r2[j].toFixed(1)}`][k];
    const alongAngle = (i, j) => interpolate(at(i, j, ab.lower), at(i, j, ab.upper), ab.fraction);
    const alongR2Low = interpolate(alongAngle(r1b.lower, r2b.lower), alongAngle(r1b.lower, r2b.upper), r2b.fraction);
    const alongR2High = interpolate(alongAngle(r1b.upper, r2b.lower), alongAngle(r1b.upper, r2b.upper), r2b.fraction);
    return {
      value: interpolate(alongR2Low, alongR2High, r1b.fraction),
      interpolated: r1b.lower !== r1b.upper || r2b.lower !== r2b.upper || ab.lower !== ab.upper,
    };
  }

  function calculateStandardSC2(input, shadingData) {
    if (!shadingData?.standard) throw new TypeError('Verified BCA standard-shading data is required');
    const type = String(input?.type || '').trim().toLowerCase();
    const orientation = String(input?.orientation || '').trim().toUpperCase();
    const group = orientationGroup(orientation);
    const angle = finiteNumber(input?.angle ?? 0, 'Inclination angle');
    if (type === 'horizontal') {
      const projection = positiveNumber(input.projection, 'Projection');
      const windowHeight = positiveNumber(input.windowHeight, 'Window height');
      const r1 = Number((projection / windowHeight).toFixed(12));
      const table = shadingData.standard.horizontal[group];
      const result = table2D(table, r1, angle, 'R1');
      return { sc2: result.value, table: table.table, r1, r2: null, angle, interpolated: result.interpolated };
    }
    if (type === 'vertical') {
      const projection = positiveNumber(input.projection, 'Projection');
      const windowWidth = positiveNumber(input.windowWidth, 'Window width');
      const r2 = Number((projection / windowWidth).toFixed(12));
      const table = shadingData.standard.vertical[group];
      const result = table2D(table, r2, angle, 'R2');
      return { sc2: result.value, table: table.table, r1: null, r2, angle, interpolated: result.interpolated };
    }
    if (type === 'eggcrate') {
      const horizontalProjection = positiveNumber(input.horizontalProjection, 'Horizontal projection');
      const verticalProjection = positiveNumber(input.verticalProjection, 'Vertical projection');
      const windowHeight = positiveNumber(input.windowHeight, 'Window height');
      const windowWidth = positiveNumber(input.windowWidth, 'Window width');
      const r1 = Number((horizontalProjection / windowHeight).toFixed(12));
      const r2 = Number((verticalProjection / windowWidth).toFixed(12));
      const table = shadingData.standard.eggcrate[group];
      const result = eggcrateValue(table, r1, r2, angle);
      return { sc2: result.value, table: table.table, r1, r2, angle, interpolated: result.interpolated };
    }
    throw new RangeError(`Unsupported standard shading-device type: ${type}`);
  }

  function resolveShading(input) {
    const mode = String(input?.mode || 'legacy').toLowerCase();
    if (mode === 'legacy') {
      const combinedSC = unitInterval(input.combinedSC, 'Combined SC');
      return { mode, glassSC: null, deviceSC2: null, combinedSC };
    }
    const glassSC = unitInterval(input.glassSC, 'Glass SC1');
    let deviceSC2;
    if (mode === 'none') deviceSC2 = 1;
    else if (mode === 'table') deviceSC2 = unitInterval(input.deviceSC2, 'Device SC2');
    else if (mode === 'b22') deviceSC2 = calculateEffectiveSC2(input.rows);
    else throw new RangeError(`Unsupported shading mode: ${mode}`);
    return { mode, glassSC, deviceSC2, combinedSC: calculateCombinedSC(glassSC, deviceSC2) };
  }

  return Object.freeze({
    MONTH_WEIGHTS,
    calculateCombinedSC,
    calculateEffectiveSC2,
    calculateStandardSC2,
    escapeHTML,
    parseSolarRows,
    resolveShading,
    safeSpreadsheetText,
  });
});
