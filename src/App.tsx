import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useSession } from "./features/auth";
import {
  ConnectionBanner,
  seedKnockoutTeams,
  teams,
  useTournamentState,
} from "./features/tournament";
import { Bracket } from "./pages/Bracket";
import { Live } from "./pages/Live";
import { Matches } from "./pages/Matches";
import { Overview } from "./pages/Overview";
import { Standings } from "./pages/Standings";
import { SubAdmin } from "./pages/SubAdmin";
import { SuperAdmin } from "./pages/SuperAdmin";
import type { Match } from "./types";

const navItems = [
  { to: "/", label: "Overview", icon: "⌂" },
  { to: "/matches", label: "Matches", icon: "▦" },
  { to: "/live", label: "Live", icon: "◉" },
  { to: "/standings", label: "Standings", icon: "☷" },
  { to: "/bracket", label: "Bracket", icon: "⌘" },
];

function App() {
  const { session, loading, refresh, signIn, signOut } = useSession();
  const { matches, connection, error, patchMatch, replaceMatches, reset, clearError } =
    useTournamentState({
      onUnauthorized: refresh,
    });
  const navigate = useNavigate();

  const consoleProps = {
    session,
    // Signing back in makes the "sign in to change the tournament" banner stale; drop it.
    signIn: async (username: string, password: string) => {
      const next = await signIn(username, password);
      clearError();
      return next;
    },
    onSignOut: () => signOut(),
    matches,
    updateMatch: (id: string, patch: Partial<Match>) => void patchMatch(id, patch),
    connection,
  };
  const consolePath = session?.role === "superadmin" ? "/superadmin" : "/subadmin";

  return (
    <div className="app-shell">
      <div className="app-header">
        <ConnectionBanner connection={connection} error={error} />
        <header className="topbar">
          <button className="brand" onClick={() => navigate("/")}>
            <span className="brand-mark">V</span>
            <span>
              ELOCITY <span>CUP 2026</span>
            </span>
          </button>
          <div className="event-meta">
            <span className="live-dot" /> LIVE EVENT <b>26 SEP 2026</b>
          </div>
          {/* Staff open /superadmin and /subadmin directly in production; spectators never see these. */}
          {import.meta.env.DEV && (
            <div className="admin-links">
              <NavLink to="/superadmin" className="admin-toggle">
                Super-admin <span>↗</span>
              </NavLink>
              <NavLink to="/subadmin" className="admin-toggle">
                SubAdmin <span>↗</span>
              </NavLink>
            </div>
          )}
        </header>
      </div>
      <div className="layout">
        <aside className="sidebar">
          <div className="side-caption">TOURNAMENT HUB</div>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
          <div className="sidebar-bottom">
            <div className="mini-event">
              <div className="mini-ball">⚽</div>
              <div>
                <strong>Velocity Cup 2026</strong>
                <small>40 teams · 95 matches</small>
              </div>
            </div>
            {session && (
              <NavLink to={consolePath} className="nav-item admin-link">
                ⚙ Console
              </NavLink>
            )}
          </div>
        </aside>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Overview matches={matches} />} />
            <Route path="/matches" element={<Matches matches={matches} />} />
            <Route path="/live" element={<Live matches={matches} />} />
            <Route path="/standings" element={<Standings matches={matches} />} />
            <Route path="/bracket" element={<Bracket matches={matches} />} />
            <Route
              path="/superadmin"
              element={
                loading ? (
                  <p className="muted">Checking sign-in…</p>
                ) : (
                  <SuperAdmin
                    {...consoleProps}
                    setup={{
                      generateSchedule: () =>
                        void replaceMatches(seedKnockoutTeams(teams, matches)),
                      resetTournament: () => void reset(),
                    }}
                  />
                )
              }
            />
            <Route
              path="/subadmin"
              element={
                loading ? (
                  <p className="muted">Checking sign-in…</p>
                ) : (
                  <SubAdmin {...consoleProps} />
                )
              }
            />
            <Route path="/admin/setup" element={<Navigate to="/superadmin" replace />} />
            <Route path="*" element={<Overview matches={matches} />} />
          </Routes>
        </main>
      </div>
      <nav className="bottom-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <footer>
        © 2026 VELOCITY CUP <span>•</span> Tournament operations platform
      </footer>
    </div>
  );
}

export default App;
