/**
 * Returns a YYYY-MM-DD string for "now" (or a given Date) in a specific IANA timezone.
 * No extra deps needed — uses Intl under the hood.
 */
function dateStrInTz(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD
  return fmt.format(date);
}

function todayStr(timezone) {
  return dateStrInTz(new Date(), timezone);
}

/**
 * Shifts a YYYY-MM-DD calendar-date string by `delta` days (can be negative).
 * Pure calendar math — pins to UTC noon internally so it's immune to DST shifts.
 */
function dateStrPlusDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function yesterdayStr(timezone) {
  return dateStrPlusDays(todayStr(timezone), -1);
}

/**
 * Returns the YYYY-MM portion of a YYYY-MM-DD string — used as the monthly
 * bucket key for resetting each user's 3 shields.
 */
function monthStr(dateStr) {
  return dateStr.slice(0, 7);
}

/**
 * Returns how many minutes past local midnight it currently is, in a given
 * IANA timezone. Used to figure out whether "today's scheduled post time"
 * has already passed, without pulling in a date-math library.
 */
function minutesSinceMidnight(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return hour * 60 + minute;
}

/**
 * Streak "fire" tiers. Each tier has an ANSI color code (used to render the
 * live checked-in list in a colored ```ansi code block — Discord supports
 * this in the desktop/web client; it degrades to plain text on mobile,
 * which is a Discord limitation, not something we can work around) plus an
 * env var name a server owner can set to a real *animated* custom emoji
 * (e.g. `<a:fire_blue:123456789012345678>`) for that tier. If unset, we
 * fall back to a plain 🔥 (static — Discord doesn't allow embedding
 * arbitrary animated GIFs inline in text; only custom guild emoji can be
 * animated inline).
 *
 * min: minimum streak (inclusive) to qualify for this tier. Order matters —
 * first match wins, so keep this sorted highest-min to lowest-min.
 */
const STREAK_TIERS = [
  { min: 200, name: 'Black-Purple', ansi: '\u001b[1;35;40m', envKey: 'FIRE_EMOJI_BLACK_PURPLE' }, // bold magenta on black
  { min: 100, name: 'Purple-Red', ansi: '\u001b[1;35m', envKey: 'FIRE_EMOJI_PURPLE_RED' },          // bold magenta
  { min: 60, name: 'Violet', ansi: '\u001b[35m', envKey: 'FIRE_EMOJI_VIOLET' },                     // magenta/pink
  { min: 30, name: 'Blue', ansi: '\u001b[34m', envKey: 'FIRE_EMOJI_BLUE' },                         // blue
  { min: 0, name: 'Classic', ansi: '\u001b[33m', envKey: 'FIRE_EMOJI_DEFAULT' },                    // yellow/orange
];
const ANSI_RESET = '\u001b[0m';
const DEFAULT_FIRE_EMOJI = '🔥';

/**
 * Returns the highest tier a given streak qualifies for.
 */
function getStreakTier(streak) {
  return STREAK_TIERS.find(t => streak >= t.min) || STREAK_TIERS[STREAK_TIERS.length - 1];
}

/**
 * Returns the fire "icon" to use for a tier — a real animated custom emoji
 * if the server owner configured one via env, otherwise the static fallback.
 */
function getFireIcon(tier) {
  const configured = process.env[tier.envKey];
  return configured && configured.trim() ? configured.trim() : DEFAULT_FIRE_EMOJI;
}

module.exports = {
  dateStrInTz,
  todayStr,
  yesterdayStr,
  dateStrPlusDays,
  monthStr,
  minutesSinceMidnight,
  getStreakTier,
  getFireIcon,
  ANSI_RESET,
  STREAK_TIERS,
};
