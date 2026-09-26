import type { Match } from "../../../types";
import { formatTime } from "../../../utils/format";
import { useMatchClock } from "../hooks/useMatchClock";
import { stageLabel } from "../logic";
import { TeamBadge } from "./TeamBadge";

export function MatchCard({ match, compact = false }: { match: Match; compact?: boolean }) {
  const clock = useMatchClock(match);
  const live = match.status === "LIVE";
  const onPitch = live || match.status === "PAUSED";
  return (
    <div className={`match-card ${live ? "match-live" : ""} ${compact ? "compact" : ""}`}>
      <div className="match-card-top">
        <span>
          {stageLabel[match.stage]} {match.groupId && `· Group ${match.groupId}`}
        </span>
        <span className={live ? "status live" : `status ${match.status.toLowerCase()}`}>
          {live
            ? "LIVE"
            : match.status === "PAUSED"
              ? "PAUSED"
              : match.status === "FINISHED"
                ? "FT"
                : formatTime(match.scheduledStart)}
        </span>
      </div>
      <div className="match-teams">
        <div>
          <TeamBadge id={match.homeTeamId} />
          <strong>{match.status === "SCHEDULED" ? "–" : match.homeScore}</strong>
        </div>
        <div>
          <TeamBadge id={match.awayTeamId} />
          <strong>{match.status === "SCHEDULED" ? "–" : match.awayScore}</strong>
        </div>
      </div>
      <div className="match-card-foot">
        <span>
          Match {match.id} · Court {match.court}
        </span>
        {onPitch && <span className={live ? "timer" : "timer paused"}>{clock}</span>}
      </div>
    </div>
  );
}
