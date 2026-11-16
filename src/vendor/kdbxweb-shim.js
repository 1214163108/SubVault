/* Bridge browser globals into the UMD kdbxweb bundle. */
(function () {
  if (typeof globalThis !== 'undefined') {
    globalThis['@xmldom/xmldom'] = {
      DOMParser: globalThis.DOMParser,
      XMLSerializer: globalThis.XMLSerializer,
    };
  }
})();
