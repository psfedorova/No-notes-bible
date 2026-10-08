const toastEl = document.getElementById('toast');
let toastTm = 0;
function toast(msg, ms, act){
  toastEl.textContent = msg;
  toastEl.classList.toggle('act', !!act);
  if(act){
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = act.label;
    b.addEventListener('mousedown', e=>e.preventDefault());
    b.addEventListener('click', ()=>{ toastEl.classList.remove('show'); act.fn(); });
    toastEl.appendChild(b);
  }
  toastEl.classList.add('show');
  clearTimeout(toastTm); toastTm = setTimeout(()=>toastEl.classList.remove('show'), ms || 1400);
}

export {
  toast
};
