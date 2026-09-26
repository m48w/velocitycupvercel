import type { SessionInfo } from "../../types";
import { requestJson } from "../../utils/http";

export const fetchSession = async () =>
  (await requestJson<{ session: SessionInfo | null }>("/api/session")).session;

export const login = async (username: string, password: string) =>
  (
    await requestJson<{ session: SessionInfo }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    })
  ).session;

export const logout = async () => {
  await requestJson<{ session: null }>("/api/logout", { method: "POST", body: "{}" });
};
