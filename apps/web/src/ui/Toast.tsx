import { useEffect } from "react";
import "./toast.css";

/**
 * Transient message, bottom-right (bottom-centre on mobile). Auto-dismisses
 * after 3 s when `onDismiss` is given.
 */
export function Toast({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  useEffect(() => {
    if (message === null || onDismiss === undefined) return;
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (message === null) return null;
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}
