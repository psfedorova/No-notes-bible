/* the short message that shows over the book */
const toastEl = document.getElementById('toast');
let toastTm = 0;
function toast(msg, ms){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTm); toastTm = setTimeout(()=>toastEl.classList.remove('show'), ms || 1400);
}

export {
  toast
};
