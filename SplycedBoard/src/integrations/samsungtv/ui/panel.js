/** Tools → Samsung TV (the page itself is public/js/tv-tool.js). */
SBTv.mount('samsungtv', {
  brand: 'Samsung',
  keyLabel: 'AccessToken',
  keyHint: '(for Savant: TVs with IP Remote on)',
  keyPlaceholder: 'None yet: Request token, or paste one',
  // TVs with IP Remote on hand out Savant's AccessToken; the others pair SplycedBoard's own remote.
  pairLabel: (tv) => (tv.info?.ipControl || (!tv.info?.smartView && !tv.info?.legacy) ? 'Request token' : 'Pair remote'),
  describe(tv) {
    const i = tv.info || {};
    if (i.ipControl) return `IP Control (port ${i.ipControlPort || 1516})`;
    if (i.smartView) return i.frame ? 'Smart View · The Frame' : 'Smart View';
    if (i.legacy) return 'Legacy remote';
    return '';
  },
});
