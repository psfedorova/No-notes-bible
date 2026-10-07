window.addEventListener('error', e=>{
  const p = document.getElementById('err');
  p.style.display = 'block';
  p.textContent += (e.message || e) + '\n';
});
window.addEventListener('unhandledrejection', e=>{
  const p = document.getElementById('err');
  p.style.display = 'block';
  p.textContent += 'Promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason) + '\n';
});
