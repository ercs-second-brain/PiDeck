/**
 * Edits one persona's effective prompt. Persona tabs switch which prompt is
 * loaded; the textarea holds the draft. Save stores an override, Reset to
 * default drops it after confirming. A Shipped/Edited badge shows whether
 * the stored prompt is the shipped one or an override, and the daemon's
 * placeholder list sits in a collapsible aside beside the editor.
 */

import { useEffect, useState } from "react";
import { errorMessage, Personas, type Persona, type Prompt } from "@pideck/shared";
import { Section } from "../ui/Section";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Dialog } from "../ui/Dialog";
import { PERSONA_LABELS } from "./personas";
import { PromptPlaceholders } from "./placeholders";
import { loadPrompt, resetPrompt, savePrompt } from "./client";
import { actionLabel, useAction } from "./use-action";

export function PromptEditor() {
  const [persona, setPersona] = useState<Persona>("global");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const action = useAction();

  useEffect(() => {
    let alive = true;
    setPrompt(null);
    setLoadError(null);
    loadPrompt(persona)
      .then((loaded) => {
        if (!alive) return;
        setPrompt(loaded);
        setDraft(loaded.prompt);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [persona]);

  const onSave = () => {
    void action.run(async () => {
      const saved = await savePrompt(persona, { prompt: draft });
      setPrompt(saved);
      setDraft(saved.prompt);
    });
  };

  const onReset = () => {
    setConfirmReset(false);
    void action.run(async () => {
      const saved = await resetPrompt(persona);
      setPrompt(saved);
      setDraft(saved.prompt);
    });
  };

  if (loadError) {
    return (
      <Section title="Prompts">
        <p style={{ color: "var(--red)" }}>
          The {PERSONA_LABELS[persona]} prompt could not be loaded: {loadError}
        </p>
      </Section>
    );
  }

  const label = PERSONA_LABELS[persona];
  const unchanged = prompt !== null && draft === prompt.prompt;

  return (
    <Section
      title="Prompts"
      description="Role, loop and boundaries for one persona. Saving stores an override; reset returns to the shipped prompt."
      footer={
        <>
          {action.error && <p style={{ color: "var(--red)", margin: 0 }}>{action.error}</p>}
          {prompt && !unchanged && action.state !== "busy" && (
            <span style={{ color: "var(--text-dim)" }}>Unsaved changes</span>
          )}
          <Button
            variant="ghost"
            disabled={!prompt || action.state === "busy"}
            onClick={() => setConfirmReset(true)}
          >
            {actionLabel(action.state, "Reset to default", "Resetting…", "Reset")}
          </Button>
          <Button
            variant="primary"
            disabled={!prompt || unchanged || action.state === "busy"}
            onClick={onSave}
          >
            {actionLabel(action.state, "Save", "Saving…")}
          </Button>
        </>
      }
    >
      <div role="tablist" aria-label="Persona prompts" style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
        {Personas.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={p === persona}
            onClick={() => setPersona(p)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              color: p === persona ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            {PERSONA_LABELS[p]}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
        <textarea
          value={prompt ? draft : ""}
          disabled={!prompt}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`${label} prompt`}
          spellCheck={false}
          rows={18}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: "320px",
            resize: "vertical",
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
            lineHeight: 1.5,
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            padding: "8px",
          }}
        />
        <aside style={{ width: "200px", flexShrink: 0, color: "var(--text-dim)", fontSize: "12px" }}>
          <details>
            <summary>Placeholders</summary>
            <ul style={{ margin: "8px 0", paddingLeft: "16px" }}>
              {PromptPlaceholders.map((placeholder) => (
                <li key={placeholder.token} style={{ marginBottom: "6px" }}>
                  <code>{"{{" + placeholder.token + "}}"}</code> — {placeholder.description}
                </li>
              ))}
            </ul>
          </details>
        </aside>
      </div>
      {prompt && (
        <p style={{ marginTop: "8px" }}>
          <Badge tone={prompt.edited ? "amber" : "dim"}>{prompt.edited ? "Edited" : "Shipped"}</Badge>
        </p>
      )}
      <Dialog
        open={confirmReset}
        title={`Reset the ${label} prompt to the shipped default?`}
        confirmLabel="Reset"
        danger
        onConfirm={onReset}
        onCancel={() => setConfirmReset(false)}
      />
    </Section>
  );
}