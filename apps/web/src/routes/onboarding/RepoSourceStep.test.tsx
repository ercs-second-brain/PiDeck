/**
 * Tests for the onboarding repo selector (issue #217): the clone URL is
 * composed verbatim from real repo data (no case transformation — the #216
 * bug class), and the filter narrows case-insensitively. The step renders
 * with `renderToString` (same pattern as the workers-panel tests); the
 * fetch itself only runs in client effects, so clone mode shows its loading
 * state.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { AccessibleRepo } from "@pideck/shared";

import { cloneUrl, filterRepos, RepoSourceStep } from "./RepoSourceStep";
import { INITIAL_FORM, type WizardForm } from "./wizard-form";

const REPOS: AccessibleRepo[] = [
  { owner: "o", name: "pidecktest", isPrivate: true },
  { owner: "o", name: "MixedCase", isPrivate: false },
];

describe("cloneUrl (issue #217)", () => {
  it("composes the clone URL verbatim from real repo data", () => {
    expect(cloneUrl(REPOS[0] as AccessibleRepo)).toBe("https://github.com/o/pidecktest");
    expect(cloneUrl(REPOS[1] as AccessibleRepo)).toBe("https://github.com/o/MixedCase");
  });
});

describe("filterRepos (issue #217)", () => {
  it("narrows case-insensitively on owner/name", () => {
    expect(filterRepos(REPOS, "pideck")).toEqual([{ owner: "o", name: "pidecktest", isPrivate: true }]);
    expect(filterRepos(REPOS, "MIXEDCASE")).toEqual([{ owner: "o", name: "MixedCase", isPrivate: false }]);
    expect(filterRepos(REPOS, "  ")).toEqual(REPOS);
    expect(filterRepos(REPOS, "nope")).toEqual([]);
  });
});

describe("RepoSourceStep", () => {
  const noop = (): void => {};

  function render(form: WizardForm): string {
    return renderToString(
      <RepoSourceStep form={form} onChange={noop} onError={noop} error={null} onContinue={noop} />,
    );
  }

  it("clone mode shows the selector's loading state until the client fetch lands", () => {
    expect(render({ ...INITIAL_FORM, mode: "clone" })).toContain("Loading your repositories");
  });

  it("create mode keeps the new-repo name field and public toggle", () => {
    const html = render({ ...INITIAL_FORM, mode: "create" });
    expect(html).toContain("New repository name");
    expect(html).toContain("Public repository");
  });
});
