import { useState } from "react";
import { Phone, Send } from "lucide-react";
import type { CareContact } from "../../types";

type Props = {
  contacts: CareContact[];
  notify: (message: string) => void;
};

export function ContactTeamPanel({ contacts, notify }: Props) {
  const [message, setMessage] = useState("");
  const [recipientId, setRecipientId] = useState(contacts[0]?.id ?? "");
  const recipient = contacts.find((contact) => contact.id === recipientId) ?? contacts[0];

  const sendMessage = () => {
    if (!message.trim() || !recipient) return;
    setMessage("");
    notify(`Message sent to ${recipient.name}. They usually reply within one working day.`);
  };

  return (
    <div className="contact-team">
      <p className="eyebrow">Call directly</p>
      <div className="urgent-calls">
        {contacts.map((contact) => (
          <a key={contact.id} className="call-card" href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}>
            <Phone aria-hidden="true" />
            <span><b>{contact.name}</b><small>{contact.role} · {contact.organisation} · {contact.phone}</small></span>
          </a>
        ))}
      </div>

      <p className="eyebrow">Or send a message</p>
      <form className="team-message-form" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <label htmlFor="team-recipient">To</label>
        <select id="team-recipient" value={recipient?.id ?? ""} onChange={(event) => setRecipientId(event.target.value)}>
          {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} — {contact.role}</option>)}
        </select>
        <label htmlFor="team-message">Your message</label>
        <textarea id="team-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe what you'd like your team to know" />
        <button className="btn primary" type="submit" disabled={!message.trim()}><Send aria-hidden="true" /> Send message</button>
      </form>
      <p className="privacy-note">Messages are not for emergencies. If symptoms are severe, call your team or 999.</p>
    </div>
  );
}
