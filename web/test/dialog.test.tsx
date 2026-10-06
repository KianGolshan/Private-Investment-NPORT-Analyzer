// Staff review F18: dialogs keep Tab inside, close on Escape and give focus
// back to whatever opened them.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { useDialog } from '../src/ui/useDialog';

function Dialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDialog(box, onClose);
  return (
    <div ref={box} role="dialog">
      <button>first</button>
      <button>last</button>
    </div>
  );
}

describe('useDialog', () => {
  it('traps Tab both ways, closes on Escape and returns focus to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const r = render(<Dialog onClose={onClose} />);
    const [first, last] = within(r.getByRole('dialog')).getAllByRole('button');
    last!.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    r.unmount();
    expect(document.activeElement).toBe(trigger);
  });
});
