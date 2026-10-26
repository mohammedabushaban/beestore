(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * v3-Lite §11 clock anomaly guard.
   *
   * The phone clock is the only time source. A clock set backwards would
   * mis-date new documents; a clock set far forward would create documents
   * outside the shop's real period. Both are detected at startup and require
   * an explicit owner confirmation before any posting. The check is repeated
   * by the facade for every write, so hiding the warning cannot bypass it.
   */
  class ClockGuardService {
    constructor(repo) {
      this.repo = repo;
      this._state = { pending: false };
      this.forwardMaxDays = 30;
    }

    async _meta() {
      return (await this.repo.get('meta', 'meta')) || {};
    }

    _dayOf(timestamp) {
      return timestamp ? String(timestamp).slice(0, 10) : null;
    }

    /**
     * @returns {Promise<{pending:boolean,reasons:string[],today:string,lastSeenDate:string|null,latestActivityDate:string|null,backwardDays:number,forwardDays:number}>}
     */
    async check() {
      const now = BeeStore.dates.now();
      const today = BeeStore.dates.today();
      const meta = await this._meta();
      const clock = meta.clock || {};
      const latestActivity = meta.updatedAt || meta.savedAt || null;
      const latestActivityDate = this._dayOf(latestActivity);
      const lastSeenDate = clock.lastSeenDate || null;
      const reasons = [];
      let backwardDays = 0;
      let forwardDays = 0;

      if (latestActivityDate) {
        const diff = BeeStore.dates.diffDays(latestActivityDate, today);
        // More than one day behind the latest committed document is a clock
        // rollback, not ordinary timezone/midnight rounding.
        if (diff < -1) {
          backwardDays = Math.abs(diff);
          reasons.push('تاريخ الهاتف اليوم (' + today + ') أقدم من آخر عملية محفوظة (' +
            latestActivityDate + ') بـ ' + backwardDays + ' يوم. قد تؤدي إضافة فاتورة الآن إلى تاريخ خاطئ.');
        }
      }
      if (lastSeenDate) {
        const step = BeeStore.dates.diffDays(lastSeenDate, today);
        if (step < -1) {
          if (backwardDays === 0) {
            reasons.push('تاريخ الهاتف رجع للخلف: آخر فتح كان بتاريخ ' + lastSeenDate +
              ' واليوم ' + today + '.');
          }
        } else if (step > this.forwardMaxDays) {
          forwardDays = step;
          reasons.push('قفزة كبيرة في تاريخ الهاتف إلى الأمام (' + step + ' يوم منذ آخر فتح في ' +
            lastSeenDate + '). تأكد أن التاريخ والوقت صحيحان قبل التسجيل.');
        }
      } else if (!latestActivityDate) {
        // First start: nothing to compare against, so no warning.
      }

      const pending = reasons.length > 0 && clock.confirmedDate !== today;
      this._state = {
        pending,
        confirmed: reasons.length > 0 && clock.confirmedDate === today,
        reasons,
        today,
        now,
        lastSeenDate,
        latestActivityDate,
        backwardDays,
        forwardDays,
        checkedAt: now,
      };
      return this._state;
    }

    /** Records a normal day's visit (no anomaly). */
    async touch() {
      const state = this._state.pending ? this._state : await this.check();
      if (state.pending) return state;
      const today = BeeStore.dates.today();
      const meta = await this._meta();
      const clock = meta.clock || {};
      if (clock.lastSeenDate === today) return state;
      clock.lastSeenDate = today;
      clock.lastSeenAt = BeeStore.dates.now();
      meta.clock = clock;
      await this.repo.transaction(async (tx) => { tx.put('meta', meta); });
      return state;
    }

    /** Owner confirms the phone clock; posting is allowed for today only. */
    async confirm() {
      const today = BeeStore.dates.today();
      const meta = await this._meta();
      meta.clock = {
        ...(meta.clock || {}),
        lastSeenDate: today,
        lastSeenAt: BeeStore.dates.now(),
        confirmedDate: today,
        confirmedAt: BeeStore.dates.now(),
      };
      await this.repo.transaction(async (tx) => { tx.put('meta', meta); });
      this._state = {
        pending: false,
        confirmed: true,
        reasons: [],
        today,
        now: BeeStore.dates.now(),
        lastSeenDate: today,
        latestActivityDate: this._dayOf(meta.updatedAt || meta.savedAt),
        backwardDays: 0,
        forwardDays: 0,
      };
      if (BeeStore.audit) {
        BeeStore.audit.record('clock_confirm', 'meta', 'clock',
          'تأكيد تاريخ الهاتف ' + today + ' بعد تحذير اختلاف الساعة');
      }
      return this._state;
    }
  }

  BeeStore.clockGuard = new ClockGuardService(null);
  BeeStore.ClockGuardService = ClockGuardService;
  if (typeof module !== 'undefined') module.exports = ClockGuardService;
})(typeof window !== 'undefined' ? window : globalThis);
