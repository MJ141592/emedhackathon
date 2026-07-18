import { useRef, type RefObject } from "react";
import { AlertTriangle, Phone, X } from "lucide-react";
import type { CareContact, SafetyAlert } from "../../types";
import { useModalFocus } from "./useModalFocus";

export function UrgentHelpDialog({ open, alert, contacts, onClose, onCare, returnFocusRef }: { open: boolean; alert?: SafetyAlert; contacts: CareContact[]; onClose: () => void; onCare?: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(open, dialogRef, closeRef, onClose, returnFocusRef);
  if (!open) return null;
  const sameDay = alert?.level === "same-day";
  const ibdContact = contacts.find((contact) => /ibd|gastro|nurse/i.test(`${contact.role} ${contact.organisation}`)) ?? contacts[0];
  return <div className="modal-layer urgent-layer"><section ref={dialogRef} className="urgent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="urgent-title"><button ref={closeRef} className="icon-btn close-corner" onClick={onClose} aria-label="Close urgent help"><X /></button><div className="urgent-symbol"><AlertTriangle /></div><p className="eyebrow">Do not wait for Penny</p><h2 id="urgent-title">{sameDay ? "Get same-day clinical advice" : "Urgent symptoms need urgent care"}</h2>{alert && <div className="screen-result"><b>Separate rules-based safety screen matched:</b><ul>{alert.triggers.map((trigger) => <li key={trigger}>{trigger}</li>)}</ul><p>{alert.message}</p></div>}<p>{sameDay ? "Contact your IBD team or GP today. If symptoms become severe, you feel unsafe, or you cannot get timely advice, use urgent care." : "Heavy or continuous bleeding, severe abdominal pain, faintness, repeated vomiting or possible obstruction need urgent assessment. Fever and dehydration need same-day clinical advice."}</p><div className="urgent-calls">{ibdContact && <a className="call-card" href={`tel:${ibdContact.phone.replace(/[^+\d]/g, "")}`}><Phone /><span><b>{ibdContact.name}</b><small>{ibdContact.role} · {sameDay ? "contact today" : "not emergency care"}</small></span></a>}<a className="call-card" href="tel:111"><Phone /><span><b>NHS 111</b><small>Urgent medical advice now</small></span></a><a className="call-card emergency" href="tel:999"><Phone /><span><b>999 or A&amp;E</b><small>If severe or in immediate danger</small></span></a></div><p className="privacy-note">Gutsy cannot assess your condition or guarantee safety. A team message may not be read immediately.</p><div className="button-row end">{onCare && <button className="btn" onClick={() => { onCare(); onClose(); }}>Open full safety check</button>}<button className="btn primary" onClick={onClose}>Close</button></div></section></div>;
}
