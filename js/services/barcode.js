(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class BarcodeService {
    generate(text, options) {
      options = options || {};
      const width = options.width || 2;
      const height = options.height || 50;
      const displayValue = options.displayValue !== false;

      if (typeof JsBarcode !== 'undefined') {
        const canvas = document.createElement('canvas');
        JsBarcode(canvas, text, {
          format: 'CODE128',
          width: width,
          height: height,
          displayValue: displayValue,
          fontSize: options.fontSize || 14,
          font: 'Cairo',
          margin: options.margin || 5,
        });
        return canvas.toDataURL('image/png');
      }

      return null;
    }

    generateSvg(text, options) {
      options = options || {};
      const width = options.width || 2;
      const height = options.height || 50;

      if (typeof JsBarcode !== 'undefined') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        JsBarcode(svg, text, {
          format: 'CODE128',
          width: width,
          height: height,
          displayValue: true,
          fontSize: options.fontSize || 14,
          font: 'Cairo',
        });
        return new XMLSerializer().serializeToString(svg);
      }

      return null;
    }

    renderToElement(element, text, options) {
      if (!element) return;
      const dataUrl = this.generate(text, options);
      if (dataUrl) {
        element.innerHTML = '';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = text;
        img.style.maxWidth = '100%';
        element.appendChild(img);
      } else {
        element.textContent = text;
      }
    }
  }

  BeeStore.barcode = new BarcodeService();
  BeeStore.BarcodeService = BarcodeService;
  if (typeof module !== 'undefined') module.exports = BarcodeService;
})(typeof window !== 'undefined' ? window : globalThis);
