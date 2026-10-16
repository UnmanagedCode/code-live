import { memo, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { MicIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { createTranscriptStore } from '@/lib/transcriptStore.js';

type TranscriptStore = ReturnType<typeof createTranscriptStore>;

const KIND_CLASS: Record<string, string> = {
  you: 'self-end border-primary/30 bg-primary/10',
  gemini: 'bg-card',
  conductor: 'border-l-4 border-l-success bg-card',
  tool_call: 'bg-muted/50 text-sm text-muted-foreground',
  tool_result: 'bg-muted/50 text-sm text-muted-foreground',
  status: 'bg-transparent text-sm text-muted-foreground',
  error: 'border-destructive/40 bg-destructive/5 text-destructive',
};

// Every string here is model-, conductor- or backend-written, and reaches the
// DOM only as a React text child: never as markup, an attribute or a link.
// A bubble subscribes to its own entry, so a streamed chunk re-renders only
// that bubble, and an added entry renders only itself (the others are memo'd).
export function Transcript({ transcript }: { transcript: TranscriptStore }) {
  const ids = useSyncExternalStore(transcript.subscribeIds, transcript.getIds);
  const region = useRef<HTMLElement>(null);
  const toEnd = useCallback(() => {
    if (region.current) region.current.scrollTop = region.current.scrollHeight;
  }, []);

  useLayoutEffect(toEnd, [ids, toEnd]);

  return (
    <main
      id="transcript"
      ref={region}
      aria-live="polite"
      aria-label="Transcript"
      tabIndex={0}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {ids.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            <MicIcon className="size-6" aria-hidden />
            Press Connect and start talking.
          </div>
        )}
        {ids.map((id) => <Bubble key={id} transcript={transcript} id={id} onChange={toEnd} />)}
      </div>
    </main>
  );
}

const Bubble = memo(function Bubble({ transcript, id, onChange }: { transcript: TranscriptStore; id: number; onChange: () => void }) {
  const subscribe = useCallback((fn: () => void) => transcript.subscribeEntry(id, fn), [transcript, id]);
  const e = useSyncExternalStore(subscribe, () => transcript.getEntry(id))!;

  // A chunk changes only this bubble: keep the newest text in view.
  useLayoutEffect(onChange, [e, onChange]);

  if ('text' in e) {
    return (
      <div
        data-kind="divider"
        className="flex items-center gap-3 py-1 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
      >
        {e.text}
      </div>
    );
  }
  return (
    <div data-kind={e.kind} className={cn('max-w-[85%] self-start rounded-lg border px-3 py-2', KIND_CLASS[e.kind] ?? 'bg-card')}>
      <div data-slot="entry-label" className="mb-0.5 text-xs text-muted-foreground">{e.label}</div>
      {e.mono ? (
        <pre data-slot="entry-body" className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">{e.body}</pre>
      ) : (
        <div data-slot="entry-body" className="whitespace-pre-wrap wrap-anywhere">{e.body}</div>
      )}
    </div>
  );
});
