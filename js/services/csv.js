(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class CsvService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * Parse a products CSV into normalized rows (never throws on bad cells;
     * collects per-row errors). Eastern digits are normalized.
     * @param {string} csvText raw file text
     * @returns {{rows:Array<{name,size,color,costMinor,priceMinor,quantity,barcode,sku}>,errors:string[]}}
     */
    parseProducts(csvText) {
      const lines = csvText.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return { rows: [], errors: ['الملف فارغ أو لا يحتوي على بيانات'] };

      const headers = this._parseLine(lines[0]);
      const nameIdx = this._findHeader(headers, ['name', 'اسم', 'المنتج', 'product']);
      const sizeIdx = this._findHeader(headers, ['size', 'المقاس', 'مقاس']);
      const colorIdx = this._findHeader(headers, ['color', 'اللون', 'لون']);
      const costIdx = this._findHeader(headers, ['cost', 'التكلفة', 'تكلفة', 'cost_minor']);
      const priceIdx = this._findHeader(headers, ['price', 'السعر', 'سعر', 'price_minor']);
      const qtyIdx = this._findHeader(headers, ['qty', 'الكمية', 'كمية', 'quantity']);
      const barcodeIdx = this._findHeader(headers, ['barcode', 'الباركود', 'باركود']);
      const skuIdx = this._findHeader(headers, ['sku', 'sku']);

      if (nameIdx === -1) return { rows: [], errors: ['لم يتم العثور على عمود اسم المنتج'] };

      const rows = [];
      const errors = [];
      const costIsMinor = costIdx >= 0 && this._isMinorHeader(headers, costIdx);
      const priceIsMinor = priceIdx >= 0 && this._isMinorHeader(headers, priceIdx);
      for (let i = 1; i < lines.length; i++) {
        const cols = this._parseLine(lines[i]);
        const row = {
          name: cols[nameIdx] || '',
          size: sizeIdx >= 0 ? cols[sizeIdx] : '',
          color: colorIdx >= 0 ? cols[colorIdx] : '',
          costMinor: costIdx >= 0
            ? (costIsMinor ? BeeStore.money.roundMinor(BeeStore.money.parseDecimal(cols[costIdx])) : BeeStore.money.fromMajor(cols[costIdx] || '0'))
            : 0,
          priceMinor: priceIdx >= 0
            ? (priceIsMinor ? BeeStore.money.roundMinor(BeeStore.money.parseDecimal(cols[priceIdx])) : BeeStore.money.fromMajor(cols[priceIdx] || '0'))
            : 0,
          quantity: qtyIdx >= 0 ? Math.floor(BeeStore.money.parseDecimal(cols[qtyIdx])) || 0 : 0,
          barcode: barcodeIdx >= 0 ? cols[barcodeIdx] : '',
          sku: skuIdx >= 0 ? cols[skuIdx] : '',
        };
        if (!row.name) { errors.push('صف ' + (i + 1) + ': اسم المنتج فارغ'); continue; }
        rows.push(row);
      }
      return { rows, errors };
    }

    async importProducts(csvText) {
      const { rows, errors } = this.parseProducts(csvText);
      if (rows.length === 0) return { ok: false, errors };

      const result = await this.repo.transaction(async (tx) => {
        await BeeStore.periods.assertOpen(tx, BeeStore.dates.today());
        const created = [];
        for (const row of rows) {
          let variant = null;
          if (row.barcode) {
            const existing = await tx.query('variants', 'barcode', row.barcode);
            if (existing.length > 0) variant = existing[0];
          }
          if (!variant && row.sku) {
            const existing = await tx.query('variants', 'sku', row.sku);
            if (existing.length > 0) variant = existing[0];
          }

          if (variant) {
            const newCost = BeeStore.stock.blendCost(
              variant.quantity, variant.costMinor, row.quantity, row.costMinor || variant.costMinor);
            variant.quantity += row.quantity;
            variant.costMinor = newCost;
            variant.priceMinor = row.priceMinor || variant.priceMinor;
            variant.updatedAt = BeeStore.dates.now();
            tx.put('variants', variant);
            tx.put('stockMovements', {
              id: BeeStore.ids.randomId('stm'),
              variantId: variant.id,
              date: BeeStore.dates.today(),
              type: 'opening',
              qtyChange: row.quantity,
              unitCostMinor: row.costMinor,
              avgCostAfterMinor: newCost,
              refType: 'import',
              refId: null,
              note: 'استيراد CSV',
              balanceAfter: variant.quantity,
              createdAt: BeeStore.dates.now(),
            });
            created.push({ action: 'updated', name: row.name });
          } else {
            const product = tx.put('products', {
              id: BeeStore.ids.randomId('prd'),
              name: row.name,
              categoryId: null,
              brand: '',
              gender: 'unisex',
              description: '',
              defaultCostMinor: row.costMinor,
              defaultPriceMinor: row.priceMinor,
              active: true,
              imageDataUri: null,
              createdAt: BeeStore.dates.now(),
            });
            const newVariant = {
              id: BeeStore.ids.randomId('var'),
              productId: product.id,
              size: row.size || 'Free size',
              color: row.color || '',
              sku: row.sku || '',
              barcode: row.barcode || BeeStore.ids.nextBarcode(),
              costMinor: row.costMinor,
              priceMinor: row.priceMinor,
              quantity: row.quantity,
              lowStockThreshold: null,
              active: true,
              createdAt: BeeStore.dates.now(),
            };
            tx.put('variants', newVariant);
            if (row.quantity > 0) {
              tx.put('stockMovements', {
                id: BeeStore.ids.randomId('stm'),
                variantId: newVariant.id,
                date: BeeStore.dates.today(),
              type: 'opening',
              qtyChange: row.quantity,
              unitCostMinor: row.costMinor,
              avgCostAfterMinor: row.costMinor,
              refType: 'import',
              refId: null,
              note: 'استيراد CSV',
              balanceAfter: row.quantity,
                createdAt: BeeStore.dates.now(),
              });
            }
            created.push({ action: 'created', name: row.name });
          }
        }
        return created;
      });

      return { ok: true, created: result, errors };
    }

    /**
     * Build a downloadable CSV (BOM for Arabic). Cells starting with
     * `= + - @` are prefixed with `'` against formula injection (v2 §12.1.7).
     * @param {string[]} headers column titles
     * @param {Array<Array>} rows cell values (money already formatted by caller)
     * @returns {string} CSV text with BOM
     */
    toCsv(headers, rows) {
      const bom = '\uFEFF';
      const escape = (v) => {
        let s = String(v === null || v === undefined ? '' : v);
        // v2 §12.1.7 CSV formula injection: neutralize cells that spreadsheet
        // apps would interpret as formulas (prefix with a single quote).
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      const lines = [headers.map(escape).join(',')];
      for (const row of rows) {
        lines.push(row.map(escape).join(','));
      }
      return bom + lines.join('\n');
    }

    exportProducts() {
      return this.repo.list('products').then(products => {
        return this.repo.list('variants').then(variants => {
          const productMap = {};
          for (const p of products) productMap[p.id] = p;
          const rows = variants.map(v => {
            const p = productMap[v.productId];
            return [
              p ? p.name : '',
              v.size,
              v.color,
              v.sku,
              v.barcode,
              (v.costMinor / 100).toFixed(2),
              (v.priceMinor / 100).toFixed(2),
              v.quantity,
            ];
          });
          return this.toCsv(['المنتج', 'المقاس', 'اللون', 'SKU', 'الباركود', 'التكلفة', 'السعر', 'الكمية'], rows);
        });
      });
    }

    exportSales(from, to) {
      return this.repo.list('sales', s => s.date >= from && s.date <= to).then(sales => {
        const rows = sales.map(s => [
          s.number,
          s.date,
          s.customerName || '',
          (s.totalMinor / 100).toFixed(2),
          (s.paidMinor / 100).toFixed(2),
          (s.dueMinor / 100).toFixed(2),
          s.status,
        ]);
        return this.toCsv(['الرقم', 'التاريخ', 'الزبون', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة'], rows);
      });
    }

    downloadCsv(csvContent, filename) {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    _parseLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    _findHeader(headers, candidates) {
      for (const c of candidates) {
        const idx = headers.findIndex(h => h.toLowerCase().trim() === c.toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    }

    _isMinorHeader(headers, idx) {
      return !!(headers[idx] && headers[idx].toLowerCase().includes('minor'));
    }
  }

  BeeStore.csv = new CsvService(null);
  BeeStore.CsvService = CsvService;
  if (typeof module !== 'undefined') module.exports = CsvService;
})(typeof window !== 'undefined' ? window : globalThis);
