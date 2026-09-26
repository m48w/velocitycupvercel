import { useState } from "react";

export function ResetButton({ onReset, disabled }: { onReset: () => void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className="outline-button reset-button"
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        ↺ Reset all matches
      </button>
    );
  }

  return (
    <div className="reset-confirm">
      <span>Reset all 95 matches to unplayed? Scores and timers will be cleared.</span>
      <button
        type="button"
        className="danger-button"
        disabled={disabled}
        onClick={() => {
          onReset();
          setArmed(false);
        }}
      >
        Yes, reset
      </button>
      <button type="button" className="outline-button" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </div>
  );
}
