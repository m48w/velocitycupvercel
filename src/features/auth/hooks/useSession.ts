import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../../types";
import * as api from "../api";

/** 旧版が localStorage に残した「管理者ログイン済み」フラグ。今は何にも使わないので消す。 */
function dropLegacyAdminFlag(): void {
  try {
    localStorage.removeItem("cupflow-admin-authed");
  } catch {
    // localStorage が使えない環境でも続行する。
  }
}

export function useSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  /** Cookie は HttpOnly なので JavaScript からは読めない。サーバーに尋ねる。 */
  const refresh = useCallback(async () => {
    try {
      setSession(await api.fetchSession());
    } catch {
      // Offline: keep whatever we knew; the next action or reload asks again.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    dropLegacyAdminFlag();
    // refresh() only sets state after the `await` inside it resolves, not synchronously — this
    // effect body itself never calls setState directly, so the lint rule is a false positive here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const next = await api.login(username, password);
    setSession(next);
    return next;
  }, []);

  /** Clears the session only once the server confirms the logout, so a network hiccup
   *  can't leave the UI believing it signed out while the cookie is still valid. */
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      return false;
    }
    setSession(null);
    return true;
  }, []);

  return { session, loading, refresh, signIn, signOut };
}
