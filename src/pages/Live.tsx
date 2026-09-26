import { Empty } from "../components/ui/Empty";
import { PageTitle } from "../components/ui/PageTitle";
import { isOnPitch, MatchCard, stageLabel, TeamBadge } from "../features/tournament";
import type { Match } from "../types";
import { formatTime } from "../utils/format";

export function Live({ matches }: { matches: Match[] }) {
  const live = matches.filter(isOnPitch);
  const nextByCourt = [
    ...matches
      .filter((match) => match.status === "SCHEDULED")
      .sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart))
      .reduce(
        (map, match) => (map.has(match.court) ? map : map.set(match.court, match)),
        new Map<number, Match>(),
      )
      .values(),
  ];
  return (
    <>
      <PageTitle eyebrow="REAL-TIME CENTRE" title="Live matches">
        <span className="refresh-label">
          <i className="live-dot" /> Updates in real time
        </span>
      </PageTitle>
      <div className="live-layout">
        <section>
          <div className="section-heading">
            <h2>On the pitch</h2>
            <span className="muted">{live.length} active</span>
          </div>
          {live.map((match) => (
            <MatchCard match={match} key={match.id} />
          ))}
          {!live.length && <Empty text="No matches are live right now" />}
        </section>
        <aside className="next-panel">
          <div className="eyebrow">NEXT MATCHES · ONE PER COURT</div>
          <h3>Coming up</h3>
          {nextByCourt.map((match) => (
            <div className="next-row" key={match.id}>
              <strong>Court {match.court}</strong>
              <div>
                <TeamBadge id={match.homeTeamId} />
                <TeamBadge id={match.awayTeamId} />
              </div>
              <small>
                {formatTime(match.scheduledStart)} ·{" "}
                {match.groupId ? `Group ${match.groupId}` : stageLabel[match.stage]}
              </small>
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
