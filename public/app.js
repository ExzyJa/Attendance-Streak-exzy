const themeToggle = document.querySelector('#theme-toggle');
const copyButton = document.querySelector('.copy-button');

if (localStorage.getItem('attendance-theme') === 'dark') {
  document.body.classList.add('dark');
}

themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('attendance-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
});

copyButton.addEventListener('click', async () => {
  const target = document.querySelector(`#${copyButton.dataset.copyTarget}`);
  await navigator.clipboard.writeText(target.textContent);
  copyButton.textContent = 'COPIED';
  window.setTimeout(() => { copyButton.textContent = 'COPY'; }, 1500);
});
