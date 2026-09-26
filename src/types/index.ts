export type Stage = "GROUP" | "R16" | "QF" | "SF" | "FINAL";
export type MatchStatus = "SCHEDULED" | "LIVE" | "PAUSED" | "FINISHED";

export interface Team {
  id: string;
  name: string;
  groupId: string;
  color: string;
}

export interface Match {
  id: string;
  stage: Stage;
  groupId?: string;
  court: number;
  scheduledStart: string;
  durationMinutes: number;
  status: MatchStatus;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  timerServerStartedAt?: string;
  timerElapsedSecondsAtPause?: number;
  isPenaltyShootout?: boolean;
  penaltyHomeScore?: number;
  penaltyAwayScore?: number;
  sourceMatchIds?: string[];
}

export interface TournamentState {
  version: number;
  updatedAt: string;
  matches: Match[];
}

/** WebSocket でサーバーが送るメッセージ。 */
export interface ServerMessage {
  type: "state";
  state: TournamentState;
}

export type Role = "superadmin" | "subadmin";

/** ログイン中の利用者。`GET /api/session` と `POST /api/login` が返す。 */
export interface SessionInfo {
  username: string;
  role: Role;
  /** SubAdmin の担当コート。Super-admin は全コートなので null。 */
  court: number | null;
}
