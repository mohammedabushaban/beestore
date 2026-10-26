#!/usr/bin/env python3
"""L10 offline PWA check (headless Chromium + ChromeDriver CDP).

Prerequisites:
  python3 -m http.server 8765      # from the repository root
  chromedriver --port=9515
  python3 tests/verify-offline.py  # optional URL as argv[1]

It seeds a fresh origin, waits for the service worker to control the page,
then switches the network off with CDP and verifies that:
  * `index.html` starts from the precache,
  * settings/accounts are readable from IndexedDB,
  * an invoice posts and survives a second offline reload.
"""
import base64
import json
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:9515'
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/index.html'


def req(method, path, data=None, timeout=300):
    body = None if data is None else json.dumps(data).encode()
    r = urllib.request.Request(BASE + path, data=body, method=method,
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def main():
    session = req('POST', '/session', {
        'capabilities': {'alwaysMatch': {
            'browserName': 'chrome',
            'goog:chromeOptions': {
                'args': ['--headless=new', '--no-sandbox', '--disable-gpu',
                         '--disable-dev-shm-usage', '--window-size=1280,900'],
            },
        }},
    })['value']
    sid = session['sessionId']
    checks = []

    def js(script):
        return req('POST', f'/session/{sid}/execute/sync',
                   {'script': script, 'args': []})['value']

    def cdp(cmd, params=None):
        return req('POST', f'/session/{sid}/goog/cdp/execute',
                   {'cmd': cmd, 'params': params or {}})['value']

    def check(name, cond, detail=''):
        checks.append({'name': name, 'ok': bool(cond), 'detail': str(detail)})
        print(('PASS' if cond else 'FAIL'), name, ('- ' + str(detail)) if detail else '')

    def wait_for(script, seconds=40):
        end = time.time() + seconds
        last = None
        while time.time() < end:
            try:
                last = js(script)
                if last:
                    return last
            except Exception as e:
                last = str(e)
            time.sleep(0.4)
        return last

    def online():
        cdp('Network.emulateNetworkConditions', {
            'offline': False, 'latency': 0,
            'downloadThroughput': -1, 'uploadThroughput': -1,
        })

    def offline():
        cdp('Network.emulateNetworkConditions', {
            'offline': True, 'latency': 0,
            'downloadThroughput': 0, 'uploadThroughput': 0,
        })

    try:
        cdp('Network.enable')
        req('POST', f'/session/{sid}/url', {'url': URL + '?seed=0'})
        wait_for("return !!(window.BeeStore && BeeStore.api && BeeStore.repo && BeeStore.repo.opened)", 30)

        js("""
window.__seed = 'running';
(async () => {
  const stored = await BeeStore.repo.get('meta', 'settings');
  if (stored) { window.__seed = 'exists'; return; }
  const firstOfMonth = BeeStore.dates.today().slice(0, 7) + '-01';
  const cash = (await BeeStore.api.accounts.create({
    name: 'الصندوق', type: 'cash', openingBalanceMinor: 50000,
  })).data;
  await BeeStore.api.settings.save({
    storeNameAr: 'متجر بلا إنترنت', systemStartDate: firstOfMonth,
    cashDrawerAccountId: cash.id,
    paymentMethods: [{ id: 'cash', name: 'نقداً', accountId: cash.id }],
  });
  const product = (await BeeStore.api.products.create({
    name: 'قميص أطفال', defaultCostMinor: 1000, defaultPriceMinor: 5000,
  })).data;
  const variant = (await BeeStore.api.variants.create({
    productId: product.id, size: 'M', color: 'أزرق', barcode: 'OFFLINE-1',
    quantity: 20, costMinor: 1000, priceMinor: 5000, date: firstOfMonth,
  })).data;
  window.__seed = JSON.stringify({ cash: cash.id, variant: variant.id });
})().catch(e => { window.__seed = 'error:' + (e && e.stack || e); });
return 'started';
""")
        seeded = wait_for("return window.__seed === 'running' ? null : window.__seed;", 40)
        check('seed settings and stock online', seeded and seeded.startswith('{'), seeded)
        ids = json.loads(seeded) if seeded and seeded.startswith('{') else {}

        # Reload with settings so the wizard is skipped, then wait for the SW
        # to be installed and controlling the page.
        req('POST', f'/session/{sid}/url', {'url': URL + '?seed=1'})
        wait_for("return !!(window.BeeStore && BeeStore.api && BeeStore.repo && BeeStore.repo.opened)", 30)
        js("""
window.__swReady = false;
(async () => {
  const reg = await navigator.serviceWorker.ready;
  window.__swReady = !!(reg && reg.active);
})().catch(() => { window.__swReady = false; });
return true;
""")
        ready = wait_for("return window.__swReady === true;", 30)
        check('service worker is ready', ready, ready)
        controller = js("return !!(navigator.serviceWorker && navigator.serviceWorker.controller);")
        if not controller:
            req('POST', f'/session/{sid}/url', {'url': URL + '?seed=2'})
            wait_for("return !!(window.BeeStore && BeeStore.api && BeeStore.repo && BeeStore.repo.opened)", 30)
            controller = js("return !!(navigator.serviceWorker && navigator.serviceWorker.controller);")
        check('service worker controls the page', controller, controller)

        js("""
window.__cacheInfo = null;
(async () => {
  const keys = await caches.keys();
  const name = keys.find(k => k.indexOf('beestore-v3-lite-') === 0);
  if (!name) { window.__cacheInfo = { name: null }; return; }
  const cache = await caches.open(name);
  const req = new Request(location.origin + '/index.html');
  window.__cacheInfo = { name, hasIndex: !!(await cache.match(req)), count: (await cache.keys()).length };
})().catch(e => { window.__cacheInfo = { error: String(e) }; });
return true;
""")
        wait_for("return window.__cacheInfo;", 20)
        cache = js("return window.__cacheInfo;")
        check('app shell cache contains index.html', cache and cache.get('hasIndex'), cache)
        check('precache has a realistic file count', cache and cache.get('count', 0) >= 90,
              cache.get('count') if cache else None)

        # Offline start: navigation must be served by the service worker.
        offline()
        try:
            req('POST', f'/session/{sid}/url', {'url': URL + '?offline=1'})
            nav_error = None
        except Exception as e:
            nav_error = str(e)
        started = wait_for("return !!(window.BeeStore && BeeStore.api && BeeStore.repo && BeeStore.repo.opened)", 30)
        check('offline reload starts the app from cache', started and not nav_error,
              nav_error or '')
        body = js("return document.body ? document.body.innerText.slice(0, 1200) : '';")
        check('offline page is the Arabic app shell', 'بي ستور' in body and 'الرئيسية' in body,
              body.split('\n')[:3])

        js("""
window.__storage = null;
(async () => {
  const s = await BeeStore.repo.get('meta', 'settings');
  const cash = await BeeStore.repo.get('accounts', %s);
  window.__storage = { store: s && s.storeNameAr, cash: cash && cash.name };
})().catch(e => { window.__storage = { error: String(e) }; });
return true;
""" % json.dumps(ids.get('cash')))
        wait_for("return window.__storage;", 20)
        storage = js("return window.__storage;")
        check('offline data is readable from IndexedDB', storage and storage.get('store') == 'متجر بلا إنترنت', storage)

        js("""
window.__sale = null;
(async () => {
  const sale = await BeeStore.api.sales.create({
    date: BeeStore.dates.today(),
    lines: [{ variantId: %s, qty: 1, unitPriceMinor: 5000 }],
    payments: [{ method: 'cash', accountId: %s, amountMinor: 5000, date: BeeStore.dates.today() }],
    clientKey: 'offline-sale-1',
  });
  if (!sale.ok) { window.__sale = { ok: false, error: sale.error }; return; }
  const stored = await BeeStore.repo.get('sales', sale.data.id);
  window.__sale = { ok: true, id: sale.data.id, number: sale.data.number, total: stored && stored.totalMinor };
})().catch(e => { window.__sale = { ok: false, error: String(e && e.stack || e) }; });
return true;
""" % (json.dumps(ids.get('variant')), json.dumps(ids.get('cash'))))
        wait_for("return window.__sale;", 30)
        created = js("return window.__sale;")
        check('offline invoice posts and persists', created and created.get('ok') and created.get('total') == 5000,
              created)

        # Reload offline once more to prove the invoice survives a restart.
        req('POST', f'/session/{sid}/url', {'url': URL + '?offline=2'})
        wait_for("return !!(window.BeeStore && BeeStore.api && BeeStore.repo && BeeStore.repo.opened)", 30)
        js("""
window.__offlineCount = null;
(async () => {
  const rows = await BeeStore.repo.list('sales');
  window.__offlineCount = rows.filter(s => s.clientKey === 'offline-sale-1').length;
})().catch(e => { window.__offlineCount = -1; });
return true;
""")
        wait_for("return window.__offlineCount !== null;", 20)
        count = js("return window.__offlineCount;")
        check('offline invoice survives a second reload', count == 1, count)

        online()
        shot = req('GET', f'/session/{sid}/screenshot')['value']
        with open('/tmp/opencode/offline.png', 'wb') as f:
            f.write(base64.b64decode(shot))
        print(json.dumps({'checks': checks}, ensure_ascii=False, indent=2))
        return 0 if all(c['ok'] for c in checks) else 1
    finally:
        try:
            online()
        except Exception:
            pass
        try:
            req('DELETE', f'/session/{sid}')
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
