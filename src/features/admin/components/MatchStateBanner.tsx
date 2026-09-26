import type { Match } from "../../../types";
import { formatTime } from "../../../utils/format";
import { useMatchClock } from "../../tournament";

const LABELS: Record<Match["status"], string> = {
  SCHEDULED: "Not started",
  LIVE: "● LIVE — in progress",
  PAUSED: "Ⅱ PAUSED",
  FINISHED: "■ Finished",
};

/** 選択中の試合がいまどの状態か、タイマーと一緒に大きく示す。 */
export function MatchStateBanner({ match }: { match: Match }) {
  const clock = useMatchClock(match);
  return (
    <div className={`match-state ${match.status.toLowerCase()}`}>
      <span>{LABELS[match.status]}</span>
      <b>
        {match.status === "SCHEDULED"
          ? `Kick-off ${formatTime(match.scheduledStart)} · Court ${match.court}`
          : clock}
      </b>
    </div>
  );
}
