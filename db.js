const Database = require('better-sqlite3');
const path = require('path');

// On Railway, set DB_PATH to a file inside your mounted volume (e.g. /data/attendance.sqlite)
// so streak data survives redeploys/restarts. Falls back to a local file for VPS/dev use.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'attendance.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    title TEXT NOT NULL DEFAULT 'Daily Attendance',
    body TEXT NOT NULL DEFAULT 'React with the checkmark if you are online today.'
  );

  CREATE TABLE IF NOT EXISTS active_messages (
    guild_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    attendance_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS streaks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_date TEXT,
    PRIMARY KEY (guild_id, user_id)
  );
`);

// ---- config ----
function setConfig(guildId, { channelId, hour, minute, timezone, title, body }) {
  db.prepare(`
    INSERT INTO config (guild_id, channel_id, hour, minute, timezone, title, body)
    VALUES (@guildId, @channelId, @hour, @minute, @timezone, @title, @body)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      hour = excluded.hour,
      minute = excluded.minute,
      timezone = excluded.timezone,
      title = excluded.title,
      body = excluded.body
  `).run({ guildId, channelId, hour, minute, timezone, title, body });
}

function getConfig(guildId) {
  return db.prepare('SELECT * FROM config WHERE guild_id = ?').get(guildId);
}

function getAllConfigs() {
  return db.prepare('SELECT * FROM config').all();
}

// ---- active message tracking (so we know which message is "today's" post) ----
function setActiveMessage(guildId, messageId, channelId, dateStr) {
  db.prepare(`
    INSERT INTO active_messages (guild_id, message_id, channel_id, attendance_date)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      message_id = excluded.message_id,
      channel_id = excluded.channel_id,
      attendance_date = excluded.attendance_date
  `).run(guildId, messageId, channelId, dateStr);
}

function getActiveMessage(guildId) {
  return db.prepare('SELECT * FROM active_messages WHERE guild_id = ?').get(guildId);
}

// ---- streaks ----
function getStreak(guildId, userId) {
  return db.prepare('SELECT * FROM streaks WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

function getLeaderboard(guildId, limit = 25) {
  return db.prepare(`
    SELECT * FROM streaks
    WHERE guild_id = ? AND current_streak > 0
    ORDER BY current_streak DESC, longest_streak DESC
    LIMIT ?
  `).all(guildId, limit);
}

/**
 * Record attendance for a user for a given date (YYYY-MM-DD string, in the guild's configured timezone).
 * Returns the updated streak row plus whether it was a new record-in / already-recorded / streak-continued.
 */
function recordAttendance(guildId, userId, todayStr, yesterdayStr) {
  const existing = getStreak(guildId, userId);

  if (!existing) {
    const row = { current_streak: 1, longest_streak: 1, last_date: todayStr };
    db.prepare(`
      INSERT INTO streaks (guild_id, user_id, current_streak, longest_streak, last_date)
      VALUES (?, ?, 1, 1, ?)
    `).run(guildId, userId, todayStr);
    return { status: 'new', ...row };
  }

  if (existing.last_date === todayStr) {
    return { status: 'already_recorded', ...existing };
  }

  let newStreak;
  if (existing.last_date === yesterdayStr) {
    newStreak = existing.current_streak + 1;
  } else {
    newStreak = 1; // missed a day (or more) — streak resets
  }
  const newLongest = Math.max(existing.longest_streak, newStreak);

  db.prepare(`
    UPDATE streaks SET current_streak = ?, longest_streak = ?, last_date = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(newStreak, newLongest, todayStr, guildId, userId);

  return { status: 'updated', current_streak: newStreak, longest_streak: newLongest, last_date: todayStr };
}

module.exports = {
  setConfig,
  getConfig,
  getAllConfigs,
  setActiveMessage,
  getActiveMessage,
  getStreak,
  getLeaderboard,
  recordAttendance,
};
