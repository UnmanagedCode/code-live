import { LoaderCircleIcon, MicIcon, MicOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { useStore } from '@/lib/useStore';
import { connectButtonView, micButtonView } from '@/lib/controls.js';
import type { AppController } from '@/App';

export function SessionControls({ controller }: { controller: AppController }) {
  const { state, micPaused, models, modelsError, modelId } = useStore(controller.store);
  const connect = connectButtonView(state);
  const pause = micButtonView(state, micPaused);
  const loading = models.length === 0;

  return (
    <section aria-label="Session" className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-end">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="model">Model</Label>
        <div className="flex items-center gap-2">
          <NativeSelect
            id="model"
            className="w-full sm:w-auto"
            value={modelId}
            disabled={loading}
            onChange={(e) => controller.setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.hint ? `${m.label} (${m.hint})` : m.label}</option>
            ))}
          </NativeSelect>
          {loading && !modelsError && <span className="text-sm whitespace-nowrap text-muted-foreground">Loading models…</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          id="connect"
          type="button"
          className="h-10 flex-1 sm:h-9 sm:flex-none"
          variant={connect.variant}
          data-state={state}
          disabled={connect.disabled}
          aria-busy={connect.busy}
          onClick={() => void controller.toggleConnect()}
        >
          {connect.busy && <LoaderCircleIcon className="animate-spin" aria-hidden />}
          {connect.label}
        </Button>
        <Button
          id="pause"
          type="button"
          className="h-10 flex-1 sm:h-9 sm:flex-none"
          variant={pause.pressed ? 'secondary' : 'outline'}
          disabled={pause.disabled}
          aria-pressed={pause.pressed}
          onClick={() => controller.toggleMic()}
        >
          {pause.pressed ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
          {pause.label}
        </Button>
      </div>
    </section>
  );
}
