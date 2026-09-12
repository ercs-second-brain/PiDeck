import type { ReactNode } from "react";
import "./section.css";

/**
 * Settings card: uppercase 12px title, optional description, body, and an
 * optional footer row (Save button + status). Composes `Row`s in its body.
 */
export function Section({ title, description, footer, children }: {
  title?: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      {title !== undefined && <h2 className="section__title">{title}</h2>}
      {description !== undefined && <p className="section__description">{description}</p>}
      <div className="section__body">{children}</div>
      {footer !== undefined && <div className="section__footer">{footer}</div>}
    </section>
  );
}
