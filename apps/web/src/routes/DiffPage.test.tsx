/**
 * renderToString smoke test for the diff page (issue #244): the page renders
 * through a MemoryRouter exactly like the terminal view tests do, and the
 * api layer is mocked so no network is reachable. renderToString does not
 * run effects, so what a smoke test can assert is the route-derived loading
 * state — the raw route segment is already turned into the honest title
 * ("PR #9" / "<worker> files changed"). Assertions are on visible text,
 * never on class names.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../lib/api", () => ({
  apiGetPullRequestDiff: vi.fn(async () => {
    throw new Error("not reached: effects do not run in renderToString");
  }),
  apiGetWorkerFilesChanged: vi.fn(async () => {
    throw new Error("not reached: effects do not run in renderToString");
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { DiffPage } from "./DiffPage";

function renderDiff(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/pulls/:prNumber" element={<DiffPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DiffPage (issue #244 smoke)", () => {
  it("derives the PR loading title and board back-link from the route", () => {
    const html = renderDiff("/projects/demo/pulls/9");
    expect(html).toContain("PR #9");
    expect(html).toContain("Loading diff…");
    expect(html).toContain("← Board");
  });

  it("derives the per-worker files-changed loading title from the route", () => {
    const html = renderDiff("/projects/demo/pulls/w-1");
    expect(html).toContain("w-1");
    expect(html).toContain("files changed");
    expect(html).toContain("Loading diff…");
  });
});
