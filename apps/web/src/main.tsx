import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toasts } from "./components/Toasts";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

// Toasts (issue #111, merged-PR notifications) mount from the entry point
// next to the router — not inside App.tsx — so the surface is independent
// of route churn and needs no router context.
createRoot(container).render(
  <StrictMode>
    <App />
    <Toasts />
  </StrictMode>,
);
