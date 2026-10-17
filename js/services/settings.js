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
    invoicePrefix: 'INV',
    purchasePrefix: 'PUR',
    returnPrefix: 'RET',
    invoiceFooter: 'شكراً لتسوقكم معنا',
    invoicePaperSize: 'A4',
    labelSize: '50x30',
    defaultLowStockThreshold: 3,
    allowNegativeStock: false,
    paymentMethods: [
      { id: 'cash', name: 'نقداً', accountId: null },
      { id: 'card', name: 'بطاقة', accountId: null },
      { id: 'bank', name: 'تحويل بنكي', accountId: null },
      { id: 'wallet', name: 'محفظة إلكترونية', accountId: null },
      { id: 'jawwal', name: 'جوال باي', accountId: null },
      { id: 'palpay', name: 'بال باي', accountId: null },
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
    lastBackupAt: null,
    lastFileSaveAt: null,
    dataFolderName: null,
    // v2 §2: first business date; no document may precede it.
    systemStartDate: null,
    // v2 §2: reject future-dated documents by default.
    blockFutureDates: true,
  };

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
      return this.repo.transaction(async (tx) => {
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
        settings.paymentMethods = methods;
        settings.id = 'settings';
        tx.put('meta', settings);
        return settings;
      });
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
