(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Small, dependency-free XLSX writer (v3-Lite §8). It uses inline strings
   * (so no sharedStrings table and no external library), a frozen header row,
   * bold headers and a two-decimal money style. The package is a normal ZIP
   * built by BeeStore.zip, so it is fully offline.
   */

  function escapeXml(value) {
    return String(value == null ? '' : value)
      // XML 1.0 forbids most control characters.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function colName(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function cleanSheetName(name, used) {
    let base = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim() || 'Sheet';
    if (base.length > 31) base = base.slice(0, 31);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = ' (' + n + ')';
      candidate = base.slice(0, Math.max(1, 31 - suffix.length)) + suffix;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function cellRef(rowIndex, colIndex) {
    return colName(colIndex) + String(rowIndex + 1);
  }

  function normalizedCell(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.minor !== undefined) {
        return { type: 'number', value: (Number(value.minor) || 0) / 100, style: 2 };
      }
      if (value.num !== undefined) {
        return { type: 'number', value: Number(value.num), style: 0 };
      }
      if (value.text !== undefined) {
        return { type: 'string', value: String(value.text) };
      }
      if (value.value !== undefined) {
        return normalizedCell(value.value);
      }
    }
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? { type: 'number', value, style: 0 } : null;
    }
    if (typeof value === 'boolean') return { type: 'boolean', value };
    if (value instanceof Date) return { type: 'string', value: value.toISOString() };
    return { type: 'string', value: String(value) };
  }

  function cellXml(value, rowIndex, colIndex, isHeader) {
    const cell = normalizedCell(value);
    if (!cell) return '';
    const ref = cellRef(rowIndex, colIndex);
    const style = isHeader ? 1 : (cell.style || 0);
    const s = style ? ' s="' + style + '"' : '';
    if (cell.type === 'number') {
      return '<c r="' + ref + '"' + s + '><v>' + cell.value + '</v></c>';
    }
    if (cell.type === 'boolean') {
      return '<c r="' + ref + '"' + s + ' t="b"><v>' + (cell.value ? 1 : 0) + '</v></c>';
    }
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' +
      escapeXml(cell.value) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    const widths = sheet.widths || [];
    let rowCount = 0;
    let maxCols = 0;
    const body = [];
    for (let r = 0; r < rows.length; r++) {
      const row = Array.isArray(rows[r]) ? rows[r] : [];
      if (row.some(v => v !== null && v !== undefined && v !== '')) rowCount = r + 1;
      maxCols = Math.max(maxCols, row.length);
      const cells = [];
      for (let c = 0; c < row.length; c++) {
        const xml = cellXml(row[c], r, c, r === 0 && sheet.header !== false);
        if (xml) cells.push(xml);
      }
      body.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
    }
    if (!body.length) body.push('<row r="1"/>');
    if (!rowCount) rowCount = 1;
    if (!maxCols) maxCols = 1;
    const dimension = 'A1:' + colName(maxCols - 1) + rowCount;
    const cols = widths.length
      ? '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) +
        '" width="' + (Number(w) || 12) + '" customWidth="1"/>').join('') + '</cols>'
      : '';
    const pane = sheet.freezeHeader === false ? ''
      : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" ' +
        'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="' + dimension + '"/>' + pane + cols +
      '<sheetData>' + body.join('') + '</sheetData></worksheet>';
  }

  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Arial"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1B2740"/>' +
    '<bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function buildWorkbook(sheets, options) {
    const list = (sheets || []).filter(Boolean);
    if (!list.length) throw new Error('ملف Excel يحتاج ورقة واحدة على الأقل');
    const used = new Set();
    const names = list.map(s => cleanSheetName(s.name, used));
    const zip = new BeeStore.zip.ZipWriter({
      date: (options && options.date) || new Date(),
      comment: (options && options.comment) || 'BeeStore',
    });

    const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    for (let i = 0; i < names.length; i++) {
      contentTypes.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    contentTypes.push('</Types>');

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + names.map((name, i) => '<sheet name="' + escapeXml(name) +
        '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map((name, i) => '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (names.length + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/></Relationships>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/></Relationships>';

    zip.add('[Content_Types].xml', contentTypes.join(''));
    zip.add('_rels/.rels', rootRels);
    zip.add('xl/workbook.xml', workbook);
    zip.add('xl/_rels/workbook.xml.rels', workbookRels);
    zip.add('xl/styles.xml', STYLES);
    for (let i = 0; i < list.length; i++) {
      zip.add('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(list[i]));
    }
    return zip.generate();
  }

  /** @param {number} minor integer minor units @returns {{minor:number}} */
  function money(minor) { return { minor: Number(minor) || 0 }; }
  /** @param {number} value @returns {{num:number}} */
  function num(value) { return { num: Number(value) || 0 }; }
  /** @param {string} value @returns {{text:string}} */
  function text(value) { return { text: String(value == null ? '' : value) }; }

  BeeStore.xlsx = {
    buildWorkbook, sheetXml, escapeXml, colName, cleanSheetName, money, num, text,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.xlsx;
})(typeof window !== 'undefined' ? window : globalThis);
