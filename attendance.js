const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { todayStr, dateStrPlusDays, monthStr, getStreakTier, getFireIcon, ANSI_RESET } = require('./utils');

const CHECK_EMOJI = '✅';
const SHIELD_EMOJI = '🛡️';

/**
 * Renders one line of the live checked-in list: name, fire icon + streak
 * (colored by tier via a ```ansi code block — desktop/web only, Discord
 * doesn't support colored text on mobile), and shields remaining.
 */
function renderCheckinLine({ name, streak, shieldsLeft }) {
  const tier = getStreakTier(streak);
  const fire = getFireIcon(tier);
  const streakPart = streak > 0 ? ` ${tier.ansi}${fire}${streak}${ANSI_RESET}` : '';
  const shieldPart = streak > 0 ? ` ${SHIELD_EMOJI}${shieldsLeft}` : '';
  return `${name}${streakPart}${shieldPart}`;
}

/**
 * Builds the daily attendance embed, including a live list of who has
 * checked in so far today. `entries` is an array of
 * { name, streak, shieldsLeft } already resolved by the caller, so every
 * reactor sees their fire streak + shields left right on the post — no
 * need to run /my-streak.
 */
function buildDailyEmbed(guildConfig, dateStr, entries) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(guildConfig.title)
    .setDescription(guildConfig.body)
    .setFooter({ text: 'React with ✅ to check in today' })
    .setTimestamp(new Date());

  const lines = entries.map(renderCheckinLine);
  const body = lines.length
    ? '```ansi\n' + lines.join('\n') + '\n```'
    : '_No one yet — be the first!_';

  embed.addFields({
    name: `✅ Checked in (${entries.length})`,
    value: body,
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
      const tier = getStreakTier(row.current_streak);
      const fire = getFireIcon(tier);

      if (row.shielded_date) {
        // Currently sitting on an auto-shielded absence, waiting for them to check back in.
        return `${i + 1}. ${name} ${SHIELD_EMOJI} streak paused (${tier.ansi}${fire}${row.current_streak}${ANSI_RESET} kept, ${shieldsLeft} shield${shieldsLeft === 1 ? '' : 's'} left)`;
      }
      return `${i + 1}. ${name} — ${tier.ansi}${fire}${row.current_streak}${ANSI_RESET} day${row.current_streak === 1 ? '' : 's'} (best: ${row.longest_streak}, ${SHIELD_EMOJI}${shieldsLeft} left)`;
    })
  );

  embed.setDescription('```ansi\n' + lines.join('\n') + '\n```');
  return embed;
}

module.exports = { postAttendance, buildLeaderboardEmbed, buildDailyEmbed, CHECK_EMOJI, SHIELD_EMOJI };
