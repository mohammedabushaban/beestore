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

      const demoBtn = document.querySelector('#wizard-step-3 .btn-primary');
      if (demoBtn) {
        demoBtn.onclick = async () => {
          await BeeStore.loadDemoData();
          this.finish();
        };
      }

      const emptyBtn = document.querySelector('#wizard-step-3 .btn-secondary');
      if (emptyBtn) {
        emptyBtn.onclick = () => this.finish();
      }
    }

    _showStep(step) {
      this.step = step;
      for (let i = 1; i <= 3; i++) {
        const el = document.getElementById('wizard-step-' + i);
        if (el) el.style.display = i === step ? 'block' : 'none';
      }
    }

    async finish() {
      const overlay = document.getElementById('first-run-wizard');
      if (overlay) overlay.style.display = 'none';
      document.getElementById('app').style.display = 'block';
      if (BeeStore.settings && BeeStore.settings.ensureDefaults) {
        await BeeStore.settings.ensureDefaults();
      }
      if (BeeStore._setupRouter) BeeStore._setupRouter();
      if (BeeStore._setupSaveStatus) BeeStore._setupSaveStatus();
      if (BeeStore._setupVisibilityHandlers) BeeStore._setupVisibilityHandlers();
      if (BeeStore.router) BeeStore.router.start();
    }
  }

  BeeStore.FirstRunWizard = FirstRunWizard;
  if (typeof module !== 'undefined') module.exports = FirstRunWizard;
})(typeof window !== 'undefined' ? window : globalThis);
