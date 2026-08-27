const themeToggle = document.querySelector('#theme-toggle');
const copyButton = document.querySelector('.copy-button');
const serverSummary = document.querySelector('#server-summary');
const serverList = document.querySelector('#server-list');
const dashboardStatus = document.querySelector('#dashboard-status');
const dashboardMessage = document.querySelector('#dashboard-message');
const setupFormWrap = document.querySelector('#setup-form-wrap');
const setupForm = document.querySelector('#web-setup-form');
const guildSelect = document.querySelector('#setup-guild');
const automationToggle = document.querySelector('#setup-automation');
const roleFields = document.querySelector('#role-fields');
const loginButton = document.querySelector('.dashboard-login');
let currentUser = null;

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

function showDashboardMessage(message, type = '') {
  dashboardMessage.textContent = message;
  dashboardMessage.className = `dashboard-message ${type}`;
}

function addOptions(select, items, emptyLabel) {
  select.innerHTML = emptyLabel ? `<option value="">${emptyLabel}</option>` : '';
  items.forEach(item => select.add(new Option(item.name, item.id)));
}

async function loadSetupOptions(guildId) {
  const response = await fetch(`/api/setup-options/${guildId}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load server settings.');
  addOptions(document.querySelector('#setup-channel'), data.channels, 'Choose a channel');
  addOptions(document.querySelector('#setup-announcement'), data.channels, 'No announcement channel');
  addOptions(document.querySelector('#setup-active-role'), data.roles, 'Choose active role');
  addOptions(document.querySelector('#setup-inactive-role'), data.roles, 'Choose inactive role');
  addOptions(document.querySelector('#setup-exemptions'), data.roles, '');
  if (data.config) {
    document.querySelector('#setup-channel').value = data.config.channel_id || '';
    document.querySelector('#setup-announcement').value = data.config.announcement_channel_id || '';
    document.querySelector('#setup-time').value = `${String(data.config.hour).padStart(2, '0')}:${String(data.config.minute).padStart(2, '0')}`;
    document.querySelector('#setup-timezone').value = data.config.timezone || 'Asia/Manila';
    document.querySelector('#setup-title').value = data.config.title || 'Daily Attendance';
    document.querySelector('#setup-body').value = data.config.body || '';
    automationToggle.checked = data.config.role_automation_enabled === 1;
    document.querySelector('#setup-active-role').value = data.config.active_role_id || '';
    document.querySelector('#setup-inactive-role').value = data.config.inactive_role_id || '';
    (data.config.exemption_role_id || '').split(',').forEach(roleId => {
      const option = document.querySelector(`#setup-exemptions option[value="${roleId}"]`);
      if (option) option.selected = true;
    });
  }
  roleFields.hidden = !automationToggle.checked;
}

if (automationToggle) automationToggle.addEventListener('change', () => { roleFields.hidden = !automationToggle.checked; });
if (guildSelect) guildSelect.addEventListener('change', async () => {
  if (!guildSelect.value) return;
  try {
    showDashboardMessage('Loading channels and roles...');
    await loadSetupOptions(guildSelect.value);
    showDashboardMessage('Ready to configure.');
  } catch (error) { showDashboardMessage(error.message, 'error'); }
});

if (setupForm) setupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const selectedExemptions = [...document.querySelector('#setup-exemptions').selectedOptions].map(option => option.value);
  const payload = { guildId: guildSelect.value, channelId: document.querySelector('#setup-channel').value, announcementChannelId: document.querySelector('#setup-announcement').value, time: document.querySelector('#setup-time').value, timezone: document.querySelector('#setup-timezone').value, title: document.querySelector('#setup-title').value, body: document.querySelector('#setup-body').value, roleAutomationEnabled: automationToggle.checked, activeRoleId: document.querySelector('#setup-active-role').value, inactiveRoleId: document.querySelector('#setup-inactive-role').value, exemptionRoleIds: selectedExemptions };
  try {
    showDashboardMessage('Saving configuration...');
    const response = await fetch('/api/setup-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save configuration.');
    showDashboardMessage('Saved. Your attendance schedule is now active.', 'success');
  } catch (error) { showDashboardMessage(error.message, 'error'); }
});

async function loadDashboard() {
  try {
    const response = await fetch('/api/me');
    const data = await response.json();
    if (!data.authenticated) return;
    currentUser = data.user;
    dashboardStatus.textContent = `Welcome, ${currentUser.username}`;
    loginButton.hidden = true;
    setupFormWrap.hidden = false;
    const guildResponse = await fetch('/api/setup-guilds');
    const guildData = await guildResponse.json();
    if (!guildResponse.ok) throw new Error(guildData.error);
    addOptions(guildSelect, guildData.guilds, 'Choose a server');
    showDashboardMessage(guildData.guilds.length ? 'Choose a server to begin.' : 'No shared servers with Manage Server permission.', guildData.guilds.length ? '' : 'error');
  } catch (error) { showDashboardMessage(error.message, 'error'); }
}

if (setupForm && dashboardStatus && dashboardMessage && setupFormWrap && loginButton) loadDashboard();
