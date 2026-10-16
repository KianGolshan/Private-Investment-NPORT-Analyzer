// Review 2026-10-15 W3: a word defined where it is used, from the one glossary.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { GLOSSARY } from '../src/lib/glossary';
import { Term } from '../src/ui/Term';

afterEach(cleanup);

describe('Term', () => {
  it('opens the glossary text on click, closes on Escape and on a click elsewhere', () => {
    const r = render(
      <p>
        each fund’s latest <Term id="nport">N-PORT</Term> report <span>outside</span>
      </p>
    );
    const btn = r.getByRole('button', { name: 'N-PORT' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(r.queryByRole('note')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const note = r.getByRole('note');
    expect(note.id).toBe(btn.getAttribute('aria-controls'));
    expect(note.textContent).toBe(`${GLOSSARY.nport.term}. ${GLOSSARY.nport.text}`);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(r.queryByRole('note')).toBeNull();
    fireEvent.click(btn);
    fireEvent.mouseDown(r.getByText('outside'));
    expect(r.queryByRole('note')).toBeNull();
    // a click inside the card keeps it open
    fireEvent.click(btn);
    fireEvent.mouseDown(r.getByRole('note'));
    expect(r.queryByRole('note')).not.toBeNull();
  });
  it('an Escape pressed on the word right after it opens closes it (CI pressed it before the listener)', () => {
    const r = render(<Term id="mark" />);
    const btn = r.getByRole('button');
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(r.queryByRole('note')).toBeNull();
    expect(btn.getAttribute('title')).toBe('What “Mark” means');
  });
  it('shows the glossary’s own word when no text is given', () => {
    const r = render(<Term id="ncen" />);
    expect(r.getByRole('button').textContent).toBe('Form N-CEN');
  });
  it('every glossary entry has a word and a sentence, and none uses the words filings do not allow', () => {
    for (const [id, g] of Object.entries(GLOSSARY)) {
      expect(g.term.length, id).toBeGreaterThan(1);
      expect(g.text, id).toMatch(/\.$/);
      expect(g.text, id).not.toMatch(/\b(bought|sold|buy|sell|led)\b/i);
    }
  });
});
