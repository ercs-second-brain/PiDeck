import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toasts } from "./components/Toasts";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

// PWA service worker (issue #179): production builds only — vite dev serves
// public/ too, but the SW has nothing to do for HMR and would only add
// noise. Deliberately minimal, network-first (no asset caching — the app
// must always match the running daemon): see apps/web/public/sw.js and
// docs/pwa.md. `updateViaCache: "none"` keeps the SW script itself
// un-cached so updates are picked up on the next navigation.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  });
}

// Toasts (issue #111, merged-PR notifications) mount from the entry point
// next to the router — not inside App.tsx — so the surface is independent
// of route churn and needs no router context.
createRoot(container).render(
  <StrictMode>
    <App />
    <Toasts />
  </StrictMode>,
);
