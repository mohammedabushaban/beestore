(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class BeeError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.message = message;
    }
  }

  function err(code, message) { return new BeeError(code, message); }

  BeeStore.errors = { BeeError, err };
  if (typeof module !== 'undefined') module.exports = BeeStore.errors;
})(typeof window !== 'undefined' ? window : globalThis);
