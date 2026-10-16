import { useLayoutEffect, useRef, type FormEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/useStore';
import type { createSettings } from '@/lib/settings.js';

type Settings = ReturnType<typeof createSettings>;
type Status = { text: string; error: boolean };

const HINT = 'text-sm text-muted-foreground';

// An error is announced at once; a confirmation politely. Empty, it takes no space in the group's gap.
function StatusLine({ id, status }: { id: string; status: Status }) {
  return (
    <p id={id} role={status.error ? 'alert' : 'status'} className={cn('text-sm empty:hidden', status.error ? 'text-destructive' : 'text-muted-foreground')}>
      {status.text}
    </p>
  );
}

// The pane's spacing is one rhythm: the body's gap separates the groups, each
// group's gap separates its items, and nothing sets a margin.
export function SettingsPane({ settings, locked, open, onOpenChange, keyInputRef }: {
  settings: Settings;
  locked: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyInputRef: RefObject<HTMLInputElement | null>;
}) {
  const s = useStore(settings.store);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const loading = !s.settled;

  // The textarea keeps the draft as typed; a load or a successful save replaces it.
  useLayoutEffect(() => {
    if (prompt.current) prompt.current.value = s.customPrompt;
  }, [s.promptRev]);

  // The key is read from the input once and never kept in React state.
  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    const input = keyInputRef.current;
    if (!input) return;
    const value = input.value;
    input.value = '';
    void settings.saveKey(value);
  };

  return (
    <details
      className="border-t bg-card px-4 py-3"
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer rounded-sm text-sm font-medium outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Settings
      </summary>
      <div id="settings" className="flex max-w-2xl flex-col gap-4 pt-3">
        <form role="group" aria-labelledby="settings-key-label" className="flex flex-col gap-2" onSubmit={saveKey}>
          <Label id="settings-key-label" htmlFor="settings-key">Gemini API key</Label>
          <p className={HINT}>The key is stored on the code-conductor machine and is never sent back to this page.</p>
          <div className="flex flex-wrap gap-2">
            <Input
              id="settings-key"
              ref={keyInputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a Gemini API key"
              className="min-w-48 flex-1"
              disabled={loading}
            />
            <Button type="submit" disabled={loading}>Save</Button>
            <Button type="button" variant="outline" disabled={loading} onClick={() => void settings.clearKey()}>Clear</Button>
          </div>
          <StatusLine id="settings-key-status" status={s.keyStatus} />
        </form>

        <div role="group" aria-labelledby="settings-voice-label" className="flex flex-col gap-2">
          <Label id="settings-voice-label" htmlFor="settings-voice">Voice</Label>
          <NativeSelect
            id="settings-voice"
            value={s.voice}
            disabled={loading || locked}
            onChange={(e) => void settings.setVoice(e.target.value)}
          >
            <option value="">Default (model's choice)</option>
            {s.voices.map((v) => <option key={v.name} value={v.name}>{`${v.name} (${v.style})`}</option>)}
          </NativeSelect>
          <StatusLine id="settings-voice-status" status={s.voiceStatus} />
        </div>

        <div role="group" aria-labelledby="settings-prompt-label" className="flex flex-col gap-2">
          <Label id="settings-prompt-label" htmlFor="settings-prompt">Custom instructions</Label>
          <p className={HINT}>Appended to code-live's built-in instructions, which take precedence.</p>
          <Textarea
            id="settings-prompt"
            ref={prompt}
            rows={4}
            className="field-sizing-fixed resize-y"
            maxLength={s.customPromptMax ?? undefined}
            disabled={loading || locked}
          />
          <div className="flex gap-2">
            <Button
              id="settings-prompt-save"
              type="button"
              disabled={loading || locked}
              onClick={() => void settings.savePrompt(prompt.current?.value ?? '')}
            >
              Save
            </Button>
          </div>
          <StatusLine id="settings-prompt-status" status={s.promptStatus} />
        </div>

        <p className={HINT}>Voice and instructions are used from the next Connect, and can't be changed while connected.</p>
      </div>
    </details>
  );
}
