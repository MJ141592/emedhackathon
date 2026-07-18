import { useRef, type ReactNode, type RefObject } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";

type Props = {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  onUrgent?: () => void;
  children: ReactNode;
  wide?: boolean;
  contentInert?: boolean;
  contentStatus?: { tone: "saving" | "error"; text: string };
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function Drawer({ open, title, eyebrow, onClose, onUrgent, children, wide, contentInert, contentStatus, returnFocusRef }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  useModalFocus(open, drawerRef, closeRef, onClose, returnFocusRef);

  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={drawerRef} className={wide ? "drawer drawer-wide" : "drawer"} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id="drawer-title">{title}</h2>
          </div>
          <div className="drawer-actions">
            {onUrgent && <button className="btn danger-outline" onClick={onUrgent}><AlertTriangle aria-hidden="true" /> Urgent help</button>}
            <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label={`Close ${title}`}><X aria-hidden="true" /></button>
          </div>
        </header>
        {contentStatus && <p className={`drawer-sync-status ${contentStatus.tone}`} role={contentStatus.tone === "error" ? "alert" : "status"}>{contentStatus.text}</p>}
        <div className="drawer-body" inert={contentInert || undefined} aria-busy={contentInert || undefined}>{children}</div>
      </section>
    </div>
  );
}
