/**
 * The archived session log viewer: a metadata header (persona, issue/PR
 * links, spawned/archived times, final state) over a read-only xterm holding
 * the captured log from `GET /api/sessions/:id/log`, ANSI colours intact.
 * The xterm is built with the live terminal's theme and configuration — the
 * palette comes from terminal-theme.ts, the font and renderer selection are
 * shared — but nothing is attached: no input path, no connection, and the
 * cursor sits still. A missing log degrades to an empty state, never an
 * error surface.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { Project, SessionView } from "@pideck/shared";
import { githubLinks } from "../shell/tree";
import { relativeTime } from "../shell/relativeTime";
import { api, ApiError } from "../lib/api";
import { MOBILE_POINTER_QUERY } from "../terminal/mobile-input";
import { loadRenderer, monoFontFamily } from "../terminal/Terminal";
import { TERMINAL_THEME } from "../terminal/terminal-theme";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Empty";
import { stateBadge } from "../ui/tones";
import type { Persona } from "@pideck/shared";
import "./logs.css";

const PERSONA_LABELS: Record<Persona, string> = {
  global: "Global agent",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
};

/**
 * Mount/teardown of the read-only log surface: the same xterm configuration
 * as the live terminal (minus cursor blink and any input path), fed the
 * captured log once it has loaded, refitting on container resizes.
 */
function useLogSurface(log: string | null, containerRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (log === null || container === null) return;

    const coarse =
      typeof globalThis.matchMedia === "function" && globalThis.matchMedia(MOBILE_POINTER_QUERY).matches;
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      scrollback: 5000,
      fontSize: coarse ? 12 : 13,
      lineHeight: 1.35,
      fontFamily: monoFontFamily(),
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(container);
    loadRenderer(term);
    term.write(log);

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // Container not measurable yet — the next observer event will fit.
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(container);
    refit();

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [log, containerRef]);
}

export function ArchivedLog({ sessionId, view, project }: {
  sessionId: string;
  view: SessionView;
  project: Project | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [failure, setFailure] = useState<"missing" | "error" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLog(null);
    setFailure(null);
    void api("sessionLog", { id: sessionId })
      .then((result) => {
        if (!cancelled) setLog(result.log);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailure(error instanceof ApiError && error.status === 404 ? "missing" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  useLogSurface(log, containerRef);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const links = project === null ? [] : githubLinks(project, view);
  const badge = view.state !== null ? stateBadge(view.state) : null;
  const { spawnedAt, archivedAt } = view.session;

  return (
    <div className="log-pane">
      <header className="log-head">
        <span className="log-head__persona">{PERSONA_LABELS[view.session.persona]}</span>
        {links.map((link) => (
          <a key={link.url} className="log-head__link" href={link.url} target="_blank" rel="noreferrer">
            {link.label.replace("Open ", "")}
          </a>
        ))}
        <span className="log-head__times" title={archivedAt ?? spawnedAt}>
          spawned {relativeTime(spawnedAt)}
          {archivedAt !== undefined && <> · archived {relativeTime(archivedAt)}</>}
        </span>
        {badge !== null && (
          <span className="log-head__state">
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        )}
      </header>
      {log === null && failure === null && <Empty>Loading log…</Empty>}
      {failure === "missing" && <Empty>No log was captured for this session.</Empty>}
      {failure === "error" && (
        <Empty action={<Button variant="primary" onClick={retry}>Retry</Button>}>Cannot load the log.</Empty>
      )}
      {log !== null && (
        <div className="log-body">
          <div ref={containerRef} className="log-screen" />
        </div>
      )}
    </div>
  );
}