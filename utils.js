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

function yesterdayStr(timezone) {
  // Get "now" in the target tz, subtract a day, then re-format in that tz.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return dateStrInTz(yesterday, timezone);
}

module.exports = { dateStrInTz, todayStr, yesterdayStr };
