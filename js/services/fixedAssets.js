(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function rounded(value) {
    return Math.round(Number(value) || 0);
  }

  class FixedAssetsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * Reactivates/creates the chart accounts needed by the module. Called by
     * the create flow after the owner enables fixed assets in Settings.
     * @returns {Promise<object>} chart seeding result
     */
    async ensureChart() {
      return this.repo.transaction(async (tx) => {
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          return BeeStore.chart.ensureSeededTx(tx);
        }
        return null;
      });
    }

    /**
     * Creates the fixed-asset register row and immediately posts the purchase
     * plus the complete straight-line depreciation schedule (v5 §8).
     * @param {object} data {name,purchaseDate,costMinor,usefulLifeMonths,salvageValueMinor,paidMinor,method,accountId,note}
     * @returns {Promise<object>} created asset
     * @throws {BeeError} VALIDATION|PERIOD_CLOSED when the module is off/invalid/closed
     */
    async create(data) {
      data = data || {};
      return this.repo.transaction(async (tx) => {
        const settings = (await tx.get('meta', 'settings')) || {};
        if (settings.fixedAssetsEnabled !== true) {
          throw BeeStore.errors.err('VALIDATION',
            'وحدة الأصول الثابتة غير مفعّلة — فعّلها من الإعدادات بعد مراجعة المحاسب');
        }
        // The fixed-asset chart accounts are seeded only while the module is
        // enabled. Creating an asset after enabling it must add them first.
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          await BeeStore.chart.ensureSeededTx(tx);
        }
        const name = String(data.name || '').trim();
        if (!name) throw BeeStore.errors.err('VALIDATION', 'اسم الأصل مطلوب');
        const purchaseDate = data.purchaseDate || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, purchaseDate);
        await BeeStore.periods.assertDayOpen(tx, purchaseDate);
        const costMinor = BeeStore.money.roundMinor(data.costMinor);
        if (costMinor <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'تكلفة الأصل يجب أن تكون أكبر من صفر');
        }
        const salvageValueMinor = BeeStore.money.roundMinor(data.salvageValueMinor);
        if (salvageValueMinor < 0 || salvageValueMinor >= costMinor) {
          throw BeeStore.errors.err('VALIDATION',
            'القيمة التخريدية يجب أن تكون بين صفر وتكلفة الأصل');
        }
        const usefulLifeMonths = Math.floor(Number(data.usefulLifeMonths) || 0);
        if (usefulLifeMonths <= 0 || usefulLifeMonths > 1200) {
          throw BeeStore.errors.err('VALIDATION',
            'العمر الإنتاجي يجب أن يكون عدد أشهر بين 1 و1200');
        }
        const paidMinor = Math.min(costMinor,
          Math.max(0, BeeStore.money.roundMinor(data.paidMinor)));
        const method = data.method || 'cash';
        const methodKind = data.methodKind ||
          BeeStore.settings.methodKind(settings, method);
        const accountId = data.accountId ||
          BeeStore.settings.resolvePaymentAccount(settings, method);
        if (paidMinor > 0 && !accountId) {
          throw BeeStore.errors.err('VALIDATION',
            'حدّد حساب الدفع للأصل الثابت');
        }
        const now = BeeStore.dates.now();
        const asset = {
          id: BeeStore.ids.randomId('fa'),
          name,
          purchaseDate,
          costMinor,
          salvageValueMinor,
          usefulLifeMonths,
          status: 'active',
          method,
          methodKind,
          accountId,
          initialPaidMinor: paidMinor,
          paidMinor,
          disposalDate: null,
          proceedsMinor: 0,
          disposalMethod: null,
          disposalMethodKind: null,
          disposalAccountId: null,
          accumulatedAtDisposalMinor: 0,
          bookValueAtDisposalMinor: null,
          gainLossMinor: 0,
          note: data.note || '',
          voided: false,
          journalEntryIds: [],
          createdAt: now,
          updatedAt: now,
        };
        tx.put('fixedAssets', asset);
        if (BeeStore.posting) {
          const purchaseEntry = await BeeStore.posting.fixedAssetPurchase(tx, asset);
          if (purchaseEntry) BeeStore.posting.link(asset, purchaseEntry);
          const schedule = await BeeStore.posting.ensureFixedAssetDepreciation(tx, asset);
          BeeStore.posting.linkAll([asset], schedule);
          tx.put('fixedAssets', asset);
        }
        return asset;
      });
    }

    /**
     * @param {object} [filters] {status,includeVoided}
     * @returns {Promise<object[]>} assets newest purchase first
     */
    async list(filters) {
      let rows = await this.repo.list('fixedAssets');
      if (filters && filters.status) rows = rows.filter(a => a.status === filters.status);
      if (!filters || !filters.includeVoided) rows = rows.filter(a => !a.voided);
      rows.sort((a, b) => String(b.purchaseDate).localeCompare(String(a.purchaseDate)));
      return rows;
    }

    /** @param {string} id asset id */
    async get(id) {
      return this.repo.get('fixedAssets', id);
    }

    /**
     * The straight-line schedule with each row's journal state. Used by the
     * asset page so the owner can see what was posted and what was cancelled
     * by a disposal.
     * @param {string} assetId asset id
     * @returns {Promise<object[]>} schedule rows
     */
    async schedule(assetId) {
      const asset = await this.repo.get('fixedAssets', assetId);
      if (!asset) throw BeeStore.errors.err('NOT_FOUND', 'الأصل الثابت غير موجود');
      const plan = BeeStore.posting
        ? BeeStore.posting.fixedAssetDepreciationPlan(asset) : [];
      const entries = await this.repo.list('journalEntries',
        e => e.sourceType === 'FIXED_ASSET' && e.sourceId === assetId);
      const originals = entries.filter(e =>
        e.event === 'FIXED_ASSET_DEPRECIATION' && !e.reversalOf);
      const reversed = new Set(entries.filter(e => e.reversalOf).map(e => e.reversalOf));
      return plan.map(item => {
        const candidates = originals.filter(e => e.date === item.date);
        const active = candidates.find(e => !reversed.has(e.id));
        let status = 'pending';
        if (active) status = 'posted';
        else if (candidates.length > 0) status = 'cancelled';
        return { ...item, status };
      });
    }

    /**
     * @param {string} assetId asset id
     * @returns {Promise<object[]>} later payments newest first
     */
    async payments(assetId) {
      const rows = await this.repo.list('fixedAssetPayments',
        p => p.assetId === assetId && !p.voided);
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return rows;
    }

    _paidThrough(asset, payments) {
      let paid = asset.initialPaidMinor != null
        ? rounded(asset.initialPaidMinor) : rounded(asset.paidMinor);
      for (const payment of payments) paid += rounded(payment.amountMinor);
      return Math.max(0, Math.min(rounded(asset.costMinor), paid));
    }

    /**
     * Pays part/all of the unpaid fixed-asset balance: Dr 2020 / Cr money.
     * @param {string} assetId asset id
     * @param {object} data {amountMinor,date,method,accountId,note}
     * @returns {Promise<object>} payment record
     */
    async pay(assetId, data) {
      data = data || {};
      return this.repo.transaction(async (tx) => {
        const asset = await tx.get('fixedAssets', assetId);
        if (!asset) throw BeeStore.errors.err('NOT_FOUND', 'الأصل الثابت غير موجود');
        if (asset.voided) {
          throw BeeStore.errors.err('VALIDATION', 'الأصل ملغى — لا يمكن السداد عليه');
        }
        const date = data.date || BeeStore.dates.today();
        await BeeStore.periods.assertOpen(tx, date);
        await BeeStore.periods.assertDayOpen(tx, date);
        const payments = await tx.list('fixedAssetPayments',
          p => p.assetId === assetId && !p.voided);
        const paid = this._paidThrough(asset, payments);
        const outstanding = Math.max(0, rounded(asset.costMinor) - paid);
        const amount = BeeStore.money.roundMinor(data.amountMinor);
        if (amount <= 0) {
          throw BeeStore.errors.err('VALIDATION', 'مبلغ الدفعة يجب أن يكون أكبر من صفر');
        }
        if (amount > outstanding) {
          throw BeeStore.errors.err('VALIDATION',
            'مبلغ الدفعة أكبر من المتبقي على الأصل (' +
            BeeStore.money.toMajor(outstanding) + ')');
        }
        const settings = (await tx.get('meta', 'settings')) || {};
        const method = data.method || 'cash';
        const accountId = data.accountId ||
          BeeStore.settings.resolvePaymentAccount(settings, method);
        const now = BeeStore.dates.now();
        const payment = {
          id: BeeStore.ids.randomId('fap'),
          assetId,
          assetName: asset.name,
          date,
          amountMinor: amount,
          method,
          methodKind: data.methodKind ||
            BeeStore.settings.methodKind(settings, method),
          accountId,
          note: data.note || '',
          voided: false,
          journalEntryIds: [],
          createdAt: now,
          updatedAt: now,
        };
        tx.put('fixedAssetPayments', payment);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.fixedAssetPayment(tx, payment);
          if (entry) {
            BeeStore.posting.link(payment, entry);
            tx.put('fixedAssetPayments', payment);
          }
        }
        const updated = {
          ...asset,
          paidMinor: paid + amount,
          updatedAt: now,
        };
        tx.put('fixedAssets', updated);
        return payment;
      });
    }

    /**
     * Voids a later fixed-asset payment and posts its reversing entry on the
     * original date. The asset returns to its previous outstanding balance.
     * @param {string} paymentId payment id
     * @param {string} [reason] void reason
     * @returns {Promise<object>} voided payment record
     */
    async voidPayment(paymentId, reason) {
      return this.repo.transaction(async (tx) => {
        const payment = await tx.get('fixedAssetPayments', paymentId);
        if (!payment) throw BeeStore.errors.err('NOT_FOUND', 'دفعة الأصل غير موجودة');
        if (payment.voided) throw BeeStore.errors.err('ALREADY_VOID', 'الدفعة ملغاة مسبقاً');
        await BeeStore.periods.assertOpen(tx, payment.date);
        const reversals = await BeeStore.posting.reverseDocument(tx,
          'FIXED_ASSET_PAYMENT', paymentId,
          { description: 'إلغاء دفعة أصل ثابت: ' + (payment.assetName || '') },
          { allowClosedDay: true });
        if (reversals.length > 0) BeeStore.posting.linkAll([payment], reversals);
        payment.voided = true;
        payment.voidReason = String(reason || '');
        payment.updatedAt = BeeStore.dates.now();
        tx.put('fixedAssetPayments', payment);
        const asset = await tx.get('fixedAssets', payment.assetId);
        if (asset) {
          const updated = {
            ...asset,
            paidMinor: Math.max(0, rounded(asset.paidMinor) - rounded(payment.amountMinor)),
            updatedAt: BeeStore.dates.now(),
          };
          tx.put('fixedAssets', updated);
        }
        return payment;
      });
    }

    /**
     * Disposes an asset: reverses only future scheduled depreciation, then
     * removes cost and accumulated depreciation and recognises gain/loss.
     * @param {string} assetId asset id
     * @param {object} data {date,proceedsMinor,method,accountId,note}
     * @returns {Promise<object>} updated asset
     */
    async dispose(assetId, data) {
      data = data || {};
      return this.repo.transaction(async (tx) => {
        const asset = await tx.get('fixedAssets', assetId);
        if (!asset) throw BeeStore.errors.err('NOT_FOUND', 'الأصل الثابت غير موجود');
        if (asset.voided) {
          throw BeeStore.errors.err('VALIDATION', 'الأصل ملغى — لا يمكن بيعه');
        }
        if (asset.status === 'disposed') {
          throw BeeStore.errors.err('ALREADY_DISPOSED', 'الأصل مباع مسبقاً');
        }
        const disposalDate = data.date || BeeStore.dates.today();
        if (!asset.purchaseDate || disposalDate < asset.purchaseDate) {
          throw BeeStore.errors.err('VALIDATION',
            'تاريخ البيع لا يمكن أن يسبق تاريخ شراء الأصل');
        }
        await BeeStore.periods.assertOpen(tx, disposalDate);
        await BeeStore.periods.assertDayOpen(tx, disposalDate);
        const proceedsMinor = Math.max(0, BeeStore.money.roundMinor(data.proceedsMinor));
        const method = data.method || 'cash';
        const settings = (await tx.get('meta', 'settings')) || {};
        const methodKind = data.methodKind ||
          BeeStore.settings.methodKind(settings, method);
        const accountId = data.accountId ||
          BeeStore.settings.resolvePaymentAccount(settings, method);
        if (proceedsMinor > 0 && !accountId) {
          throw BeeStore.errors.err('VALIDATION',
            'حدّد حساب استلام ثمن بيع الأصل');
        }
        const plan = BeeStore.posting
          ? BeeStore.posting.fixedAssetDepreciationPlan(asset)
          : [];
        let accumulated = 0;
        for (const item of plan) {
          if (item.date <= disposalDate) accumulated += item.amountMinor;
        }
        const book = rounded(asset.costMinor) - accumulated;
        const updated = {
          ...asset,
          status: 'disposed',
          disposalDate,
          proceedsMinor,
          disposalMethod: method,
          disposalMethodKind: methodKind,
          disposalAccountId: accountId,
          accumulatedAtDisposalMinor: accumulated,
          bookValueAtDisposalMinor: book,
          gainLossMinor: proceedsMinor - book,
          note: data.note || asset.note || '',
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('fixedAssets', updated);
        if (BeeStore.posting) {
          const entry = await BeeStore.posting.fixedAssetDisposal(tx, updated);
          if (entry) BeeStore.posting.link(updated, entry);
          const all = await BeeStore.journal._forSourceTx(tx, 'FIXED_ASSET', assetId);
          BeeStore.posting.linkAll([updated], all);
          tx.put('fixedAssets', updated);
        }
        return updated;
      });
    }

    /**
     * Balance-sheet contribution of the register as of a date: cost of assets
     * still held, accumulated depreciation, and net book value.
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<{costMinor:number,accumulatedMinor:number,netMinor:number,rows:object[]}>}
     */
    async registerAsOf(asOf) {
      const assets = await this.repo.list('fixedAssets', a => !a.voided);
      const rows = [];
      let costMinor = 0;
      let accumulatedMinor = 0;
      for (const asset of assets) {
        if (!asset.purchaseDate || asset.purchaseDate > asOf) continue;
        if (asset.status === 'disposed' && asset.disposalDate &&
          asset.disposalDate <= asOf) continue;
        const plan = BeeStore.posting
          ? BeeStore.posting.fixedAssetDepreciationPlan(asset) : [];
        const cutoff = asset.status === 'disposed' && asset.disposalDate &&
          asset.disposalDate < asOf ? asset.disposalDate : asOf;
        let accumulated = 0;
        for (const item of plan) {
          if (item.date <= cutoff) accumulated += item.amountMinor;
        }
        costMinor += rounded(asset.costMinor);
        accumulatedMinor += accumulated;
        rows.push({
          id: asset.id, name: asset.name, costMinor: rounded(asset.costMinor),
          accumulatedMinor: accumulated,
          netMinor: rounded(asset.costMinor) - accumulated,
        });
      }
      return {
        costMinor,
        accumulatedMinor,
        netMinor: costMinor - accumulatedMinor,
        rows,
      };
    }

    /**
     * Outstanding fixed-asset liability as of a date (unpaid purchase cost).
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<number>} minor units still owed
     */
    async unpaidAsOf(asOf) {
      const assets = await this.repo.list('fixedAssets',
        a => !a.voided && a.purchaseDate && a.purchaseDate <= asOf);
      const payments = await this.repo.list('fixedAssetPayments',
        p => !p.voided && p.date <= asOf);
      const byAsset = new Map();
      for (const payment of payments) {
        byAsset.set(payment.assetId,
          (byAsset.get(payment.assetId) || 0) + rounded(payment.amountMinor));
      }
      let total = 0;
      for (const asset of assets) {
        const paid = (asset.initialPaidMinor != null
          ? rounded(asset.initialPaidMinor) : rounded(asset.paidMinor)) +
          (byAsset.get(asset.id) || 0);
        total += Math.max(0, rounded(asset.costMinor) - paid);
      }
      return total;
    }

    /**
     * Depreciation and disposal gain/loss within a period, used by the
     * document-side P&L when the materialized summary is not applicable.
     * @param {string} from YYYY-MM-DD
     * @param {string} to YYYY-MM-DD
     * @returns {Promise<{depreciationMinor:number,gainMinor:number,lossMinor:number}>}
     */
    async periodAmounts(from, to) {
      const assets = await this.repo.list('fixedAssets', a => !a.voided);
      let depreciationMinor = 0;
      let gainMinor = 0;
      let lossMinor = 0;
      for (const asset of assets) {
        const plan = BeeStore.posting
          ? BeeStore.posting.fixedAssetDepreciationPlan(asset) : [];
        for (const item of plan) {
          if (item.date < from || item.date > to) continue;
          if (asset.status === 'disposed' && asset.disposalDate &&
            item.date > asset.disposalDate) continue;
          depreciationMinor += item.amountMinor;
        }
        if (asset.status === 'disposed' && asset.disposalDate &&
          asset.disposalDate >= from && asset.disposalDate <= to) {
          const gainLoss = rounded(asset.gainLossMinor);
          if (gainLoss >= 0) gainMinor += gainLoss;
          else lossMinor += -gainLoss;
        }
      }
      return { depreciationMinor, gainMinor, lossMinor };
    }

    /**
     * Human-readable register rows for reports.
     * @param {string} asOf YYYY-MM-DD
     * @returns {Promise<object[]>} rows
     */
    async reportRows(asOf) {
      return (await this.registerAsOf(asOf)).rows;
    }
  }

  BeeStore.fixedAssets = new FixedAssetsService(null);
  BeeStore.FixedAssetsService = FixedAssetsService;
  if (typeof module !== 'undefined') module.exports = FixedAssetsService;
})(typeof window !== 'undefined' ? window : globalThis);
