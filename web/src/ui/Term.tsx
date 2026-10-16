import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GLOSSARY, type TermId } from '../lib/glossary';

// A word defined where it is used (review 2026-10-15 W3): a dotted underline
// that opens a short definition from lib/glossary.ts, the same text the About
// page shows. A click, Enter or Space opens it; Escape, a second click, a click
// elsewhere or a scroll closes it, and focus stays on the word. The card is placed
// against the screen (measured before it opens), so it never widens the page.
const CARD = 320;
const EDGE = 8;

export function Term({ id, children }: { id: TermId; children?: ComponentChildren }) {
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const pop = useId();
  const box = useRef<HTMLSpanElement>(null);
  const word = useRef<HTMLButtonElement>(null);
  const open = at !== null;
  // attached as the card renders, not after paint, so a quick Escape or click is never missed
  useLayoutEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const toggle = () => {
    if (open) return setAt(null);
    const r = word.current!.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const width = Math.min(CARD, vw - 2 * EDGE);
    setAt({ left: Math.max(EDGE, Math.min(r.left, vw - width - EDGE)), top: r.bottom + 6, width });
  };
  const g = GLOSSARY[id];
  return (
    <span
      class="term-wrap"
      ref={box}
      onKeyDown={e => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setAt(null);
        }
      }}
    >
      <button
        ref={word}
        type="button"
        class="term"
        aria-expanded={open}
        aria-controls={pop}
        title={open ? undefined : `What “${g.term}” means`}
        onClick={toggle}
      >
        {children ?? g.term}
      </button>
      {at && (
        <span
          id={pop}
          role="note"
          class="term-pop"
          style={{ left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px` }}
        >
          <strong>{g.term}.</strong> {g.text}
        </span>
      )}
    </span>
  );
}
