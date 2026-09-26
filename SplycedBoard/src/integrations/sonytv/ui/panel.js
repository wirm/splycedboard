/** Tools → Sony TV (the page itself is public/js/tv-tool.js). */
SBTv.mount('sonytv', {
  brand: 'Sony',
  keyLabel: 'Pre-Shared Key',
  keyHint: '(set on the TV; Savant\'s Sony profiles send 1234)',
  keyPlaceholder: '1234',
  describe(tv) {
    return tv.info?.apiVersion ? `API ${tv.info.apiVersion}` : '';
  },
});
