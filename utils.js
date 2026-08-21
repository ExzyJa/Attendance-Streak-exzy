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

module.exports = { dateStrInTz, todayStr, yesterdayStr, dateStrPlusDays, monthStr };
