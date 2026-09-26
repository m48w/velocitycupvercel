import type { ComponentProps } from "react";
import { LoginForm } from "../features/auth";
import type { SessionInfo } from "../types";
import { AdminSetup } from "./AdminSetup";

type ConsoleProps = Omit<ComponentProps<typeof AdminSetup>, "eyebrow" | "account">;

export function SuperAdmin({
  session,
  signIn,
  ...console
}: ConsoleProps & {
  session: SessionInfo | null;
  signIn: (username: string, password: string) => Promise<unknown>;
}) {
  if (session?.role !== "superadmin") {
    return (
      <LoginForm
        eyebrow="SUPER-ADMIN"
        title="Super-admin sign in"
        description="Sign in to prepare the tournament and correct results on every court."
        fixedUsername="superadmin"
        onSubmit={signIn}
      />
    );
  }
  return <AdminSetup eyebrow="SUPER-ADMIN CONSOLE" account={session} {...console} />;
}
