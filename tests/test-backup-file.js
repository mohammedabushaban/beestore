const { test } = require('node:test');
const assert = require('node:assert');

global.window = global.window || global;
require('../js/core/namespace.js');
const BeeStore = global.window.BeeStore;
require('../js/core/config.js');
require('../js/core/dates.js');
require('../js/core/errors.js');
require('../js/storage/repository.js');
const MemoryRepository = require('../js/storage/memoryRepository.js');
const BF = require('../js/services/backupFile.js');
const BackupService = require('../js/services/backup.js');

function makeRepo() {
  return new MemoryRepository();
}

async function seed(repo, id) {
  await repo.open();
  await repo.transaction(async (tx) => {
    tx.put('meta', {
      id: 'settings',
      storeName: 'Bee Store',
      address: 'نابلس',
      backupWarnDays: 2,
      backupCriticalDays: 7,
      lastBackupAt: null,
      lastOffDeviceBackupAt: null,
    });
    tx.put('products', { id: 'prd_' + id, name: 'Product ' + id, active: true });
    tx.put('sales', {
      id: 'sal_' + id,
      number: 'INV-' + id,
      date: BeeStore.dates.today(),
      totalMinor: 1000,
      status: 'paid',
      createdAt: new Date().toISOString(),
    });
  });
  return repo;
}

function fakeDownloadEnv(canShare, shareImpl) {
  const clicks = [];
  const doc = {
    createElement: function () {
      return {
        set href(value) { this._href = value; },
        set download(value) { this._download = value; },
        click: function () { clicks.push(this._download); },
        remove: function () {},
      };
    },
    body: { appendChild: function () {}, removeChild: function () {} },
  };
  const urlApi = {
    createObjectURL: function () { return 'blob:test'; },
    revokeObjectURL: function () {},
  };
  return {
    env: {
      navigator: { canShare: function () { return canShare; }, share: shareImpl },
      document: doc,
      URL: urlApi,
      File: global.File,
    },
    clicks: clicks,
  };
}

test('backup filename follows BeeStore-backup-YYYY-MM-DD-HHmm.json', () => {
  const d = new Date(2026, 9, 24, 9, 5, 0);
  assert.strictEqual(BF.backupFileName(d), 'BeeStore-backup-2026-10-24-0905.json');
});

test('streamed export is byte-identical compact JSON and reports counts', async () => {
  const repo = await seed(makeRepo(), 'stream');
  const dump = await repo.exportAll();
  const streamed = await repo.exportAllStreamed();
  assert.strictEqual(await streamed.blob.text(), BF.dataJson(dump));
  assert.strictEqual(streamed.counts.products, 1);
  assert.strictEqual(streamed.counts.sales, 1);
  assert.strictEqual(streamed.schemaVersion, BeeStore.schemaVersion);
});

test('checksum detects tampering and old backups remain readable', async () => {
  const repo = await seed(makeRepo(), 'checksum');
  const svc = new BackupService(repo, null);
  const payload = await svc.createPayload({ now: new Date(2026, 9, 24, 9, 5, 0) });
  const backup = JSON.parse(await payload.blob.text());
  assert.strictEqual(payload.filename, 'BeeStore-backup-2026-10-24-0905.json');
  assert.strictEqual(backup.integrity.algorithm, 'SHA-256');
  assert.strictEqual((await BF.verifyIntegrity(backup)).ok, true);

  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.collections.products[0].name = 'Tampered';
  assert.strictEqual((await BF.verifyIntegrity(tampered)).ok, false);
  await assert.rejects(
    () => BF.openBackup(tampered),
    (error) => error.code === 'CHECKSUM_MISMATCH'
  );

  const old = { schemaVersion: 2, meta: { id: 'meta', revision: 1 }, settings: {}, collections: {} };
  const opened = await BF.openBackup(old);
  assert.strictEqual(opened.integrity.verified, false);
  assert.strictEqual(opened.integrity.reason, 'missing');

  const unsupported = {
    schemaVersion: 2, meta: { id: 'meta' }, settings: {}, collections: {},
    integrity: { algorithm: 'MD5', value: 'not-a-sha256' },
  };
  await assert.rejects(
    () => BF.openBackup(unsupported),
    (error) => error.code === 'CHECKSUM_MISMATCH'
  );
});

test('encrypted backup round-trips and rejects a wrong passphrase', async () => {
  const repo = await seed(makeRepo(), 'crypto');
  const svc = new BackupService(repo, null);
  const payload = await svc.createPayload({ encrypt: true, passphrase: 'correct horse' });
  const envelope = JSON.parse(await payload.blob.text());
  assert.strictEqual(envelope.format, BF.ENCRYPTED_FORMAT);
  assert.strictEqual(payload.encrypted, true);

  await assert.rejects(
    () => svc.inspect(envelope, { passphrase: 'wrong password' }),
    (error) => error.code === 'WRONG_PASSPHRASE'
  );
  const inspected = await svc.inspect(envelope, { passphrase: 'correct horse' });
  assert.strictEqual(inspected.encrypted, true);
  assert.strictEqual(inspected.verified, true);
  assert.strictEqual(inspected.summary.total, 2);
});

test('share uses the share sheet and falls back to download', async () => {
  const blob = new Blob(['{}'], { type: 'application/json' });

  let shared = null;
  const shareEnv = fakeDownloadEnv(true, async function (data) { shared = data; });
  const sharedResult = await BF.shareOrDownload(blob, 'backup.json', shareEnv.env);
  assert.strictEqual(sharedResult.method, 'share');
  assert.ok(shared.files[0] instanceof global.File);
  assert.strictEqual(shareEnv.clicks.length, 0);

  const downloadEnv = fakeDownloadEnv(false, async function () {});
  const downloadResult = await BF.shareOrDownload(blob, 'backup.json', downloadEnv.env);
  assert.strictEqual(downloadResult.method, 'download');
  assert.deepStrictEqual(downloadEnv.clicks, ['backup.json']);

  const cancelEnv = fakeDownloadEnv(true, async function () {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  });
  const cancelResult = await BF.shareOrDownload(blob, 'backup.json', cancelEnv.env);
  assert.strictEqual(cancelResult.method, 'cancelled');
  assert.strictEqual(cancelEnv.clicks.length, 0);

  const failEnv = fakeDownloadEnv(true, async function () { throw new Error('not supported'); });
  const failResult = await BF.shareOrDownload(blob, 'backup.json', failEnv.env);
  assert.strictEqual(failResult.method, 'download');
  assert.deepStrictEqual(failEnv.clicks, ['backup.json']);
});

test('share/download marks last backup and keeps lastOffDeviceBackupAt for shares', async () => {
  const repo = await seed(makeRepo(), 'mark');
  const svc = new BackupService(repo, null);

  const shareEnv = fakeDownloadEnv(true, async function () {});
  const share = await svc.share({ env: shareEnv.env });
  assert.strictEqual(share.method, 'share');
  let settings = await repo.get('meta', 'settings');
  assert.ok(settings.lastBackupAt);
  assert.strictEqual(settings.lastBackupMethod, 'share');
  assert.strictEqual(settings.lastOffDeviceBackupAt, settings.lastBackupAt);
  const offDeviceAt = settings.lastOffDeviceBackupAt;
  const status = await svc.status();
  assert.strictEqual(status.activitySince, false, 'backup bookkeeping is not business activity');

  const downloadEnv = fakeDownloadEnv(false, async function () {});
  const download = await svc.download({ env: downloadEnv.env });
  assert.strictEqual(download.method, 'download');
  settings = await repo.get('meta', 'settings');
  assert.strictEqual(settings.lastBackupMethod, 'download');
  assert.strictEqual(settings.lastOffDeviceBackupAt, offDeviceAt);
  assert.ok(settings.lastBackupAt);
});

test('backup status warns only after activity and escalates at 7 days', () => {
  const now = new Date('2026-10-24T12:00:00.000Z').getTime();
  const recentActivity = new Date('2026-10-24T11:00:00.000Z').toISOString();
  const threeDaysAgo = new Date('2026-10-21T12:00:00.000Z').toISOString();
  const eightDaysAgo = new Date('2026-10-16T12:00:00.000Z').toISOString();

  const none = BF.backupStatus({ backupWarnDays: 2, backupCriticalDays: 7 }, {
    createdAt: threeDaysAgo, updatedAt: recentActivity,
  }, now);
  assert.strictEqual(none.overdue, true);
  assert.strictEqual(none.critical, false);

  const current = BF.backupStatus({
    backupWarnDays: 2, backupCriticalDays: 7, lastBackupAt: recentActivity,
  }, { updatedAt: threeDaysAgo }, now);
  assert.strictEqual(current.activitySince, false);
  assert.strictEqual(current.overdue, false);

  const critical = BF.backupStatus({
    backupWarnDays: 2, backupCriticalDays: 7, lastBackupAt: eightDaysAgo,
  }, { updatedAt: recentActivity }, now);
  assert.strictEqual(critical.overdue, true);
  assert.strictEqual(critical.critical, true);

  // Bookkeeping writes increment meta.revision; the recorded revision must
  // keep that from looking like new business activity.
  const bookkeeping = BF.backupStatus({
    backupWarnDays: 2, backupCriticalDays: 7, lastBackupAt: eightDaysAgo, lastBackupRevision: 9,
  }, { updatedAt: recentActivity, revision: 9 }, now);
  assert.strictEqual(bookkeeping.activitySince, false);
  assert.strictEqual(bookkeeping.overdue, false);
  assert.strictEqual(bookkeeping.critical, true, 'red banner is age-based');
  const afterBusiness = BF.backupStatus({
    backupWarnDays: 2, backupCriticalDays: 7, lastBackupAt: eightDaysAgo, lastBackupRevision: 9,
  }, { updatedAt: recentActivity, revision: 10 }, now);
  assert.strictEqual(afterBusiness.activitySince, true);
  assert.strictEqual(afterBusiness.critical, true);
});

test('inspect warns for older, other-device, and checksum-less backups', () => {
  const info = BF.inspectBackup({
    schemaVersion: 2,
    meta: { id: 'meta', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z', deviceId: 'dev_old' },
    collections: {},
  }, {
    id: 'meta', revision: 9, updatedAt: '2026-10-01T00:00:00.000Z', deviceId: 'dev_new',
  }, 'dev_new');
  const codes = info.warnings.map(function (warning) { return warning.code; });
  assert.ok(codes.includes('NO_CHECKSUM'));
  assert.ok(codes.includes('OLDER_BACKUP'));
  assert.ok(codes.includes('DIFFERENT_DEVICE'));
  assert.ok(codes.includes('WILL_MIGRATE'));
});

test('restore creates a safety snapshot and replaces data', async () => {
  const source = await seed(makeRepo(), 'source');
  const sourceSvc = new BackupService(source, null);
  const payload = await sourceSvc.createPayload();
  const backup = JSON.parse(await payload.blob.text());

  const target = makeRepo();
  await target.open();
  const targetDeviceId = (await target.get('meta', 'meta')).deviceId;
  await target.transaction(async (tx) => {
    tx.put('products', { id: 'prd_old', name: 'Old product' });
  });

  let snapshotReason = null;
  BeeStore.snapshots = {
    create: async function (reason) { snapshotReason = reason; return { id: 'snap_test' }; },
  };
  BeeStore.migrations = { migrate: async function (data) { return data; } };

  const targetSvc = new BackupService(target, null);
  const result = await targetSvc.restore(backup);
  assert.strictEqual(result.restored, true);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(snapshotReason, 'pre-restore');
  assert.strictEqual(await target.get('products', 'prd_old'), null);
  assert.ok(await target.get('products', 'prd_source'));
  const restoredMeta = await target.get('meta', 'meta');
  assert.strictEqual(restoredMeta.deviceId, targetDeviceId, 'restore makes this phone primary');
});
