import type { ReactNode } from "react";
import "./page.css";

/**
 * Screen frame: title, optional sub-nav row, content column capped at 640px
 * with 24px padding. Every main-pane page composes on top of it.
 */
export function Page({ title, subnav, children }: { title: string; subnav?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <h1 className="page__title">{title}</h1>
      {subnav !== undefined && <nav className="page__subnav">{subnav}</nav>}
      <div className="page__content">{children}</div>
    </div>
  );
}
