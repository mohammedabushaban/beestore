(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class BackupService {
    constructor(repo, fileSync) {
      this.repo = repo;
      this.fileSync = fileSync;
    }

    /** Creates a file-sync backup now (null without fileSync).
     * @returns {Promise<Object|null>} backup handle or null
     */
    async createNow() {
      if (this.fileSync) {
        return this.fileSync.createBackup();
      }
      return null;
    }

    /** Lists available file-sync backups (empty without fileSync).
     * @returns {Promise<Array>} backup handles
     */
    async list() {
      if (this.fileSync) {
        return this.fileSync.listBackups();
      }
      return [];
    }

    /** Exports all data and triggers a browser JSON download.
     * @returns {Promise<boolean>} true when triggered
     */
    async download() {
      const data = await this.repo.exportAll();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'beestore-backup-' + BeeStore.dates.today() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }

    /** Validates, migrates, then imports a backup payload.
     * @param {Object} data backup with collections
     * @returns {Promise<boolean>} true on success
     * @throws {BeeError} INVALID_DATA on bad file
     */
    async restore(data) {
      if (!data || !data.collections) {
        throw BeeStore.errors.err('INVALID_DATA', 'ملف غير صالح');
      }
      const migrated = await BeeStore.migrations.migrate(data, BeeStore.schemaVersion);
      await this.repo.importAll(migrated);
      return true;
    }

    /** Restores a named file-sync backup.
     * @param {string} name backup name
     * @returns {Promise<Object|null>} restored data or null
     * @throws {BeeError} NOT_FOUND if backup missing
     */
    async restoreFromFile(name) {
      if (!this.fileSync) return null;
      const data = await this.fileSync.restoreBackup(name);
      if (!data) throw BeeStore.errors.err('NOT_FOUND', 'النسخة الاحتياطية غير موجودة');
      await this.restore(data);
      return data;
    }
  }

  BeeStore.backup = new BackupService(null, null);
  BeeStore.BackupService = BackupService;
  if (typeof module !== 'undefined') module.exports = BackupService;
})(typeof window !== 'undefined' ? window : globalThis);
