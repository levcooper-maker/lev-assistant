// Time-zone helpers without a date library.

// "-06:00" for America/Chicago in winter, etc.
export function offsetFor(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date);
  const name = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || "00"}` : "+00:00";
}

// YYYY-MM-DD for `date` as seen in `timeZone`.
export function localDate(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Start and end of the local day containing `date`, as ISO strings with offset.
export function dayRange(timeZone, date = new Date(), days = 1) {
  const day = localDate(timeZone, date);
  const start = new Date(`${day}T00:00:00${offsetFor(timeZone, date)}`);
  const end = new Date(start.getTime() + days * 86400000);
  return { day, start: start.toISOString(), end: end.toISOString() };
}

export function localTime(timeZone, iso) {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "all day";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function nowLocal(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}
