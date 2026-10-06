import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

// A modal dialog's keyboard contract (staff review F18): Tab and Shift+Tab stay
// inside it, Escape closes it, and focus goes back to whatever opened it when
// it closes. The dialog sets its own first focus (an input, a Close button).

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog(ref: RefObject<HTMLElement>, onClose: () => void, open = true): void {
  const close = useRef(onClose);
  close.current = onClose;
  // a layout effect: it records the trigger before the dialog moves focus to its input
  useLayoutEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest('[hidden]'));
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (!box.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open]);
}
