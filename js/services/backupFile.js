(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  const PLAIN_FORMAT = 'beestore-backup';
  const ENCRYPTED_FORMAT = 'beestore-backup-encrypted';
  const PBKDF2_ITERATIONS = 210000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  function fail(code, message) {
    if (BeeStore.errors && BeeStore.errors.err) return BeeStore.errors.err(code, message);
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function getCrypto(impl) {
    return impl || root.crypto || null;
  }

  function getSubtle(impl) {
    const crypto = getCrypto(impl);
    return crypto && crypto.subtle ? crypto.subtle : null;
  }

  function randomBytes(length, impl) {
    const crypto = getCrypto(impl);
    if (!crypto || typeof crypto.getRandomValues !== 'function') {
      throw fail('CRYPTO_UNAVAILABLE', 'التشفير غير متاح في هذا المتصفح. حدّث المتصفح أو استخدم نسخة غير مشفرة.');
    }
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  }

  function bytesToBase64(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof root.Buffer !== 'undefined' && root.Buffer.from) {
      return root.Buffer.from(arr).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return root.btoa(binary);
  }

  function base64ToBytes(value) {
    const text = String(value || '');
    if (typeof root.Buffer !== 'undefined' && root.Buffer.from) {
      return new Uint8Array(root.Buffer.from(text, 'base64'));
    }
    const binary = root.atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function toHex(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
    return out;
  }

  async function sha256Hex(input, impl) {
    const subtle = getSubtle(impl);
    if (!subtle) {
      throw fail('CRYPTO_UNAVAILABLE', 'التحقق من سلامة الملف غير متاح في هذا المتصفح.');
    }
    const data = typeof input === 'string' ? new root.TextEncoder().encode(input) : input;
    const digest = await subtle.digest('SHA-256', data);
    return toHex(new Uint8Array(digest));
  }

  function countCollections(backup) {
    const counts = {};
    const collections = (backup && backup.collections) || {};
    for (const name of Object.keys(collections)) {
      if (Array.isArray(collections[name])) counts[name] = collections[name].length;
    }
    return counts;
  }

  function dataObject(backup) {
    return {
      schemaVersion: backup.schemaVersion,
      meta: backup.meta || null,
      settings: backup.settings || null,
      collections: backup.collections || {},
    };
  }

  function dataJson(backup) {
    return JSON.stringify(dataObject(backup));
  }

  function dataBlob(backup) {
    return new Blob([dataJson(backup)], { type: 'application/json' });
  }

  function buildIntegrity(value, info) {
    info = info || {};
    return {
      algorithm: 'SHA-256',
      value: value,
      appVersion: info.appVersion || BeeStore.version || '',
      createdAt: info.createdAt || new Date().toISOString(),
      schemaVersion: Number(info.schemaVersion || 1),
      counts: info.counts || {},
    };
  }

  /**
   * Appends an `integrity` entry to a streamed JSON object blob. The checksum
   * covers exactly the four stable data fields, not the integrity entry.
   */
  async function addIntegrity(blob, info, impl) {
    const value = await sha256Hex(await blob.arrayBuffer(), impl);
    const integrity = buildIntegrity(value, info);
    // The data blob is a complete object ending in '}'. Remove only that
    // final brace, then add the integrity property and close the object again.
    const data = blob.size > 0 ? blob.slice(0, blob.size - 1) : blob;
    const finalBlob = new Blob([data, ',"integrity":' + JSON.stringify(integrity) + '}'], {
      type: 'application/json',
    });
    return { blob: finalBlob, integrity: integrity };
  }

  async function verifyIntegrity(backup, impl) {
    if (!backup || !backup.integrity) {
      return { ok: true, verified: false, reason: 'missing' };
    }
    const integrity = backup.integrity;
    if (integrity.algorithm !== 'SHA-256' || !integrity.value) {
      // An integrity block that exists but cannot be checked must not be
      // silently downgraded to "no checksum".
      return { ok: false, verified: true, reason: 'unsupported' };
    }
    const actual = await sha256Hex(dataJson(backup), impl);
    return {
      ok: actual === String(integrity.value).toLowerCase(),
      verified: true,
      expected: String(integrity.value).toLowerCase(),
      actual: actual,
    };
  }

  function isEncryptedEnvelope(value) {
    return !!(value && typeof value === 'object' &&
      value.format === ENCRYPTED_FORMAT &&
      typeof value.data === 'string');
  }

  function isBackup(value) {
    return !!(value && typeof value === 'object' &&
      value.collections && typeof value.collections === 'object');
  }

  async function deriveKey(passphrase, salt, iterations, impl) {
    const subtle = getSubtle(impl);
    if (!subtle) {
      throw fail('CRYPTO_UNAVAILABLE', 'التشفير غير متاح في هذا المتصفح.');
    }
    const baseKey = await subtle.importKey(
      'raw',
      new root.TextEncoder().encode(String(passphrase)),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(bytes, passphrase, impl, options) {
    options = options || {};
    if (!passphrase) {
      throw fail('PASSPHRASE_REQUIRED', 'أدخل كلمة مرور للتشفير.');
    }
    const subtle = getSubtle(impl);
    if (!subtle) {
      throw fail('CRYPTO_UNAVAILABLE', 'التشفير غير متاح في هذا المتصفح.');
    }
    const salt = randomBytes(SALT_BYTES, impl);
    const iv = randomBytes(IV_BYTES, impl);
    const iterations = Number(options.iterations || PBKDF2_ITERATIONS);
    const key = await deriveKey(passphrase, salt, iterations, impl);
    const cipher = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      key,
      bytes
    );
    return {
      format: ENCRYPTED_FORMAT,
      version: 1,
      createdAt: options.createdAt || new Date().toISOString(),
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: iterations,
        salt: bytesToBase64(salt),
      },
      cipher: {
        name: 'AES-GCM',
        iv: bytesToBase64(iv),
        tagLength: 128,
      },
      data: bytesToBase64(new Uint8Array(cipher)),
    };
  }

  async function decryptEnvelope(envelope, passphrase, impl) {
    if (!isEncryptedEnvelope(envelope)) {
      throw fail('INVALID_DATA', 'ملف النسخة الاحتياطية غير صالح.');
    }
    if (!passphrase) {
      throw fail('PASSPHRASE_REQUIRED', 'هذه النسخة مشفرة. أدخل كلمة المرور.');
    }
    try {
      const iterations = Math.min(Math.max(Number(envelope.kdf && envelope.kdf.iterations) || PBKDF2_ITERATIONS, 10000), 1000000);
      const salt = base64ToBytes(envelope.kdf && envelope.kdf.salt);
      const iv = base64ToBytes(envelope.cipher && envelope.cipher.iv);
      const key = await deriveKey(passphrase, salt, iterations, impl);
      const plain = await getSubtle(impl).decrypt(
        { name: 'AES-GCM', iv: iv, tagLength: 128 },
        key,
        base64ToBytes(envelope.data)
      );
      const text = new root.TextDecoder().decode(plain);
      return JSON.parse(text);
    } catch (error) {
      if (error && error.code) throw error;
      throw fail('WRONG_PASSPHRASE', 'كلمة المرور غير صحيحة أو الملف تالف.');
    }
  }

  /**
   * Opens an unencrypted backup object or an encrypted envelope. Verifies the
   * SHA-256 integrity entry when present. Older backups without a checksum are
   * accepted but reported as unverified.
   */
  async function openBackup(input, passphrase, impl) {
    let backup = input;
    if (typeof backup === 'string') {
      try { backup = JSON.parse(backup); }
      catch (e) { throw fail('INVALID_DATA', 'ملف غير صالح: تعذّر قراءة JSON.'); }
    }
    let encrypted = false;
    if (isEncryptedEnvelope(backup)) {
      backup = await decryptEnvelope(backup, passphrase, impl);
      encrypted = true;
    }
    if (!isBackup(backup)) {
      throw fail('INVALID_DATA', 'ملف غير صالح: لا يحتوي بيانات بي ستور.');
    }
    const integrity = await verifyIntegrity(backup, impl);
    if (integrity.verified && !integrity.ok) {
      throw fail('CHECKSUM_MISMATCH', 'فشل التحقق من سلامة الملف. قد يكون تالفاً أو تم تعديله. لم يتم استيراده.');
    }
    return { backup: backup, encrypted: encrypted, integrity: integrity };
  }

  function backupFileName(now) {
    const d = now instanceof Date ? now : new Date(now || Date.now());
    const p = function (n) { return String(n).padStart(2, '0'); };
    return 'BeeStore-backup-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' +
      p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  function newestDocument(backup) {
    let best = null;
    let bestKey = '';
    const collections = (backup && backup.collections) || {};
    for (const name of Object.keys(collections)) {
      const docs = collections[name];
      if (!Array.isArray(docs)) continue;
      for (const doc of docs) {
        const key = String(doc.updatedAt || doc.createdAt || doc.date || doc.at || '');
        if (key && key > bestKey) {
          bestKey = key;
          best = {
            collection: name,
            id: doc.id || null,
            number: doc.number || doc.invoiceNumber || doc.purchaseNumber || null,
            date: key,
          };
        }
      }
    }
    return best;
  }

  function summarizeBackup(backup) {
    const counts = countCollections(backup);
    let total = 0;
    for (const name of Object.keys(counts)) total += counts[name];
    const integrity = (backup && backup.integrity) || {};
    const meta = (backup && backup.meta) || {};
    return {
      createdAt: integrity.createdAt || meta.savedAt || meta.updatedAt || meta.createdAt || null,
      schemaVersion: (backup && backup.schemaVersion) || null,
      appVersion: integrity.appVersion || null,
      deviceId: meta.deviceId || null,
      counts: counts,
      total: total,
      newest: newestDocument(backup),
      hasChecksum: !!integrity.value,
    };
  }

  function inspectBackup(backup, currentMeta, currentDeviceId) {
    const summary = summarizeBackup(backup);
    const warnings = [];
    if (!summary.hasChecksum) {
      warnings.push({
        code: 'NO_CHECKSUM',
        message: 'هذه النسخة قديمة ولا تحتوي بصمة تحقق. سيتم استيرادها كما هي.',
      });
    }
    currentMeta = currentMeta || {};
    const backupMeta = (backup && backup.meta) || {};
    const currentRevision = Number(currentMeta.revision || 0);
    const backupRevision = Number(backupMeta.revision || 0);
    const currentAt = currentMeta.updatedAt || currentMeta.savedAt || null;
    const backupAt = backupMeta.updatedAt || backupMeta.savedAt || null;
    if (backupRevision < currentRevision || (backupAt && currentAt && String(backupAt) < String(currentAt))) {
      warnings.push({
        code: 'OLDER_BACKUP',
        message: 'هذه النسخة أقدم من بياناتك الحالية. الاستعادة ستستبدل البيانات الحالية بالنسخة القديمة.',
      });
    }
    const backupDevice = backupMeta.deviceId || null;
    if (currentDeviceId && backupDevice && backupDevice !== currentDeviceId) {
      warnings.push({
        code: 'DIFFERENT_DEVICE',
        message: 'هذه النسخة من جهاز آخر. بعد الاستعادة سيصبح هذا الجهاز هو الأساس، وتوقّف العمل على الجهاز القديم لتجنّب التعارض.',
      });
    }
    if (backup && backup.schemaVersion && BeeStore.schemaVersion &&
      Number(backup.schemaVersion) < Number(BeeStore.schemaVersion)) {
      warnings.push({
        code: 'WILL_MIGRATE',
        message: 'النسخة من إصدار أقدم. سيتم ترقيتها تلقائياً بعد الاستعادة.',
      });
    }
    return { summary: summary, warnings: warnings };
  }

  function parseTime(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function backupStatus(settings, meta, nowMs) {
    settings = settings || {};
    meta = meta || {};
    const now = Number(nowMs || Date.now());
    const lastBackupAt = settings.lastBackupAt || settings.lastOffDeviceBackupAt || null;
    const lastOffDeviceBackupAt = settings.lastOffDeviceBackupAt || null;
    const lastActivityAt = meta.updatedAt || settings.updatedAt || meta.createdAt || settings.createdAt || null;
    const backupTime = parseTime(lastBackupAt);
    const activityTime = parseTime(lastActivityAt);
    const lastBackupRevision = settings.lastBackupRevision != null
      ? Number(settings.lastBackupRevision)
      : null;
    let activitySince;
    if (!backupTime) {
      activitySince = true;
    } else if (lastBackupRevision !== null && Number.isFinite(lastBackupRevision)) {
      activitySince = Number(meta.revision || 0) > lastBackupRevision;
    } else {
      // Old settings have no revision marker. Ignore the tiny timestamp skew
      // caused by writing the backup bookkeeping itself.
      activitySince = activityTime !== null && activityTime > backupTime + 5000;
    }
    const reference = backupTime || parseTime(meta.createdAt) || parseTime(settings.createdAt);
    const ageDays = reference === null ? null : Math.max(0, (now - reference) / (24 * 60 * 60 * 1000));
    const warnDays = Math.max(1, Number(settings.backupWarnDays || 2));
    const criticalDays = Math.max(warnDays, Number(settings.backupCriticalDays || 7));
    return {
      lastBackupAt: lastBackupAt,
      lastOffDeviceBackupAt: lastOffDeviceBackupAt,
      lastBackupMethod: settings.lastBackupMethod || null,
      lastActivityAt: lastActivityAt,
      activitySince: activitySince,
      ageDays: ageDays,
      warnDays: warnDays,
      criticalDays: criticalDays,
      overdue: !!activitySince && ageDays !== null && ageDays >= warnDays,
      // Red is an age-based escalation: a backup older than 7 days is unsafe
      // even if the shop happened to be idle.
      critical: ageDays !== null && ageDays >= criticalDays,
    };
  }

  function downloadBlob(blob, filename, env) {
    env = env || {};
    const doc = env.document || root.document;
    const urlApi = env.URL || root.URL;
    if (!doc || !urlApi || typeof urlApi.createObjectURL !== 'function') {
      throw fail('DOWNLOAD_UNAVAILABLE', 'تعذّر تنزيل الملف في هذا المتصفح.');
    }
    const url = urlApi.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    if (doc.body && doc.body.appendChild) doc.body.appendChild(link);
    link.click();
    if (link.remove) link.remove();
    else if (doc.body && doc.body.removeChild) doc.body.removeChild(link);
    setTimeout(function () {
      try { urlApi.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }, 1000);
    return { method: 'download', filename: filename };
  }

  /**
   * Shares the backup file through the OS share sheet when files are
   * supported; otherwise (or when sharing fails) downloads it. A user cancel
   * is not converted into an unexpected download.
   */
  async function shareOrDownload(blob, filename, env) {
    env = env || {};
    const nav = env.navigator || root.navigator;
    const FileCtor = env.File || root.File;
    let file = null;
    if (FileCtor) {
      try { file = new FileCtor([blob], filename, { type: 'application/json' }); }
      catch (e) { file = null; }
    }
    if (file && nav && typeof nav.share === 'function') {
      let canShare = true;
      if (typeof nav.canShare === 'function') {
        try { canShare = !!nav.canShare({ files: [file] }); }
        catch (e) { canShare = false; }
      }
      if (canShare) {
        try {
          await nav.share({
            files: [file],
            title: 'نسخة احتياطية — بي ستور',
            text: 'احفظ هذه النسخة خارج الهاتف (Drive أو واتساب أو بريد إلكتروني).',
          });
          return { method: 'share', filename: filename };
        } catch (error) {
          if (error && error.name === 'AbortError') {
            return { method: 'cancelled', filename: filename };
          }
          // Unsupported files, permission errors, or a failed share: fall back.
        }
      }
    }
    return downloadBlob(blob, filename, env);
  }

  BeeStore.backupFile = {
    PLAIN_FORMAT: PLAIN_FORMAT,
    ENCRYPTED_FORMAT: ENCRYPTED_FORMAT,
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    fail: fail,
    sha256Hex: sha256Hex,
    countCollections: countCollections,
    dataObject: dataObject,
    dataJson: dataJson,
    dataBlob: dataBlob,
    addIntegrity: addIntegrity,
    verifyIntegrity: verifyIntegrity,
    isEncryptedEnvelope: isEncryptedEnvelope,
    isBackup: isBackup,
    encryptBytes: encryptBytes,
    decryptEnvelope: decryptEnvelope,
    openBackup: openBackup,
    backupFileName: backupFileName,
    summarizeBackup: summarizeBackup,
    inspectBackup: inspectBackup,
    backupStatus: backupStatus,
    downloadBlob: downloadBlob,
    shareOrDownload: shareOrDownload,
  };

  if (typeof module !== 'undefined') module.exports = BeeStore.backupFile;
})(typeof window !== 'undefined' ? window : globalThis);
