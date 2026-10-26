(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class AuditService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Returns a complete audit entry (including the acting profile) so
     * services that write auditLog inside their own transaction use the exact
     * same shape as `log()`.
     * @returns {object} audit entry ready for tx.put('auditLog', entry) */
    build(action, entityType, entityId, summary) {
      const profile = BeeStore.auth && BeeStore.auth.profile
        ? BeeStore.auth.profile() : null;
      const profileName = BeeStore.auth && BeeStore.auth.profileName
        ? BeeStore.auth.profileName() : null;
      return {
        id: BeeStore.ids.randomId('aud'),
        timestamp: BeeStore.dates.now(),
        action,
        entityType,
        entityId,
        summary,
        profile: profile || 'owner',
        profileName: profileName || 'المالك',
      };
    }

    /** Appends an audit entry for an action on an entity.
     * @param {string} action Action name. @param {string} entityType Entity store. @param {string} entityId Entity id. @param {string} summary Human-readable summary.
     * @returns {Promise<void>} Resolves when entry is stored. */
    async log(action, entityType, entityId, summary) {
      return this.repo.transaction(async (tx) => {
        tx.put('auditLog', this.build(action, entityType, entityId, summary));
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
