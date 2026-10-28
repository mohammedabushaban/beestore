(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * v5 §4 inventory-side posting helpers.
   *
   * Every helper runs inside the caller's document transaction and is a
   * no-op when the journal/chart services are not loaded (older unit tests and
   * non-accounting scripts still work). Amounts are always integer minor units
   * and every emitted entry is balanced by construction; a missing system
   * account is an error, never a silently skipped posting.
   */
  class PostingService {
    constructor(repo) {
      this.repo = repo;
    }

    available() {
      return !!(BeeStore.journal && BeeStore.journal.post &&
        BeeStore.chart && BeeStore.chart.ensureSeededTx);
    }

    async chartMap(tx) {
      if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
        await BeeStore.chart.ensureSeededTx(tx);
      }
      const chart = await tx.list('chartOfAccounts');
      const byKey = new Map();
      for (const account of chart) {
        if (account.systemKey) byKey.set(account.systemKey, account);
      }
      return byKey;
    }

    /**
     * Finds one active system account by its stable seed key.
     * @param {object} tx active transaction
     * @param {string} key chart seed key (inventory, cogs, ap, ...)
     * @returns {Promise<object>} chart account
     */
    async accountByKey(tx, key) {
      const byKey = await this.chartMap(tx);
      const account = byKey.get(key);
      if (!account) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي النظامي غير موجود: ' + key);
      }
      if (account.active === false) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي معطّل: ' + account.nameAr);
      }
      return account;
    }

    _account(byKey, key) {
      const account = byKey.get(key);
      if (!account) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي النظامي غير موجود: ' + key);
      }
      if (account.active === false) {
        throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي معطّل: ' + account.nameAr);
      }
      return account;
    }

    /**
     * Builds and appends one balanced entry from system-key parts.
     * @param {object} tx active transaction
     * @param {object} spec {date,sourceType,sourceId,description,parts[],allowClosedDay?}
     * @returns {Promise<object|null>} entry, or null for a zero-value event
     */
    async postParts(tx, spec) {
      if (!this.available()) return null;
      const byKey = await this.chartMap(tx);
      const lines = [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const part of (spec.parts || [])) {
        const debit = Math.round(Number(part.debit) || 0);
        const credit = Math.round(Number(part.credit) || 0);
        if (debit < 0 || credit < 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ ترحيل المخزون لا يمكن أن يكون سالباً');
        }
        if (debit === 0 && credit === 0) continue;
        if (debit > 0 && credit > 0) {
          throw BeeStore.errors.err('VALIDATION', 'سطر الترحيل لا يكون مديناً ودائناً معاً');
        }
        const account = this._account(byKey, part.key);
        lines.push({
          accountId: account.id,
          debitMinor: debit,
          creditMinor: credit,
          partyType: part.partyType || null,
          partyId: part.partyId || null,
          memo: part.memo || '',
        });
        totalDebit += debit;
        totalCredit += credit;
      }
      if (lines.length < 2) return null;
      if (totalDebit !== totalCredit) {
        throw BeeStore.errors.err('VALIDATION',
          'ترحيل المخزون غير متوازن — مدين ' + totalDebit + ' مقابل دائن ' + totalCredit);
      }
      return BeeStore.journal.post(tx, {
        date: spec.date,
        sourceType: spec.sourceType,
        sourceId: spec.sourceId === undefined ? null : spec.sourceId,
        description: spec.description,
        lines,
      }, { allowClosedDay: spec.allowClosedDay !== false });
    }

    /**
     * Sale cost entry: Dr 5010 COGS / Cr 1200 Inventory.
     * @param {object} tx active transaction
     * @param {object} sale posted sale
     * @param {number} totalCogsMinor exact §3.2 cost of the sold units
     * @returns {Promise<object|null>} entry
     */
    async saleCost(tx, sale, totalCogsMinor) {
      const amount = Math.round(Number(totalCogsMinor) || 0);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: sale.date,
        sourceType: 'SALE',
        sourceId: sale.id,
        description: 'تكلفة مبيعات ' + sale.number,
        parts: amount > 0
          ? [{ key: 'cogs', debit: amount }, { key: 'inventory', credit: amount }]
          : [{ key: 'inventory', debit: -amount }, { key: 'cogs', credit: -amount }],
      });
    }

    /**
     * Restocked sale return: Dr 1200 Inventory / Cr 5010 COGS.
     * Damaged returns are not posted here because their cost stays in COGS.
     * @param {object} tx active transaction
     * @param {object} ret sale return
     * @param {number} restockCostMinor exact original cost of restocked units
     * @returns {Promise<object|null>} entry
     */
    async saleReturnCost(tx, ret, restockCostMinor) {
      const amount = Math.round(Number(restockCostMinor) || 0);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: ret.date,
        sourceType: 'SALE_RETURN',
        sourceId: ret.id,
        description: 'تكلفة مرتجع مبيعات ' + ret.number,
        parts: amount > 0
          ? [{ key: 'inventory', debit: amount }, { key: 'cogs', credit: amount }]
          : [{ key: 'cogs', debit: -amount }, { key: 'inventory', credit: -amount }],
      });
    }

    /**
     * Purchase invoice inventory side: Dr 1200 Inventory / Cr 2010 AP.
     * @param {object} tx active transaction
     * @param {object} purchase posted purchase
     * @param {number} inventoryValueMinor lines net of allocated discount
     * @returns {Promise<object|null>} entry
     */
    async purchase(tx, purchase, inventoryValueMinor) {
      const amount = Math.round(Number(inventoryValueMinor) || 0);
      if (amount === 0) return null;
      const ap = await this.accountByKey(tx, 'ap');
      return this.postParts(tx, {
        date: purchase.date,
        sourceType: 'PURCHASE',
        sourceId: purchase.id,
        description: 'مشتريات ' + purchase.number,
        parts: [
          { key: 'inventory', debit: amount },
          {
            key: 'ap', credit: amount,
            partyType: purchase.supplierId ? 'supplier' : null,
            partyId: purchase.supplierId || null,
            memo: ap.nameAr,
          },
        ],
      });
    }

    /**
     * Purchase return: Dr AP (refund value), Cr Inventory (tracked value
     * removed), with any difference to 5030 (v5 §4 row 7). A refund above the
     * removed carrying value is a credit (gain); below is a debit (loss).
     * @param {object} tx active transaction
     * @param {object} ret purchase return
     * @param {number} refundValueMinor supplier refund / payable reduction
     * @param {number} removedValueMinor exact value removed from inventory
     * @returns {Promise<object|null>} entry
     */
    async purchaseReturn(tx, ret, refundValueMinor, removedValueMinor) {
      const refund = Math.round(Number(refundValueMinor) || 0);
      const removed = Math.round(Number(removedValueMinor) || 0);
      if (refund === 0 && removed === 0) return null;
      const parts = [
        {
          key: 'ap', debit: refund,
          partyType: ret.supplierId ? 'supplier' : null,
          partyId: ret.supplierId || null,
        },
        { key: 'inventory', credit: removed },
      ];
      if (refund > removed) {
        parts.push({ key: 'inventory_revaluation', credit: refund - removed });
      } else if (removed > refund) {
        parts.push({ key: 'inventory_revaluation', debit: removed - refund });
      }
      return this.postParts(tx, {
        date: ret.date,
        sourceType: 'PURCHASE_RETURN',
        sourceId: ret.id,
        description: 'مرتجع مشتريات ' + ret.number,
        parts,
      });
    }

    /**
     * Stock adjustment/count: gain Dr 1200 / Cr 5020, loss Dr 5020 / Cr 1200.
     * @param {object} tx active transaction
     * @param {object} movement stock movement
     * @param {number} valueChangeMinor signed tracked-value change
     * @returns {Promise<object|null>} entry
     */
    async stockAdjustment(tx, movement, valueChangeMinor) {
      const delta = Math.round(Number(valueChangeMinor) || 0);
      if (delta === 0) return null;
      return this.postParts(tx, {
        date: movement.date,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: movement.id,
        description: movement.type === 'stocktake' ? 'جرد مخزون ' + movement.date : 'تسوية مخزون ' + movement.date,
        parts: delta > 0
          ? [{ key: 'inventory', debit: delta }, { key: 'inventory_loss', credit: delta }]
          : [{ key: 'inventory_loss', debit: -delta }, { key: 'inventory', credit: -delta }],
      });
    }

    /**
     * Cost revaluation (v4 R1): value delta between 1200 and 5030.
     * @param {object} tx active transaction
     * @param {object} movement revaluation movement
     * @param {number} valueChangeMinor signed tracked-value change
     * @returns {Promise<object|null>} entry
     */
    async revaluation(tx, movement, valueChangeMinor) {
      const delta = Math.round(Number(valueChangeMinor) || 0);
      if (delta === 0) return null;
      return this.postParts(tx, {
        date: movement.date,
        sourceType: 'REVALUATION',
        sourceId: movement.id,
        description: 'تسوية تكلفة مخزون ' + movement.date,
        parts: delta > 0
          ? [{ key: 'inventory', debit: delta }, { key: 'inventory_revaluation', credit: delta }]
          : [{ key: 'inventory_revaluation', debit: -delta }, { key: 'inventory', credit: -delta }],
      });
    }

    /**
     * Opening stock contributed by the owner: Dr 1200 / Cr 3030.
     * @param {object} tx active transaction
     * @param {object} spec {date,sourceId?,description,valueMinor}
     * @returns {Promise<object|null>} entry
     */
    async openingStock(tx, spec) {
      const amount = Math.round(Number(spec.valueMinor) || 0);
      if (amount === 0) return null;
      return this.postParts(tx, {
        date: spec.date,
        sourceType: 'OPENING',
        sourceId: spec.sourceId || null,
        description: spec.description || 'مخزون افتتاحي',
        parts: [
          { key: 'inventory', debit: amount },
          { key: 'opening_equity', credit: amount },
        ],
      });
    }

    /**
     * Appends one entry id to a document's journalEntryIds (idempotent).
     * @param {object} doc document or stock movement
     * @param {object} entry journal entry
     * @returns {object} the same document
     */
    link(doc, entry) {
      if (!doc || !entry) return doc;
      const ids = Array.isArray(doc.journalEntryIds) ? doc.journalEntryIds : [];
      if (ids.indexOf(entry.id) < 0) ids.push(entry.id);
      doc.journalEntryIds = ids;
      return doc;
    }

    /**
     * Links several documents/movements to one or more entries.
     * @param {object[]} docs documents
     * @param {object|object[]} entries one entry or an array
     * @returns {object[]} docs
     */
    linkAll(docs, entries) {
      const list = Array.isArray(entries) ? entries : (entries ? [entries] : []);
      for (const doc of (docs || [])) {
        for (const entry of list) this.link(doc, entry);
      }
      return docs;
    }

    /**
     * Reverses every entry of one source document inside its transaction.
     * Returns [] for legacy documents that have no journal entries yet.
     * @param {object} tx active transaction
     * @param {string} sourceType source type
     * @param {string} sourceId source id
     * @param {object} [meta] description/reason
     * @param {object} [options] {allowClosedDay}
     * @returns {Promise<object[]>} reversal entries
     */
    async reverseDocument(tx, sourceType, sourceId, meta, options) {
      if (!BeeStore.journal || !BeeStore.journal.reverseSourceTx) return [];
      return BeeStore.journal.reverseSourceTx(tx, sourceType, sourceId, meta,
        { allowClosedDay: options && options.allowClosedDay !== undefined ? options.allowClosedDay : true });
    }
  }

  BeeStore.posting = new PostingService(null);
  BeeStore.PostingService = PostingService;
  if (typeof module !== 'undefined') module.exports = PostingService;
})(typeof window !== 'undefined' ? window : globalThis);
