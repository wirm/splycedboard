/** SCLI Bridge dashboard panel. */
(() => {
  let ctx = null;
  const $ = (id) => document.getElementById(id);

  function render(s) {
    $('scliPath').textContent = s.scliFound ? s.scliPath : 'Not found — is this the Savant Pro Host?';
    $('scliPath').style.color = s.scliFound ? 'var(--green)' : 'var(--red)';
    $('scliSavantDot').className = 'status-dot' + (s.savantConnected ? ' ok' : '');
    $('scliSavantText').textContent = s.savantConnected ? `Connected (${s.savantAddr})` : 'Not connected';
    $('scliSavantPort').textContent = s.savantPort;
    $('scliClientPort').textContent = s.clientPort;
    ctx.root.querySelectorAll('.scli-client-port').forEach((el) => { el.textContent = s.clientPort; });
  }

  async function refresh() {
    try {
      render(await ctx.api('GET', '/status'));
    } catch { /* disabled — the hub shows a banner */ }
  }

  async function exec() {
    const cmd = $('scliInput').value.trim();
    if (!cmd) return;
    const out = $('scliOutput');
    out.style.display = 'block';
    out.textContent = 'Running…';
    try {
      const res = await ctx.api('POST', '/exec', { command: cmd });
      out.textContent = res.output || '(no output)';
    } catch (err) {
      out.textContent = `Error: ${err.message}`;
    }
  }

  window.Scli = { exec };

  SB.registerPanel('scli', {
    init(context) {
      ctx = context;
      $('scliInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') exec(); });
      ctx.root.querySelectorAll('.scli-host').forEach((el) => { el.textContent = location.hostname; });
    },
    onStateChange(integration) {
      if (integration.running) refresh();
    },
    onMessage(msg) {
      if (msg.type === 'status') render(msg);
    },
  });
})();
