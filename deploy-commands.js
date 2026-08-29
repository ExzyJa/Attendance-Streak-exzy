require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('setup-attendance')
    .setDescription('Configure the daily attendance post for this server')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Channel to post attendance in').setRequired(true))
    .addStringOption(opt =>
      opt.setName('time').setDescription('Time to post daily, 24h HH:MM (e.g. 09:00)').setRequired(true))
      .addChannelOption(opt =>
        opt.setName('announcement-channel').setDescription('Channel for inactive-member announcements').setRequired(false))
    .addStringOption(opt =>
      opt.setName('timezone').setDescription('IANA timezone, e.g. Asia/Manila (default UTC)').setRequired(false))
    .addStringOption(opt =>
      opt.setName('title').setDescription('Embed title (default "Daily Attendance")').setRequired(false))
    .addStringOption(opt =>
      opt.setName('message').setDescription('Embed body text').setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('enable-role-automation').setDescription('Enable inactive role changes and saved-role restoration').setRequired(false))
    .addRoleOption(opt =>
      opt.setName('active-role').setDescription('Optional fallback active role to re-add when a member checks in again').setRequired(false))
    .addRoleOption(opt =>
      opt.setName('inactive-role').setDescription('Role to add when the streak reaches zero').setRequired(false))
    .addStringOption(opt =>
      opt.setName('exemption-roles').setDescription('Role IDs or mentions, separated by commas or spaces').setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('post-attendance-now')
    .setDescription('Manually post today\'s attendance message right now')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('streaks')
    .setDescription('Show the attendance streak leaderboard')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('my-streak')
    .setDescription('Show your current attendance streak')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('forgive-inactive')
    .setDescription('Restore a member\'s roles after forgiving their inactive status')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Member whose previous roles should be restored').setRequired(true))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered globally (can take up to ~1 hour to appear everywhere; instant in servers if you use guild commands instead).');
  } catch (err) {
    console.error(err);
  }
})();
