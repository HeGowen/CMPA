// renderer/app.js — UI logic only; runs under strict CSP
const $ = id => document.getElementById(id);

$('start').onclick = async () => {
  setStatus('starting...');
  try {
    const res = await window.ble.start({
      namePrefix: $('name').value.trim(),
      serviceUUID: $('svc').value.trim(),
      notifyUUID: $('notify').value.trim()
    });
    if (res && res.ok === false) {
      setStatus(res.err || 'start failed');
    }
  } catch (e) {
    setStatus(e?.message || 'start error');
  }
};

$('stop').onclick = async () => {
  try { await window.ble.stop(); } catch {}
};

window.ble.onStatus((s) => setStatus(s));
window.ble.onData((d) => {
  $('stats').innerHTML =
    `last bytes: ${d.lastPacketBytes}<br>` +
    `total bytes: ${d.totalBytes}<br>` +
    `samples: ${d.samples}<br>` +
    `shape: ${d.samples} × ${d.channels}`;
});

function setStatus(text) {
  $('status').textContent = 'Status: ' + text;
}
