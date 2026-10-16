// Pins the transcript's cost per event: a streamed chunk re-renders only the
// streaming bubble, an added entry renders only the new bubble, and the DOM of
// every other bubble is left untouched. Every bubble render creates exactly
// one element carrying `data-kind`, so the JSX runtime is wrapped to count them.
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

const rendered: string[] = [];
const record = (props: Record<string, unknown> | null) => {
  if (props && typeof props['data-kind'] === 'string') rendered.push(props['data-kind'] as string);
};
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const m = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...m, jsxDEV: (type: any, props: any, ...rest: any[]) => { record(props); return (m.jsxDEV as any)(type, props, ...rest); } };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const m = await importOriginal<typeof import('react/jsx-runtime')>();
  const wrap = (f: any) => (type: any, props: any, ...rest: any[]) => { record(props); return f(type, props, ...rest); };
  return { ...m, jsx: wrap(m.jsx), jsxs: wrap(m.jsxs) };
});

const { Transcript } = await import('./Transcript');
const { createTranscriptStore } = await import('@/lib/transcriptStore.js');

function populated(n: number) {
  const tr = createTranscriptStore();
  for (let i = 0; i < n; i++) tr.add(i % 2 ? 'status' : 'conductor', `entry ${i}`, { title: 'A' });
  tr.divider('New session started · 10:00:00');
  tr.appendStream('gemini', 'Hel');
  return tr;
}

describe('Transcript render cost', () => {
  it('the counter sees every bubble on the first render', () => {
    rendered.length = 0;
    render(<Transcript transcript={populated(50)} />);
    expect(rendered).toHaveLength(52);
  });

  it('a streamed chunk re-renders only the streaming bubble and leaves the other bubbles\' DOM alone', () => {
    const tr = populated(200);
    const { container } = render(<Transcript transcript={tr} />);
    const nodes = [...container.querySelectorAll('[data-kind]')];
    const changed: Node[] = [];
    const observer = new MutationObserver((records) => { for (const r of records) changed.push(r.target); });
    observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true });
    rendered.length = 0;
    act(() => { tr.appendStream('gemini', 'lo'); });
    expect(rendered).toEqual(['gemini']);
    for (const r of observer.takeRecords()) changed.push(r.target);
    observer.disconnect();
    const streaming = nodes.at(-1)!;
    expect(changed.length).toBeGreaterThan(0);
    for (const n of changed) expect(streaming.contains(n), 'only the streaming bubble changes').toBe(true);
    expect([...container.querySelectorAll('[data-kind]')]).toEqual(nodes);
    expect(streaming.textContent).toBe('GeminiHello');
  });

  it('an added entry renders only the new bubble', () => {
    const tr = populated(200);
    const { container } = render(<Transcript transcript={tr} />);
    const before = [...container.querySelectorAll('[data-kind]')];
    rendered.length = 0;
    act(() => { tr.add('error', 'boom'); });
    expect(rendered).toEqual(['error']);
    const after = [...container.querySelectorAll('[data-kind]')];
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)!.textContent).toBe('Errorboom');
  });
});
