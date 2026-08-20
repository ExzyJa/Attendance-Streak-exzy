const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { todayStr } = require('./utils');

const CHECK_EMOJI = '✅';

async function postAttendance(client, guildConfig) {
  const channel = await client.channels.fetch(guildConfig.channel_id).catch(() => null);
  if (!channel) {
    console.error(`[attendance] Could not fetch channel ${guildConfig.channel_id} for guild ${guildConfig.guild_id}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(guildConfig.title)
    .setDescription(guildConfig.body)
    .setFooter({ text: 'React with ✅ to check in today' })
    .setTimestamp(new Date());

  const message = await channel.send({ content: '@everyone', embeds: [embed] });
  await message.react(CHECK_EMOJI);

  const dateStr = todayStr(guildConfig.timezone);
  db.setActiveMessage(guildConfig.guild_id, message.id, channel.id, dateStr);

  return message;
}

async function buildLeaderboardEmbed(guild, limit = 25) {
  const rows = db.getLeaderboard(guild.id, limit);

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
      return `**${i + 1}.** ${name} — 🔥 ${row.current_streak} day${row.current_streak === 1 ? '' : 's'} (best: ${row.longest_streak})`;
    })
  );

  embed.setDescription(lines.join('\n'));
  return embed;
}

module.exports = { postAttendance, buildLeaderboardEmbed, CHECK_EMOJI };
