export type IsoDate = `${number}-${number}-${number}`;

export type TimeContext = {
  today: IsoDate;
  thisWeekStart: IsoDate;
  thisWeekEnd: IsoDate;
  lastWeekStart: IsoDate;
  lastWeekEnd: IsoDate;
  thisMonthStart: IsoDate;
  thisMonthEnd: IsoDate;
  lastMonthStart: IsoDate;
  lastMonthEnd: IsoDate;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string): asserts value is IsoDate {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
}

export function formatIsoDate(date: Date): IsoDate {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}` as IsoDate;
}

export function parseIsoDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map((x) => Number(x));
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Monday-start week, Sunday-end week.
function startOfUtcWeekMonday(date: Date): Date {
  const day = date.getUTCDay(); // 0=Sun,1=Mon,...6=Sat
  const delta = day === 0 ? -6 : 1 - day;
  return startOfUtcDay(addUtcDays(date, delta));
}

function endOfUtcWeekSunday(date: Date): Date {
  const start = startOfUtcWeekMonday(date);
  return startOfUtcDay(addUtcDays(start, 6));
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date: Date): Date {
  const startNext = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return startOfUtcDay(addUtcDays(startNext, -1));
}

export function getTimeContext(today: IsoDate): TimeContext {
  const todayDate = parseIsoDate(today);

  const thisWeekStart = startOfUtcWeekMonday(todayDate);
  const thisWeekEnd = endOfUtcWeekSunday(todayDate);

  const lastWeekStart = addUtcDays(thisWeekStart, -7);
  const lastWeekEnd = addUtcDays(thisWeekEnd, -7);

  const thisMonthStart = startOfUtcMonth(todayDate);
  const thisMonthEnd = endOfUtcMonth(todayDate);

  const lastMonthEnd = addUtcDays(thisMonthStart, -1);
  const lastMonthStart = startOfUtcMonth(lastMonthEnd);

  return {
    today,
    thisWeekStart: formatIsoDate(thisWeekStart),
    thisWeekEnd: formatIsoDate(thisWeekEnd),
    lastWeekStart: formatIsoDate(lastWeekStart),
    lastWeekEnd: formatIsoDate(lastWeekEnd),
    thisMonthStart: formatIsoDate(thisMonthStart),
    thisMonthEnd: formatIsoDate(thisMonthEnd),
    lastMonthStart: formatIsoDate(lastMonthStart),
    lastMonthEnd: formatIsoDate(lastMonthEnd)
  };
}

export function augmentQueryWithTimeContext(query: string, ctx: TimeContext): string {
  return [
    query.trim(),
    "",
    "[Time context — treat weeks as calendar weeks (Mon–Sun)]",
    `Today: ${ctx.today}`,
    `This week: ${ctx.thisWeekStart}..${ctx.thisWeekEnd}`,
    `Last week: ${ctx.lastWeekStart}..${ctx.lastWeekEnd}`,
    `This month: ${ctx.thisMonthStart}..${ctx.thisMonthEnd}`,
    `Last month: ${ctx.lastMonthStart}..${ctx.lastMonthEnd}`
  ].join("\n");
}

