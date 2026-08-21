require('dotenv').config();
const http = require('http');
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
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Attendance bot is running.\n');
  })
  .listen(PORT, () => console.log(`[http] Health check server listening on port ${PORT}`));

const db = require('./db');
const { postAttendance, buildLeaderboardEmbed, buildDailyEmbed, CHECK_EMOJI } = require('./attendance');
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
      const time = interaction.options.getString('time', true);
      const timezone = interaction.options.getString('timezone') || 'UTC';
      const title = interaction.options.getString('title') || 'Daily Attendance';
      const body = interaction.options.getString('message') || 'React with ✅ if you are online today.';

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

      const config = { channelId: channel.id, hour, minute, timezone, title, body, configuredDate: todayStr(timezone) };
      db.setConfig(interaction.guildId, config);
      scheduleGuild({ guild_id: interaction.guildId, channel_id: channel.id, hour, minute, timezone, title, body });

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
    const active = db.getActiveMessage(guildId);
    if (!config || !active) return;
    if (active.message_id !== reaction.message.id) return; // reacted on an old post, not today's

    const today = todayStr(config.timezone);
    const yesterday = yesterdayStr(config.timezone);

    const isNewCheckin = db.recordCheckin(guildId, user.id, today);
    if (!isNewCheckin) return; // already checked in today — avoid double-counting

    const result = db.recordAttendance(guildId, user.id, today, yesterday);
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
    const active = db.getActiveMessage(guildId);
    if (!config || !active) return;
    if (active.message_id !== reaction.message.id) return;

    const today = todayStr(config.timezone);
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
