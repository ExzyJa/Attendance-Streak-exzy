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
    body TEXT NOT NULL DEFAULT 'React with the checkmark if you are online today.',
    active_role_id TEXT,
    inactive_role_id TEXT,
    exemption_role_id TEXT
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

  CREATE TABLE IF NOT EXISTS daily_checkins (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, date)
  );

  CREATE TABLE IF NOT EXISTS role_snapshots (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_ids TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);

// ---- lightweight migration: add shield columns to older DBs without them ----
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
ensureColumn('streaks', 'shields_used', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'shields_month', "TEXT NOT NULL DEFAULT ''");
ensureColumn('streaks', 'shielded_date', 'TEXT');
// Tracks the guild-local calendar date (YYYY-MM-DD) this config was last
// created/edited. Used by catchUpMissedPosts() so it doesn't fire an
// immediate "missed post" catch-up the same day someone just ran
// /setup-attendance — every schedule time technically "already passed"
// on its own creation day, so without this, every fresh setup (or any
// restart later that same day) triggers an instant extra post.
ensureColumn('config', 'configured_date', "TEXT NOT NULL DEFAULT ''");
ensureColumn('config', 'active_role_id', 'TEXT');
ensureColumn('config', 'inactive_role_id', 'TEXT');
ensureColumn('config', 'exemption_role_id', 'TEXT');
ensureColumn('config', 'role_automation_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'absence_days', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'last_absence_date', 'TEXT');
db.prepare(`
  UPDATE config SET role_automation_enabled = 1
  WHERE active_role_id IS NOT NULL AND inactive_role_id IS NOT NULL
    AND role_automation_enabled = 0
`).run();

const MAX_SHIELDS = 3;

// ---- config ----
function setConfig(guildId, { channelId, hour, minute, timezone, title, body, configuredDate, activeRoleId, inactiveRoleId, exemptionRoleId, roleAutomationEnabled }) {
  db.prepare(`
    INSERT INTO config (guild_id, channel_id, hour, minute, timezone, title, body, configured_date, active_role_id, inactive_role_id, exemption_role_id, role_automation_enabled)
    VALUES (@guildId, @channelId, @hour, @minute, @timezone, @title, @body, @configuredDate, @activeRoleId, @inactiveRoleId, @exemptionRoleId, @roleAutomationEnabled)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      hour = excluded.hour,
      minute = excluded.minute,
      timezone = excluded.timezone,
      title = excluded.title,
      body = excluded.body,
        configured_date = excluded.configured_date,
        active_role_id = excluded.active_role_id,
        inactive_role_id = excluded.inactive_role_id,
        exemption_role_id = excluded.exemption_role_id,
        role_automation_enabled = excluded.role_automation_enabled
        `).run({ guildId, channelId, hour, minute, timezone, title, body, configuredDate, activeRoleId, inactiveRoleId, exemptionRoleId, roleAutomationEnabled });
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

// ---- daily check-ins (who reacted ✅ on a given date — drives the live list on the post) ----
/**
 * Records that a user checked in on a given date.
 * Returns true if this is a NEW check-in (first ✅ today), false if they'd
 * already checked in (e.g. duplicate event) — caller should skip streak
 * processing on `false` to avoid double-counting.
 */
function recordCheckin(guildId, userId, dateStr) {
  const res = db.prepare(`
    INSERT OR IGNORE INTO daily_checkins (guild_id, user_id, date) VALUES (?, ?, ?)
  `).run(guildId, userId, dateStr);
  return res.changes > 0;
}

function removeCheckin(guildId, userId, dateStr) {
  db.prepare('DELETE FROM daily_checkins WHERE guild_id = ? AND user_id = ? AND date = ?')
    .run(guildId, userId, dateStr);
}

function getCheckins(guildId, dateStr) {
  return db.prepare('SELECT user_id FROM daily_checkins WHERE guild_id = ? AND date = ?')
    .all(guildId, dateStr)
    .map(r => r.user_id);
}

function saveRoleSnapshot(guildId, userId, roleIds) {
  db.prepare(`
    INSERT INTO role_snapshots (guild_id, user_id, role_ids)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO NOTHING
  `).run(guildId, userId, JSON.stringify(roleIds));
}

function getRoleSnapshot(guildId, userId) {
  const row = db.prepare('SELECT role_ids FROM role_snapshots WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId);
  if (!row) return null;
  try {
    return JSON.parse(row.role_ids);
  } catch {
    return null;
  }
}

function removeRoleSnapshot(guildId, userId) {
  db.prepare('DELETE FROM role_snapshots WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);
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
 * Shields remaining for a user this calendar month (accounts for the lazy
 * monthly reset — shields_used only actually resets in the DB the next time
 * processAbsences touches that row, so we compute the "effective" count here
 * for display purposes without needing to write anything).
 */
function shieldsRemaining(row, monthKey) {
  if (!row) return MAX_SHIELDS;
  const used = row.shields_month === monthKey ? row.shields_used : 0;
  return Math.max(0, MAX_SHIELDS - used);
}

/**
 * Record attendance for a user for a given date (YYYY-MM-DD string, in the guild's configured timezone).
 * `todayStr` here is a date string (param name kept for backward-compat), not a function.
 */
function recordAttendance(guildId, userId, todayDateStr, yesterdayDateStr) {
  const existing = getStreak(guildId, userId);

  if (!existing) {
    db.prepare(`
      INSERT INTO streaks (guild_id, user_id, current_streak, longest_streak, last_date)
      VALUES (?, ?, 1, 1, ?)
    `).run(guildId, userId, todayDateStr);
    return { status: 'new', current_streak: 1, longest_streak: 1 };
  }

  if (existing.last_date === todayDateStr) {
    return { status: 'already_recorded', current_streak: existing.current_streak, longest_streak: existing.longest_streak };
  }

  let newStreak;
  if (existing.last_date === yesterdayDateStr) {
    // Continues normally — this also covers the case where yesterday was a
    // shield-covered absence, since processAbsences() sets last_date to that
    // absent date for shielded users.
    newStreak = existing.current_streak + 1;
  } else {
    newStreak = 1; // real gap — streak resets
  }
  const newLongest = Math.max(existing.longest_streak, newStreak);

  db.prepare(`
    UPDATE streaks SET current_streak = ?, longest_streak = ?, last_date = ?, shielded_date = NULL, absence_days = 0, last_absence_date = NULL
    WHERE guild_id = ? AND user_id = ?
  `).run(newStreak, newLongest, todayDateStr, guildId, userId);

  return { status: 'updated', current_streak: newStreak, longest_streak: newLongest };
}

/**
 * Nightly job: finalize everyone who did NOT check in on `dateStr`.
 *
 * Rules:
 *  - If they were absent for a single isolated day and have a shield left
 *    this month (max 3), the shield auto-applies: their streak is preserved
 *    (not incremented, not reset), that date is marked as "shielded", and
 *    `last_date` is bumped to that date so their streak continues normally
 *    the next time they check in.
 *  - If the immediately preceding date was ALSO a shielded absence (i.e.
 *    this is their 2nd absence in a row), shields cannot cover it — the
 *    streak resets to 0, even if shields remain.
 *  - If they have no shields left this month, the streak resets to 0.
 *
 * `dateStr` = the day that just ended. `prevDateStr` = the day before that.
 * `monthKey` = YYYY-MM of `dateStr`, used for the monthly shield reset.
 */
function processAbsences(guildId, dateStr, prevDateStr, monthKey) {
  const rows = db.prepare('SELECT * FROM streaks WHERE guild_id = ?').all(guildId);

  const checkedIn = new Set(getCheckins(guildId, dateStr));
  const results = [];

  for (const row of rows) {
    if (checkedIn.has(row.user_id)) continue; // present — nothing to finalize
    if (row.last_date === dateStr) continue;   // already accounted for today

    const absenceDays = row.last_absence_date === prevDateStr ? row.absence_days + 1 : 1;

    const shieldsUsed = row.shields_month === monthKey ? row.shields_used : 0;
    const consecutiveAbsence = row.shielded_date === prevDateStr;

    if (!consecutiveAbsence && shieldsUsed < MAX_SHIELDS) {
      db.prepare(`
        UPDATE streaks
        SET shields_used = ?, shields_month = ?, shielded_date = ?, last_date = ?, absence_days = ?, last_absence_date = ?
        WHERE guild_id = ? AND user_id = ?
      `).run(shieldsUsed + 1, monthKey, dateStr, dateStr, absenceDays, dateStr, guildId, row.user_id);
      results.push({ userId: row.user_id, status: 'shielded', streak: row.current_streak, shieldsLeft: MAX_SHIELDS - (shieldsUsed + 1), absenceDays });
    } else {
      db.prepare(`
        UPDATE streaks
        SET current_streak = 0, shielded_date = NULL, shields_used = ?, shields_month = ?, absence_days = ?, last_absence_date = ?
        WHERE guild_id = ? AND user_id = ?
      `).run(shieldsUsed, monthKey, absenceDays, dateStr, guildId, row.user_id);
      results.push({ userId: row.user_id, status: 'reset', previousStreak: row.current_streak, absenceDays });
    }
  }

  return results;
}

module.exports = {
  MAX_SHIELDS,
  setConfig,
  getConfig,
  getAllConfigs,
  setActiveMessage,
  getActiveMessage,
  recordCheckin,
  removeCheckin,
  getCheckins,
  saveRoleSnapshot,
  getRoleSnapshot,
  removeRoleSnapshot,
  getStreak,
  getLeaderboard,
  shieldsRemaining,
  recordAttendance,
  processAbsences,
};
