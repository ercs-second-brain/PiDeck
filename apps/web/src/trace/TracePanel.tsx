import { useEffect, useState } from "react";
import type { SessionTrace, TraceEntry, TraceFacts } from "@pideck/shared";
import { api } from "../lib/api";
import { relativeTime } from "../shell/relativeTime";
import { Badge } from "../ui/Badge";
import "./trace.css";

const KIND_TONES: Record<TraceEntry["kind"], "blue" | "amber" | "purple" | "green" | "dim"> = {
  delivery: "blue",
  state: "amber",
  spawn: "purple",
  archive: "dim",
  facts: "green",
};

/** Live sessions gain new entries as the daemon works; refresh while open. */
const REFRESH_MS = 5000;

/**
 * The collapsible Trace panel under a session's terminal (live and
 * archived): what the daemon saw and sent, newest first. Deliveries expand
 * to show the exact line that went into the pane; the header links to the
 * session's pi transcript when it still exists.
 */
export function TracePanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<SessionTrace | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api("sessionTrace", { id: sessionId })
        .then((result) => {
          if (!cancelled) setTrace(result);
        })
        .catch(() => {
          // The pane still works without the trace; try again on the next tick.
        });
    };
    load();
    const timer = open ? setInterval(load, REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sessionId, open]);

  const entries = trace?.entries ?? [];
  const toggle = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <section className="trace">
      <div className="trace__bar">
        <button type="button" className="trace__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`trace__chevron${open ? " trace__chevron--open" : ""}`}>▸</span>
          Trace{trace !== null ? ` (${entries.length})` : ""}
        </button>
        {trace?.transcriptPath != null && (
          <a
            className="trace__transcript"
            href={`file://${trace.transcriptPath}`}
            title={trace.transcriptPath}
            target="_blank"
            rel="noreferrer"
          >
            pi transcript
          </a>
        )}
      </div>
      {open && (
        <div className="trace__list">
          {entries.length === 0 && <p className="trace__empty">Nothing traced for this session yet.</p>}
          {[...entries].reverse().map((entry, position) => {
            const index = entries.length - 1 - position;
            return (
              <div key={index} className="trace__item">
                <div className="trace__row">
                  <span className="trace__time" title={entry.at}>
                    {relativeTime(entry.at)}
                  </span>
                  <Badge tone={KIND_TONES[entry.kind]}>{entry.kind}</Badge>
                  {entry.kind === "delivery" ? (
                    <button
                      type="button"
                      className="trace__summary trace__summary--button"
                      onClick={() => toggle(index)}
                    >
                      {entry.text ?? ""}
                    </button>
                  ) : (
                    <span className="trace__summary">{traceSummary(entry)}</span>
                  )}
                </div>
                {entry.kind === "delivery" && expanded.has(index) && (
                  <pre className="trace__text">{entry.text}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function traceSummary(entry: TraceEntry): string {
  if (entry.kind === "state") {
    return `${entry.from ?? "-"} → ${entry.to ?? "-"} · ${entry.status ?? ""}`;
  }
  if (entry.kind === "facts") return factsSummary(entry.facts);
  return entry.detail ?? "";
}

function factsSummary(facts: TraceFacts | undefined): string {
  if (facts === undefined) return "";
  const parts: string[] = [];
  if (facts.issueNumber !== undefined) parts.push(`issue #${facts.issueNumber}`);
  if (facts.openBlockers !== undefined) parts.push(`blockers ${facts.openBlockers}`);
  if (facts.prNumber !== undefined) parts.push(`PR #${facts.prNumber}`);
  if (facts.headSha !== undefined) parts.push(`head ${facts.headSha.slice(0, 7)}`);
  if (facts.ci !== undefined) parts.push(`ci ${facts.ci}`);
  if (facts.failingChecks !== undefined && facts.failingChecks.length > 0) {
    parts.push(`failing: ${facts.failingChecks.join(", ")}`);
  }
  if (facts.reviewDecision !== undefined) parts.push(`review ${facts.reviewDecision ?? "-"}`);
  if (facts.mergeable !== undefined) parts.push(facts.mergeable.toLowerCase());
  return parts.join(" · ");
}
