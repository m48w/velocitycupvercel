import type { Match } from "../../../types";
import { formatTime } from "../../../utils/format";
import { findCourtConflicts, matchEndMs } from "../../tournament";

export function ScheduleCheck({ matches }: { matches: Match[] }) {
  const conflicts = findCourtConflicts(matches);
  const finish = matches.length
    ? formatTime(new Date(Math.max(...matches.map(matchEndMs))).toISOString())
    : "—";

  if (!conflicts.length) {
    return (
      <div className="warning-box ok">
        ⓘ Schedule check: {matches.length} matches, no court clashes, finishing {finish}.
      </div>
    );
  }

  return (
    <div className="warning-box">
      ⚠ Schedule check: {conflicts.length} court clash{conflicts.length > 1 ? "es" : ""} —{" "}
      {conflicts
        .slice(0, 3)
        .map(([a, b]) => `${a.id}×${b.id}`)
        .join(", ")}
      {conflicts.length > 3 ? "…" : ""}
    </div>
  );
}
