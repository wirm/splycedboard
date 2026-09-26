/** Tools → Samsung TV (the page itself is public/js/tv-tool.js). */
SBTv.mount('samsungtv', {
  brand: 'Samsung',
  keyLabel: 'AccessToken',
  keyHint: '(for Savant, 2020 and newer TVs)',
  keyPlaceholder: 'None yet: Request token, or paste one',
  // 2020+ TVs with IP Remote on hand out Savant's AccessToken; older ones pair SplycedBoard's remote.
  pairLabel: (tv) => (tv.info?.ipControl || (tv.year || 0) >= 2020 || !tv.year ? 'Request token' : 'Pair remote'),
  describe(tv) {
    const i = tv.info || {};
    if (i.ipControl) return 'IP Control';
    if (i.smartView) return i.frame ? 'Smart View · The Frame' : 'Smart View';
    if (i.legacy) return 'Legacy remote';
    return '';
  },
});
