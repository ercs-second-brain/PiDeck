/**
 * "Could not reach the daemon" note with a Retry button — the error state
 * shared by the daemon-probe surfaces (pi auth banner, onboarding steps).
 */
export function DaemonError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <>
      <p className="error-note">Could not reach the daemon: {error}</p>
      <button type="button" className="button" onClick={onRetry}>
        Retry
      </button>
    </>
  );
}
