import { useState } from "react";
import { PageTitle } from "../components/ui/PageTitle";
import { MatchCard, stageLabel, teams } from "../features/tournament";
import type { Match } from "../types";

export function Matches({ matches }: { matches: Match[] }) {
  const [stage, setStage] = useState("ALL");
  const [teamId, setTeamId] = useState("ALL");
  const [groupId, setGroupId] = useState("ALL");
  const [court, setCourt] = useState("ALL");
  const filtered = matches.filter(
    (match) =>
      (stage === "ALL" || match.stage === stage) &&
      (teamId === "ALL" || match.homeTeamId === teamId || match.awayTeamId === teamId) &&
      (groupId === "ALL" || match.groupId === groupId) &&
      (court === "ALL" || String(match.court) === court),
  );
  return (
    <>
      <PageTitle eyebrow="FULL TOURNAMENT SCHEDULE" title="All matches">
        <span className="bracket-note">All group fixtures · {filtered.length} shown</span>
      </PageTitle>
      <div className="filter-bar">
        <select value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="ALL">Round · All</option>
          {(["GROUP", "R16", "QF", "SF", "FINAL"] as const).map((option) => (
            <option value={option} key={option}>
              {stageLabel[option]}
            </option>
          ))}
        </select>
        <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
          <option value="ALL">Team · All</option>
          {teams.map((team) => (
            <option value={team.id} key={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="ALL">Group · All</option>
          {["A", "B", "C", "D", "E", "F", "G", "H"].map((value) => (
            <option value={value} key={value}>
              Group {value}
            </option>
          ))}
        </select>
        <select value={court} onChange={(event) => setCourt(event.target.value)}>
          <option value="ALL">Court · All</option>
          {[1, 2, 3].map((value) => (
            <option value={value} key={value}>
              Court {value}
            </option>
          ))}
        </select>
        <button
          className="outline-button"
          type="button"
          onClick={() => {
            setStage("ALL");
            setTeamId("ALL");
            setGroupId("ALL");
            setCourt("ALL");
          }}
        >
          Reset
        </button>
      </div>
      <div className="list-grid">
        {filtered.map((match) => (
          <MatchCard match={match} key={match.id} />
        ))}
      </div>
      <p className="muted centered">
        Showing {filtered.length} of {matches.length} matches
      </p>
    </>
  );
}
