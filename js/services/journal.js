(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  if (!BeeStore.chartSeed && typeof require !== 'undefined') require('../core/chartSeed.js');

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
  const PARTY_COLLECTIONS = {
    customer: 'customers',
    supplier: 'suppliers',
    employee: 'employees',
  };
  const NO_SOURCE_TYPES = ['MANUAL', 'OPENING'];
  const REVERSAL_MEMO = 'قيد عكسي';

  function isDate(value) {
    const s = String(value || '');
    if (!DATE_RE.test(s)) return false;
    return BeeStore.dates.formatDate(s) === s;
  }

  function isAmount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  function lineSignature(line) {
    return [
      line.accountId || '',
      line.partyType || '',
      line.partyId || '',
      line.memo || '',
      Number(line.debitMinor) || 0,
      Number(line.creditMinor) || 0,
    ].join('\u0000');
  }

  function mirrorLines(lines) {
    return (lines || []).map(line => ({
      accountId: line.accountId,
      debitMinor: Number(line.creditMinor) || 0,
      creditMinor: Number(line.debitMinor) || 0,
      partyType: line.partyType || null,
      partyId: line.partyId || null,
      memo: line.memo || '',
    }));
  }

  function sortNumbers(a, b) {
    const na = BeeStore.chartSeed.parseNumber(a.number) || 0;
    const nb = BeeStore.chartSeed.parseNumber(b.number) || 0;
    return nb - na;
  }

  class JournalService {
    constructor(repo) {
      this.repo = repo;
    }

    /**
     * Append a balanced journal entry in its own transaction.
     * Posting services should call post(tx, ...) inside their document
     * transaction so the document and its entries commit atomically.
     * @param {object} data entry fields
     * @returns {Promise<object>} saved entry
     */
    async append(data) {
      return this.repo.transaction(tx => this.post(tx, data));
    }

    /**
     * Core posting gate. Validates the entry, checks locks, reserves the next
     * gapless number, and appends. Never updates or deletes an existing entry.
     * @param {object} tx active repository transaction
     * @param {object} data entry fields
     * @param {object} [options] {allowInactive,allowClosedDay}
     * @returns {Promise<object>} saved entry
     */
    async post(tx, data, options) {
      options = options || {};
      data = data || {};

      if (BeeStore.chart && BeeStore.chart.ensureSeededTx) {
        await BeeStore.chart.ensureSeededTx(tx);
      }
      const chart = await tx.list('chartOfAccounts');
      const accountMap = new Map(chart.map(a => [a.id, a]));

      const date = String(data.date || '').trim();
      if (!isDate(date)) {
        throw BeeStore.errors.err('VALIDATION', 'تاريخ القيد غير صالح — استخدم YYYY-MM-DD');
      }
      const sourceType = String(data.sourceType || '').trim();
      if (!sourceType) {
        throw BeeStore.errors.err('VALIDATION', 'نوع مصدر القيد مطلوب');
      }
      const sourceId = data.sourceId === undefined || data.sourceId === null || data.sourceId === ''
        ? null
        : String(data.sourceId);
      if (!sourceId && NO_SOURCE_TYPES.indexOf(sourceType) < 0) {
        throw BeeStore.errors.err('VALIDATION', 'معرّف المستند مطلوب لنوع القيد ' + sourceType);
      }
      const description = String(data.description || '').trim();
      if (!description) {
        throw BeeStore.errors.err('VALIDATION', 'وصف القيد مطلوب');
      }
      if (!Array.isArray(data.lines) || data.lines.length < 2) {
        throw BeeStore.errors.err('VALIDATION', 'القيد يحتاج سطرين على الأقل');
      }

      const lines = [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (let i = 0; i < data.lines.length; i++) {
        const raw = data.lines[i] || {};
        const accountId = String(raw.accountId || '');
        const account = accountMap.get(accountId);
        if (!account) {
          throw BeeStore.errors.err('VALIDATION', 'حساب القيد غير موجود: ' + (accountId || '(فارغ)'));
        }
        if (account.active === false && !options.allowInactive) {
          throw BeeStore.errors.err('VALIDATION', 'الحساب المحاسبي معطّل: ' + account.nameAr);
        }
        const debit = raw.debitMinor === undefined || raw.debitMinor === null ? 0 : raw.debitMinor;
        const credit = raw.creditMinor === undefined || raw.creditMinor === null ? 0 : raw.creditMinor;
        if (!Number.isSafeInteger(debit) || debit < 0 ||
          !Number.isSafeInteger(credit) || credit < 0) {
          throw BeeStore.errors.err('VALIDATION',
            'مبالغ القيد يجب أن تكون أعداداً صحيحة بالوحدة الصغرى (سطر ' + (i + 1) + ')');
        }
        if (debit > 0 && credit > 0) {
          throw BeeStore.errors.err('VALIDATION',
            'كل سطر إما مدين أو دائن — ليس الاثنين (سطر ' + (i + 1) + ')');
        }
        if (debit === 0 && credit === 0) {
          throw BeeStore.errors.err('VALIDATION',
            'كل سطر يحتاج مبلغاً أكبر من صفر (سطر ' + (i + 1) + ')');
        }
        const partyType = raw.partyType ? String(raw.partyType) : null;
        const partyId = raw.partyId ? String(raw.partyId) : null;
        if (partyType && Object.keys(PARTY_COLLECTIONS).indexOf(partyType) < 0) {
          throw BeeStore.errors.err('VALIDATION', 'نوع الطرف غير صالح: ' + partyType);
        }
        if (partyType && !partyId) {
          throw BeeStore.errors.err('VALIDATION', 'معرّف الطرف مطلوب عند تحديد نوعه');
        }
        if (!partyType && partyId) {
          throw BeeStore.errors.err('VALIDATION', 'نوع الطرف مطلوب عند تحديد معرّفه');
        }
        if (partyType) {
          const party = await tx.get(PARTY_COLLECTIONS[partyType], partyId);
          if (!party) {
            throw BeeStore.errors.err('VALIDATION', 'الطرف المرتبط بالقيد غير موجود');
          }
        }
        if (!Number.isSafeInteger(totalDebit + debit) ||
          !Number.isSafeInteger(totalCredit + credit)) {
          throw BeeStore.errors.err('VALIDATION', 'مبالغ القيد تتجاوز الحد الآمن');
        }
        totalDebit += debit;
        totalCredit += credit;
        lines.push({
          accountId,
          debitMinor: debit,
          creditMinor: credit,
          partyType,
          partyId,
          memo: raw.memo === undefined || raw.memo === null ? '' : String(raw.memo),
        });
      }
      if (totalDebit !== totalCredit) {
        throw BeeStore.errors.err('VALIDATION',
          'القيد غير متوازن — مدين ' + totalDebit + ' مقابل دائن ' + totalCredit);
      }
      if (totalDebit <= 0) {
        throw BeeStore.errors.err('VALIDATION', 'القيد لا يحتوي مبلغاً موجباً');
      }

      let reversalOf = data.reversalOf ? String(data.reversalOf) : null;
      if (reversalOf) {
        const original = await tx.get('journalEntries', reversalOf);
        if (!original) {
          throw BeeStore.errors.err('VALIDATION', 'القيد الأصلي للعكس غير موجود');
        }
        if (original.date !== date) {
          throw BeeStore.errors.err('VALIDATION',
            'القيد العكسي يجب أن يكون بتاريخ القيد الأصلي (' + original.date + ')');
        }
        const expected = mirrorLines(original.lines).map(lineSignature).sort();
        const actual = lines.map(lineSignature).sort();
        if (expected.length !== actual.length ||
          expected.some((sig, i) => sig !== actual[i])) {
          throw BeeStore.errors.err('VALIDATION', 'القيد العكسي يجب أن يعكس أسطر القيد الأصلي تماماً');
        }
        const already = await tx.query('journalEntries', 'reversalOf', reversalOf);
        if (already.length > 0) {
          throw BeeStore.errors.err('ALREADY_REVERSED', 'هذا القيد تم عكسه مسبقاً');
        }
      }

      const entry = {
        id: BeeStore.ids.randomId('je'),
        number: null,
        date,
        time: TIME_RE.test(String(data.time || '')) ? String(data.time) : BeeStore.dates.nowTime(),
        createdAt: BeeStore.dates.now(),
        sourceType,
        sourceId,
        description,
        lines,
        reversalOf,
        isScheduled: !!data.isScheduled,
        postingVersion: Number.isSafeInteger(data.postingVersion) && data.postingVersion > 0
          ? data.postingVersion
          : BeeStore.chartSeed.POSTING_VERSION,
        profile: data.profile !== undefined ? data.profile : this._profileName(),
      };

      await this._assertLocks(tx, entry, options);
      entry.number = await this._reserveNumber(tx);
      await tx.append('journalEntries', entry);
      return entry;
    }

    _profileName() {
      try {
        if (BeeStore.auth && BeeStore.auth.profileName) {
          return BeeStore.auth.profileName() || 'system';
        }
      } catch (e) {
        // No auth layer in a pure service test.
      }
      return 'system';
    }

    async _assertLocks(tx, entry, options) {
      options = options || {};
      if (entry.isScheduled) {
        if (BeeStore.periods.assertScheduledOpen) {
          await BeeStore.periods.assertScheduledOpen(tx, entry.date);
        } else {
          const settings = (await tx.get('meta', 'settings')) || {};
          if (settings.systemStartDate && entry.date < settings.systemStartDate) {
            throw BeeStore.errors.err('VALIDATION',
              'لا يمكن جدولة قيد قبل تاريخ بدء النظام (' + settings.systemStartDate + ')');
          }
          await BeeStore.periods.assertMonthsOpen(tx, [entry.date.slice(0, 7)]);
        }
      } else {
        await BeeStore.periods.assertOpen(tx, entry.date);
      }
      // Inventory-only postings (purchases, stock counts, opening stock, cost
      // revaluation) are non-cash and may be recorded after the day is closed,
      // matching the v3-Lite §4.5 day-lock rules. Cash documents never set this.
      if (!options.allowClosedDay) {
        await BeeStore.periods.assertDayOpen(tx, entry.date);
      }
      return true;
    }

    /**
     * Reserves the next JE number inside the current transaction. A counter
     * that is behind an imported entry is repaired by scanning the index; a
     * failed transaction rolls the counter back with the rest of the snapshot.
     */
    async _reserveNumber(tx) {
      const meta = await tx.get('meta', 'meta');
      let counter = Number(meta && meta.counters && meta.counters.journal) || 0;
      let candidate = counter + 1;
      if (counter === 0) {
        const entries = await tx.list('journalEntries');
        let max = 0;
        for (const entry of entries) {
          const n = BeeStore.chartSeed.parseNumber(entry && entry.number);
          if (n && n > max) max = n;
        }
        candidate = max + 1;
      } else {
        let guard = 0;
        while (guard++ < 100000) {
          const number = BeeStore.chartSeed.formatNumber(candidate);
          const found = await tx.query('journalEntries', 'number', number);
          if (!found || found.length === 0) break;
          candidate++;
        }
      }
      if (typeof tx.setCounter === 'function') {
        await tx.setCounter('journal', candidate);
      } else {
        await tx.nextCounter('journal');
      }
      return BeeStore.chartSeed.formatNumber(candidate);
    }

    /**
     * Appends one reversing entry per original, dated the original date and
     * mirroring every line. Must run inside a document's transaction.
     * @param {object} tx active transaction
     * @param {object[]} entries originals
     * @param {object} [meta] {description, reason, sourceType, sourceId, profile}
     * @param {object} [options] {allowClosedDay}
     * @returns {Promise<object[]>} reversal entries
     */
    async reverseEntries(tx, entries, meta, options) {
      meta = meta || {};
      options = options || {};
      const out = [];
      for (const original of (entries || [])) {
        if (!original || !original.id) continue;
        const already = await tx.query('journalEntries', 'reversalOf', original.id);
        if (already.length > 0) {
          throw BeeStore.errors.err('ALREADY_REVERSED', 'القيد ' + original.number + ' تم عكسه مسبقاً');
        }
        const reversal = await this.post(tx, {
          date: original.date,
          sourceType: meta.sourceType || original.sourceType,
          sourceId: meta.sourceId !== undefined ? meta.sourceId : original.sourceId,
          description: meta.description ||
            ('عكس القيد ' + original.number + (meta.reason ? ' — ' + meta.reason : '')),
          lines: mirrorLines(original.lines),
          reversalOf: original.id,
          isScheduled: original.isScheduled === true,
          profile: meta.profile,
          postingVersion: meta.postingVersion,
        }, { allowInactive: true, allowClosedDay: !!options.allowClosedDay });
        out.push(reversal);
      }
      return out;
    }

    /**
     * Reverses every entry belonging to one source document inside an
     * existing transaction. Returns [] when the document has no entries
     * (legacy documents before their journal replay).
     * @param {object} tx active transaction
     * @param {string} sourceType source document type
     * @param {string} sourceId source document id
     * @param {object} [meta] description/reason/profile
     * @param {object} [options] {allowClosedDay}
     * @returns {Promise<object[]>} reversal entries
     */
    async reverseSourceTx(tx, sourceType, sourceId, meta, options) {
      const entries = await this._forSourceTx(tx, sourceType, sourceId);
      if (entries.length === 0) return [];
      return this.reverseEntries(tx, entries, {
        ...(meta || {}),
        sourceType: meta && meta.sourceType ? meta.sourceType : sourceType,
        sourceId: meta && meta.sourceId !== undefined ? meta.sourceId : sourceId,
      }, options);
    }

    /**
     * Reverses every entry belonging to one source document.
     * @param {string} sourceType source document type
     * @param {string} sourceId source document id
     * @param {object} [meta] description/reason/profile
     * @returns {Promise<object[]>} reversal entries
     */
    async reverseSource(sourceType, sourceId, meta) {
      return this.repo.transaction(async (tx) => {
        const entries = await this._forSourceTx(tx, sourceType, sourceId);
        if (entries.length === 0) {
          throw BeeStore.errors.err('NOT_FOUND', 'لا توجد قيود لهذا المستند');
        }
        return this.reverseEntries(tx, entries, {
          ...(meta || {}),
          sourceType: meta && meta.sourceType ? meta.sourceType : sourceType,
          sourceId: meta && meta.sourceId !== undefined ? meta.sourceId : sourceId,
        });
      });
    }

    async _forSourceTx(tx, sourceType, sourceId) {
      let rows;
      if (sourceId) {
        rows = await tx.query('journalEntries', 'sourceId', String(sourceId));
      } else {
        rows = await tx.list('journalEntries');
      }
      rows = rows.filter(e => (!sourceType || e.sourceType === sourceType) &&
        (sourceId === undefined || sourceId === null || e.sourceId === String(sourceId)));
      rows.sort((a, b) => {
        const na = BeeStore.chartSeed.parseNumber(a.number) || 0;
        const nb = BeeStore.chartSeed.parseNumber(b.number) || 0;
        return na - nb;
      });
      return rows;
    }

    /**
     * @param {object} [filters] {from,to,sourceType,sourceId,accountId,search,limit}
     * @returns {Promise<object[]>} entries newest first
     */
    async list(filters) {
      filters = filters || {};
      let rows = (filters.from || filters.to)
        ? await this.repo.listRange('journalEntries', filters.from, filters.to)
        : await this.repo.list('journalEntries');
      if (filters.sourceType) rows = rows.filter(e => e.sourceType === filters.sourceType);
      if (filters.sourceId) rows = rows.filter(e => e.sourceId === filters.sourceId);
      if (filters.accountId) {
        rows = rows.filter(e => (e.lines || []).some(l => l.accountId === filters.accountId));
      }
      if (filters.search) {
        const q = String(filters.search).toLowerCase();
        rows = rows.filter(e =>
          String(e.number || '').toLowerCase().indexOf(q) >= 0 ||
          String(e.description || '').toLowerCase().indexOf(q) >= 0 ||
          String(e.sourceId || '').toLowerCase().indexOf(q) >= 0);
      }
      rows.sort(sortNumbers);
      if (filters.limit) rows = rows.slice(0, Math.max(0, Number(filters.limit) || 0));
      return rows;
    }

    async get(id) {
      return this.repo.get('journalEntries', id);
    }

    async byNumber(number) {
      const rows = await this.repo.query('journalEntries', 'number', String(number));
      return rows[0] || null;
    }

    async forSource(sourceType, sourceId) {
      return this._forSourceTx(this.repo, sourceType, sourceId);
    }

    /**
     * Trial balance from the journal. Debit-positive balances; totals are
     * compared exactly and a difference is never plugged.
     * @param {object} [filters] {from,to,asOf,includeZero}
     * @returns {Promise<object>} balances
     */
    async trialBalance(filters) {
      filters = filters || {};
      const from = filters.from ? String(filters.from) : null;
      let to = filters.to ? String(filters.to) : null;
      if (from && !isDate(from)) throw BeeStore.errors.err('VALIDATION', 'تاريخ البداية غير صالح');
      if (to && !isDate(to)) throw BeeStore.errors.err('VALIDATION', 'تاريخ النهاية غير صالح');
      if (filters.asOf) {
        if (!isDate(filters.asOf)) throw BeeStore.errors.err('VALIDATION', 'تاريخ كشف الميزان غير صالح');
        if (to && to !== String(filters.asOf)) {
          throw BeeStore.errors.err('VALIDATION', 'لا يمكن الجمع بين تاريخ النهاية وتاريخ الميزان');
        }
        to = String(filters.asOf);
      }
      if (from && to && from > to) {
        throw BeeStore.errors.err('VALIDATION', 'تاريخ البداية بعد تاريخ النهاية');
      }

      const [accounts, entries] = await Promise.all([
        this.repo.list('chartOfAccounts'),
        (from || to)
          ? this.repo.listRange('journalEntries', from || undefined, to || undefined)
          : this.repo.list('journalEntries'),
      ]);
      if (accounts.length === 0 && BeeStore.chart) {
        await BeeStore.chart.ensureSeeded();
      }
      const chart = accounts.length ? accounts : await this.repo.list('chartOfAccounts');
      const rows = new Map();
      for (const account of chart) {
        rows.set(account.id, {
          accountId: account.id,
          code: account.code,
          nameAr: account.nameAr,
          type: account.type,
          normalSide: account.normalSide || BeeStore.chartSeed.normalSideFor(account.type, account.contra),
          debitMinor: 0,
          creditMinor: 0,
          balanceMinor: 0,
          side: 'zero',
        });
      }
      let totalDebit = 0;
      let totalCredit = 0;
      for (const entry of entries) {
        for (const line of (entry.lines || [])) {
          let row = rows.get(line.accountId);
          if (!row) {
            row = {
              accountId: line.accountId,
              code: '',
              nameAr: 'حساب غير معروف',
              type: null,
              normalSide: null,
              debitMinor: 0,
              creditMinor: 0,
              balanceMinor: 0,
              side: 'zero',
              missing: true,
            };
            rows.set(line.accountId, row);
          }
          row.debitMinor += Number(line.debitMinor) || 0;
          row.creditMinor += Number(line.creditMinor) || 0;
          totalDebit += Number(line.debitMinor) || 0;
          totalCredit += Number(line.creditMinor) || 0;
        }
      }
      const out = Array.from(rows.values()).map((row) => {
        const balance = row.debitMinor - row.creditMinor;
        return {
          ...row,
          balanceMinor: balance,
          side: balance > 0 ? 'debit' : (balance < 0 ? 'credit' : 'zero'),
        };
      }).filter(row => filters.includeZero || row.debitMinor !== 0 || row.creditMinor !== 0 || row.missing);
      out.sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }));
      return {
        from,
        to,
        asOf: filters.asOf ? String(filters.asOf) : null,
        accounts: out,
        totalDebitMinor: totalDebit,
        totalCreditMinor: totalCredit,
        differenceMinor: totalDebit - totalCredit,
        balanced: totalDebit === totalCredit,
        entryCount: entries.length,
      };
    }

    /**
     * Read-only invariant check (v5 §9.1/§9.3). Never modifies data.
     * @returns {Promise<object>} {ok, errors, checked}
     */
    async verify() {
      const [entries, chart] = await Promise.all([
        this.repo.list('journalEntries'),
        this.repo.list('chartOfAccounts'),
      ]);
      const errors = [];
      const add = (code, entry, message) => {
        errors.push({
          code,
          entryId: entry ? entry.id : null,
          number: entry ? entry.number : null,
          message,
        });
      };
      const accountIds = new Set(chart.map(a => a.id));
      const byId = new Map(entries.map(e => [e.id, e]));
      const seenNumbers = new Map();
      const monthTotals = {};
      let totalDebit = 0;
      let totalCredit = 0;
      let lineCount = 0;

      for (const entry of entries) {
        if (!entry || !entry.id) {
          add('entry-id', entry, 'قيد بدون معرّف');
          continue;
        }
        if (!isDate(entry.date)) add('entry-date', entry, 'تاريخ قيد غير صالح');
        if (!entry.sourceType) add('entry-source', entry, 'قيد بدون نوع مصدر');
        const n = BeeStore.chartSeed.parseNumber(entry.number);
        if (!n) {
          add('entry-number-format', entry, 'رقم قيد غير صالح: ' + entry.number);
        } else if (seenNumbers.has(n)) {
          add('entry-number-duplicate', entry, 'رقم قيد مكرر: ' + entry.number);
        } else {
          seenNumbers.set(n, entry);
        }
        if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
          add('entry-lines', entry, 'القيد يحتاج سطرين على الأقل');
          continue;
        }
        let debit = 0;
        let credit = 0;
        for (const line of entry.lines) {
          lineCount++;
          if (!line || !accountIds.has(line.accountId)) {
            add('entry-account', entry, 'سطر يشير إلى حساب محاسبي غير موجود');
          }
          if (!Number.isSafeInteger(line.debitMinor) || line.debitMinor < 0 ||
            !Number.isSafeInteger(line.creditMinor) || line.creditMinor < 0) {
            add('entry-amount', entry, 'مبلغ سطر غير صالح');
            continue;
          }
          if (line.debitMinor > 0 && line.creditMinor > 0) {
            add('entry-line-side', entry, 'سطر مدين ودائن معاً');
          }
          if (line.debitMinor === 0 && line.creditMinor === 0) {
            add('entry-line-empty', entry, 'سطر بمبلغ صفر');
          }
          debit += line.debitMinor;
          credit += line.creditMinor;
        }
        if (debit !== credit) {
          add('entry-balance', entry, 'قيد غير متوازن: ' + debit + ' ≠ ' + credit);
        }
        totalDebit += debit;
        totalCredit += credit;
        if (entry.date && DATE_RE.test(entry.date)) {
          const month = entry.date.slice(0, 7);
          if (!monthTotals[month]) monthTotals[month] = { debit: 0, credit: 0 };
          monthTotals[month].debit += debit;
          monthTotals[month].credit += credit;
        }

        if (entry.reversalOf) {
          const original = byId.get(entry.reversalOf);
          if (!original) {
            add('reversal-missing', entry, 'قيد عكسي يشير إلى قيد غير موجود');
          } else {
            if (original.date !== entry.date) {
              add('reversal-date', entry, 'القيد العكسي ليس بتاريخ القيد الأصلي');
            }
            const expected = mirrorLines(original.lines).map(lineSignature).sort();
            const actual = (entry.lines || []).map(lineSignature).sort();
            if (expected.length !== actual.length ||
              expected.some((sig, i) => sig !== actual[i])) {
              add('reversal-mirror', entry, 'القيد العكسي لا يعكس القيد الأصلي تماماً');
            }
          }
        }
      }

      // Gapless sequence: after sorting, entry n must have number n.
      const numbered = Array.from(seenNumbers.keys()).sort((a, b) => a - b);
      for (let i = 0; i < numbered.length; i++) {
        if (numbered[i] !== i + 1) {
          const entry = seenNumbers.get(numbered[i]);
          add('entry-number-gap', entry,
            'تسلسل أرقام القيود غير متصل — متوقع ' + (i + 1) + ' ووجد ' + numbered[i]);
          break;
        }
      }
      // Duplicate reversals of one entry are never valid.
      const reversalCount = {};
      for (const entry of entries) {
        if (!entry.reversalOf) continue;
        reversalCount[entry.reversalOf] = (reversalCount[entry.reversalOf] || 0) + 1;
      }
      for (const id of Object.keys(reversalCount)) {
        if (reversalCount[id] > 1) {
          add('reversal-duplicate', byId.get(id), 'يوجد أكثر من قيد عكسي للقيد نفسه');
        }
      }
      // Every month must balance independently.
      for (const month of Object.keys(monthTotals)) {
        if (monthTotals[month].debit !== monthTotals[month].credit) {
          add('month-balance', null,
            'شهر ' + month + ' غير متوازن: ' + monthTotals[month].debit + ' ≠ ' + monthTotals[month].credit);
        }
      }
      if (totalDebit !== totalCredit) {
        add('trial-balance', null, 'ميزان المراجعة غير متوازن');
      }

      return {
        ok: errors.length === 0,
        errors,
        checked: {
          entries: entries.length,
          lines: lineCount,
          accounts: chart.length,
          totalDebitMinor: totalDebit,
          totalCreditMinor: totalCredit,
          differenceMinor: totalDebit - totalCredit,
          months: Object.keys(monthTotals).length,
        },
      };
    }
  }

  JournalService.REVERSAL_MEMO = REVERSAL_MEMO;
  JournalService.mirrorLines = mirrorLines;
  BeeStore.journal = new JournalService(null);
  BeeStore.JournalService = JournalService;
  if (typeof module !== 'undefined') module.exports = JournalService;
})(typeof window !== 'undefined' ? window : globalThis);
