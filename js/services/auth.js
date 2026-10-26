(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Local profiles and app lock (v3-Lite §7).
   *
   * The PIN is never stored in plain text: only a random salt and a PBKDF2
   * hash are written to settings. This has no server and no remote wipe; the
   * honest limitation is documented in README/CHECKLIST: a technical person
   * with developer tools can bypass any local UI check. Enforcement still
   * lives in the facade so casual access never sees cost/profit or owner
   * operations.
   */

  const PBKDF2_ITERATIONS = 210000;
  const HASH_BITS = 256;
  const SALT_BYTES = 16;
  const PIN_RE = /^\d{4,6}$/;
  const LOCKOUT_SECONDS = 30;
  const LOCKOUT_MAX_SECONDS = 15 * 60;

  const COST_PROFIT_KEYS = new Set([
    'cost', 'costminor', 'defaultcostminor', 'unitcostminor', 'avgcostafterminor',
    'lastcostminor', 'profit', 'profitminor', 'grossprofit', 'netprofit',
    'potentialprofit', 'margin', 'cogs', 'inventorycost', 'totalcostminor',
    'costvalue', 'purchasecostminor',
  ]);

  function _crypto() {
    return root.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
  }

  function _toBase64(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(arr).toString('base64');
  }

  function _fromBase64(text) {
    if (typeof atob === 'function') {
      const binary = atob(text);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(text, 'base64'));
  }

  function _randomSalt() {
    const c = _crypto();
    if (!c || !c.getRandomValues) throw BeeStore.errors.err('CRYPTO_UNAVAILABLE', 'تعذّر توليد ملح آمن في هذا المتصفح');
    const salt = new Uint8Array(SALT_BYTES);
    c.getRandomValues(salt);
    return salt;
  }

  async function derivePinHash(pin, saltBytes, iterations, cryptoImpl) {
    const c = cryptoImpl || _crypto();
    if (!c || !c.subtle) throw BeeStore.errors.err('CRYPTO_UNAVAILABLE', 'التشفير غير متاح — افتح التطبيق عبر https أو localhost');
    const key = await c.subtle.importKey(
      'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await c.subtle.deriveBits({
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: iterations || PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    }, key, HASH_BITS);
    return _toBase64(new Uint8Array(bits));
  }

  async function hashPin(pin, options) {
    const opts = options || {};
    if (!PIN_RE.test(String(pin || ''))) {
      throw BeeStore.errors.err('VALIDATION', 'الرقم السري يجب أن يكون من 4 إلى 6 أرقام');
    }
    const saltBytes = opts.salt ? _fromBase64(opts.salt) : _randomSalt();
    const iterations = opts.iterations || PBKDF2_ITERATIONS;
    const hash = await derivePinHash(pin, saltBytes, iterations, opts.crypto);
    return {
      algorithm: 'PBKDF2-SHA256',
      iterations,
      salt: _toBase64(saltBytes),
      hash,
      createdAt: opts.createdAt || BeeStore.dates.now(),
    };
  }

  async function verifyPin(pin, record, cryptoImpl) {
    if (!record || !record.salt || !record.hash) return false;
    if (!PIN_RE.test(String(pin || ''))) return false;
    const hash = await derivePinHash(pin, _fromBase64(record.salt), record.iterations || PBKDF2_ITERATIONS, cryptoImpl);
    return _constantTimeEqual(hash, record.hash);
  }

  function _constantTimeEqual(a, b) {
    a = String(a || '');
    b = String(b || '');
    let diff = a.length ^ b.length;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
  }

  /** Removes every cost/profit field from a cashier-facing response. */
  function stripSensitive(value) {
    if (Array.isArray(value)) return value.map(stripSensitive);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value)) {
      if (COST_PROFIT_KEYS.has(String(key).toLowerCase())) continue;
      out[key] = stripSensitive(value[key]);
    }
    return out;
  }

  /** Hides PIN hashes/salts even from the owner UI (they are write-only). */
  function sanitizeSettings(settings) {
    const copy = JSON.parse(JSON.stringify(settings || {}));
    const profiles = copy.profiles || {};
    const safe = {};
    for (const id of Object.keys(profiles)) {
      const p = profiles[id] || {};
      safe[id] = {
        id: p.id || id,
        name: p.name || id,
        active: p.active !== false && !!p.pin,
        pinSet: !!p.pin,
        updatedAt: p.updatedAt || null,
      };
    }
    copy.profiles = safe;
    return copy;
  }

  /**
   * The facade's permission table. Cashier methods are an explicit allow-list;
   * anything not listed is owner-only. This is the single place pages rely on.
   */
  const CASHIER_ALLOWED = new Set([
    'settings.get',
    'categories.list',
    'products.list', 'products.get', 'products.getWithVariants', 'products.search',
    'variants.list', 'variants.get', 'variants.search', 'variants.byBarcode',
    'variants.getLowStock',
    'stock.movements',
    'sales.list', 'sales.get', 'sales.getByNumber', 'sales.searchForReturn',
    'sales.create', 'sales.printData',
    'returns.list', 'returns.get', 'returns.create',
    'customers.list', 'customers.get', 'customers.balance', 'customers.statement',
    'customers.receivePayment', 'customers.overdueInstallments',
    'dashboard.get',
    'dailyClosings.status',
  ]);

  const READ_METHODS = new Set([
    'get', 'list', 'search', 'byBarcode', 'getWithVariants', 'printData',
    'preview', 'status', 'report', 'textSummary', 'checklist', 'monthsWithData',
    'getByNumber', 'searchForReturn', 'movements', 'valueAsOf', 'balance',
    'balanceAsOf', 'ledger', 'statement', 'overdueInstallments', 'profitAndLoss',
    'monthReview', 'yearOverview', 'revenue', 'compareMonths', 'salesReport',
    'inventoryValuation', 'receivablesAging', 'payablesAging', 'balanceSnapshot',
    'dailyClosing', 'integrityCheck', 'isDatabaseEmpty', 'daysInMonth',
    'unclosedDays', 'getLowStock', 'categories', 'recurring', 'advances',
    'outstandingAdvances', 'inspect', 'list',
  ]);

  class AuthService {
    constructor(repo) {
      this.repo = repo;
      this._profile = 'owner';
      this._locked = false;
      this._configured = false;
      this._attempts = { owner: 0, cashier: 0 };
      this._lockUntil = { owner: 0, cashier: 0 };
      this._blocks = { owner: 0, cashier: 0 };
      this._clock = null;
      this._lastUnlockedProfile = 'owner';
    }

    /** Loads the stored profiles and decides whether the app starts locked. */
    async init() {
      const settings = await this._settings();
      const profiles = settings.profiles || {};
      const ownerPin = profiles.owner && profiles.owner.pin;
      this._attempts = { owner: 0, cashier: 0 };
      this._lockUntil = { owner: 0, cashier: 0 };
      this._blocks = { owner: 0, cashier: 0 };
      this._clock = null;
      this._configured = !!ownerPin;
      this._locked = this._configured;
      this._profile = this._configured ? null : 'owner';
      this._lastUnlockedProfile = this._profile || 'owner';
      this._profiles = [];
      for (const id of ['owner', 'cashier']) {
        const record = profiles[id];
        if (record && record.pin) {
          this._profiles.push({ id, name: record.name || (id === 'owner' ? 'المالك' : 'الكاشير') });
        }
      }
      return this.state();
    }

    async _settings() {
      if (!BeeStore.settings) return {};
      return BeeStore.settings.get();
    }

    state() {
      return {
        profile: this._profile,
        role: this._profile,
        locked: this._locked,
        configured: this._configured,
        canSwitch: !!(this._profiles && this._profiles.length > 1),
        lastProfile: this._lastUnlockedProfile,
      };
    }

    isLocked() { return this._locked; }
    isCashier() { return this._profile === 'cashier' && !this._locked; }
    isOwner() { return this._profile === 'owner' && !this._locked; }
    profile() { return this._locked ? null : this._profile; }
    profileName() {
      if (this._locked) return null;
      return this._profile === 'cashier' ? 'الكاشير' : 'المالك';
    }

    /** @param {string} action namespace.method @returns {boolean} */
    can(action) {
      if (this._locked) return false;
      if (this._profile === 'owner') return true;
      return CASHIER_ALLOWED.has(action);
    }

    assertCan(action) {
      if (this._locked) {
        throw BeeStore.errors.err('LOCKED', 'التطبيق مقفل — أدخل الرمز السري للمتابعة');
      }
      if (!this.can(action)) {
        throw BeeStore.errors.err('PERMISSION', 'هذه العملية غير متاحة لملف الكاشير');
      }
      return true;
    }

    /** Loads the two profile records (owner + cashier) for the lock screen. */
    async profiles() {
      const settings = await this._settings();
      const p = settings.profiles || {};
      const list = [];
      for (const id of ['owner', 'cashier']) {
        const profile = p[id];
        if (!profile || !profile.pin) continue;
        list.push({ id, name: profile.name || (id === 'owner' ? 'المالك' : 'الكاشير') });
      }
      this._profiles = list;
      return list;
    }

    async _saveProfiles(profiles) {
      const current = await this._settings();
      const merged = {
        ...current,
        profiles: { ...(current.profiles || {}), ...profiles },
      };
      return BeeStore.settings.save(merged);
    }

    /**
     * Verifies a PIN and unlocks a profile. Wrong attempts create a growing
     * in-memory delay (no server, so a reload also resets it — documented).
     * @param {'owner'|'cashier'} profile
     * @param {string} pin
     */
    async unlock(profile, pin) {
      if (profile !== 'owner' && profile !== 'cashier') {
        throw BeeStore.errors.err('VALIDATION', 'ملف مستخدم غير صالح');
      }
      const now = Date.now();
      const waitMs = (this._lockUntil[profile] || 0) - now;
      if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000);
        throw BeeStore.errors.err('LOCKED', 'محاولات كثيرة خاطئة — انتظر ' + seconds + ' ثانية ثم حاول مجدداً');
      }
      const settings = await this._settings();
      const profileData = (settings.profiles || {})[profile];
      if (!profileData || !profileData.pin) {
        throw BeeStore.errors.err('PIN_NOT_SET', profile === 'owner'
          ? 'لم يُضبط رمز المالك بعد — اضبطه من الإعدادات أو معالج البدء'
          : 'ملف الكاشير غير مُفعّل — يفعّله المالك من الإعدادات');
      }
      const ok = await verifyPin(pin, profileData.pin);
      if (!ok) {
        this._attempts[profile] = (this._attempts[profile] || 0) + 1;
        const threshold = Number(settings.lockoutAfter) || 5;
        if (this._attempts[profile] >= threshold) {
          this._blocks[profile] = (this._blocks[profile] || 0) + 1;
          const base = Number(settings.lockoutSeconds) || LOCKOUT_SECONDS;
          const seconds = Math.min(LOCKOUT_MAX_SECONDS, base * Math.pow(2, this._blocks[profile] - 1));
          this._lockUntil[profile] = now + seconds * 1000;
          this._attempts[profile] = 0;
          throw BeeStore.errors.err('LOCKED', 'تم إيقاف المحاولات مؤقتاً — انتظر ' + seconds + ' ثانية');
        }
        throw BeeStore.errors.err('WRONG_PIN', 'الرمز السري غير صحيح');
      }
      this._attempts[profile] = 0;
      this._blocks[profile] = 0;
      this._lockUntil[profile] = 0;
      this._profile = profile;
      this._lastUnlockedProfile = profile;
      this._locked = false;
      if (BeeStore.audit) {
        BeeStore.audit.record('unlock', 'profile', profile, 'فتح التطبيق بملف ' +
          (profile === 'owner' ? 'المالك' : 'الكاشير'));
      }
      return this.state();
    }

    /** Locks immediately (manual button, idle timeout, background > 1 min). */
    lock(reason) {
      if (this._locked) return this.state();
      if (this._configured) {
        this._locked = true;
        if (BeeStore.audit) {
          BeeStore.audit.record('lock', 'profile', this._profile, 'قفل التطبيق' + (reason ? ' - ' + reason : ''));
        }
        this._profile = null;
      }
      return this.state();
    }

    /** Sets/changes a profile PIN. Owner must be unlocked; changing an owner
     * PIN requires the current PIN when one exists. */
    async setPin(profile, pin, options) {
      const opts = options || {};
      if (profile !== 'owner' && profile !== 'cashier') {
        throw BeeStore.errors.err('VALIDATION', 'ملف مستخدم غير صالح');
      }
      if (this._locked) throw BeeStore.errors.err('LOCKED', 'التطبيق مقفل');
      if (this._profile !== 'owner') {
        throw BeeStore.errors.err('PERMISSION', 'إدارة الرموز السرية للمالك فقط');
      }
      const current = await this._settings();
      const profiles = current.profiles || {};
      if (profile === 'owner' && profiles.owner && profiles.owner.pin) {
        if (!opts.currentPin) throw BeeStore.errors.err('VALIDATION', 'أدخل الرمز الحالي لتغييره');
        const ok = await verifyPin(opts.currentPin, profiles.owner.pin);
        if (!ok) throw BeeStore.errors.err('WRONG_PIN', 'الرمز الحالي غير صحيح');
      }
      const pinData = await hashPin(pin);
      const name = opts.name || (profiles[profile] && profiles[profile].name) ||
        (profile === 'owner' ? 'المالك' : 'الكاشير');
      await this._saveProfiles({
        [profile]: {
          id: profile,
          name,
          pin: pinData,
          active: true,
          updatedAt: BeeStore.dates.now(),
        },
      });
      if (profile === 'owner') this._configured = true;
      if (BeeStore.audit) {
        BeeStore.audit.record('pin_set', 'profile', profile, 'ضبط رمز سري لملف ' + name);
      }
      return { profile, name, pinSet: true };
    }

    /** Disables the cashier profile (owner PIN cannot be removed). */
    async removeCashier() {
      if (this._locked) throw BeeStore.errors.err('LOCKED', 'التطبيق مقفل');
      if (this._profile !== 'owner') throw BeeStore.errors.err('PERMISSION', 'للمالك فقط');
      const current = await this._settings();
      const existing = (current.profiles || {}).cashier || {};
      await this._saveProfiles({
        cashier: { id: 'cashier', name: existing.name || 'الكاشير', pin: null, active: false, updatedAt: BeeStore.dates.now() },
      });
      if (BeeStore.audit) {
        BeeStore.audit.record('pin_remove', 'profile', 'cashier', 'تعطيل ملف الكاشير');
      }
      return { profile: 'cashier', pinSet: false };
    }

    /** Updates lock limits (owner only). Values are validated in the facade. */
    async updateSecurity(patch, currentPin) {
      if (this._locked) throw BeeStore.errors.err('LOCKED', 'التطبيق مقفل');
      if (this._profile !== 'owner') throw BeeStore.errors.err('PERMISSION', 'للمالك فقط');
      const current = await this._settings();
      if (current.profiles && current.profiles.owner && current.profiles.owner.pin) {
        if (!currentPin) throw BeeStore.errors.err('VALIDATION', 'أدخل رمز المالك الحالي');
        const ok = await verifyPin(currentPin, current.profiles.owner.pin);
        if (!ok) throw BeeStore.errors.err('WRONG_PIN', 'رمز المالك غير صحيح');
      }
      const allowed = ['autoLockMinutes', 'cashierMaxDiscountPercent', 'cashierMaxReturnMinor', 'lockoutAfter', 'lockoutSeconds', 'largeFont'];
      const safe = {};
      for (const key of allowed) {
        if (patch && patch[key] !== undefined) safe[key] = patch[key];
      }
      const validateInt = (key, min, max) => {
        if (safe[key] === undefined) return;
        const value = Number(safe[key]);
        if (!isFinite(value) || Math.round(value) !== value || value < min || value > max) {
          throw BeeStore.errors.err('VALIDATION',
            'قيمة ' + key + ' يجب أن تكون رقماً صحيحاً بين ' + min + ' و' + max);
        }
        safe[key] = value;
      };
      validateInt('autoLockMinutes', 1, 60);
      validateInt('cashierMaxDiscountPercent', 0, 100);
      validateInt('cashierMaxReturnMinor', 0, 100000000);
      validateInt('lockoutAfter', 3, 10);
      validateInt('lockoutSeconds', 10, 600);
      if (safe.largeFont !== undefined) safe.largeFont = !!safe.largeFont;
      const updated = { ...current, ...safe };
      await BeeStore.settings.save(updated);
      if (BeeStore.audit) {
        BeeStore.audit.record('security_update', 'settings', 'settings', 'تحديث إعدادات الأمان');
      }
      return sanitizeSettings(updated);
    }

    async limits() {
      const settings = await this._settings();
      return {
        autoLockMinutes: Math.max(1, Number(settings.autoLockMinutes) || 5),
        cashierMaxDiscountPercent: Math.max(0, Number(settings.cashierMaxDiscountPercent) || 0),
        cashierMaxReturnMinor: Math.max(0, Number(settings.cashierMaxReturnMinor) || 0),
        lockoutAfter: Math.max(3, Number(settings.lockoutAfter) || 5),
      };
    }

    /** True when the facade must block posting until the clock is confirmed. */
    postingBlocked() {
      return !!(this._clock && this._clock.pending);
    }

    setClockState(state) { this._clock = state; }
  }

  BeeStore.auth = new AuthService(null);
  BeeStore.AuthService = AuthService;
  BeeStore.authUtils = {
    PBKDF2_ITERATIONS, PIN_RE, hashPin, verifyPin, derivePinHash,
    stripSensitive, sanitizeSettings, CASHIER_ALLOWED, READ_METHODS,
    COST_PROFIT_KEYS, _constantTimeEqual,
  };
  if (typeof module !== 'undefined') module.exports = AuthService;
})(typeof window !== 'undefined' ? window : globalThis);
