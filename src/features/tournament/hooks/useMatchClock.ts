import { useEffect, useState } from "react";
import type { Match } from "../../../types";
import { formatClock } from "../../../utils/format";
import { elapsedSeconds } from "../timer";

/** 試合タイマーを mm:ss で返す。試合中だけ1秒ごとに進む。 */
export function useMatchClock(match: Match): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (match.status !== "LIVE") return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [match.status]);
  return formatClock(elapsedSeconds(match, now));
}
