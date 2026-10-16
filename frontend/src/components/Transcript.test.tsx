// Pins: model-, conductor- and backend-written content of every kind renders as
// inert text (hostile markup creates no elements), tool payloads render as JSON
// text in <pre>, labels carry title, ask and name; streamed chunks show as one
// bubble that updates live; a divider is inert text; announcements arriving over
// SSE render the same way; the region is a polite live region that scrolls to
// the bottom on every change, and shows an empty state until the first entry.
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Transcript } from './Transcript';
import { createTranscriptStore } from '@/lib/transcriptStore.js';
import { installAnnouncements } from '@/lib/announcements.js';

const HOSTILE = ['<img src=x onerror=alert(1)>', '</pre><script>x</script>', '"><svg onload=alert(1)>'];
const KINDS = ['you', 'gemini', 'conductor', 'status', 'error', 'tool_call', 'tool_result'];

const body = (el: Element) => el.querySelector('[data-slot="entry-body"]')!;
const label = (el: Element) => el.querySelector('[data-slot="entry-label"]')!;
const messages = (root: HTMLElement) => [...root.querySelectorAll('[data-kind]:not([data-kind="divider"])')];

describe('Transcript', () => {
  it('renders every kind of hostile payload as text', () => {
    const tr = createTranscriptStore();
    for (const kind of KINDS) for (const p of HOSTILE) tr.add(kind, kind.startsWith('tool') ? { args: p } : p, { title: p, name: p });
    for (const p of HOSTILE) tr.appendStream('gemini', p);
    const { container } = render(<Transcript transcript={tr} />);
    const shown = messages(container);
    expect(shown).toHaveLength(KINDS.length * HOSTILE.length + 1);
    let i = 0;
    for (const kind of KINDS) {
      for (const p of HOSTILE) {
        const el = shown[i++];
        expect(el.getAttribute('data-kind')).toBe(kind);
        if (kind.startsWith('tool')) {
          expect(body(el).tagName).toBe('PRE');
          expect(body(el).textContent).toBe(JSON.stringify({ args: p }, null, 2));
        } else {
          expect(body(el).textContent).toBe(p);
        }
        expect(label(el).textContent).toContain(p);
      }
    }
    expect(body(shown.at(-1)!).textContent).toBe(HOSTILE.join(''));
    expect(container.querySelectorAll('img,script,svg')).toHaveLength(0);
  });

  it('shows streamed chunks as one bubble, updated as they arrive', () => {
    const tr = createTranscriptStore();
    const { container } = render(<Transcript transcript={tr} />);
    act(() => { tr.appendStream('gemini', 'Hel'); });
    act(() => { tr.appendStream('gemini', 'lo'); });
    expect(messages(container).map((e) => body(e).textContent)).toEqual(['Hello']);
    act(() => { tr.endTurn(); tr.appendStream('gemini', 'Again'); });
    expect(messages(container).map((e) => [label(e).textContent, body(e).textContent])).toEqual([['Gemini', 'Hello'], ['Gemini', 'Again']]);
  });

  it('renders a divider as inert text between the bubbles it separates', () => {
    const tr = createTranscriptStore();
    for (const p of HOSTILE) tr.divider(p);
    tr.appendStream('gemini', 'a');
    tr.divider('New session started · 10:00:00');
    tr.appendStream('gemini', 'b');
    const { container } = render(<Transcript transcript={tr} />);
    const dividers = [...container.querySelectorAll('[data-kind="divider"]')];
    expect(dividers.map((d) => d.textContent)).toEqual([...HOSTILE, 'New session started · 10:00:00']);
    expect(container.querySelectorAll('img,script,svg')).toHaveLength(0);
    const [a, b] = messages(container);
    expect(a.compareDocumentPosition(dividers.at(-1)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dividers.at(-1)!.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders hostile plan, question and title text from SSE announcements as text, never as elements', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const listeners: Record<string, (ev: { data: string }) => void> = {};
    const tr = createTranscriptStore();
    installAnnouncements({ eventSource: { addEventListener: (n: string, fn: (ev: { data: string }) => void) => { listeners[n] = fn; } }, transcript: tr, session: { state: 'idle', sendText() {} }, hostIndicator: { set() {} } });
    const { container } = render(<Transcript transcript={tr} />);
    act(() => {
      listeners.announce({ data: JSON.stringify({ sessionId: 'c', title: evil, text: `plan ${evil}`, ask: { kind: 'plan', planPath: evil } }) });
      listeners.announce({ data: JSON.stringify({ sessionId: 'c', title: evil, text: `--- questions ---\n1. ${evil}`, ask: { kind: 'question', count: 1 } }) });
    });
    expect(container.querySelectorAll('img,script')).toHaveLength(0);
    expect(messages(container)).toHaveLength(2);
    expect(container.textContent).toContain(evil);
    expect(label(messages(container)[0]).textContent).toBe(`Conductor · ${evil} · plan`);
  });

  it('is a polite, focusable live region named Transcript, with an empty state until the first entry', () => {
    const tr = createTranscriptStore();
    render(<Transcript transcript={tr} />);
    const region = screen.getByRole('main', { name: 'Transcript' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toBe('Press Connect and start talking.');
    act(() => { tr.add('status', 'hello'); });
    expect(region.textContent).not.toContain('Press Connect');
  });

  it('scrolls to the bottom on every change', () => {
    const tr = createTranscriptStore();
    render(<Transcript transcript={tr} />);
    const region = screen.getByRole('main', { name: 'Transcript' });
    let height = 100;
    Object.defineProperty(region, 'scrollHeight', { get: () => height });
    act(() => { tr.add('status', 'one'); });
    expect(region.scrollTop).toBe(100);
    height = 250;
    act(() => { tr.appendStream('gemini', 'chunk'); });
    expect(region.scrollTop).toBe(250);
  });
});
