(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class FileSync {
    constructor(repo) {
      this.repo = repo;
      this.dirHandle = null;
      this.status = 'unavailable';
      this.lastSavedAt = null;
      this.lastError = null;
      this.onStatusChange = null;
      this._debounceTimer = null;
      this._pending = false;
      this._handleDbPromise = null;
    }

    isSupported() {
      return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    }

    _setStatus(status) {
      if (this.status !== status) {
        this.status = status;
        if (typeof this.onStatusChange === 'function') this.onStatusChange(this.getStatus());
      } else {
        this.status = status;
      }
    }

    _openHandleDb() {
      if (!(typeof indexedDB !== 'undefined')) return Promise.reject(new Error('IndexedDB unavailable'));
      if (this._handleDbPromise) return this._handleDbPromise;
      const name = BeeStore.config.handlesDbName || 'beestore-handles';
      this._handleDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this._handleDbPromise;
    }

    async _saveHandle(handle) {
      try {
        const db = await this._openHandleDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: BeeStore.config.storageKey, handle });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        return true;
      } catch (e) {
        this.lastError = e.message;
        return false;
      }
    }

    async _readHandle() {
      try {
        const db = await this._openHandleDb();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readonly');
          const r = tx.objectStore('kv').get(BeeStore.config.storageKey);
          r.onsuccess = () => resolve(r.result ? r.result.handle : null);
          r.onerror = () => reject(r.error);
        });
      } catch (e) {
        return null;
      }
    }

    async _clearStoredHandle() {
      try {
        const db = await this._openHandleDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').delete(BeeStore.config.storageKey);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { /* ignore */ }
    }

    async _rememberFolderName(name) {
      try {
        if (BeeStore.settings && typeof BeeStore.settings.save === 'function' && BeeStore.settings.repo) {
          await BeeStore.settings.save({ dataFolderName: name });
        } else if (this.repo && this.repo.transaction) {
          await this.repo.transaction(async (tx) => {
            const meta = await tx.get('meta', 'settings') || {};
            meta.id = 'settings';
            meta.dataFolderName = name;
            tx.put('meta', meta);
          });
        }
      } catch (e) { /* ignore */ }
    }

    async loadHandle() {
      if (!this.isSupported()) { this._setStatus('unavailable'); return null; }
      const handle = await this._readHandle();
      if (handle && handle.kind === 'directory') {
        this.dirHandle = handle;
        const granted = await this.checkPermission();
        if (granted) {
          this._setStatus('ok');
          await this.saveNow();
        } else {
          this._setStatus('need-permission');
        }
        return handle;
      }
      this._setStatus('unavailable');
      return null;
    }

    async pickFolder() {
      if (!this.isSupported()) {
        this._setStatus('unavailable');
        return false;
      }
      try {
        this.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await this._saveHandle(this.dirHandle);
        await this._rememberFolderName(this.dirHandle.name);
        this._setStatus('ok');
        await this.saveNow();
        return true;
      } catch (e) {
        if (e.name !== 'AbortError') {
          this._setStatus('error');
          this.lastError = e.message;
        }
        return false;
      }
    }

    async checkPermission() {
      if (!this.dirHandle) return false;
      try {
        const perm = await this.dirHandle.queryPermission({ mode: 'readwrite' });
        return perm === 'granted';
      } catch (e) {
        return false;
      }
    }

    async requestPermission() {
      if (!this.dirHandle) return false;
      try {
        const perm = await this.dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          this._setStatus('ok');
          await this.saveNow();
          return true;
        }
        this._setStatus('need-permission');
      } catch (e) { /* ignore */ }
      return false;
    }

    async disconnect() {
      this.dirHandle = null;
      this.lastSavedAt = null;
      await this._clearStoredHandle();
      await this._rememberFolderName(null);
      this._setStatus('unavailable');
    }

    scheduleSave() {
      if (!this.dirHandle) return;
      this._pending = true;
      this._setStatus('pending');
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this.saveNow(), BeeStore.config.debounceMs);
    }

    async saveNow() {
      if (!this.dirHandle) return false;
      try {
        const perm = await this.checkPermission();
        if (!perm) {
          this._setStatus('need-permission');
          return false;
        }
        const data = await this.repo.exportAll();
        const json = JSON.stringify(data, null, 2);
        const fileHandle = await this.dirHandle.getFileHandle(BeeStore.config.fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        this.lastSavedAt = new Date().toISOString();
        this._pending = false;
        this._setStatus('ok');
        return true;
      } catch (e) {
        this._setStatus('error');
        this.lastError = e.message;
        return false;
      }
    }

    async createBackup() {
      if (!this.dirHandle) return null;
      try {
        const perm = await this.checkPermission();
        if (!perm) return null;
        const data = await this.repo.exportAll();
        const json = JSON.stringify(data, null, 2);
        const now = new Date();
        const ts = now.getFullYear() + '-' +
          String(now.getMonth() + 1).padStart(2, '0') + '-' +
          String(now.getDate()).padStart(2, '0') + '-' +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0');
        const backupDir = await this.dirHandle.getDirectoryHandle(BeeStore.config.backupDir, { create: true });
        const fileHandle = await backupDir.getFileHandle(
          BeeStore.config.backupPrefix + ts + '.json', { create: true }
        );
        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        return ts;
      } catch (e) {
        return null;
      }
    }

    async listBackups() {
      if (!this.dirHandle) return [];
      try {
        const backupDir = await this.dirHandle.getDirectoryHandle(BeeStore.config.backupDir);
        const backups = [];
        for await (const [name, handle] of backupDir.entries()) {
          if (handle.kind === 'file' && name.endsWith('.json')) {
            const file = await handle.getFile();
            backups.push({ name, size: file.size, lastModified: file.lastModified });
          }
        }
        backups.sort((a, b) => b.lastModified - a.lastModified);
        return backups;
      } catch (e) {
        return [];
      }
    }

    async restoreBackup(name) {
      if (!this.dirHandle) return null;
      try {
        const backupDir = await this.dirHandle.getDirectoryHandle(BeeStore.config.backupDir);
        const fileHandle = await backupDir.getFileHandle(name);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }

    async readFile() {
      if (!this.dirHandle) return null;
      try {
        const fileHandle = await this.dirHandle.getFileHandle(BeeStore.config.fileName);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }

    getStatus() {
      return {
        status: this.status,
        lastSavedAt: this.lastSavedAt,
        lastError: this.lastError,
        folderName: this.dirHandle ? this.dirHandle.name : null,
        hasHandle: !!this.dirHandle,
        supported: this.isSupported(),
      };
    }
  }

  BeeStore.FileSync = FileSync;
  if (typeof module !== 'undefined') module.exports = FileSync;
})(typeof window !== 'undefined' ? window : globalThis);
