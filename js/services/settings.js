(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const DEFAULT_SETTINGS = {
    storeName: 'Bee Store',
    storeNameAr: 'بي ستور',
    phone: '',
    address: '',
    logo: null,
    currencyCode: 'ILS',
    currencySymbol: '₪',
    taxEnabled: false,
    taxRate: 0,
    taxIncludedInPrices: true,
    // v5 §7.2: optional payroll components. All are off by default; rates are
    // basis points of the employee's base salary. The accountant confirms the
    // legal rates before enabling any of them.
    payrollComponents: [
      { id: 'withholding', nameAr: 'استقطاعات الموظف (تأمين/ضريبة)', type: 'employee_withholding', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
      { id: 'employer_cost', nameAr: 'مساهمة صاحب العمل', type: 'employer_cost', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
      { id: 'end_of_service', nameAr: 'مخصص نهاية الخدمة', type: 'end_of_service', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
    ],
    // v5 §8: fixed assets are disabled by default. While disabled a large
    // expense shows a capitalization warning instead of silently distorting
    // one month's profit.
    fixedAssetsEnabled: false,
    capitalizationWarnThresholdMinor: 50000,
    invoicePrefix: 'INV',
    purchasePrefix: 'PUR',
    returnPrefix: 'RET',
    invoiceFooter: 'شكراً لتسوقكم معنا',
    invoicePaperSize: 'A4',
    labelSize: '50x30',
    defaultLowStockThreshold: 3,
    allowNegativeStock: false,
    // v5 §6: `kind` decides the money account at posting time. Clearing
    // methods collect on their own asset account until a settlement arrives.
    paymentMethods: [
      { id: 'cash', name: 'نقداً', kind: 'cash', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
      { id: 'card', name: 'بطاقة', kind: 'clearing', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
      { id: 'bank', name: 'تحويل بنكي', kind: 'bank_direct', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
      { id: 'wallet', name: 'محفظة إلكترونية', kind: 'clearing', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
      { id: 'jawwal', name: 'جوال باي', kind: 'clearing', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
      { id: 'palpay', name: 'بال باي', kind: 'clearing', accountId: null, feeBasisPoints: 0, feeFixedMinor: 0, settlementDays: 0 },
    ],
    sizes: ['Newborn', '0-3M', '3-6M', '6-9M', '9-12M', '12-18M', '18-24M', '2Y', '3Y', '4Y', '5Y', '6Y', '7Y', '8Y', '9Y', '10Y', '12Y', '14Y', 'Free size'],
    colors: [
      { name: 'أبيض', hex: '#FFFFFF' },
      { name: 'أسود', hex: '#000000' },
      { name: 'رمادي', hex: '#808080' },
      { name: 'وردي', hex: '#FFC0CB' },
      { name: 'أزرق', hex: '#0000FF' },
      { name: 'أحمر', hex: '#FF0000' },
      { name: 'أصفر', hex: '#FFFF00' },
      { name: 'أخضر', hex: '#008000' },
    ],
    autoBackup: true,
    backupKeep: 30,
    backupReminderDays: 3,
    backupWarnDays: 2,
    backupCriticalDays: 7,
    lastBackupAt: null,
    lastOffDeviceBackupAt: null,
    lastBackupMethod: null,
    lastBackupRevision: null,
    lastFileSaveAt: null,
    dataFolderName: null,
    // v2 §2: first business date; no document may precede it.
    systemStartDate: null,
    // v2 §2: reject future-dated documents by default.
    blockFutureDates: true,
    // v3-Lite §4.1: cash drawer + day-closing preferences.
    cashDrawerAccountId: null,
    defaultBankAccountId: null,
    // The daily count sheet is ordered biggest first. Amounts are major units
    // (the UI converts using money.fromMajor), matching the ILS default.
    cashDenominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.1],
    // v3-Lite §7: local profiles and app lock. Pin records are salted
    // PBKDF2 hashes; the facade strips them from every UI response.
    profiles: {
      owner: { id: 'owner', name: 'المالك', pin: null, active: false },
      cashier: { id: 'cashier', name: 'الكاشير', pin: null, active: false },
    },
    autoLockMinutes: 5,
    lockoutAfter: 5,
    lockoutSeconds: 30,
    cashierMaxDiscountPercent: 10,
    cashierMaxReturnMinor: 5000,
    // v4 R9.2: an invoice-less return is owner-only until this is raised.
    cashierUnlinkedReturnLimitMinor: 0,
    largeFont: false,
  };

  const METHOD_KINDS = ['cash', 'bank_direct', 'clearing', 'customer_credit'];
  const PAYROLL_COMPONENT_TYPES = ['employee_withholding', 'employer_cost',
    'end_of_service', 'earning', 'deduction', 'advance_repayment'];

  function inferKind(id) {
    if (id === 'cash') return 'cash';
    if (id === 'bank') return 'bank_direct';
    if (id === 'customer_credit') return 'customer_credit';
    return 'clearing';
  }

  function normaliseMethod(pm) {
    const method = { ...(pm || {}) };
    method.kind = METHOD_KINDS.indexOf(method.kind) >= 0
      ? method.kind
      : inferKind(method.id);
    method.feeBasisPoints = Math.max(0, Number(method.feeBasisPoints) || 0);
    method.feeFixedMinor = Math.max(0, Math.round(Number(method.feeFixedMinor) || 0));
    method.settlementDays = Math.max(0, Math.floor(Number(method.settlementDays) || 0));
    return method;
  }

  function normaliseComponent(component, index) {
    const comp = { ...(component || {}) };
    if (PAYROLL_COMPONENT_TYPES.indexOf(comp.type) < 0) {
      throw new Error('نوع مكوّن راتب غير معروف: ' + comp.type);
    }
    comp.id = comp.id || ('cmp_' + (index + 1));
    comp.nameAr = String(comp.nameAr || comp.id);
    comp.enabled = comp.enabled === true;
    comp.rateBasisPoints = Math.max(0,
      Math.round(Number(comp.rateBasisPoints) || 0));
    comp.fixedMinor = Math.max(0, Math.round(Number(comp.fixedMinor) || 0));
    comp.accountId = comp.accountId || null;
    return comp;
  }

  class SettingsService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * @returns {Promise<object>} stored settings, or built-in defaults when none saved
     */
    async get() {
      const meta = await this.repo.get('meta', 'settings');
      return meta || DEFAULT_SETTINGS;
    }

    /**
     * Merge-save settings over defaults (one transaction).
     * @param {object} settings partial settings to store
     * @returns {Promise<object>} the merged record
     */
    async save(settings) {
      return this.repo.transaction(async (tx) => {
        const existing = await tx.get('meta', 'settings');
        const updated = { ...DEFAULT_SETTINGS, ...existing, ...settings, id: 'settings' };
        if (Array.isArray(updated.paymentMethods)) {
          updated.paymentMethods = updated.paymentMethods.map(normaliseMethod);
        }
        const components = Array.isArray(updated.payrollComponents)
          ? updated.payrollComponents : DEFAULT_SETTINGS.payrollComponents;
        updated.payrollComponents = components.map(normaliseComponent);
        updated.fixedAssetsEnabled = updated.fixedAssetsEnabled === true;
        updated.capitalizationWarnThresholdMinor = Math.max(0,
          Math.round(Number(updated.capitalizationWarnThresholdMinor) || 0));
        tx.put('meta', updated);
        return updated;
      });
    }

    /**
     * @param {object} patch partial settings
     * @returns {Promise<object>} the merged record
     */
    async update(patch) {
      const current = await this.get();
      return this.save({ ...current, ...patch });
    }

    /**
     * First-run/bootstrap defaults (one transaction): creates cash+bank
     * accounts if missing, sets systemStartDate (v2 §2), one-time-merges
     * newly-shipped payment methods without resurrecting user-deleted ones,
     * and maps each method to an account.
     * @returns {Promise<object>} the ensured settings
     */
    async ensureDefaults() {
      const ensured = await this.repo.transaction(async (tx) => {
        const accounts = await tx.list('accounts');
        let cashAcc = accounts.find(a => a.type === 'cash');
        let bankAcc = accounts.find(a => a.type === 'bank');
        const now = BeeStore.dates.now();
        if (!cashAcc) {
          cashAcc = {
            id: BeeStore.ids.randomId('acc'),
            name: 'الصندوق (نقدي)',
            type: 'cash',
            openingBalanceMinor: 0,
            active: true,
            createdAt: now,
            updatedAt: now,
          };
          tx.put('accounts', cashAcc);
        }
        if (!bankAcc) {
          bankAcc = {
            id: BeeStore.ids.randomId('acc'),
            name: 'البنك',
            type: 'bank',
            openingBalanceMinor: 0,
            active: true,
            createdAt: now,
            updatedAt: now,
          };
          tx.put('accounts', bankAcc);
        }
        const existing = await tx.get('meta', 'settings');
        const settings = { ...DEFAULT_SETTINGS, ...(existing || {}) };
        if (!settings.systemStartDate) {
          settings.systemStartDate = BeeStore.dates.today().slice(0, 7) + '-01';
        }
        const baseMethods = (settings.paymentMethods && settings.paymentMethods.length)
          ? settings.paymentMethods
          : DEFAULT_SETTINGS.paymentMethods;
        const methods = baseMethods.map(pm => ({ ...pm }));
        // One-time: add any newly-shipped default payment methods missing from
        // an existing install (e.g. جوال باي / بال باي) without re-adding ones
        // the user has since removed.
        if (!settings.paymentMethodDefaultsMerged) {
          for (const dm of DEFAULT_SETTINGS.paymentMethods) {
            if (!methods.some(m => m.id === dm.id)) methods.push({ ...dm });
          }
          settings.paymentMethodDefaultsMerged = true;
        }
        for (const pm of methods) {
          if (!pm.accountId) pm.accountId = pm.id === 'cash' ? cashAcc.id : bankAcc.id;
        }
        // v5 §6: every method carries its routing kind and fee metadata. An
        // existing install's methods are upgraded in place; account ids and
        // historical documents are untouched.
        settings.paymentMethods = methods.map(normaliseMethod);
        // v5 §7.2: every install has the three optional components, all off by
        // default. Existing arrays are normalised; user-removed rows are not
        // resurrected because this is not a one-time merge.
        settings.payrollComponents = (Array.isArray(settings.payrollComponents)
          ? settings.payrollComponents : DEFAULT_SETTINGS.payrollComponents)
          .map(normaliseComponent);
        settings.fixedAssetsEnabled = settings.fixedAssetsEnabled === true;
        settings.capitalizationWarnThresholdMinor = Math.max(0,
          Math.round(Number(settings.capitalizationWarnThresholdMinor) || 0));
        // v3-Lite §4: the cash drawer is the account the closing counts. Fall
        // back to the cash account for installs that predate this setting.
        const drawerValid = accounts.some(a => a.id === settings.cashDrawerAccountId);
        if (!drawerValid) settings.cashDrawerAccountId = cashAcc.id;
        const bankValid = accounts.some(a => a.id === settings.defaultBankAccountId);
        if (!bankValid) settings.defaultBankAccountId = bankAcc.id;
        if (!Array.isArray(settings.cashDenominations) || settings.cashDenominations.length === 0) {
          settings.cashDenominations = DEFAULT_SETTINGS.cashDenominations.slice();
        }
        settings.id = 'settings';
        tx.put('meta', settings);
        if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
          await BeeStore.chart.ensureSeededTx(tx);
          return (await tx.get('meta', 'settings')) || settings;
        }
        return settings;
      });
      return ensured;
    }

    /**
     * Resolve the default account id configured for a payment method.
     * @param {object} settings current settings record
     * @param {string} method payment-method id (e.g. 'cash')
     * @returns {string|null} the account id, or null when unset/unknown
     */
    /**
     * Pure lookup: which account a payment method settles into.
     * @param {object} settings settings record (or null)
     * @param {string} method payment method id
     * @returns {string|null} account id or null when unmapped/unknown
     */
    resolvePaymentAccount(settings, method) {
      const methods = (settings && settings.paymentMethods) || [];
      const pm = methods.find(m => m.id === method);
      return pm ? (pm.accountId || null) : null;
    }

    /**
     * Payment-method definition with v5 §6 defaults applied.
     * @param {object} settings settings record (may be null)
     * @param {string} method payment-method id
     * @returns {object|null} normalised method definition
     */
    paymentMethod(settings, method) {
      const methods = (settings && Array.isArray(settings.paymentMethods))
        ? settings.paymentMethods
        : DEFAULT_SETTINGS.paymentMethods;
      const found = methods.find(m => m.id === method);
      return found ? normaliseMethod(found) : null;
    }

    /**
     * v5 §6 routing kind: cash drawer, direct bank, clearing, or credit.
     * Unknown methods fall back to `cash` so legacy behaviour is preserved.
     * @param {object} settings settings record (may be null)
     * @param {string} method payment-method id
     * @returns {string} kind
     */
    methodKind(settings, method) {
      const pm = this.paymentMethod(settings, method);
      return pm ? pm.kind : 'cash';
    }

    /** @returns {boolean} true when receipts wait in a clearing account */
    isClearingMethod(settings, method) {
      return this.methodKind(settings, method) === 'clearing';
    }

    /**
     * Resolves the payment method behind a legacy money account. Used by
     * refunds whose historical shape stores an account id, not a method id.
     * @param {object} settings settings record
     * @param {string} accountId legacy accounts id
     * @returns {object|null} normalised method
     */
    methodForAccount(settings, accountId) {
      if (!accountId) return null;
      const methods = (settings && Array.isArray(settings.paymentMethods))
        ? settings.paymentMethods
        : DEFAULT_SETTINGS.paymentMethods;
      const found = methods.find(m => m.accountId === accountId);
      return found ? normaliseMethod(found) : null;
    }

    /**
     * Expected provider fee for a receipt under a method definition.
     * @param {object} settings settings record
     * @param {string} method payment-method id
     * @param {number} grossMinor receipt amount
     * @returns {{feeMinor:number,basisPoints:number,fixedMinor:number}}
     */
    expectedFee(settings, method, grossMinor) {
      const pm = this.paymentMethod(settings, method);
      const gross = Math.max(0, Math.round(Number(grossMinor) || 0));
      const basisPoints = pm ? pm.feeBasisPoints : 0;
      const fixedMinor = pm ? pm.feeFixedMinor : 0;
      const feeMinor = Math.min(gross,
        Math.round(gross * basisPoints / 10000) + fixedMinor);
      return { feeMinor, basisPoints, fixedMinor };
    }

    /**
     * Normalised v5 §7.2 payroll components for a settings record.
     * @param {object} settings settings record (may be null)
     * @returns {object[]} component definitions (enabled and disabled)
     */
    payrollComponents(settings) {
      const list = (settings && Array.isArray(settings.payrollComponents) && settings.payrollComponents.length)
        ? settings.payrollComponents
        : DEFAULT_SETTINGS.payrollComponents;
      return list.map(normaliseComponent);
    }

    /**
     * Calculates the enabled payroll component amounts for one employee month.
     * Rates are basis points of the base salary and use v5 §3 half-up
     * rounding. `overrides` lets the owner replace a computed amount per
     * component id (e.g. an actual insurance figure from the authority).
     * @param {object} settings settings record
     * @param {number} baseMinor employee base salary in minor units
     * @param {object} [overrides] component id → integer minor amount
     * @returns {{withholdingMinor:number,employerCostMinor:number,endOfServiceMinor:number,components:object[]}}
     */
    payrollComponentTotals(settings, baseMinor, overrides) {
      const base = Math.max(0, Math.round(Number(baseMinor) || 0));
      const chosen = overrides || {};
      const components = [];
      let withholdingMinor = 0;
      let employerCostMinor = 0;
      let endOfServiceMinor = 0;
      for (const component of this.payrollComponents(settings)) {
        if (!component.enabled) continue;
        let amountMinor;
        if (chosen[component.id] !== undefined && chosen[component.id] !== null) {
          amountMinor = Math.max(0, Math.round(Number(chosen[component.id]) || 0));
        } else {
          amountMinor = Math.max(0,
            Math.round(base * component.rateBasisPoints / 10000) +
            component.fixedMinor);
        }
        if (component.type === 'employee_withholding') withholdingMinor += amountMinor;
        else if (component.type === 'employer_cost') employerCostMinor += amountMinor;
        else if (component.type === 'end_of_service') endOfServiceMinor += amountMinor;
        components.push({
          id: component.id,
          nameAr: component.nameAr,
          type: component.type,
          amountMinor,
        });
      }
      return { withholdingMinor, employerCostMinor, endOfServiceMinor, components };
    }

    /**
     * v5 §8 capitalization warning: a large single expense while the fixed
     * asset module is off can distort one month's profit.
     * @param {object} settings settings record
     * @param {number} amountMinor expense amount
     * @returns {boolean} true when the warning must be shown
     */
    capitalizationWarningNeeded(settings, amountMinor) {
      if (settings && settings.fixedAssetsEnabled === true) return false;
      const threshold = Math.max(0,
        Math.round(Number(settings && settings.capitalizationWarnThresholdMinor) || 0));
      return threshold > 0 && Math.round(Number(amountMinor) || 0) >= threshold;
    }

    /**
     * Build `{value,label}` options for payment-method selects.
     * Falls back to the built-in defaults when settings aren't available.
     * @param {object} settings current settings record (may be null)
     * @returns {Array<{value: string, label: string}>} select options
     */
    /**
     * @param {object} settings settings record (or null → built-in defaults)
     * @returns {Array<{value:string,label:string}>} options for method selects
     */
    methodOptions(settings) {
      const methods = (settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length)
        ? settings.paymentMethods
        : DEFAULT_SETTINGS.paymentMethods;
      return methods.map(m => ({ value: m.id, label: m.name }));
    }

    /**
     * Human-readable name for a payment-method id.
     * @param {object} settings current settings record
     * @param {string} id payment-method id
     * @returns {string} the method name, or the raw id when unknown
     */
    /**
     * @param {object} settings settings record (or null)
     * @param {string} id payment method id
     * @returns {string} Arabic label, or the id itself when unknown
     */
    methodLabel(settings, id) {
      const opts = this.methodOptions(settings);
      const found = opts.find(o => o.value === id);
      return found ? found.label : (id || '');
    }
  }

  BeeStore.settings = new SettingsService(null);
  BeeStore.SettingsService = SettingsService;
  if (typeof module !== 'undefined') module.exports = SettingsService;
})(typeof window !== 'undefined' ? window : globalThis);
