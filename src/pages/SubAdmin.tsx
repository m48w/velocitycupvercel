import type { ComponentProps } from "react";
import { LoginForm } from "../features/auth";
import type { SessionInfo } from "../types";
import { AdminSetup } from "./AdminSetup";

type ConsoleProps = Omit<ComponentProps<typeof AdminSetup>, "eyebrow" | "account" | "setup">;

export function SubAdmin({
  session,
  signIn,
  matches,
  ...console
}: ConsoleProps & {
  session: SessionInfo | null;
  signIn: (username: string, password: string) => Promise<unknown>;
}) {
  if (session?.role !== "subadmin") {
    return (
      <LoginForm
        eyebrow="COURT OPERATIONS"
        title="SubAdmin sign in"
        description="Sign in with your court account (subadmin1–6) to run the matches on your court."
        onSubmit={signIn}
      />
    );
  }
  // The server refuses other courts' matches; showing only ours keeps the list to what can be run.
  const courtMatches = matches.filter((match) => match.court === session.court);
  return (
    <AdminSetup
      key={session.court}
      eyebrow={`COURT ${session.court} CONSOLE`}
      account={session}
      matches={courtMatches}
      {...console}
    />
  );
}
