async function ask() {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
    msg.textContent = '✅ Camera allowed. You can close this tab and use AirType anywhere.';
  } catch (e) {
    msg.textContent = '❌ ' + (e.name === 'NotAllowedError'
      ? 'Blocked. Click the camera icon in the address bar, choose Allow, then press “Ask again”.'
      : e.message);
  }
}
document.getElementById('retry').onclick = ask;
ask();
