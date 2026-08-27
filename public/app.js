const themeToggle = document.querySelector('#theme-toggle');
const copyButton = document.querySelector('.copy-button');
const serverSummary = document.querySelector('#server-summary');
const serverList = document.querySelector('#server-list');

if (localStorage.getItem('attendance-theme') === 'dark') {
  document.body.classList.add('dark');
}

if (themeToggle) themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('attendance-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
});

if (copyButton) copyButton.addEventListener('click', async () => {
  const target = document.querySelector(`#${copyButton.dataset.copyTarget}`);
  await navigator.clipboard.writeText(target.textContent);
  copyButton.textContent = 'COPIED';
  window.setTimeout(() => { copyButton.textContent = 'COPY'; }, 1500);
});

async function loadServers() {
  try {
    const response = await fetch('/api/servers');
    if (!response.ok) throw new Error('Server list unavailable');
    const data = await response.json();
    serverSummary.textContent = data.count === 1
      ? '1 Discord community is keeping its rhythm with Attendance Streak.'
      : `${data.count} Discord communities are keeping their rhythm with Attendance Streak.`;
    serverList.innerHTML = data.servers.length === 0
      ? '<div class="server-loading">No connected servers yet.</div>'
      : data.servers.map((server, index) => `<div class="server-item"><span class="server-index">${String(index + 1).padStart(2, '0')}</span><span class="server-avatar">${server.name.slice(0, 2).toUpperCase()}</span><strong>${server.name}</strong><span class="server-status">CONNECTED</span></div>`).join('');
  } catch {
    serverSummary.textContent = 'The bot is not connected yet. Check back after it comes online.';
    serverList.innerHTML = '<div class="server-loading">Server list unavailable.</div>';
  }
}

if (serverSummary && serverList) loadServers();
