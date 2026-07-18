import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";

type Props = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
};

export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onCancel, danger, busy = false, children }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const guardedCancel = () => { if (!busy) onCancel(); };
  useModalFocus(open, dialogRef, cancelRef, guardedCancel);
  if (!open) return null;
  return (
    <div className="modal-layer">
      <section ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" aria-busy={busy}>
        <button className="icon-btn close-corner" onClick={guardedCancel} aria-label="Cancel and close" disabled={busy}><X aria-hidden="true" /></button>
        <p className="eyebrow">Your confirmation is required</p>
        <h2 id="confirm-title">{title}</h2>
        <div id="confirm-description" className="confirm-copy">{description}</div>
        {children}
        <div className="button-row end">
          <button ref={cancelRef} className="btn" onClick={guardedCancel} disabled={busy}>Go back</button>
          <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
