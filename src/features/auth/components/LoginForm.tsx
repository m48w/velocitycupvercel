import { useState, type FormEvent } from "react";
import { loginErrorMessage } from "../messages";

export function LoginForm({
  eyebrow,
  title,
  description,
  fixedUsername,
  onSubmit,
}: {
  eyebrow: string;
  title: string;
  description: string;
  /** 指定するとユーザー名の欄を出さない（Super-admin は1アカウントだけ）。 */
  fixedUsername?: string;
  onSubmit: (username: string, password: string) => Promise<unknown>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(fixedUsername ?? username, password);
    } catch (cause) {
      setError(loginErrorMessage(cause));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-gate">
      <div className="admin-gate-card">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
        <form onSubmit={submit}>
          {!fixedUsername && (
            <input
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username (e.g. subadmin1)"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
          <input
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            required
          />
          {error && <div className="login-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
