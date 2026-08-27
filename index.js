require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
} = require('discord.js');
const cron = require('node-cron');

// Railway (and most PaaS hosts) expect the service to bind to $PORT and respond
// to HTTP so they can health-check it. The bot itself only needs the Discord
// Gateway connection, so this is just a minimal "I'm alive" endpoint.
const PORT = process.env.PORT || 3000;
const webSessions = new Map();
const oauthStates = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
    const separator = cookie.indexOf('=');
    return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
  }));
}

function getWebSession(req) {
  const sessionId = parseCookies(req).attendance_session;
  return sessionId ? webSessions.get(sessionId) : null;
}

function requireWebSession(req, res) {
  const session = getWebSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Sign in with Discord to continue.' });
    return null;
  }
  return session;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) reject(new Error('Request body is too large.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function discordRequest(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, options);
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const reason = payload.error_description || payload.message || payload.error || 'request failed';
    throw new Error(`Discord API ${response.status}: ${reason}`);
  }
  return payload;
}

function hasManageGuildPermission(guild) {
  return guild.owner || (BigInt(guild.permissions || 0) & 0x20n) === 0x20n;
}

function getAuthorizedGuild(session, guildId) {
  if (!session || session.expiresAt < Date.now()) return null;
  return session.guilds.find(guild => guild.id === guildId && hasManageGuildPermission(guild) && client.guilds.cache.has(guildId));
}

http
  .createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Attendance bot is running.\n');
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/auth/login') {
      if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_REDIRECT_URI) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Web login is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.\n');
        return;
      }
      const state = crypto.randomBytes(24).toString('hex');
      oauthStates.set(state, Date.now() + 5 * 60 * 1000);
      const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify guilds',
        state,
      });
      res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${params}` });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/auth/callback') {
      if (requestUrl.searchParams.get('error')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Discord authorization was cancelled. Please try again and click Authorize.\n');
        return;
      }
      const stateExpiry = oauthStates.get(requestUrl.searchParams.get('state'));
      oauthStates.delete(requestUrl.searchParams.get('state'));
      if (!stateExpiry || stateExpiry < Date.now() || !requestUrl.searchParams.get('code')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid or expired login request.\n');
        return;
      }
      try {
        const tokenParams = new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: requestUrl.searchParams.get('code'),
          redirect_uri: process.env.DISCORD_REDIRECT_URI,
        });
        const token = await discordRequest('/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenParams });
        const [user, guilds] = await Promise.all([
          discordRequest('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } }),
          discordRequest('/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } }),
        ]);
        const sessionId = crypto.randomBytes(32).toString('hex');
        webSessions.set(sessionId, { user, guilds, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        res.writeHead(302, { Location: '/dashboard.html#dashboard', 'Set-Cookie': `attendance_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800` });
        res.end();
      } catch (err) {
        console.error('[web-auth] login failed:', err.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Discord login failed. Please try again.\n');
      }
      return;
    }

    if (requestUrl.pathname === '/auth/logout') {
      const sessionId = parseCookies(req).attendance_session;
      if (sessionId) webSessions.delete(sessionId);
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'attendance_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/api/me') {
      const session = getWebSession(req);
      sendJson(res, 200, session ? { authenticated: true, user: session.user } : { authenticated: false });
      return;
    }

    if (requestUrl.pathname === '/api/setup-guilds') {
      const session = requireWebSession(req, res);
      if (!session) return;
      if (session.expiresAt < Date.now()) {
        sendJson(res, 401, { error: 'Your session expired. Please sign in again.' });
        return;
      }
      const guilds = session.guilds.filter(hasManageGuildPermission).filter(guild => client.guilds.cache.has(guild.id)).map(guild => ({ id: guild.id, name: guild.name, icon: guild.icon }));
      sendJson(res, 200, { guilds });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/setup-options/')) {
      const session = requireWebSession(req, res);
      if (!session) return;
      const guildId = requestUrl.pathname.split('/').pop();
      if (!getAuthorizedGuild(session, guildId)) {
        sendJson(res, 403, { error: 'You cannot configure this server.' });
        return;
      }
      const guild = client.guilds.cache.get(guildId);
      const channels = guild.channels.cache.filter(channel => channel.isTextBased() && !channel.isThread()).map(channel => ({ id: channel.id, name: channel.name })).sort((first, second) => first.name.localeCompare(second.name));
      const roles = guild.roles.cache.filter(role => !role.managed && role.id !== guildId).map(role => ({ id: role.id, name: role.name })).sort((first, second) => first.name.localeCompare(second.name));
      sendJson(res, 200, { channels, roles, config: db.getConfig(guildId) || null });
      return;
    }

    if (requestUrl.pathname === '/api/setup-config' && req.method === 'POST') {
      const session = requireWebSession(req, res);
      if (!session) return;
      try {
        const data = JSON.parse(await readRequestBody(req));
        const guildId = String(data.guildId || '');
        const authorizedGuild = getAuthorizedGuild(session, guildId);
        const guild = client.guilds.cache.get(guildId);
        if (!authorizedGuild || !guild) return sendJson(res, 403, { error: 'You cannot configure this server.' });
        const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(data.time || '').trim());
        const hour = timeMatch ? Number(timeMatch[1]) : -1;
        const minute = timeMatch ? Number(timeMatch[2]) : -1;
        if (hour > 23 || minute > 59 || hour < 0 || minute < 0) return sendJson(res, 400, { error: 'Use a valid 24-hour time such as 00:00.' });
        Intl.DateTimeFormat('en-US', { timeZone: String(data.timezone || '') });
        const channel = guild.channels.cache.get(String(data.channelId || ''));
        const announcementChannel = data.announcementChannelId ? guild.channels.cache.get(String(data.announcementChannelId)) : null;
        const activeRole = data.activeRoleId ? guild.roles.cache.get(String(data.activeRoleId)) : null;
        const inactiveRole = data.inactiveRoleId ? guild.roles.cache.get(String(data.inactiveRoleId)) : null;
        const exemptionRoleIds = parseExemptionRoleIds(Array.isArray(data.exemptionRoleIds) ? data.exemptionRoleIds.join(',') : data.exemptionRoleIds);
        if (!channel || !channel.isTextBased() || (announcementChannel && !announcementChannel.isTextBased()) || (activeRole && activeRole.managed) || (inactiveRole && inactiveRole.managed) || exemptionRoleIds.some(roleId => !guild.roles.cache.has(roleId))) return sendJson(res, 400, { error: 'Choose valid channels and roles from this server.' });
        if (data.roleAutomationEnabled && (!activeRole || !inactiveRole || activeRole.id === inactiveRole.id)) return sendJson(res, 400, { error: 'Choose two different active and inactive roles.' });
        const config = { channelId: channel.id, announcementChannelId: announcementChannel?.id || null, hour, minute, timezone: String(data.timezone), title: String(data.title || 'Daily Attendance').slice(0, 256), body: String(data.body || 'React with ✅ if you are online today.').slice(0, 4000), configuredDate: todayStr(String(data.timezone)), activeRoleId: data.roleAutomationEnabled ? activeRole.id : null, inactiveRoleId: data.roleAutomationEnabled ? inactiveRole.id : null, exemptionRoleId: data.roleAutomationEnabled ? exemptionRoleIds.join(',') || null : null, roleAutomationEnabled: data.roleAutomationEnabled ? 1 : 0 };
        db.setConfig(guildId, config);
        scheduleGuild({ guild_id: guildId, channel_id: config.channelId, announcement_channel_id: config.announcementChannelId, hour, minute, timezone: config.timezone, title: config.title, body: config.body, active_role_id: config.activeRoleId, inactive_role_id: config.inactiveRoleId, exemption_role_id: config.exemptionRoleId, role_automation_enabled: config.roleAutomationEnabled });
        sendJson(res, 200, { saved: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message.includes('time zone') ? 'Use a valid IANA timezone such as Asia/Manila.' : 'Please check the form values and try again.' });
      }
      return;
    }

    if (req.url.split('?')[0] === '/api/servers') {
      const servers = client.guilds.cache.map(guild => ({
        name: guild.name,
        icon: guild.iconURL({ extension: 'png', size: 64 }),
      })).sort((first, second) => first.name.localeCompare(second.name));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ count: servers.length, servers }));
      return;
    }

    const requestedPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(__dirname, 'public', path.normalize(requestedPath));
    const contentTypes = {
      '.css': 'text/css',
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };

    if (!filePath.startsWith(path.join(__dirname, 'public')) || !contentTypes[path.extname(filePath)]) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found.\n');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found.\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] });
      res.end(content);
    });
  })
  .listen(PORT, () => console.log(`[http] Health check server listening on port ${PORT}`));

const db = require('./db');
const { postAttendance, buildLeaderboardEmbed, buildDailyEmbed, updateAttendanceRoles, forgiveInactiveRole, CHECK_EMOJI } = require('./attendance');
const { todayStr, yesterdayStr, monthStr, minutesSinceMidnight } = require('./utils');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// guildId -> node-cron task, so we can reschedule after /setup-attendance
const scheduledTasks = new Map();

function parseExemptionRoleIds(value) {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/).map(role => {
    const mention = /^<@&(\d+)>$/.exec(role);
    return mention ? mention[1] : role;
  }))];
}

function scheduleGuild(config) {
  const existing = scheduledTasks.get(config.guild_id);
  if (existing) existing.stop();

  const cronExpr = `${config.minute} ${config.hour} * * *`;
  const task = cron.schedule(
    cronExpr,
    () => {
      postAttendance(client, config).catch(err =>
        console.error(`[cron] Failed to post attendance for guild ${config.guild_id}:`, err)
      );
    },
    { timezone: config.timezone || 'UTC' }
  );

  scheduledTasks.set(config.guild_id, task);
  console.log(`[schedule] Guild ${config.guild_id} -> daily at ${config.hour}:${String(config.minute).padStart(2, '0')} (${config.timezone})`);
}

// Re-renders the "Checked in (N)" list on today's attendance post to reflect
// current reactions — including each person's fire streak + shields left,
// so nobody needs to run /my-streak just to see it. Called after every add/remove.
async function refreshAttendanceEmbed(message, config, guildId, dateStr) {
  const userIds = db.getCheckins(guildId, dateStr);
  const guild = message.guild;
  const currentMonth = monthStr(dateStr);
  const entries = [];
  for (const uid of userIds) {
    const member = await guild.members.fetch(uid).catch(() => null);
    const name = member ? member.displayName : `Unknown user (${uid})`;
    const row = db.getStreak(guildId, uid);
    const streak = row ? row.current_streak : 0;
    const shieldsLeft = db.shieldsRemaining(row, currentMonth);
    entries.push({ name, streak, shieldsLeft });
  }
  const embed = buildDailyEmbed(config, dateStr, entries);
  await message.edit({ embeds: [embed] }).catch(err =>
    console.error('[embed] failed to refresh attendance post:', err)
  );
}

// If the bot was offline at the exact scheduled minute (redeploy, restart,
// brief outage, etc.), node-cron's tick is simply missed and nothing posts
// until the *next* day. This catches that up on boot: for each guild, if
// today's post hasn't gone out yet and the scheduled time has already
// passed for today, post immediately — so the daily message + streak reset
// still happens automatically without anyone needing to run
// /post-attendance-now by hand.
async function catchUpMissedPosts(configs) {
  for (const config of configs) {
    try {
      const dateStr = todayStr(config.timezone);
      const active = db.getActiveMessage(config.guild_id);
      if (active && active.attendance_date === dateStr) continue; // already posted today

      // Don't catch up on the same guild-local day the schedule was just
      // created/edited — the schedule's very first occurrence hasn't
      // happened yet from the user's perspective, even though the clock
      // time technically "already passed" earlier today. Real misses on
      // later days still get caught normally.
      if (config.configured_date === dateStr) {
        console.log(`[catchup] Guild ${config.guild_id} config set today — skipping catch-up, waiting for next scheduled run.`);
        continue;
      }

      const nowMinutes = minutesSinceMidnight(config.timezone);
      const scheduledMinutes = config.hour * 60 + config.minute;
      if (nowMinutes >= scheduledMinutes) {
        console.log(`[catchup] Guild ${config.guild_id} missed today's ${config.hour}:${String(config.minute).padStart(2, '0')} post — posting now.`);
        await postAttendance(client, config);
      }
    } catch (err) {
      console.error(`[catchup] Failed for guild ${config.guild_id}:`, err);
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const configs = db.getAllConfigs();
  configs.forEach(scheduleGuild);
  await catchUpMissedPosts(configs);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'setup-attendance') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the Manage Server permission to do this.', ephemeral: true });
      }

      const channel = interaction.options.getChannel('channel', true);
      const announcementChannel = interaction.options.getChannel('announcement-channel');
      const time = interaction.options.getString('time', true);
      const timezone = interaction.options.getString('timezone') || 'UTC';
      const title = interaction.options.getString('title') || 'Daily Attendance';
      const body = interaction.options.getString('message') || 'React with ✅ if you are online today.';
      const roleAutomationEnabled = interaction.options.getBoolean('enable-role-automation') || false;
      const activeRole = interaction.options.getRole('active-role');
      const inactiveRole = interaction.options.getRole('inactive-role');
      const exemptionRoleIds = parseExemptionRoleIds(interaction.options.getString('exemption-roles'));

      if (exemptionRoleIds.some(roleId => !/^\d{17,20}$/.test(roleId))) {
        return interaction.reply({ content: 'Use valid role IDs or role mentions, separated by commas or spaces.', ephemeral: true });
      }

      if (roleAutomationEnabled && (!activeRole || !inactiveRole)) {
        return interaction.reply({ content: 'When role automation is enabled, set both `active-role` and `inactive-role`.', ephemeral: true });
      }
      if (activeRole && inactiveRole && activeRole.id === inactiveRole.id) {
        return interaction.reply({ content: 'The active and inactive roles must be different.', ephemeral: true });
      }

      const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
      if (!match) {
        return interaction.reply({ content: 'Time must be in 24h HH:MM format, e.g. `09:00`.', ephemeral: true });
      }
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) {
        return interaction.reply({ content: 'That time is out of range.', ephemeral: true });
      }

      try {
        // Validate timezone
        Intl.DateTimeFormat('en-US', { timeZone: timezone });
      } catch {
        return interaction.reply({ content: `"${timezone}" isn't a valid IANA timezone (e.g. Asia/Manila, America/New_York).`, ephemeral: true });
      }

      const config = {
        channelId: channel.id, announcementChannelId: announcementChannel?.id || null, hour, minute, timezone, title, body,
        configuredDate: todayStr(timezone),
        activeRoleId: roleAutomationEnabled ? activeRole?.id : null,
        inactiveRoleId: roleAutomationEnabled ? inactiveRole?.id : null,
        exemptionRoleId: roleAutomationEnabled ? exemptionRoleIds.join(',') || null : null,
        roleAutomationEnabled: roleAutomationEnabled ? 1 : 0,
      };
      db.setConfig(interaction.guildId, config);
      scheduleGuild({ guild_id: interaction.guildId, channel_id: channel.id, announcement_channel_id: announcementChannel?.id || null, hour, minute, timezone, title, body, active_role_id: roleAutomationEnabled ? activeRole?.id : null, inactive_role_id: roleAutomationEnabled ? inactiveRole?.id : null, exemption_role_id: roleAutomationEnabled ? exemptionRoleIds.join(',') || null : null, role_automation_enabled: roleAutomationEnabled ? 1 : 0 });

      return interaction.reply({
        content: `✅ Attendance will post daily in ${channel} at **${match[1].padStart(2, '0')}:${match[2]}** (${timezone}) — that time also acts as the daily reset ("midnight") for streaks and shields. Use \`/post-attendance-now\` to test it immediately.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'post-attendance-now') {
      const config = db.getConfig(interaction.guildId);
      if (!config) {
        return interaction.reply({ content: 'Run `/setup-attendance` first.', ephemeral: true });
      }
      await interaction.reply({ content: 'Posting now...', ephemeral: true });
      await postAttendance(client, config);
      return;
    }

    if (interaction.commandName === 'streaks') {
      const embed = await buildLeaderboardEmbed(interaction.guild);
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'my-streak') {
      const row = db.getStreak(interaction.guildId, interaction.user.id);
      if (!row || row.current_streak === 0) {
        return interaction.reply({ content: "You don't have an active streak yet — react ✅ on today's attendance post!", ephemeral: true });
      }
      const currentMonth = monthStr(todayStr('UTC'));
      const shieldsLeft = db.shieldsRemaining(row, currentMonth);

      if (row.shielded_date) {
        return interaction.reply({
          content: `🛡️ Your streak is currently **paused, not broken** — a shield auto-covered your last absence. You're still on a **${row.current_streak}-day** streak (best: ${row.longest_streak}). React ✅ next time to keep it going. Shields left this month: **${shieldsLeft}/${db.MAX_SHIELDS}**.`,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: `🔥 You're on a **${row.current_streak}-day** streak (best: ${row.longest_streak}). Shields left this month: **${shieldsLeft}/${db.MAX_SHIELDS}** (auto-used if you miss a single day).`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'forgive-inactive') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the Manage Server permission to do this.', ephemeral: true });
      }

      const config = db.getConfig(interaction.guildId);
      if (!config?.inactive_role_id) {
        return interaction.reply({ content: 'Inactive role automation is not configured.', ephemeral: true });
      }

      const user = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        return interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
      }

      const restored = await forgiveInactiveRole(member, config);
      return interaction.reply({
        content: restored ? `Restored ${member} to their roles from before inactive status.` : 'No saved roles were found, or this member is exempt.',
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('[interaction] error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (reaction.emoji.name !== CHECK_EMOJI) return;

    const guildId = reaction.message.guildId;
    if (!guildId) return;

    const config = db.getConfig(guildId);
    const today = config ? todayStr(config.timezone) : null;
    const active = db.getActiveMessage(guildId);
    if (!config || !active) return;
    if (active.message_id !== reaction.message.id || active.attendance_date !== today) return; // old or stale post

    const yesterday = yesterdayStr(config.timezone);

    const isNewCheckin = db.recordCheckin(guildId, user.id, today);
    if (!isNewCheckin) return; // already checked in today — avoid double-counting

    const result = db.recordAttendance(guildId, user.id, today, yesterday);
    const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
    await updateAttendanceRoles(member, config, false);
    if (result.status === 'updated' || result.status === 'new') {
      console.log(`[streak] ${user.tag} in guild ${guildId} -> ${result.current_streak} day streak`);
    }

    await refreshAttendanceEmbed(reaction.message, config, guildId, today);
  } catch (err) {
    console.error('[reactionAdd] error:', err);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (reaction.emoji.name !== CHECK_EMOJI) return;

    const guildId = reaction.message.guildId;
    if (!guildId) return;

    const config = db.getConfig(guildId);
    const today = config ? todayStr(config.timezone) : null;
    const active = db.getActiveMessage(guildId);
    if (!config || !active) return;
    if (active.message_id !== reaction.message.id || active.attendance_date !== today) return;

    db.removeCheckin(guildId, user.id, today);

    // Note: this only removes them from today's visible list. It does NOT
    // roll back a streak increment that already happened when they first
    // reacted — if they un-react and never react again today, they'll still
    // count as "checked in" for streak purposes but will show as absent
    // tomorrow's list. This edge case is intentionally left simple.
    await refreshAttendanceEmbed(reaction.message, config, guildId, today);
  } catch (err) {
    console.error('[reactionRemove] error:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
