(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  async function loadDemoData() {
    const repo = BeeStore.repo;
    if (!repo) return;

    const cat1 = await BeeStore.categories.create({ name: 'أولاد' });
    const cat2 = await BeeStore.categories.create({ name: 'بنات' });
    const cat3 = await BeeStore.categories.create({ name: 'مواليد' });
    const cat4 = await BeeStore.categories.create({ name: 'أحذية' });
    const cat5 = await BeeStore.categories.create({ name: 'إكسسوارات' });

    const sizeList = ['3-6M', '6-9M', '9-12M', '12-18M', '18-24M', '2Y', '3Y', '4Y', '5Y'];
    const colorList = [
      { name: 'أبيض', hex: '#FFFFFF' },
      { name: 'أسود', hex: '#000000' },
      { name: 'أزرق', hex: '#0000FF' },
      { name: 'وردي', hex: '#FFC0CB' },
      { name: 'رمادي', hex: '#808080' },
    ];

    const productsData = [
      { name: 'تيشيرت قطني', categoryId: cat1.id, gender: 'boys', cost: 1500, price: 3500 },
      { name: 'فستان صيفي', categoryId: cat2.id, gender: 'girls', cost: 2500, price: 5500 },
      { name: 'طقم مواليد', categoryId: cat3.id, gender: 'baby', cost: 3000, price: 6500 },
      { name: 'حذاء رياضي', categoryId: cat4.id, gender: 'unisex', cost: 4000, price: 8500 },
      { name: 'قبعة أطفال', categoryId: cat5.id, gender: 'unisex', cost: 800, price: 2000 },
      { name: 'جينز أطفال', categoryId: cat1.id, gender: 'boys', cost: 2000, price: 4500 },
      { name: 'بلوزة شتوية', categoryId: cat2.id, gender: 'girls', cost: 1800, price: 4000 },
      { name: 'بيجاما نوم', categoryId: cat3.id, gender: 'baby', cost: 1200, price: 2800 },
      { name: 'جوارب أطفال', categoryId: cat5.id, gender: 'unisex', cost: 300, price: 800 },
      { name: 'معطف شتوي', categoryId: cat1.id, gender: 'boys', cost: 5000, price: 11000 },
    ];

    const allVariants = [];
    for (const pd of productsData) {
      const variants = [];
      for (const size of sizeList.slice(0, 4)) {
        for (const color of colorList.slice(0, 3)) {
          variants.push({
            size,
            color: color.name,
            quantity: Math.floor(Math.random() * 20) + 5,
            costMinor: pd.cost,
            priceMinor: pd.price,
          });
        }
      }
      const prod = await BeeStore.products.create({
        ...pd,
        defaultCostMinor: pd.cost,
        defaultPriceMinor: pd.price,
        variants,
      });
      const createdProduct = await BeeStore.products.getWithVariants(prod.id);
      for (const v of createdProduct.variants) {
        allVariants.push({ ...v, productName: pd.name });
      }
    }

    const supplier1 = await BeeStore.suppliers.create({ name: 'شركة النسيج', phone: '0501234567' });
    const supplier2 = await BeeStore.suppliers.create({ name: 'مصنع الأحذية', phone: '0509876543' });

    const customer1 = await BeeStore.customers.create({ name: 'أحمد محمد', phone: '0501112233', address: 'شارع الملك فهد' });
    const customer2 = await BeeStore.customers.create({ name: 'سارة علي', phone: '0504445566', address: 'شارع العليا' });
    const customer3 = await BeeStore.customers.create({ name: 'خالد عبدالله', phone: '0507778899', address: 'شارع التحلية' });

    const today = BeeStore.dates.today();
    let earliest = today;
    for (let i = 0; i < 30; i++) {
      const date = BeeStore.dates.addDays(today, -i);
      if (date < earliest) earliest = date;
      const salesCount = Math.floor(Math.random() * 5) + 1;
      for (let j = 0; j < salesCount; j++) {
        const variant = allVariants[Math.floor(Math.random() * allVariants.length)];
        const customer = Math.random() > 0.5 ? [customer1, customer2, customer3][Math.floor(Math.random() * 3)] : null;
        const qty = Math.floor(Math.random() * 3) + 1;
        const data = {
          date,
          customerId: customer ? customer.id : null,
          customerName: customer ? customer.name : null,
          lines: [{ variantId: allVariants.find(v => v.productId === variant.productId && v.size === variant.size && v.color === variant.color)?.id || variant.productId, qty, unitPriceMinor: variant.priceMinor }],
        };
        try { await BeeStore.sales.create(data); } catch (e) { /* ignore */ }
      }
    }

    await BeeStore.expenses.createCategory({ name: 'إيجار' });
    await BeeStore.expenses.createCategory({ name: 'كهرباء' });
    await BeeStore.expenses.createCategory({ name: 'ماء' });

    await BeeStore.expenses.create({ amountMinor: 50000, categoryId: null, categoryName: 'إيجار', description: 'إيجار المحل', date: today });
    await BeeStore.expenses.create({ amountMinor: 15000, categoryId: null, categoryName: 'كهرباء', description: 'فاتورة كهرباء', date: BeeStore.dates.addDays(today, -5) });

    const emp1 = await BeeStore.employees.create({ name: 'محمد أحمد', phone: '0501234567', position: 'كاشير', baseSalaryMinor: 150000 });
    const emp2 = await BeeStore.employees.create({ name: 'فاطمة علي', phone: '0509876543', position: 'بائعة', baseSalaryMinor: 120000 });

    await BeeStore.payroll.prepare(BeeStore.dates.monthKey(today));

    await BeeStore.payroll.createAdvance({ employeeId: emp1.id, amountMinor: 30000 });

    // Demo documents predate the wizard default (first of current month);
    // move the start date back so period validation accepts them.
    await BeeStore.settings.save({ systemStartDate: earliest.slice(0, 7) + '-01' });
  }

  BeeStore.loadDemoData = loadDemoData;
  if (typeof module !== 'undefined') module.exports = { loadDemoData };
})(typeof window !== 'undefined' ? window : globalThis);
