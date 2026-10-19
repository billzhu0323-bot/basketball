/** Hour (0-23) of `date` in an IANA time zone. */
export function localHour(date: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date);
  return Number(h);
}

/**
 * Earliest instant >= `from` outside quiet hours [start, end) in `timeZone`.
 * Quiet hours may wrap midnight (e.g. 21 -> 9). Steps in 15-minute increments,
 * which keeps DST handling trivial.
 */
export function nextAllowedSendTime(from: Date, timeZone: string, quietStart: number, quietEnd: number): Date {
  const isQuiet = (d: Date) => {
    const h = localHour(d, timeZone);
    if (quietStart === quietEnd) return false;
    return quietStart < quietEnd ? h >= quietStart && h < quietEnd : h >= quietStart || h < quietEnd;
  };
  let t = new Date(from);
  for (let i = 0; i < 4 * 24 && isQuiet(t); i++) {
    t = new Date(t.getTime() + 15 * 60_000);
    t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return t;
}
