import { PageTitle } from "../components/ui/PageTitle";
import { bracketRounds, type BracketGame } from "../features/tournament";
import type { Match } from "../types";
import { formatTime } from "../utils/format";

function BracketSide({ name, score }: { name: string; score: number | null }) {
  return (
    <div className="bracket-side">
      <span>{name}</span>
      {score !== null && <b>{score}</b>}
    </div>
  );
}

function BracketCard({ game }: { game: BracketGame }) {
  return (
    <div className="bracket-game">
      <small>
        {game.scheduledStart ? `${formatTime(game.scheduledStart)} · Court ${game.court}` : game.id}
      </small>
      <BracketSide name={game.home} score={game.homeScore} />
      <BracketSide name={game.away} score={game.awayScore} />
    </div>
  );
}

export function Bracket({ matches }: { matches: Match[] }) {
  return (
    <>
      <PageTitle eyebrow="WORLD CUP KNOCKOUT" title="Velocity Cup 2026">
        <span className="bracket-note">15 matches · One champion</span>
      </PageTitle>
      <div className="tournament-banner">
        <span>VELOCITY CUP 2026</span>
        <b>ROAD TO THE FINAL</b>
        <small>Every match. Every moment. One champion.</small>
      </div>
      <div className="bracket-scroll">
        <div className="bracket">
          {bracketRounds(matches).map((round) => (
            <section className="bracket-round" key={round.stage}>
              <h3>{round.title}</h3>
              <div className="bracket-slots">
                {round.games.map((game) => (
                  <div className="bracket-slot" key={game.id}>
                    <BracketCard game={game} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
