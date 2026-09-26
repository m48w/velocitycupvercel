export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 60_000;

export interface LoginAttempts {
  /** 0 ならログインを試してよい。正の数はあと何秒拒否するか。 */
  retryAfterSeconds(username: string, now: number): number;
  recordFailure(username: string, now: number): void;
  clear(username: string): void;
}

interface AttemptRow {
  failures: number;
  last_failed_at: number;
}

export function createLoginAttempts(sql: SqlStorage): LoginAttempts {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS login_attempts (
       username TEXT PRIMARY KEY,
       failures INTEGER NOT NULL,
       last_failed_at INTEGER NOT NULL
     )`,
  );

  const read = (username: string) =>
    sql
      .exec<{ failures: number; last_failed_at: number }>(
        "SELECT failures, last_failed_at FROM login_attempts WHERE username = ?",
        username,
      )
      .toArray()[0] as AttemptRow | undefined;

  const lockedForMs = (row: AttemptRow | undefined, now: number) =>
    row && row.failures >= MAX_FAILURES ? Math.max(0, row.last_failed_at + LOCKOUT_MS - now) : 0;

  return {
    retryAfterSeconds(username, now) {
      return Math.ceil(lockedForMs(read(username), now) / 1000);
    },

    recordFailure(username, now) {
      const row = read(username);
      // A lockout that has run out starts a fresh count, so one more typo does not lock again at once.
      const expired =
        row !== undefined && row.failures >= MAX_FAILURES && lockedForMs(row, now) === 0;
      const failures = row && !expired ? row.failures + 1 : 1;
      sql.exec(
        `INSERT INTO login_attempts (username, failures, last_failed_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE
           SET failures = excluded.failures, last_failed_at = excluded.last_failed_at`,
        username,
        failures,
        now,
      );
    },

    clear(username) {
      sql.exec("DELETE FROM login_attempts WHERE username = ?", username);
    },
  };
}
