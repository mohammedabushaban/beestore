(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});
  if (!BeeStore.chartSeed && typeof require !== 'undefined') require('../core/chartSeed.js');

  const migrations = [
    {
      from: 1,
      to: 2,
      migrate(data) {
        if (!data.collections) return data;
        for (const sale of (data.collections.sales || [])) {
          if (!sale.returnStatus) sale.returnStatus = 'none';
        }
        return data;
      },
    },
    {
      // v2 periods: expense month/allocation/void flags, recurring template
      // fields, purchase line return tracking, systemStartDate.
      from: 2,
      to: 3,
      migrate(data) {
        if (!data.collections) return data;
        const C = data.collections;
        for (const e of (C.expenses || [])) {
          if (!e.month && e.date) e.month = String(e.date).slice(0, 7);
          if (!e.allocation) e.allocation = { mode: 'single' };
          if (e.voided === undefined) e.voided = false;
          if (e.voidReason === undefined) e.voidReason = null;
        }
        for (const r of (C.recurringExpenses || [])) {
          if (r.startMonth === undefined) r.startMonth = null;
          if (r.endMonth === undefined) r.endMonth = null;
          if (r.lastGeneratedMonth === undefined) r.lastGeneratedMonth = null;
          if (r.effectiveFrom === undefined) r.effectiveFrom = null;
        }
        for (const p of (C.purchases || [])) {
          for (const l of (p.lines || [])) {
            if (l.returnedQty === undefined) l.returnedQty = 0;
          }
        }
        if (!C.periodClosings) C.periodClosings = [];
        // v2 §8/§10: backfill avgCostAfterMinor by replaying each variant's
        // ledger in order (same canonical rule as stock.blendCost).
        const blend = (oldQty, oldCost, qty, unitCost) => {
          oldQty = Number(oldQty) || 0;
          unitCost = Math.round(Number(unitCost) || 0);
          if (oldQty <= 0) return unitCost;
          return Math.round((oldQty * Math.round(Number(oldCost) || 0) + Number(qty) * unitCost) /
            (oldQty + Number(qty)));
        };
        const byVariant = {};
        for (const m of (C.stockMovements || [])) {
          (byVariant[m.variantId] = byVariant[m.variantId] || []).push(m);
        }
        for (const vid of Object.keys(byVariant)) {
          const seq = byVariant[vid].sort((a, b) =>
            String(a.date).localeCompare(String(b.date)) ||
            String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          let qty = 0, avg = 0;
          for (const m of seq) {
            const q = Number(m.qtyChange) || 0;
            if (m.type === 'opening') avg = Math.round(Number(m.unitCostMinor) || 0);
            else if (m.type === 'purchase' || m.type === 'sale_return') {
              avg = blend(qty, avg, q, m.unitCostMinor);
            }
            qty += q;
            if (m.avgCostAfterMinor === undefined) m.avgCostAfterMinor = avg;
          }
        }
        const settings = (data.settings) || {};
        if (!settings.systemStartDate) {
          let earliest = null;
          const consider = (d) => {
            if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
              if (!earliest || d < earliest) earliest = d;
            }
          };
          for (const coll of ['sales', 'purchases', 'expenses', 'stockMovements',
            'customerPayments', 'supplierPayments', 'ownerTransactions', 'transfers']) {
            for (const r of ((C[coll]) || [])) consider(r.date);
          }
          settings.systemStartDate = earliest
            ? earliest.slice(0, 7) + '-01'
            : BeeStore.dates.today().slice(0, 7) + '-01';
          data.settings = settings;
        }
        return data;
      },
    },
    {
      // A1: seed the v5 chart and link legacy money/expense records. Existing
      // documents are untouched; journalEntries starts empty for A3 replay.
      from: 3,
      to: 4,
      migrate(data) {
        if (!data.collections) data.collections = {};
        return BeeStore.chartSeed.applyToData(data);
      },
    },
    {
      // A2: tracked inventory value. Replays every legacy stock movement with
      // its historical unit cost so existing data keeps its old gross value
      // (no retrospective discount reallocation), then backfills the fields
      // new postings and reports rely on. No journal entries are created here:
      // A3 replays the documents into the journal.
      from: 4,
      to: 5,
      migrate(data) {
        if (!data.collections) data.collections = {};
        const C = data.collections;
        if (!Array.isArray(C.journalEntries)) C.journalEntries = [];
        const round = (v) => Math.round(Number(v) || 0);
        const ensureLinks = (doc) => {
          if (!Array.isArray(doc.journalEntryIds)) doc.journalEntryIds = [];
        };

        for (const sale of (C.sales || [])) {
          ensureLinks(sale);
          let totalCogs = 0;
          for (const line of (sale.lines || [])) {
            const qty = Number(line.qty) || 0;
            const cogs = line.cogsMinor != null
              ? round(line.cogsMinor)
              : round((Number(line.unitCostMinor) || 0) * qty);
            line.cogsMinor = cogs;
            if (line.costEstimated === undefined) line.costEstimated = false;
            if (line.costFlag === undefined) {
              line.costFlag = line.costEstimated ? 'COST_ESTIMATED' : null;
            }
            if (line.returnedCostMinor === undefined) {
              const returned = Number(line.returnedQty) || 0;
              line.returnedCostMinor = qty > 0
                ? Math.round(cogs * returned / qty)
                : 0;
            }
            if (line.returnedDiscountMinor === undefined) {
              line.returnedDiscountMinor = 0;
            }
            totalCogs += cogs;
          }
          if (sale.cogsMinor === undefined) sale.cogsMinor = totalCogs;
          if (sale.costEstimated === undefined) sale.costEstimated = false;
          if (sale.costFlag === undefined) {
            sale.costFlag = sale.costEstimated ? 'COST_ESTIMATED' : null;
          }
        }

        for (const ret of (C.salesReturns || [])) {
          ensureLinks(ret);
          let totalRestock = 0;
          for (const line of (ret.lines || [])) {
            const qty = Number(line.qty) || 0;
            const originalCost = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.returnedCostMinor === undefined) line.returnedCostMinor = originalCost;
            if (line.restockCostMinor === undefined) {
              line.restockCostMinor = line.restock === false ? 0 : originalCost;
            }
            if (line.valueChangeMinor === undefined) line.valueChangeMinor = 0;
            totalRestock += round(line.restockCostMinor);
          }
          if (ret.restockCostMinor === undefined) ret.restockCostMinor = totalRestock;
        }

        // Reconstruct the line discount already refunded by legacy returns so
        // the next partial return takes the exact remainder (v5 §3.1). The
        // old refund formula was unitPrice × qty − rounded discount, so the
        // difference is the discount actually granted.
        const saleById = new Map((C.sales || []).map(s => [s.id, s]));
        for (const ret of (C.salesReturns || [])) {
          const sale = saleById.get(ret.saleId);
          if (!sale || !Array.isArray(sale.lines)) continue;
          for (const line of (ret.lines || [])) {
            const saleLine = sale.lines[Number(line.saleLineIndex)];
            if (!saleLine || line.lineRefundMinor == null) continue;
            const qty = Number(line.qty) || 0;
            const unitPrice = line.unitPriceMinor != null
              ? round(line.unitPriceMinor)
              : round(saleLine.unitPriceMinor);
            const discount = Math.max(0,
              round(unitPrice * qty) - round(line.lineRefundMinor));
            const lineDiscount = Math.max(0, round(saleLine.lineDiscountMinor));
            saleLine.returnedDiscountMinor = Math.min(lineDiscount,
              round(saleLine.returnedDiscountMinor) + discount);
          }
        }

        for (const purchase of (C.purchases || [])) {
          ensureLinks(purchase);
          let totalValue = 0;
          for (const line of (purchase.lines || [])) {
            const qty = Number(line.qty) || 0;
            const gross = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.grossMinor === undefined) line.grossMinor = gross;
            if (line.discountMinor === undefined) line.discountMinor = 0;
            if (line.inventoryValueMinor === undefined) {
              // Preserve the old document-derived inventory value exactly.
              line.inventoryValueMinor = gross;
            }
            if (line.netUnitCostMinor === undefined) {
              line.netUnitCostMinor = qty > 0
                ? Math.round(line.inventoryValueMinor / qty)
                : (Number(line.unitCostMinor) || 0);
            }
            if (line.returnedValueMinor === undefined) line.returnedValueMinor = 0;
            totalValue += round(line.inventoryValueMinor);
          }
          if (purchase.inventoryValueMinor === undefined) {
            purchase.inventoryValueMinor = totalValue;
          }
        }

        for (const ret of (C.purchaseReturns || [])) {
          ensureLinks(ret);
          let totalValue = 0;
          for (const line of (ret.lines || [])) {
            const qty = Number(line.qty) || 0;
            const fallback = round((Number(line.unitCostMinor) || 0) * qty);
            if (line.valueMinor === undefined) {
              line.valueMinor = line.lineTotalMinor != null
                ? round(line.lineTotalMinor)
                : fallback;
            }
            if (line.lineTotalMinor === undefined) line.lineTotalMinor = line.valueMinor;
            if (line.removedValueMinor === undefined) line.removedValueMinor = line.valueMinor;
            if (line.differenceMinor === undefined) {
              line.differenceMinor = round(line.valueMinor - line.removedValueMinor);
            }
            totalValue += round(line.valueMinor);
          }
          if (ret.totalMinor === undefined) ret.totalMinor = totalValue;
        }

        // Replay tracked value in the same date/created order as the stock
        // ledger. Movements already carrying value (a partially migrated or
        // re-imported dump) keep that exact value; all others use their
        // historical unit cost so old reports keep the same gross figures.
        const byVariant = {};
        const movements = C.stockMovements || [];
        for (let i = 0; i < movements.length; i++) {
          const m = movements[i];
          ensureLinks(m);
          if (!m.variantId) continue;
          (byVariant[m.variantId] = byVariant[m.variantId] || []).push({ m, i });
        }
        const replay = {};
        for (const variantId of Object.keys(byVariant)) {
          const seq = byVariant[variantId].sort((a, b) =>
            String(a.m.date || '').localeCompare(String(b.m.date || '')) ||
            String(a.m.createdAt || '').localeCompare(String(b.m.createdAt || '')) ||
            a.i - b.i);
          let qty = 0;
          let value = 0;
          let lastCost = 0;
          for (const entry of seq) {
            const m = entry.m;
            const q = Number(m.qtyChange) || 0;
            const unitCost = round(m.unitCostMinor);
            let valueChange;
            if (m.valueChangeMinor != null) {
              valueChange = round(m.valueChangeMinor);
            } else if (m.type === 'revaluation') {
              valueChange = 0;
            } else {
              // Signed movement value: opening/purchase/void_sale positive,
              // sale/purchase_return/void_purchase negative, adjustments by
              // their own signed quantity.
              valueChange = round(q * unitCost);
            }
            m.valueChangeMinor = valueChange;
            value += valueChange;
            qty += q;
            if (m.type === 'opening' || qty > 0) {
              if (value >= 0 && qty > 0) lastCost = Math.round(value / qty);
            }
            m.valueAfterMinor = round(value);
            const derived = qty > 0 && value >= 0 ? Math.round(value / qty) : 0;
            m.avgCostAfterMinor = derived || lastCost || unitCost;
          }
          replay[variantId] = { qty, value, lastCost };
        }

        for (const variant of (C.variants || [])) {
          ensureLinks(variant);
          const qty = Number(variant.quantity) || 0;
          const oldCost = round(variant.costMinor);
          const state = replay[variant.id];
          if (state) {
            variant.valueMinor = round(state.value);
            if (qty > 0 && variant.valueMinor >= 0) {
              variant.costMinor = Math.round(variant.valueMinor / qty);
            } else if (state.lastCost >= 0) {
              variant.costMinor = state.lastCost;
            }
          } else if (variant.valueMinor == null) {
            variant.valueMinor = round(qty * oldCost);
          }
        }

        return data;
      },
    },
    {
      // A3: post the historical documents into the journal. The replay itself
      // runs at startup (needs a live repository), so this migration only
      // marks that it is required, fixes purchase dues to the v5 cash-refund
      // rule and seeds the conditional tax account for legacy tax data.
      from: 5,
      to: 6,
      migrate(data) {
        if (!data.collections) data.collections = {};
        const C = data.collections;
        BeeStore.chartSeed.applyToData(data);
        const round = (v) => Math.round(Number(v) || 0);

        // v5 §4 row 7: only a payable-reducing return lowers the purchase
        // due. Legacy cash refunds used to reduce it as well; add those back
        // by recomputing from the invoice itself.
        const reducedByPurchase = new Map();
        for (const ret of (C.purchaseReturns || [])) {
          if (ret.mode === 'cash_refund') continue;
          const id = ret.purchaseId;
          if (!id) continue;
          reducedByPurchase.set(id, (reducedByPurchase.get(id) || 0) + round(ret.totalMinor));
        }
        for (const purchase of (C.purchases || [])) {
          const total = purchase.totalMinor != null
            ? round(purchase.totalMinor)
            : round(purchase.inventoryValueMinor);
          const paid = round(purchase.paidMinor);
          const reduced = reducedByPurchase.get(purchase.id) || 0;
          purchase.dueMinor = total - paid - reduced;
          if (purchase.status !== 'void') {
            purchase.status = purchase.dueMinor <= 0 ? 'paid'
              : (paid > 0 ? 'partial' : 'unpaid');
          }
        }

        // v5 §4 row 2: replay needs the AR/credit split of old collections.
        // Reconstruct the customer position in date order: opening receivable,
        // sales, embedded receipts, credit returns and then each collection.
        // A payment only clears AR up to the positive balance; the rest is a
        // 2030 credit, exactly like the live posting rule.
        const paymentEvents = new Map();
        const addEvent = (customerId, event) => {
          if (!customerId) return;
          if (!paymentEvents.has(customerId)) paymentEvents.set(customerId, []);
          paymentEvents.get(customerId).push(event);
        };
        for (const sale of (C.sales || [])) {
          if (sale.status === 'void' || sale.voided) continue;
          addEvent(sale.customerId, {
            date: sale.date || '', createdAt: sale.createdAt || '',
            priority: 0, kind: 'sale', amount: round(sale.totalMinor), id: sale.id,
          });
          const payments = Array.isArray(sale.payments) ? sale.payments : [];
          for (let i = 0; i < payments.length; i++) {
            addEvent(sale.customerId, {
              date: payments[i].date || sale.date || '',
              createdAt: sale.createdAt || '',
              priority: 1, order: i, kind: 'receipt',
              amount: round(payments[i].amountMinor), id: sale.id,
            });
          }
        }
        for (const ret of (C.salesReturns || [])) {
          if (ret.refundMode !== 'customer_credit' && ret.refundMode !== 'exchange') continue;
          addEvent(ret.customerId, {
            date: ret.date || '', createdAt: ret.createdAt || '',
            priority: 2, kind: 'return', amount: round(ret.refundMinor), id: ret.id,
          });
        }
        for (const payment of (C.customerPayments || [])) {
          addEvent(payment.customerId, {
            date: payment.date || '', createdAt: payment.createdAt || '',
            priority: 3, kind: 'payment', amount: round(payment.amountMinor),
            id: payment.id, payment,
          });
        }
        const customerOpening = new Map((C.customers || []).map(c =>
          [c.id, round(c.openingBalanceMinor)]));
        for (const [customerId, events] of paymentEvents) {
          events.sort((a, b) =>
            String(a.date).localeCompare(String(b.date)) ||
            String(a.createdAt).localeCompare(String(b.createdAt)) ||
            (a.priority - b.priority) ||
            ((a.order || 0) - (b.order || 0)) ||
            String(a.id).localeCompare(String(b.id)));
          let balance = customerOpening.get(customerId) || 0;
          for (const event of events) {
            if (event.kind === 'sale') balance += event.amount;
            else if (event.kind === 'return' || event.kind === 'receipt') balance -= event.amount;
            else {
              if (event.payment.appliedMinor == null) {
                event.payment.appliedMinor = Math.min(event.amount, Math.max(0, balance));
              }
              balance -= event.amount;
            }
          }
        }

        const meta = data.meta || (C.meta || []).find(m => m && m.id === 'meta');
        if (meta) {
          meta.journalReplay = {
            ...(meta.journalReplay || {}),
            needed: true,
            version: 1,
          };
        }
        return data;
      },
    },
    {
      // A4: card/wallet settlements are new documents. Historical receipts
      // deliberately keep their legacy account routing; only documents created
      // from this schema onward carry an explicit clearing method snapshot.
      from: 6,
      to: 7,
      migrate(data) {
        if (!data.collections) data.collections = {};
        if (!Array.isArray(data.collections.cardSettlements)) {
          data.collections.cardSettlements = [];
        }
        return data;
      },
    },
    {
      // A4.2: every expense before this schema was paid in full at recording
      // time. Preserve that exact economic meaning (and therefore historical
      // journal routing) while introducing the unpaid/partial sub-ledger.
      from: 7,
      to: 8,
      migrate(data) {
        if (!data.collections) data.collections = {};
        if (!Array.isArray(data.collections.expensePayments)) {
          data.collections.expensePayments = [];
        }
        for (const expense of (data.collections.expenses || [])) {
          if (!expense) continue;
          const amount = Math.round(Number(expense.amountMinor) || 0);
          if (expense.paidMinor === undefined || expense.paidMinor === null) {
            expense.paidMinor = amount;
          }
          expense.paidMinor = Math.max(0, Math.min(amount,
            Math.round(Number(expense.paidMinor) || 0)));
          if (expense.initialPaidMinor === undefined || expense.initialPaidMinor === null) {
            expense.initialPaidMinor = expense.paidMinor;
          }
          expense.initialPaidMinor = Math.max(0, Math.min(amount,
            Math.round(Number(expense.initialPaidMinor) || 0)));
          if (!expense.paymentStatus) {
            expense.paymentStatus = expense.paidMinor >= amount ? 'paid'
              : (expense.paidMinor > 0 ? 'partial' : 'unpaid');
          }
          if (expense.payee === undefined) expense.payee = '';
          if (expense.dueDate === undefined) expense.dueDate = null;
        }
        return data;
      },
    },
    {
      // A4.3: payroll components, payroll liability payments and the fixed
      // asset register are new. Existing payrolls had no withholding/
      // employer/EOS components, so zeros preserve their exact posting.
      from: 8,
      to: 9,
      migrate(data) {
        if (!data.collections) data.collections = {};
        const C = data.collections;
        for (const name of ['payrollLiabilityPayments', 'fixedAssets',
          'fixedAssetPayments']) {
          if (!Array.isArray(C[name])) C[name] = [];
        }
        for (const payroll of (C.payroll || [])) {
          if (!payroll) continue;
          if (payroll.withholdingMinor === undefined ||
            payroll.withholdingMinor === null) payroll.withholdingMinor = 0;
          if (payroll.employerCostMinor === undefined ||
            payroll.employerCostMinor === null) payroll.employerCostMinor = 0;
          if (payroll.endOfServiceMinor === undefined ||
            payroll.endOfServiceMinor === null) payroll.endOfServiceMinor = 0;
          if (!Array.isArray(payroll.payrollComponentSnapshot)) {
            payroll.payrollComponentSnapshot = [];
          }
        }
        const settings = data.settings ||
          (data.meta && data.meta.id === 'settings' ? data.meta : null) ||
          (C.meta || []).find(m => m && m.id === 'settings');
        if (settings) {
          if (!Array.isArray(settings.payrollComponents)) {
            settings.payrollComponents = [
              { id: 'withholding', nameAr: 'استقطاعات الموظف (تأمين/ضريبة)', type: 'employee_withholding', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
              { id: 'employer_cost', nameAr: 'مساهمة صاحب العمل', type: 'employer_cost', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
              { id: 'end_of_service', nameAr: 'مخصص نهاية الخدمة', type: 'end_of_service', enabled: false, rateBasisPoints: 0, fixedMinor: 0, accountId: null },
            ];
          }
          if (settings.fixedAssetsEnabled === undefined) {
            settings.fixedAssetsEnabled = false;
          }
          if (settings.capitalizationWarnThresholdMinor === undefined) {
            settings.capitalizationWarnThresholdMinor = 50000;
          }
        }
        return data;
      },
    },
    {
      // v4 M1/M3/M7 (schema 10):
      // - items become category-independent with a human item code, optional
      //   variants and a precomputed search key;
      // - sale lines snapshot the list price and receipts split the physical
      //   amount from the portion applied to the invoice;
      // - historical overpayments keep their old accounting meaning and are
      //   explicitly tagged customer_credit;
      // - returns gain the no-reference/mixed mode fields.
      from: 9,
      to: 10,
      migrate(data) {
        if (!data.collections) data.collections = {};
        const C = data.collections;
        if (!Array.isArray(C.products)) C.products = [];
        if (!Array.isArray(C.variants)) C.variants = [];
        if (!Array.isArray(C.sales)) C.sales = [];
        if (!Array.isArray(C.salesReturns)) C.salesReturns = [];

        const normalize = (value) => String(value == null ? '' : value)
          .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
          .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
          .replace(/\u0649/g, '\u064A')
          .replace(/\u0629/g, '\u0647')
          .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
          .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        const keyFor = (product, variant) => normalize([
          product && product.name, product && product.brand,
          product && product.itemCode, product && product.notes,
          product && product.unit,
          variant && variant.size, variant && variant.color,
          variant && variant.itemCode, variant && variant.barcode,
          variant && variant.sku,
        ].filter(Boolean).join(' '));

        const variantsByProduct = new Map();
        for (const variant of C.variants) {
          if (!variant) continue;
          if (!variantsByProduct.has(variant.productId)) {
            variantsByProduct.set(variant.productId, []);
          }
          variantsByProduct.get(variant.productId).push(variant);
        }

        // Item codes are sequential from 1001. Explicit numeric codes already
        // present in a future backup advance the same sequence.
        let counter = 0;
        const usedCodes = new Set();
        for (const product of C.products) {
          if (!product) continue;
          product.unit = String(product.unit || 'قطعة').trim() || 'قطعة';
          if (product.notes === undefined || product.notes === null) {
            product.notes = product.description || '';
          }
          if (product.lowStockThreshold === undefined) {
            product.lowStockThreshold = null;
          }
          if (!product.itemCode) {
            const siblings = variantsByProduct.get(product.id) || [];
            const dims = siblings.filter(v => (v && v.size) || (v && v.color));
            product.hasVariants = siblings.length > 1 || dims.length > 0;
          } else if (product.hasVariants === undefined ||
            product.hasVariants === null) {
            const siblings = variantsByProduct.get(product.id) || [];
            product.hasVariants = siblings.length > 1 ||
              siblings.some(v => v && (v.size || v.color));
          }
          if (product.itemCode) {
            usedCodes.add(String(product.itemCode).trim());
            const numeric = Number(product.itemCode);
            if (Number.isInteger(numeric) && numeric >= 1001) {
              counter = Math.max(counter, numeric - 1000);
            }
          }
        }
        for (const product of C.products) {
          if (!product) continue;
          if (!product.itemCode) {
            let next = counter + 1;
            while (usedCodes.has(String(1000 + next))) next++;
            counter = next;
            product.itemCode = String(1000 + counter);
            usedCodes.add(product.itemCode);
          }
          const siblings = variantsByProduct.get(product.id) || [];
          if (product.hasVariants === false && siblings.length === 1 &&
            product.defaultVariantId == null) {
            product.defaultVariantId = siblings[0].id;
          } else if (product.hasVariants === false && siblings.length > 1) {
            // More than one stored variant means the item really does have
            // variants, even if no dimension text was ever filled in.
            product.hasVariants = true;
          }
          product.searchKey = keyFor(product, null);
        }

        // Variants inherit a unique code: default variants may share the parent
        // code, dimensioned variants get parentCode-1, parentCode-2, ...
        const productMap = new Map();
        for (const product of C.products) {
          if (product) productMap.set(product.id, product);
        }
        const variantCodeUsed = new Set();
        for (const product of C.products) {
          if (!product) continue;
          const siblings = variantsByProduct.get(product.id) || [];
          siblings.forEach((variant, index) => {
            if (!variant) return;
            variant.unit = String(variant.unit || product.unit || 'قطعة').trim() || 'قطعة';
            if (!variant.itemCode) {
              variant.itemCode = siblings.length === 1 &&
                !variant.size && !variant.color
                ? product.itemCode
                : product.itemCode + '-' + (index + 1);
            }
            let code = String(variant.itemCode).trim();
            if (variantCodeUsed.has(code)) {
              code = product.itemCode + '-' + (index + 1);
              let suffix = index + 1;
              while (variantCodeUsed.has(code)) {
                suffix++;
                code = product.itemCode + '-' + suffix;
              }
              variant.itemCode = code;
            }
            variantCodeUsed.add(code);
            variant.searchKey = keyFor(product, variant);
          });
        }

        const variantMap = new Map();
        for (const variant of C.variants) {
          if (variant) variantMap.set(variant.id, variant);
        }

        for (const sale of C.sales) {
          if (!sale) continue;
          let remaining = Math.max(0, Math.round(Number(sale.totalMinor) || 0));
          let tendered = 0;
          for (const payment of (sale.payments || [])) {
            if (!payment) continue;
            const amount = Math.max(0, Math.round(Number(payment.amountMinor) || 0));
            const applied = Math.max(0, Math.min(amount, remaining));
            payment.appliedMinor = applied;
            payment.changeMinor = 0;
            remaining -= applied;
            tendered += amount;
          }
          sale.overpaymentMinor = Math.max(0, tendered - (Number(sale.totalMinor) || 0));
          if (sale.overpaymentMinor > 0) {
            // Historically the excess was always posted to 2030. Keep that
            // exact meaning instead of silently turning old money into income.
            sale.overpaymentMode = 'customer_credit';
          } else {
            sale.overpaymentMode = null;
            sale.overpaymentMinor = 0;
          }
          sale.changeGivenMinor = 0;
          for (const line of (sale.lines || [])) {
            if (!line) continue;
            const variant = variantMap.get(line.variantId);
            if (line.itemCode === undefined) {
              line.itemCode = variant ? (variant.itemCode || variant.sku || '') : '';
            }
            if (line.listPriceMinor === undefined || line.listPriceMinor === null) {
              // The catalog price at the time is unknowable; the recorded
              // unit price is the safest snapshot and produces no false
              // price-variance in historical reports.
              line.listPriceMinor = Math.round(Number(line.unitPriceMinor) || 0);
            }
            if (line.priceDiffMinor === undefined || line.priceDiffMinor === null) {
              line.priceDiffMinor = 0;
            }
          }
        }

        for (const ret of C.salesReturns) {
          if (!ret) continue;
          if (!Array.isArray(ret.flags)) {
            ret.flags = ret.saleId ? [] : ['NO_REFERENCE'];
          }
          if (!ret.mode) {
            ret.mode = ret.saleId ? 'linked' : 'unlinked';
          }
          if (ret.customerName === undefined) ret.customerName = null;
          for (const line of (ret.lines || [])) {
            if (!line) continue;
            if (line.reference === undefined) line.reference = ret.saleId || null;
            const variant = variantMap.get(line.variantId);
            if (line.itemCode === undefined) {
              line.itemCode = variant ? (variant.itemCode || variant.sku || '') : '';
            }
            if (line.listPriceMinor === undefined || line.listPriceMinor === null) {
              line.listPriceMinor = Math.round(Number(line.unitPriceMinor) || 0);
            }
          }
        }

        const settings = data.settings ||
          (data.meta && data.meta.id === 'settings' ? data.meta : null) ||
          (C.meta || []).find(m => m && m.id === 'settings');
        if (settings) {
          if (settings.cashierUnlinkedReturnLimitMinor === undefined) {
            settings.cashierUnlinkedReturnLimitMinor = 0;
          }
        }

        const meta = (data.meta && data.meta.id === 'meta' ? data.meta : null) ||
          (C.meta || []).find(m => m && m.id === 'meta');
        if (meta) {
          if (!meta.counters) meta.counters = {};
          meta.counters.itemCode = Math.max(
            Number(meta.counters.itemCode) || 0, counter);
        }
        return data;
      },
    },
  ];

  async function migrate(data, currentVersion) {
    let version = data.schemaVersion || 1;
    for (const m of migrations) {
      if (version >= m.from && version < m.to) {
        data = await m.migrate(data);
        version = m.to;
      }
    }
    data.schemaVersion = Math.max(version, currentVersion || version);
    if (data.meta) data.meta.schemaVersion = data.schemaVersion;
    return data;
  }

  BeeStore.migrations = { migrate, migrations };
  if (typeof module !== 'undefined') module.exports = { migrate, migrations };
})(typeof window !== 'undefined' ? window : globalThis);
