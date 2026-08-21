const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { todayStr, dateStrPlusDays, monthStr } = require('./utils');

const CHECK_EMOJI = '✅';

/**
 * Builds the daily attendance embed, including a live list of who has
 * checked in so far today (names passed in, already resolved by the caller).
 */
function buildDailyEmbed(guildConfig, dateStr, names) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(guildConfig.title)
    .setDescription(guildConfig.body)
    .setFooter({ text: 'React with ✅ to check in today' })
    .setTimestamp(new Date());

  embed.addFields({
    name: `✅ Checked in (${names.length})`,
    value: names.length ? names.join('\n') : '_No one yet — be the first!_',
  });

  return embed;
}

async function postAttendance(client, guildConfig) {
  const channel = await client.channels.fetch(guildConfig.channel_id).catch(() => null);
  if (!channel) {
    console.error(`[attendance] Could not fetch channel ${guildConfig.channel_id} for guild ${guildConfig.guild_id}`);
    return;
  }

  const dateStr = todayStr(guildConfig.timezone);

  // Before posting today's new message, finalize yesterday's attendance:
  // anyone who didn't check in gets auto-shielded (if eligible) or reset.
  const prevActive = db.getActiveMessage(guildConfig.guild_id);
  if (prevActive && prevActive.attendance_date && prevActive.attendance_date !== dateStr) {
    const prevDate = prevActive.attendance_date;
    const prevBeforeThat = dateStrPlusDays(prevDate, -1);
    const monthKey = monthStr(prevDate);
    const results = db.processAbsences(guildConfig.guild_id, prevDate, prevBeforeThat, monthKey);
    for (const r of results) {
      if (r.status === 'shielded') {
        console.log(`[shield] user ${r.userId} in guild ${guildConfig.guild_id} auto-shielded (${r.shieldsLeft} left this month)`);
      } else {
        console.log(`[streak] user ${r.userId} in guild ${guildConfig.guild_id} streak reset (was ${r.previousStreak})`);
      }
    }
  }

  const embed = buildDailyEmbed(guildConfig, dateStr, []);
  const message = await channel.send({ content: '@everyone', embeds: [embed] });
  await message.react(CHECK_EMOJI);

  db.setActiveMessage(guildConfig.guild_id, message.id, channel.id, dateStr);

  return message;
}

async function buildLeaderboardEmbed(guild, limit = 25) {
  const rows = db.getLeaderboard(guild.id, limit);
  const currentMonth = monthStr(todayStr('UTC'));

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🔥 Attendance Streaks')
    .setTimestamp(new Date());

  if (rows.length === 0) {
    embed.setDescription('No active streaks yet — react to today\'s attendance post to start one!');
    return embed;
  }

  const lines = await Promise.all(
    rows.map(async (row, i) => {
      const member = await guild.members.fetch(row.user_id).catch(() => null);
      const name = member ? member.displayName : `Unknown user (${row.user_id})`;
      const shieldsLeft = db.shieldsRemaining(row, currentMonth);

      if (row.shielded_date) {
        // Currently sitting on an auto-shielded absence, waiting for them to check back in.
        return `**${i + 1}.** ${name} — 🛡️ streak paused (🔥 ${row.current_streak} kept, ${shieldsLeft} shield${shieldsLeft === 1 ? '' : 's'} left)`;
      }
      return `**${i + 1}.** ${name} — 🔥 ${row.current_streak} day${row.current_streak === 1 ? '' : 's'} (best: ${row.longest_streak}, ${shieldsLeft} shield${shieldsLeft === 1 ? '' : 's'} left)`;
    })
  );

  embed.setDescription(lines.join('\n'));
  return embed;
}

module.exports = { postAttendance, buildLeaderboardEmbed, buildDailyEmbed, CHECK_EMOJI };
