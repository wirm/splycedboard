/** Tools → LG TV (the page itself is public/js/tv-tool.js). */
SBTv.mount('lgtv', {
  brand: 'LG',
  keyLabel: 'Keycode',
  keyHint: '(from the TV\'s IP Control Setup screen; Blueprint\'s AccessToken)',
  keyPlaceholder: '8 letters and digits, like A1B2C3D4',
  describe(tv) {
    if (tv.info?.ipControl) return 'IP Control on';
    if (tv.info?.ipControl === false) return 'IP Control off';
    return '';
  },
});
