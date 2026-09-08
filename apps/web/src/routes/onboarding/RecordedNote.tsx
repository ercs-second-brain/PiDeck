import type { OnboardingRecord } from "@pideck/shared";

/**
 * Issue #165: the shell installer's recorded onboarding results, surfaced
 * in the wizard header so work the shell onboarding completed (model, gh
 * user) is visible instead of re-asked.
 */
export function RecordedNote({ recorded }: { recorded: OnboardingRecord }) {
  return (
    <p className="perm-detail">
      Shell onboarding completed {recorded.onboardedAt.slice(0, 10)}
      {recorded.pi.model !== null && (
        <>
          {" "}— model <code>{recorded.pi.model}</code>
        </>
      )}
      {recorded.gh.user !== null && (
        <>
          {", gh user "}<code>{recorded.gh.user}</code>
        </>
      )}
    </p>
  );
}
