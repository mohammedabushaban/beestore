(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class AuditService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Appends an audit entry for an action on an entity.
     * @param {string} action Action name. @param {string} entityType Entity store. @param {string} entityId Entity id. @param {string} summary Human-readable summary.
     * @returns {Promise<void>} Resolves when entry is stored. */
    async log(action, entityType, entityId, summary) {
      return this.repo.transaction(async (tx) => {
        tx.put('auditLog', {
          id: BeeStore.ids.randomId('aud'),
          timestamp: BeeStore.dates.now(),
          action,
          entityType,
          entityId,
          summary,
        });
      });
    }

    /** Lists audit entries newest-first, optionally capped.
     * @param {number} [limit] Max entries to return.
     * @returns {Promise<Array>} Audit entries. */
    async list(limit) {
      const all = await this.repo.list('auditLog');
      all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return limit ? all.slice(0, limit) : all;
    }

    record(action, entityType, entityId, summary) {
      if (!this.repo) return;
      try {
        this.log(action, entityType, entityId, summary).catch(() => {});
      } catch (e) { /* audit must never break the main operation */ }
    }
  }

  BeeStore.audit = new AuditService(null);
  BeeStore.AuditService = AuditService;
  if (typeof module !== 'undefined') module.exports = AuditService;
})(typeof window !== 'undefined' ? window : globalThis);
