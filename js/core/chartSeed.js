(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  // v5 §1 rule 9: the posting rules version is stored on every entry so a
  // later change to the rules never rewrites history.
  const POSTING_VERSION = 1;

  const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'contra'];

  // v5 §2. Account 2300 (tax payable) is deliberately absent: VAT is out of
  // scope until the shop registers. Fixed-asset accounts are conditional.
  const SYSTEM_ACCOUNTS = [
    { code: '1010', nameAr: 'الصندوق', type: 'asset', normalSide: 'debit', systemKey: 'cash' },
    { code: '1100', nameAr: 'الذمم المدينة – الزبائن', type: 'asset', normalSide: 'debit', systemKey: 'ar' },
    { code: '1150', nameAr: 'سلف الموظفين', type: 'asset', normalSide: 'debit', systemKey: 'employee_advances' },
    { code: '1200', nameAr: 'المخزون', type: 'asset', normalSide: 'debit', systemKey: 'inventory' },
    { code: '1300', nameAr: 'مصاريف مدفوعة مقدماً', type: 'asset', normalSide: 'debit', systemKey: 'prepaid' },
    { code: '2010', nameAr: 'الذمم الدائنة – الموردون', type: 'liability', normalSide: 'credit', systemKey: 'ap' },
    { code: '2020', nameAr: 'مستحقات ومصاريف غير مدفوعة', type: 'liability', normalSide: 'credit', systemKey: 'accrued_expenses' },
    { code: '2030', nameAr: 'أرصدة الزبائن الدائنة', type: 'liability', normalSide: 'credit', systemKey: 'customer_credits' },
    { code: '2100', nameAr: 'رواتب مستحقة', type: 'liability', normalSide: 'credit', systemKey: 'accrued_salaries' },
    { code: '2110', nameAr: 'استقطاعات الرواتب المستحقة', type: 'liability', normalSide: 'credit', systemKey: 'accrued_withholdings' },
    { code: '2120', nameAr: 'مساهمات صاحب العمل المستحقة', type: 'liability', normalSide: 'credit', systemKey: 'accrued_employer' },
    { code: '2200', nameAr: 'مخصص نهاية الخدمة', type: 'liability', normalSide: 'credit', systemKey: 'end_of_service' },
    { code: '3010', nameAr: 'رأس المال', type: 'equity', normalSide: 'credit', systemKey: 'capital' },
    { code: '3020', nameAr: 'مسحوبات المالك', type: 'equity', normalSide: 'debit', contra: true, systemKey: 'drawings' },
    { code: '3030', nameAr: 'حقوق الملكية الافتتاحية', type: 'equity', normalSide: 'credit', systemKey: 'opening_equity' },
    { code: '4010', nameAr: 'إيرادات المبيعات', type: 'revenue', normalSide: 'credit', systemKey: 'sales_revenue' },
    { code: '4020', nameAr: 'مردودات المبيعات', type: 'revenue', normalSide: 'debit', contra: true, systemKey: 'sales_returns' },
    { code: '4100', nameAr: 'إيرادات أخرى', type: 'revenue', normalSide: 'credit', systemKey: 'other_income' },
    { code: '5010', nameAr: 'تكلفة البضاعة المباعة (COGS)', type: 'expense', normalSide: 'debit', systemKey: 'cogs' },
    { code: '5020', nameAr: 'خسائر/فروقات المخزون', type: 'expense', normalSide: 'debit', systemKey: 'inventory_loss' },
    { code: '5030', nameAr: 'تسوية تكلفة المخزون', type: 'expense', normalSide: 'debit', systemKey: 'inventory_revaluation' },
    { code: '6100', nameAr: 'الرواتب والأجور', type: 'expense', normalSide: 'debit', systemKey: 'salaries' },
    { code: '6110', nameAr: 'تكاليف صاحب العمل على الرواتب', type: 'expense', normalSide: 'debit', systemKey: 'employer_costs' },
    { code: '6120', nameAr: 'مصروف نهاية الخدمة', type: 'expense', normalSide: 'debit', systemKey: 'end_of_service_expense' },
    { code: '6200', nameAr: 'عمولات البطاقات والمحافظ', type: 'expense', normalSide: 'debit', systemKey: 'card_fees' },
    { code: '6400', nameAr: 'عجز الصندوق', type: 'expense', normalSide: 'debit', systemKey: 'cash_shortage' },
    { code: '6410', nameAr: 'ديون معدومة', type: 'expense', normalSide: 'debit', systemKey: 'bad_debts' },
  ];

  const FIXED_ASSET_ACCOUNTS = [
    { code: '1500', nameAr: 'الأصول الثابتة', type: 'asset', normalSide: 'debit', systemKey: 'fixed_assets' },
    { code: '1590', nameAr: 'مجمع الإهلاك', type: 'contra', normalSide: 'credit', systemKey: 'accumulated_depreciation', parentCode: '1500' },
    { code: '4110', nameAr: 'أرباح بيع الأصول', type: 'revenue', normalSide: 'credit', systemKey: 'asset_sale_gain' },
    { code: '6300', nameAr: 'مصروف الإهلاك', type: 'expense', normalSide: 'debit', systemKey: 'depreciation' },
    { code: '6350', nameAr: 'خسائر بيع الأصول', type: 'expense', normalSide: 'debit', systemKey: 'asset_sale_loss' },
  ];

  // v5 §2 seeds 6xxx expense accounts from the v2 categories. Codes use
  // 6010-6099 so they never collide with the reserved payroll/fee accounts.
  const DEFAULT_EXPENSE_ACCOUNTS = [
    { code: '6010', nameAr: 'إيجار' },
    { code: '6020', nameAr: 'كهرباء' },
    { code: '6030', nameAr: 'ماء' },
    { code: '6040', nameAr: 'إنترنت وهاتف' },
    { code: '6050', nameAr: 'مواصلات' },
    { code: '6060', nameAr: 'تسويق وإعلان' },
    { code: '6070', nameAr: 'تغليف وأكياس' },
    { code: '6080', nameAr: 'صيانة' },
    { code: '6090', nameAr: 'ضرائب ورسوم' },
    { code: '6095', nameAr: 'مصاريف أخرى' },
  ];

  const DEFAULT_EXPENSE_NAMES = DEFAULT_EXPENSE_ACCOUNTS.map(a => a.nameAr);

  const CORE_SYSTEM_KEYS = new Set(
    SYSTEM_ACCOUNTS.map(a => a.systemKey).concat(FIXED_ASSET_ACCOUNTS.map(a => a.systemKey))
  );

  function normalSideFor(type, contra) {
    if (contra) {
      if (type === 'asset' || type === 'expense' || type === 'contra') return 'credit';
      return 'debit';
    }
    if (type === 'asset' || type === 'expense') return 'debit';
    if (type === 'liability' || type === 'equity' || type === 'revenue') return 'credit';
    if (type === 'contra') return 'credit';
    return 'debit';
  }

  function formatNumber(value) {
    return 'JE-' + String(value).padStart(6, '0');
  }

  function parseNumber(value) {
    const m = /^JE-(\d{6,})$/.exec(String(value || ''));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  function systemAccounts(fixedAssetsEnabled) {
    return fixedAssetsEnabled ? SYSTEM_ACCOUNTS.concat(FIXED_ASSET_ACCOUNTS) : SYSTEM_ACCOUNTS.slice();
  }

  function nextExpenseCode(usedCodes) {
    const used = new Set(Array.from(usedCodes || []).map(c => Number(c)));
    const inRange = Array.from(used).filter(n => Number.isInteger(n) && n >= 6000 && n <= 6099);
    const start = inRange.length ? Math.max.apply(null, inRange) + 1 : 6010;
    const ranges = [[start, 6099], [6010, start - 1], [6130, 6199], [6210, 6299]];
    for (const range of ranges) {
      for (let code = range[0]; code <= range[1]; code++) {
        if (!used.has(code)) return String(code);
      }
    }
    throw new Error('لا توجد أكواد مصروفات شاغرة في النطاق 6xxx');
  }

  function nextMoneyCode(kind, usedCodes) {
    const used = new Set(Array.from(usedCodes || []).map(c => String(c)));
    const range = kind === 'cash' ? [1010, 1019]
      : kind === 'bank' ? [1020, 1049]
        : [1050, 1099];
    for (let code = range[0]; code <= range[1]; code++) {
      if (!used.has(String(code))) return String(code);
    }
    throw new Error('لا توجد أكواد شاغرة لحسابات النقد/البنك');
  }

  function inferMethodKind(id) {
    if (id === 'cash') return 'cash';
    if (id === 'bank') return 'bank_direct';
    if (id === 'customer_credit') return 'customer_credit';
    return 'clearing';
  }

  /**
   * Pure chart planning: reads plain arrays, never a repository. It returns
   * additions/links that both the migration and ChartOfAccountsService apply.
   * Existing chart records are never overwritten beyond adding a missing link.
   */
  function plan(input) {
    input = input || {};
    const now = input.now || new Date().toISOString();
    const accountsIn = (input.accounts || []).map(a => ({ ...a }));
    const categoriesIn = (input.categories || []).map(c => ({ ...c }));
    const settingsIn = input.settings ? JSON.parse(JSON.stringify(input.settings)) : null;
    const fixedEnabled = input.fixedAssetsEnabled !== undefined
      ? !!input.fixedAssetsEnabled
      : !!(settingsIn && settingsIn.fixedAssetsEnabled);

    const chart = (input.chart || []).map(a => ({ ...a }));
    const additions = [];
    const updateMap = new Map();
    const byId = new Map(chart.map(a => [a.id, a]));
    const usedCodes = new Set(chart.map(a => String(a.code)));

    function find(predicate) {
      return chart.find(predicate) || null;
    }

    function updateAccount(account, patch) {
      if (!account) return;
      const merged = Object.assign({}, updateMap.get(account.id) || {}, patch);
      updateMap.set(account.id, merged);
      Object.assign(account, patch);
    }

    function createAccount(attrs) {
      let code = String(attrs.code || '');
      if (!code || usedCodes.has(code)) {
        code = attrs.type === 'expense'
          ? nextExpenseCode(usedCodes)
          : nextMoneyCode(attrs.moneyKind || 'clearing', usedCodes);
      }
      usedCodes.add(code);
      let id = attrs.id || ('coa_' + code);
      if (byId.has(id)) id = id + '_' + (additions.length + 1);
      const account = {
        id,
        code,
        nameAr: attrs.nameAr,
        type: attrs.type,
        normalSide: attrs.normalSide || normalSideFor(attrs.type, attrs.contra),
        system: !!attrs.system,
        active: true,
        parentCode: attrs.parentCode || null,
        contra: !!attrs.contra,
        createdAt: now,
        updatedAt: now,
      };
      if (attrs.systemKey) account.systemKey = attrs.systemKey;
      if (attrs.legacyAccountId) account.legacyAccountId = attrs.legacyAccountId;
      if (attrs.legacyType) account.legacyType = attrs.legacyType;
      if (attrs.paymentMethodId) account.paymentMethodId = attrs.paymentMethodId;
      if (attrs.expenseCategoryId) account.expenseCategoryId = attrs.expenseCategoryId;
      if (attrs.clearing) account.clearing = true;
      chart.push(account);
      additions.push(account);
      byId.set(id, account);
      return account;
    }

    function ensureSystem(seed) {
      let account = find(a => a.systemKey === seed.systemKey) ||
        find(a => String(a.code) === seed.code);
      if (account) {
        if (!account.systemKey && seed.systemKey) updateAccount(account, { systemKey: seed.systemKey });
        return account;
      }
      return createAccount({ ...seed, system: true });
    }

    function ensureExpenseAccount(name, preferredCode, options) {
      options = options || {};
      let account = null;
      if (options.chartAccountId) account = byId.get(options.chartAccountId) || null;
      if (!account && options.categoryId) {
        account = find(a => a.expenseCategoryId === options.categoryId);
      }
      if (!account) {
        account = find(a => a.type === 'expense' && a.nameAr === name);
      }
      if (account && account.type !== 'expense') account = null;
      if (!account) {
        const code = preferredCode && !usedCodes.has(String(preferredCode))
          ? String(preferredCode)
          : nextExpenseCode(usedCodes);
        account = createAccount({
          code,
          nameAr: name,
          type: 'expense',
          normalSide: 'debit',
          system: false,
          expenseCategoryId: options.categoryId || null,
        });
      } else if (options.categoryId && account.expenseCategoryId !== options.categoryId) {
        updateAccount(account, { expenseCategoryId: options.categoryId });
      }
      return account;
    }

    // 1) Core system chart.
    for (const seed of systemAccounts(fixedEnabled)) ensureSystem(seed);

    // 2) Default v2 expense categories.
    for (const def of DEFAULT_EXPENSE_ACCOUNTS) {
      ensureExpenseAccount(def.nameAr, def.code, {});
    }

    // 3) Existing expense categories become chart accounts.
    const categoryLinks = [];
    for (const cat of categoriesIn) {
      if (!cat.name) continue;
      const account = ensureExpenseAccount(cat.name, null, {
        chartAccountId: cat.chartAccountId,
        categoryId: cat.id,
      });
      if (cat.chartAccountId !== account.id || String(cat.code || '') !== String(account.code)) {
        categoryLinks.push({
          categoryId: cat.id,
          chartAccountId: account.id,
          code: account.code,
        });
      }
    }

    // 4) Existing cash/bank/wallet accounts keep their balances and become
    //    linked detail records. The chart account is the accounting identity.
    const accountLinks = [];
    for (const account of accountsIn) {
      if (account.type !== 'cash' && account.type !== 'bank' && account.type !== 'wallet') continue;
      let chartAccount = account.chartAccountId ? byId.get(account.chartAccountId) : null;
      if (!chartAccount) chartAccount = find(a => a.legacyAccountId === account.id);
      if (!chartAccount && account.type === 'cash') {
        const drawer = find(a => a.systemKey === 'cash');
        if (drawer && !drawer.legacyAccountId) chartAccount = drawer;
      }
      if (!chartAccount) {
        const code = nextMoneyCode(account.type, usedCodes);
        chartAccount = createAccount({
          code,
          nameAr: account.name || 'حساب نقدي',
          type: 'asset',
          normalSide: 'debit',
          system: false,
          moneyKind: account.type,
          legacyAccountId: account.id,
          legacyType: account.type,
        });
      } else if (!chartAccount.legacyAccountId) {
        updateAccount(chartAccount, { legacyAccountId: account.id });
      }
      if (account.chartAccountId !== chartAccount.id) {
        accountLinks.push({ accountId: account.id, chartAccountId: chartAccount.id });
      }
    }

    // 5) Payment methods: cash → drawer, bank → direct bank, everything else
    //    → its own clearing account (v5 §6). The legacy accountId stays intact.
    let settingsPatch = null;
    if (settingsIn && Array.isArray(settingsIn.paymentMethods)) {
      const legacyById = new Map(accountsIn.map(a => [a.id, a]));
      const chartForLegacy = (legacyId) => {
        const legacy = legacyById.get(legacyId);
        if (!legacy) return null;
        if (legacy.chartAccountId && byId.get(legacy.chartAccountId)) return byId.get(legacy.chartAccountId);
        return find(a => a.legacyAccountId === legacyId);
      };
      const drawerLegacy = settingsIn.cashDrawerAccountId;
      const bankLegacy = settingsIn.defaultBankAccountId;
      let drawer = chartForLegacy(drawerLegacy) || find(a => a.systemKey === 'cash');
      let defaultBank = chartForLegacy(bankLegacy);
      if (!defaultBank) defaultBank = find(a => a.legacyType === 'bank');
      const methods = settingsIn.paymentMethods.map((pm) => {
        const kind = pm.kind || inferMethodKind(pm.id);
        let chartAccount = null;
        if (kind === 'cash') {
          chartAccount = drawer;
        } else if (kind === 'bank_direct') {
          chartAccount = chartForLegacy(pm.accountId) || defaultBank;
        } else if (kind === 'customer_credit') {
          chartAccount = find(a => a.systemKey === 'customer_credits');
        } else {
          chartAccount = find(a => a.paymentMethodId === pm.id);
          if (!chartAccount) {
            chartAccount = createAccount({
              code: nextMoneyCode('clearing', usedCodes),
              nameAr: 'تسوية ' + (pm.name || pm.id),
              type: 'asset',
              normalSide: 'debit',
              system: false,
              moneyKind: 'clearing',
              paymentMethodId: pm.id,
              clearing: true,
            });
          }
        }
        return {
          ...pm,
          kind,
          chartAccountId: chartAccount ? chartAccount.id : (pm.chartAccountId || null),
        };
      });
      if (JSON.stringify(methods) !== JSON.stringify(settingsIn.paymentMethods)) {
        settingsPatch = { paymentMethods: methods };
      }
    }

    return {
      chart,
      categories: categoriesIn,
      accounts: additions,
      chartUpdates: Array.from(updateMap, ([id, patch]) => ({ id, patch })),
      accountLinks,
      categoryLinks,
      settingsPatch,
    };
  }

  /**
   * Applies the plan to a backup/export-shaped object (used by migrations).
   * Old records are preserved; only chart/link/counter fields are added.
   */
  function applyToData(data) {
    if (!data) return data;
    if (!data.collections) data.collections = {};
    const C = data.collections;
    if (!Array.isArray(C.chartOfAccounts)) C.chartOfAccounts = [];
    if (!Array.isArray(C.journalEntries)) C.journalEntries = [];
    if (!Array.isArray(C.accounts)) C.accounts = [];
    if (!Array.isArray(C.expenseCategories)) C.expenseCategories = [];

    const metaSettings = (C.meta || []).find(m => m && m.id === 'settings') || null;
    const settings = (metaSettings || data.settings)
      ? { ...(metaSettings || {}), ...(data.settings || {}) }
      : null;

    const result = plan({
      chart: C.chartOfAccounts,
      accounts: C.accounts,
      categories: C.expenseCategories,
      settings,
      fixedAssetsEnabled: settings ? !!settings.fixedAssetsEnabled : false,
      now: new Date().toISOString(),
    });

    C.chartOfAccounts = C.chartOfAccounts.concat(result.accounts);
    const chartById = new Map(C.chartOfAccounts.map(a => [a.id, a]));
    for (const update of result.chartUpdates) {
      const account = chartById.get(update.id);
      if (account) Object.assign(account, update.patch);
    }
    const accountsById = new Map(C.accounts.map(a => [a.id, a]));
    for (const link of result.accountLinks) {
      const account = accountsById.get(link.accountId);
      if (account) account.chartAccountId = link.chartAccountId;
    }
    const categoriesById = new Map(C.expenseCategories.map(c => [c.id, c]));
    for (const link of result.categoryLinks) {
      const category = categoriesById.get(link.categoryId);
      if (category) {
        category.chartAccountId = link.chartAccountId;
        category.code = link.code;
      }
    }

    // Backfill any chart fields missing from an early preview build.
    for (const account of C.chartOfAccounts) {
      if (account.active === undefined) account.active = true;
      if (account.system === undefined) {
        account.system = !!(account.systemKey && CORE_SYSTEM_KEYS.has(account.systemKey));
      }
      if (!account.normalSide) account.normalSide = normalSideFor(account.type, account.contra);
      if (account.contra === undefined) account.contra = false;
    }

    if (result.settingsPatch) {
      if (data.settings) Object.assign(data.settings, result.settingsPatch);
      if (metaSettings) Object.assign(metaSettings, result.settingsPatch);
      if (!data.settings && !metaSettings) data.settings = { id: 'settings', ...result.settingsPatch };
    }

    // Reconcile the JE counter with restored entries. Gaplessness itself is
    // checked by JournalService.verify(); this only prevents duplicate numbers.
    const meta = data.meta || (C.meta || []).find(m => m && m.id === 'meta');
    if (meta) {
      meta.counters = meta.counters || {};
      let max = 0;
      for (const entry of C.journalEntries) {
        const n = parseNumber(entry && entry.number);
        if (n && n > max) max = n;
      }
      const stored = Number(meta.counters.journal) || 0;
      meta.counters.journal = Math.max(stored, max);
    }
    return data;
  }

  BeeStore.chartSeed = {
    POSTING_VERSION,
    ACCOUNT_TYPES,
    SYSTEM_ACCOUNTS,
    FIXED_ASSET_ACCOUNTS,
    DEFAULT_EXPENSE_ACCOUNTS,
    DEFAULT_EXPENSE_NAMES,
    CORE_SYSTEM_KEYS,
    normalSideFor,
    formatNumber,
    parseNumber,
    systemAccounts,
    nextExpenseCode,
    nextMoneyCode,
    inferMethodKind,
    plan,
    applyToData,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.chartSeed;
})(typeof window !== 'undefined' ? window : globalThis);
