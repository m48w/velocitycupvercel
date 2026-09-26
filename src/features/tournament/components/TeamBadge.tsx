import { findTeam } from "../data";

export function TeamBadge({ id }: { id: string }) {
  const team = findTeam(id);
  return (
    <span className="team-badge">
      <i style={{ background: team?.color }} />
      {team?.name ?? "TBD"}
    </span>
  );
}
