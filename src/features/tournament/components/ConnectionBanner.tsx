import type { ConnectionState } from "../hooks/useTournamentState";

export function ConnectionBanner({
  connection,
  error,
}: {
  connection: ConnectionState;
  error: string | null;
}) {
  if (connection === "live" && !error) return null;

  const tone = error ? "error" : connection;
  const message =
    error ??
    (connection === "connecting"
      ? "Connecting to the match server…"
      : "Disconnected — showing last known data");

  return <div className={`connection-banner ${tone}`}>{message}</div>;
}
