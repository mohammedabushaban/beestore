(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class FirstRunWizard {
    constructor() {
      this.step = 1;
      this.settings = {};
    }

    show() {
      const overlay = document.getElementById('first-run-wizard');
      if (overlay) overlay.style.display = 'flex';
      this._bindEvents();
    }

    _bindEvents() {
      const nameInput = document.getElementById('wizard-store-name');
      const phoneInput = document.getElementById('wizard-store-phone');
      const addressInput = document.getElementById('wizard-store-address');
      const startDateInput = document.getElementById('wizard-start-date');
      if (startDateInput && !startDateInput.value) {
        startDateInput.value = BeeStore.dates.today().slice(0, 7) + '-01';
      }

      const nextBtn = document.querySelector('#wizard-step-1 .btn-primary');
      if (nextBtn) {
        nextBtn.onclick = async () => {
          this.settings.storeName = nameInput.value.trim() || 'Bee Store';
          this.settings.storeNameAr = nameInput.value.trim() || 'بي ستور';
          this.settings.phone = phoneInput.value.trim();
          this.settings.address = addressInput.value.trim();
          this.settings.systemStartDate = (startDateInput && startDateInput.value) ||
            BeeStore.dates.today().slice(0, 7) + '-01';
          await BeeStore.settings.save(this.settings);
          this._showStep(2);
        };
      }

      const pickBtn = document.querySelector('#wizard-step-2 .btn-primary');
      if (pickBtn) {
        pickBtn.onclick = async () => {
          const ok = await BeeStore.fileSync.pickFolder();
          if (ok) this._showStep(3);
        };
      }

      const skipBtn = document.querySelector('#wizard-step-2 .btn-secondary');
      if (skipBtn) {
        skipBtn.onclick = () => this._showStep(3);
      }

      const demoBtn = document.getElementById('wizard-demo');
      if (demoBtn) {
        demoBtn.onclick = async () => {
          await BeeStore.loadDemoData();
          this._showStep(4);
        };
      }

      const restoreBtn = document.getElementById('wizard-restore');
      if (restoreBtn) {
        restoreBtn.onclick = function () {
          if (BeeStore.backupUI) {
            BeeStore.backupUI.restoreFromFile({ reload: true });
          } else {
            BeeStore.ui.toast('خدمة الاستعادة غير متاحة', 'error');
          }
        };
      }

      const emptyBtn = document.getElementById('wizard-empty');
      if (emptyBtn) {
        emptyBtn.onclick = () => this._showStep(4);
      }

      const startBtn = document.getElementById('wizard-start');
      if (startBtn) {
        startBtn.onclick = () => this.finish();
      }
    }

    _showStep(step) {
      // The JSON folder mirror is desktop-only. On a phone (no File System
      // Access API) skip step 2 instead of showing a dead button.
      if (step === 2 && (!BeeStore.fileSync || !BeeStore.fileSync.isSupported())) {
        step = 3;
      }
      this.step = step;
      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('wizard-step-' + i);
        if (el) el.style.display = i === step ? 'block' : 'none';
      }
      if (step === 4) {
        const pin = document.getElementById('wizard-owner-pin');
        if (pin) setTimeout(() => pin.focus(), 80);
      }
    }

    async finish() {
      const ownerPin = (document.getElementById('wizard-owner-pin') || {}).value || '';
      const ownerConfirm = (document.getElementById('wizard-owner-pin-confirm') || {}).value || '';
      const cashierPin = (document.getElementById('wizard-cashier-pin') || {}).value || '';
      if (!/^\d{4,6}$/.test(ownerPin)) {
        BeeStore.ui.toast('اضبط رمزاً سرياً للمالك من 4 إلى 6 أرقام', 'error');
        return;
      }
      if (ownerPin !== ownerConfirm) {
        BeeStore.ui.toast('تأكيد رمز المالك لا يطابق الرمز', 'error');
        return;
      }
      if (cashierPin && !/^\d{4,6}$/.test(cashierPin)) {
        BeeStore.ui.toast('رمز الكاشير يجب أن يكون من 4 إلى 6 أرقام أو فارغاً', 'error');
        return;
      }
      if (BeeStore.settings && BeeStore.settings.ensureDefaults) {
        await BeeStore.settings.ensureDefaults();
      }
      try {
        await BeeStore.auth.setPin('owner', ownerPin);
        if (cashierPin) await BeeStore.auth.setPin('cashier', cashierPin);
      } catch (e) {
        BeeStore.ui.toast(e.message || 'تعذّر حفظ الرمز السري', 'error');
        return;
      }
      const overlay = document.getElementById('first-run-wizard');
      if (overlay) overlay.style.display = 'none';
      document.getElementById('app').style.display = 'block';
      // The wizard has just created the PIN: unlock directly instead of asking
      // the owner to type the PIN they entered a second ago.
      await BeeStore.auth.init();
      const unlocked = await BeeStore.auth.unlock('owner', ownerPin);
      if (!unlocked) {
        BeeStore.appLock.show();
        return;
      }
      BeeStore.settingsCache = await BeeStore.settings.get();
      if (BeeStore.appLock && BeeStore.appLock.applyPreferences) {
        BeeStore.appLock.applyPreferences(BeeStore.settingsCache);
      }
      BeeStore.appLock.bind({ onUnlocked: BeeStore._startApp });
      await BeeStore.appLock.start();
    }
  }

  BeeStore.FirstRunWizard = FirstRunWizard;
  if (typeof module !== 'undefined') module.exports = FirstRunWizard;
})(typeof window !== 'undefined' ? window : globalThis);
