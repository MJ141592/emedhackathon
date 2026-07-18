import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])';
const modalStack: HTMLElement[] = [];

export function useModalFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    // A newly-mounted modal can make its trigger inert before this effect runs.
    // Callers that know the opener pass it explicitly so focus still has a
    // deterministic destination when the modal closes.
    const previous = returnFocusRef?.current ?? document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (container) modalStack.push(container);
    initialRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (container && modalStack.at(-1) !== container) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCallback.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (container) {
        const position = modalStack.lastIndexOf(container);
        if (position >= 0) modalStack.splice(position, 1);
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [containerRef, initialRef, open, returnFocusRef]);
}
