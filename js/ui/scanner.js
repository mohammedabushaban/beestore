(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  /**
   * Barcode scanner (camera based).
   *
   * Two engines, picked automatically:
   *  - `BarcodeDetector` — native, fast, available on Android Chrome / ChromeOS.
   *  - ZXing (vendored, `vendor/zxing/zxing.min.js`) — fallback for browsers
   *    without the native API (desktop Chrome, Safari/iOS, Firefox).
   *
   * Both need `getUserMedia`, which the browser only exposes in a SECURE
   * CONTEXT (https, or http://localhost). Over plain http on a LAN IP the
   * camera is blocked by the browser — that is a browser rule, not a bug here.
   *
   * The overlay keeps working without a camera: the user can always type the
   * barcode by hand, and USB/Bluetooth keyboard scanners keep feeding the
   * normal inputs of the page.
   */

  // Formats we try to read (retail labels first).
  const PREFERRED_FORMATS = [
    'ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e', 'code_39', 'qr_code',
  ];

  // Extra formats the native detector may support; harmless to request.
  const EXTRA_FORMATS = ['itf', 'codabar', 'data_matrix', 'pdf417', 'aztec'];

  const REASONS = {
    INSECURE: 'insecure',
    NO_CAMERA_API: 'no-camera-api',
    NO_DECODER: 'no-decoder',
  };

  // A physical scanner re-reads the same label many times while it is in view.
  const REPEAT_WINDOW_MS = 1500;
  const MAX_LOG_ROWS = 6;

  // The overlay currently on screen (there is never more than one).
  let activeController = null;

  /** Closes the open scanner overlay, if any. */
  function closeCurrent() {
    if (activeController) {
      try { activeController.close(); } catch (e) { /* ignore */ }
    }
  }

  /** Normalizes a raw scanned value (trim + collapse inner whitespace). */
  function normalizeCode(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).replace(/\s+/g, ' ').trim();
  }

  /**
   * Pure "ignore the same code for N ms" filter — exported so it can be
   * unit-tested without a camera.
   *
   * @param {{windowMs?:number, now?:()=>number}} [options]
   * @returns {{accept:(raw:string)=>boolean, reset:()=>void, last:()=>string|null}}
   */
  function createRepeatFilter(options) {
    options = options || {};
    const windowMs = options.windowMs != null ? options.windowMs : REPEAT_WINDOW_MS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let lastCode = null;
    let lastAt = 0;
    return {
      accept(raw) {
        const code = normalizeCode(raw);
        if (!code) return false;
        const t = now();
        if (code === lastCode && t - lastAt < windowMs) return false;
        lastCode = code;
        lastAt = t;
        return true;
      },
      reset() { lastCode = null; lastAt = 0; },
      last() { return lastCode; },
    };
  }

  function isSecureContext() {
    return typeof window !== 'undefined' && window.isSecureContext !== false;
  }

  function hasCameraApi() {
    return typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  function hasNativeDetector() {
    return typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function';
  }

  function hasZxing() {
    return typeof window !== 'undefined' &&
      !!window.ZXing &&
      typeof window.ZXing.BrowserMultiFormatReader === 'function';
  }

  /**
   * @returns {string} '' when scanning is possible, otherwise a reason key.
   */
  function unsupportedReason() {
    if (!isSecureContext()) return REASONS.INSECURE;
    if (!hasCameraApi()) return REASONS.NO_CAMERA_API;
    if (!hasNativeDetector() && !hasZxing()) return REASONS.NO_DECODER;
    return '';
  }

  function isSupported() {
    return unsupportedReason() === '';
  }

  /** Arabic explanation for an unsupported reason. */
  function reasonMessage(reason) {
    switch (reason) {
      case REASONS.INSECURE:
        return 'قراءة الباركود بالكاميرا تحتاج اتصالاً آمناً (https). ' +
          'افتح البرنامج من نسخة https المنشورة، أو من http://localhost. ' +
          'يمكنك الآن كتابة الباركود يدوياً.';
      case REASONS.NO_CAMERA_API:
        return 'المتصفح لا يوفّر الوصول للكاميرا على هذا الجهاز. ' +
          'يمكنك كتابة الباركود يدوياً أو استخدام قارئ الباركود USB.';
      case REASONS.NO_DECODER:
        return 'لا يوجد محرك قراءة باركود في هذا المتصفح. ' +
          'استخدم Chrome أو Safari حديثاً، أو اكتب الباركود يدوياً.';
      default:
        return 'تعذّر تشغيل الكاميرا.';
    }
  }

  function cameraErrorMessage(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'تم رفض إذن الكاميرا. اسمح بالوصول للكاميرا من إعدادات المتصفح ثم أعد المحاولة.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'لم يتم العثور على كاميرا في هذا الجهاز.';
    }
    if (name === 'NotReadableError') {
      return 'الكاميرا مستخدمة من تطبيق آخر. أغلقه ثم أعد المحاولة.';
    }
    return 'تعذّر تشغيل الكاميرا: ' + ((err && err.message) || 'خطأ غير معروف');
  }

  /* ---------------------------------------------------------------- sound */

  let audioCtx = null;

  function _audioContext() {
    if (audioCtx) return audioCtx;
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return null;
    try { audioCtx = new Ctx(); } catch (e) { return null; }
    return audioCtx;
  }

  /** Creates/resumes the audio context inside a user gesture (iOS policy). */
  function primeAudio() {
    const ctx = _audioContext();
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Short feedback beep: bright single tone for a known item, a lower double
   * buzz for an unknown barcode.
   *
   * @param {'ok'|'error'} kind
   */
  function beep(kind) {
    const ctx = _audioContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.setValueAtTime(kind === 'error' ? 220 : 1000, t);
      if (kind === 'error') osc.frequency.setValueAtTime(170, t + 0.12);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.16 : 0.11, t + 0.012);
      const end = kind === 'error' ? 0.3 : 0.14;
      gain.gain.exponentialRampToValueAtTime(0.0001, t + end);
      osc.start(t);
      osc.stop(t + end + 0.02);
    } catch (e) { /* audio is a nicety, never block scanning */ }
  }

  function vibrate(kind) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(kind === 'error' ? [40, 60, 40] : 45); } catch (e) { /* ignore */ }
  }

  function _cameraIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('scan-btn-icon');
    svg.innerHTML =
      '<path d="M4 8.5h3l1.4-2h7.2l1.4 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>' +
      '<circle cx="12" cy="13.5" r="3.4"/>';
    return svg;
  }

  /**
   * Opens the camera overlay.
   *
   * @param {Object} [options]
   * @param {string} [options.title]
   * @param {string} [options.hint] status line shown under the viewfinder
   * @param {boolean} [options.continuous] keep scanning after a hit
   *   (defaults to true when `onScan` is provided)
   * @param {(code:string)=>(boolean|{ok:boolean,label?:string,message?:string}|Promise)} [options.onScan]
   *   called per accepted code in continuous mode; return `{ok:false}` for
   *   the "unknown barcode" sound/red flash
   * @param {(code:string)=>(boolean|{ok:boolean,message?:string}|Promise)} [options.validate]
   *   one-shot mode hook: return false to keep the scanner open
   * @param {(code:string|null)=>void} [options.onClose]
   * @param {number} [options.repeatWindowMs] same-code debounce window
   * @returns {{close:Function, promise:Promise<string|null>, element:HTMLElement}}
   */
  function open(options) {
    options = options || {};
    const { el } = BeeStore.ui;
    const continuous = options.continuous !== undefined
      ? !!options.continuous
      : typeof options.onScan === 'function';
    const repeat = createRepeatFilter({ windowMs: options.repeatWindowMs || REPEAT_WINDOW_MS });
    const reason = unsupportedReason();

    let closed = false;
    let resolveResult;
    const promise = new Promise((resolve) => { resolveResult = resolve; });

    let stream = null;
    let rafId = null;
    let zxingControls = null;
    let busy = false;
    let torchOn = false;
    let facingMode = options.facingMode || 'environment';
    let scannedCount = 0;
    let flashTimer = null;

    /* ------------------------------------------------------------ markup */

    const countEl = el('span', { class: 'scanner-log-count' }, '0');
    const subtitle = el('div', { class: 'scanner-subtitle' },
      continuous ? 'وضع المسح المتواصل — يبقى مفتوحاً لإضافة عدة أصناف' : 'امسح الباركود بالكاميرا');

    const statusEl = el('div', { class: 'scanner-status', role: 'status', 'aria-live': 'polite' },
      options.hint || 'وجّه الكاميرا نحو الباركود');

    const manualInput = el('input', {
      type: 'text', class: 'form-input', placeholder: 'أو اكتب الباركود يدوياً',
      'aria-label': 'إدخال الباركود يدوياً', autocomplete: 'off',
    });

    const video = el('video', {
      class: 'scanner-video', autoplay: true, playsinline: true, muted: true,
    });
    const frame = el('div', { class: 'scanner-frame', 'aria-hidden': 'true' });
    const flashEl = el('div', { class: 'scanner-flash', 'aria-hidden': 'true' });
    const videoWrap = el('div', { class: 'scanner-video-wrap' }, [video, frame, flashEl]);

    const torchBtn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'الإضاءة');
    const switchBtn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'تبديل الكاميرا');
    const retryBtn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'إعادة المحاولة');
    const closeBtn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button' }, 'إغلاق');
    const manualBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'إضافة');
    const logEl = el('div', { class: 'scanner-log', role: 'log', 'aria-live': 'polite' });

    const overlay = el('div', {
      class: 'dialog-overlay scanner-overlay',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'قارئ الباركود',
    });
    const dialog = el('div', { class: 'dialog scanner-dialog' }, [
      el('div', { class: 'scanner-header' }, [
        el('div', { style: 'flex:1;min-width:0;' }, [
          el('h3', {}, options.title || 'مسح باركود'),
          subtitle,
        ]),
        continuous ? countEl : null,
        el('button', {
          class: 'scanner-close', type: 'button', 'aria-label': 'إغلاق',
          onclick: () => finish(null),
        }, '×'),
      ]),
      videoWrap,
      el('div', { class: 'scanner-bottom' }, [
        continuous ? logEl : null,
        statusEl,
        el('div', { class: 'scanner-manual' }, [manualInput, manualBtn]),
        el('div', { class: 'scanner-controls' }, [torchBtn, switchBtn, retryBtn, closeBtn]),
      ]),
    ]);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.body.classList.add('scanner-open');

    // Torch is only meaningful on phones; hide until we know it is supported.
    torchBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    if (continuous) {
      const hint = el('div', { class: 'scanner-empty-hint' }, 'لم يُمسح أي صنف بعد');
      logEl.appendChild(hint);
    }

    /* ------------------------------------------------------------ helpers */

    function setStatus(text, tone) {
      statusEl.textContent = text;
      statusEl.className = 'scanner-status' + (tone ? ' scanner-status-' + tone : '');
    }

    function flash(ok) {
      flashEl.classList.add('is-on');
      flashEl.classList.toggle('is-error', !ok);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashEl.classList.remove('is-on');
        flashEl.classList.remove('is-error');
      }, 190);
    }

    function addLog(ok, info) {
      if (!continuous) return;
      const empty = logEl.querySelector('.scanner-empty-hint');
      if (empty) empty.remove();
      const row = el('div', { class: 'scanner-log-row ' + (ok ? 'is-ok' : 'is-error') }, [
        el('span', { class: 'scanner-log-label' },
          ok ? (info.label || 'تمت إضافة الصنف') : (info.message || 'باركود غير معروف')),
        el('span', { class: 'scanner-log-code' }, info.code),
      ]);
      logEl.appendChild(row);
      while (logEl.children.length > MAX_LOG_ROWS) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
      if (ok) {
        scannedCount++;
        countEl.textContent = String(scannedCount);
      }
    }

    function feedback(ok, info) {
      beep(ok ? 'ok' : 'error');
      vibrate(ok ? 'ok' : 'error');
      flash(ok);
      if (continuous) {
        addLog(ok, info);
        if (ok) {
          setStatus(info.label ? 'تمت الإضافة: ' + info.label : 'تم مسح ' + info.code, 'success');
        } else {
          setStatus(info.message || 'باركود غير معروف', 'error');
        }
      } else if (!ok) {
        setStatus(info.message || 'باركود غير معروف', 'error');
      }
    }

    /** Stops the camera and resolves the promise. Safe to call twice. */
    function finish(code) {
      if (closed) return;
      closed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (flashTimer) clearTimeout(flashTimer);
      stopCamera();
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('keydown', onDocKey, true);
      document.body.classList.remove('scanner-open');
      overlay.remove();
      if (activeController === controller) activeController = null;
      const value = normalizeCode(code) || null;
      resolveResult(value);
      if (typeof options.onClose === 'function') options.onClose(value);
    }

    /** Navigating away must never leave the camera running. */
    function onHashChange() {
      finish(null);
    }

    /**
     * Handles one decoded value. Returns whether it was accepted.
     * In continuous mode it calls `onScan` and keeps the overlay open.
     */
    async function handleCode(raw) {
      if (closed) return false;
      const code = normalizeCode(raw);
      if (!code) return false;
      if (!repeat.accept(code)) return false;

      if (continuous) {
        let result;
        try {
          result = typeof options.onScan === 'function' ? await options.onScan(code) : { ok: true };
        } catch (e) {
          result = { ok: false, message: 'تعذّر معالجة الباركود' };
        }
        // The user may have closed the overlay while the page was saving.
        if (closed) return false;
        const ok = !(result === false || (result && result.ok === false));
        feedback(ok, {
          code,
          label: result && result.label,
          message: result && result.message,
        });
        // Let the cashier re-scan the same code immediately after fixing it.
        if (!ok) repeat.reset();
        return ok;
      }

      if (typeof options.validate === 'function') {
        let valid;
        try { valid = await options.validate(code); }
        catch (e) { valid = { ok: false, message: 'تعذّر التحقق من الباركود' }; }
        if (valid === false || (valid && valid.ok === false)) {
          feedback(false, { code, message: (valid && valid.message) || 'باركود غير مقبول' });
          repeat.reset();
          return false;
        }
      }
      feedback(true, { code });
      finish(code);
      return true;
    }

    /* ------------------------------------------------------------- camera */

    function stopCamera() {
      try { if (zxingControls && typeof zxingControls.stop === 'function') zxingControls.stop(); } catch (e) { /* ignore */ }
      zxingControls = null;
      const active = stream || video.srcObject;
      if (active && typeof active.getTracks === 'function') {
        active.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
      }
      stream = null;
      try { video.srcObject = null; } catch (e) { /* ignore */ }
    }

    function videoTrack() {
      const active = stream || video.srcObject;
      if (!active || typeof active.getVideoTracks !== 'function') return null;
      return active.getVideoTracks()[0] || null;
    }

    function refreshTorchButton() {
      const track = videoTrack();
      let supported = false;
      try {
        const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
        supported = !!caps.torch;
      } catch (e) { supported = false; }
      torchBtn.style.display = supported ? '' : 'none';
      torchBtn.classList.toggle('is-active', supported && torchOn);
    }

    async function toggleTorch() {
      const track = videoTrack();
      if (!track) { setStatus('الإضاءة غير مدعومة على هذا الجهاز', 'warn'); return; }
      let caps = {};
      try { caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}; } catch (e) { caps = {}; }
      if (!caps.torch) { setStatus('الإضاءة غير مدعومة على هذا الجهاز', 'warn'); return; }
      torchOn = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        torchBtn.classList.toggle('is-active', torchOn);
        setStatus(torchOn ? 'الإضاءة مفعّلة' : 'الإضاءة مطفأة');
      } catch (e) {
        torchOn = false;
        torchBtn.classList.remove('is-active');
        setStatus('تعذّر تفعيل الإضاءة', 'warn');
      }
    }

    async function startCamera() {
      stopCamera();
      torchOn = false;
      setStatus('جارٍ تشغيل الكاميرا...');
      try {
        if (hasNativeDetector()) await startNative();
        else await startZxing();
        if (closed) return;
        refreshTorchButton();
        retryBtn.style.display = 'none';
        setStatus(continuous
          ? 'جاهز — امسح الأصناف واحداً تلو الآخر'
          : 'وجّه الكاميرا نحو الباركود');
      } catch (err) {
        if (!closed) {
          setStatus(cameraErrorMessage(err), 'error');
          retryBtn.style.display = '';
        }
      }
    }

    async function startNative() {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (closed) { stopCamera(); return; }
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* muted autoplay is allowed */ }

      let detector = null;
      try {
        if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const wanted = PREFERRED_FORMATS.concat(EXTRA_FORMATS);
          const formats = wanted.filter((f) => supported.indexOf(f) !== -1);
          detector = formats.length
            ? new window.BarcodeDetector({ formats })
            : new window.BarcodeDetector();
        } else {
          detector = new window.BarcodeDetector();
        }
      } catch (e) {
        detector = new window.BarcodeDetector();
      }

      const tick = async () => {
        if (closed) return;
        if (!busy) {
          busy = true;
          try {
            const codes = await detector.detect(video);
            const raw = codes && codes.length ? (codes[0].rawValue || '') : '';
            if (raw) await handleCode(raw);
          } catch (e) { /* a bad frame must not kill the loop */ }
          busy = false;
        }
        if (!closed) rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    async function startZxing() {
      const reader = new window.ZXing.BrowserMultiFormatReader();
      const hints = new Map();
      hints.set('TRY_HARDER', true);
      zxingControls = await reader.decodeFromConstraints(
        {
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        video,
        (result) => {
          if (result && typeof result.getText === 'function') {
            handleCode(result.getText());
          }
        },
        hints
      );
      if (closed) { stopCamera(); return; }
      // ZXing attaches the stream to the video element; use it for the torch.
      stream = (zxingControls && zxingControls.stream) || video.srcObject || stream;
    }

    async function switchCamera() {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      await startCamera();
      if (!closed) {
        setStatus(facingMode === 'user' ? 'الكاميرا الأمامية' : 'الكاميرا الخلفية');
      }
    }

    /* ------------------------------------------------------------- events */

    manualBtn.addEventListener('click', () => {
      const value = manualInput.value;
      manualInput.value = '';
      handleCode(value);
    });
    manualInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      const value = manualInput.value;
      manualInput.value = '';
      handleCode(value);
    });
    torchBtn.addEventListener('click', toggleTorch);
    switchBtn.addEventListener('click', switchCamera);
    retryBtn.addEventListener('click', startCamera);
    closeBtn.addEventListener('click', () => finish(null));
    // Capture on document: focus may still be on the page behind the overlay,
    // so Escape must work from anywhere, and Ctrl/Cmd+Enter must never reach
    // the invoice save shortcut behind us.
    function onDocKey(e) {
      if (closed) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onDocKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    /* --------------------------------------------------------------- boot */

    window.addEventListener('hashchange', onHashChange);
    if (reason) {
      setStatus(reasonMessage(reason), 'warn');
      switchBtn.style.display = 'none';
      retryHint();
    } else {
      primeAudio();
      startCamera();
    }

    function retryHint() {
      // No camera: the manual field is the way in.
      manualInput.placeholder = 'اكتب الباركود يدوياً ثم اضغط إضافة';
    }

    const controller = {
      close: () => finish(null),
      promise,
      element: overlay,
      handleCode,
    };
    activeController = controller;
    return controller;
  }

  /**
   * One-shot scan: resolves with the code, or null if the user closes the
   * overlay. Rejects duplicate barcodes via `options.validate` when provided.
   *
   * @param {{title?:string, hint?:string, validate?:Function, onClose?:Function}} [options]
   * @returns {Promise<string|null>}
   */
  function scan(options) {
    options = options || {};
    return new Promise((resolve) => {
      open(Object.assign({}, options, {
        continuous: false,
        onScan: undefined,
        onClose(code) {
          resolve(code || null);
          if (typeof options.onClose === 'function') options.onClose(code || null);
        },
      }));
    });
  }

  /**
   * Builds a "scan" button.
   *
   * @param {(code:string)=>void} onResult called with the code
   * @param {Object} [options] passed to `open()`; set `continuous:true` to
   *   keep scanning and call `onResult` for every accepted code.
   * @returns {HTMLElement}
   */
  function scanButton(onResult, options) {
    options = options || {};
    const btn = BeeStore.ui.el('button', {
      class: 'btn btn-secondary scan-btn ' + (options.className || ''),
      type: 'button',
      title: options.title || 'مسح باركود بالكاميرا',
      'aria-label': options.title || 'مسح باركود بالكاميرا',
    }, [_cameraIcon(), options.label || 'مسح']);

    btn.addEventListener('click', async () => {
      const opts = Object.assign({}, options);
      delete opts.className;
      delete opts.label;
      if (opts.continuous) {
        open(Object.assign(opts, {
          continuous: true,
          onScan: async (code) => (typeof onResult === 'function' ? onResult(code) : { ok: true }),
        }));
      } else {
        const code = await scan(opts);
        if (code && typeof onResult === 'function') onResult(code);
      }
    });
    return btn;
  }

  BeeStore.scanner = {
    open,
    scan,
    scanButton,
    closeCurrent,
    isSupported,
    unsupportedReason,
    reasonMessage,
    normalizeCode,
    createRepeatFilter,
    PREFERRED_FORMATS,
    REASONS,
    REPEAT_WINDOW_MS,
  };
  if (typeof module !== 'undefined') module.exports = BeeStore.scanner;
})(typeof window !== 'undefined' ? window : globalThis);
