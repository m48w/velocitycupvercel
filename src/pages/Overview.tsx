import { NavLink } from "react-router-dom";
import { Empty } from "../components/ui/Empty";
import { PageTitle } from "../components/ui/PageTitle";
import { isOnPitch, MatchCard } from "../features/tournament";
import type { Match } from "../types";

export function Overview({ matches }: { matches: Match[] }) {
  const live = matches.filter(isOnPitch);
  const next = matches.filter((m) => m.status === "SCHEDULED").slice(0, 3);
  return (
    <>
      <PageTitle eyebrow="SATURDAY · 26 SEPTEMBER 2026" title="Tournament overview">
        <button className="outline-button">↗ Share event</button>
      </PageTitle>
      <section className="hero-grid">
        <div className="hero-card">
          <div className="hero-kicker">AUTUMN CUP 2026</div>
          <h2>
            One day.
            <br />
            <em>One champion.</em>
          </h2>
          <p>Follow every score, table and knockout moment in real time.</p>
          <div className="hero-stats">
            <div>
              <b>40</b>
              <span>Teams</span>
            </div>
            <div>
              <b>95</b>
              <span>Matches</span>
            </div>
            <div>
              <b>8</b>
              <span>Groups</span>
            </div>
          </div>
        </div>
        <div className="today-card">
          <div className="section-heading">
            <h3>Live now</h3>
            <NavLink to="/live">View live ↗</NavLink>
          </div>
          {live.length ? (
            live.map((match) => <MatchCard match={match} key={match.id} />)
          ) : (
            <Empty text="No matches are live right now" />
          )}
        </div>
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <div className="eyebrow">UP NEXT</div>
            <h2>Today’s schedule</h2>
          </div>
          <NavLink to="/matches">View all matches ↗</NavLink>
        </div>
        <div className="match-grid">
          {next.map((match) => (
            <MatchCard match={match} key={match.id} />
          ))}
        </div>
      </section>
    </>
  );
}
