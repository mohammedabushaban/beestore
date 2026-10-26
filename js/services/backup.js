(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  function bf() {
    if (!BeeStore.backupFile) {
      throw BeeStore.errors.err('INTERNAL', 'خدمة ملف النسخ الاحتياطي غير محمّلة.');
    }
    return BeeStore.backupFile;
  }

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

    async _fallbackStream() {
      const dump = await this.repo.exportAll();
      const helper = bf();
      return {
        blob: helper.dataBlob(dump),
        schemaVersion: dump.schemaVersion,
        counts: helper.countCollections(dump),
        meta: dump.meta || null,
        settings: dump.settings || null,
      };
    }

    /**
     * Builds a complete, integrity-protected backup. The payload is streamed
     * per collection when the repository supports it; encryption wraps the
     * exact final JSON bytes (AES-GCM, PBKDF2-derived key).
     * @param {Object} [options] {encrypt, passphrase, now, createdAt, crypto}
     * @returns {Promise<{blob: Blob, filename: string, encrypted: boolean, integrity: Object}>}
     */
    async createPayload(options) {
      options = options || {};
      const helper = bf();
      const streamed = (typeof this.repo.exportAllStreamed === 'function')
        ? await this.repo.exportAllStreamed()
        : await this._fallbackStream();
      const createdAt = options.createdAt || new Date().toISOString();
      const withIntegrity = await helper.addIntegrity(streamed.blob, {
        appVersion: BeeStore.version || '',
        createdAt: createdAt,
        schemaVersion: streamed.schemaVersion,
        counts: streamed.counts,
      }, options.crypto);

      let blob = withIntegrity.blob;
      let encrypted = false;
      if (options.encrypt) {
        const bytes = new Uint8Array(await withIntegrity.blob.arrayBuffer());
        const envelope = await helper.encryptBytes(bytes, options.passphrase, options.crypto, {
          createdAt: createdAt,
        });
        blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
        encrypted = true;
      }

      return {
        blob: blob,
        filename: helper.backupFileName(options.now || new Date()),
        encrypted: encrypted,
        integrity: withIntegrity.integrity,
        schemaVersion: streamed.schemaVersion,
      };
    }

    /**
     * Shares the backup through the OS share sheet, falling back to a
     * download when file sharing is unsupported. A cancelled share does not
     * mark the backup as completed.
     * @param {Object} [options] {encrypt, passphrase, now, env}
     * @returns {Promise<Object>} {method, filename, encrypted, warning?}
     */
    async share(options) {
      options = options || {};
      const payload = await this.createPayload(options);
      // v3-Lite §8.2: backups and accountant packages share one CloudTarget
      // delivery path. Older Node suites that load only backupFile keep the
      // direct fallback (which takes the env directly, not an options wrapper).
      const useCloudTarget = !!(BeeStore.cloudTarget && BeeStore.cloudTarget.shareOrDownload);
      const result = useCloudTarget
        ? await BeeStore.cloudTarget.shareOrDownload(payload.blob, payload.filename, {
          env: options.env,
          mimeType: 'application/json',
          title: 'نسخة احتياطية — بي ستور',
          text: 'احفظ هذه النسخة خارج الهاتف (Drive أو واتساب أو بريد إلكتروني).',
        })
        : await bf().shareOrDownload(payload.blob, payload.filename, options.env);
      let warning = null;
      if (result.method === 'share' || result.method === 'download') {
        try {
          await this._markBackup(result.method);
        } catch (error) {
          warning = error && error.message ? error.message : 'تعذّر تحديث تاريخ آخر نسخة احتياطية.';
        }
      }
      return {
        method: result.method,
        filename: payload.filename,
        encrypted: payload.encrypted,
        integrity: payload.integrity,
        warning: warning,
      };
    }

    /**
     * Exports and downloads a backup without opening the share sheet.
     * @param {Object} [options] {encrypt, passphrase, now, env}
     * @returns {Promise<Object>} download result
     */
    async download(options) {
      options = options || {};
      const payload = await this.createPayload(options);
      const result = bf().downloadBlob(payload.blob, payload.filename, options.env);
      let warning = null;
      try {
        await this._markBackup('download');
      } catch (error) {
        warning = error && error.message ? error.message : 'تعذّر تحديث تاريخ آخر نسخة احتياطية.';
      }
      return {
        method: result.method,
        filename: payload.filename,
        encrypted: payload.encrypted,
        integrity: payload.integrity,
        warning: warning,
      };
    }

    /**
     * Inspects a backup without touching current data. Handles encrypted
     * envelopes and verifies the checksum when present.
     * @param {Object|string} data backup or encrypted envelope
     * @param {Object} [options] {passphrase, crypto}
     * @returns {Promise<Object>} {summary, warnings, encrypted, verified}
     */
    async inspect(data, options) {
      options = options || {};
      const opened = await bf().openBackup(data, options.passphrase, options.crypto);
      const currentMeta = await this.repo.get('meta', 'meta') || {};
      const info = bf().inspectBackup(opened.backup, currentMeta, currentMeta.deviceId);
      return {
        summary: info.summary,
        warnings: info.warnings,
        encrypted: opened.encrypted,
        verified: opened.integrity.verified,
        integrity: opened.integrity,
      };
    }

    /**
     * Validates, checks integrity, creates a safety snapshot, migrates, then
     * imports a backup payload.
     * @param {Object|string} data backup or encrypted envelope
     * @param {Object} [options] {passphrase, crypto}
     * @returns {Promise<Object>} restore summary
     * @throws {BeeError} INVALID_DATA / CHECKSUM_MISMATCH / WRONG_PASSPHRASE
     */
    async restore(data, options) {
      options = options || {};
      const opened = await bf().openBackup(data, options.passphrase, options.crypto);
      const backup = opened.backup;
      const currentMeta = await this.repo.get('meta', 'meta') || {};

      // Automatic safety snapshot before replacing the live database. If it
      // cannot be written, abort instead of destroying the only copy.
      if (BeeStore.snapshots && typeof BeeStore.snapshots.create === 'function') {
        const current = await this.repo.exportAll();
        await BeeStore.snapshots.create('pre-restore', current);
      }

      const migrated = await BeeStore.migrations.migrate(backup, BeeStore.schemaVersion);
      // A restored backup from another phone must make THIS phone the primary
      // device, otherwise both phones keep writing under the old deviceId.
      if (migrated.meta && currentMeta.deviceId) {
        migrated.meta.deviceId = currentMeta.deviceId;
      }
      await this.repo.importAll(migrated);
      return {
        restored: true,
        summary: bf().summarizeBackup(migrated),
        verified: opened.integrity.verified,
        encrypted: opened.encrypted,
      };
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

    /** @returns {Promise<Object>} last-backup status for banners/dashboard. */
    async status() {
      const settings = await this.repo.get('meta', 'settings') || {};
      const meta = await this.repo.get('meta', 'meta') || {};
      return bf().backupStatus(settings, meta, Date.now());
    }

    async _markBackup(method) {
      const now = new Date().toISOString();
      const meta = await this.repo.get('meta', 'meta') || {};
      // The settings write itself increments meta.revision once. Record the
      // post-write revision so that this bookkeeping is not mistaken for new
      // business activity in the backup reminder.
      const revisionAfterWrite = Number(meta.revision || 0) + 1;
      const patch = {
        lastBackupAt: now,
        lastBackupMethod: method,
        lastBackupRevision: revisionAfterWrite,
      };
      if (method === 'share') patch.lastOffDeviceBackupAt = now;
      const existing = await this.repo.get('meta', 'settings') || {};
      const updated = Object.assign({}, existing, patch, { id: 'settings' });
      await this.repo.transaction(async (tx) => {
        tx.put('meta', updated);
        return updated;
      });
      return updated;
    }
  }

  BeeStore.backup = new BackupService(null, null);
  BeeStore.BackupService = BackupService;
  if (typeof module !== 'undefined') module.exports = BackupService;
})(typeof window !== 'undefined' ? window : globalThis);
