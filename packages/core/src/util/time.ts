import { formatIsoDate, getTimeContext, type IsoDate, type TimeContext } from "@ia/data";

export type RunClock = {
  nowMs(): number;
  today(): IsoDate;
  timeContext(): TimeContext;
};

export function systemClock(todayOverride?: IsoDate): RunClock {
  return {
    nowMs: () => Date.now(),
    today: () => {
      if (todayOverride) return todayOverride;
      const now = new Date();
      return formatIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    },
    timeContext: () => getTimeContext(todayOverride ?? (formatIsoDate(new Date()) as IsoDate))
  };
}

