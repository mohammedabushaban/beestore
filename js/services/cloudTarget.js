(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * CloudTarget abstraction (v3-Lite §8.2). Backups and accountant packages
   * both deliver files through this interface, so a future direct Drive
   * upload can be added without touching the generators. No Drive upload is
   * implemented here by design.
   */

  class ShareSheetTarget {
    constructor(env) { this.env = env || {}; }

    available() {
      const nav = this.env.navigator || root.navigator;
      return !!(nav && typeof nav.share === 'function');
    }

    /**
     * Opens the OS share sheet. Returns {method:'share'} on success,
     * {method:'cancelled'} if the user closed it, or {method:'unavailable'}
     * when files cannot be shared here (the caller may download instead).
     */
    async deliver(blob, filename, options) {
      const opts = options || {};
      const env = this.env;
      const nav = env.navigator || root.navigator;
      const FileCtor = env.File || root.File;
      if (!this.available() || !FileCtor) return { method: 'unavailable', filename };
      let file;
      try {
        file = new FileCtor([blob], filename, { type: opts.mimeType || blob.type || 'application/octet-stream' });
      } catch (e) {
        return { method: 'unavailable', filename };
      }
      if (typeof nav.canShare === 'function') {
        try {
          if (!nav.canShare({ files: [file] })) return { method: 'unavailable', filename };
        } catch (e) {
          return { method: 'unavailable', filename };
        }
      }
      try {
        await nav.share({
          files: [file],
          title: opts.title || filename,
          text: opts.text || '',
        });
        return { method: 'share', filename };
      } catch (error) {
        if (error && error.name === 'AbortError') return { method: 'cancelled', filename };
        return { method: 'unavailable', filename, error };
      }
    }
  }

  class DownloadTarget {
    constructor(env) { this.env = env || {}; }

    available() { return true; }

    deliver(blob, filename, options) {
      const opts = options || {};
      const backupFile = BeeStore.backupFile;
      if (backupFile && typeof backupFile.downloadBlob === 'function') {
        return backupFile.downloadBlob(blob, filename, this.env);
      }
      const env = this.env;
      const doc = env.document || root.document;
      const urlApi = env.URL || root.URL;
      if (!doc || !urlApi || typeof urlApi.createObjectURL !== 'function') {
        throw new Error('تعذّر تنزيل الملف في هذا المتصفح.');
      }
      const url = urlApi.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => { try { urlApi.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
      return { method: 'download', filename };
    }
  }

  /**
   * Share sheet first, download fallback. This is the same behavior backups
   * already had; the backup service now goes through it too.
   * @param {Blob} blob
   * @param {string} filename
   * @param {object} [options] {mimeType,title,text,env,prefer:'share'|'download'}
   */
  async function shareOrDownload(blob, filename, options) {
    const opts = options || {};
    if (opts.prefer === 'download') {
      return new DownloadTarget(opts.env).deliver(blob, filename, opts);
    }
    const shared = await new ShareSheetTarget(opts.env).deliver(blob, filename, opts);
    if (shared.method === 'share' || shared.method === 'cancelled') return shared;
    return new DownloadTarget(opts.env).deliver(blob, filename, opts);
  }

  BeeStore.cloudTarget = {
    ShareSheetTarget, DownloadTarget, shareOrDownload,
    /** @returns {Array<object>} targets in preference order */
    defaults(options) {
      const opts = options || {};
      return [new ShareSheetTarget(opts.env), new DownloadTarget(opts.env)];
    },
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.cloudTarget;
})(typeof window !== 'undefined' ? window : globalThis);
