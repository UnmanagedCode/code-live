import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { createAppController } from '@/lib/controller.js';
import { useStore } from '@/lib/useStore';
import { settingsLocked } from '@/lib/controls.js';
import { StatusBar } from '@/components/StatusBar';
import { SessionControls } from '@/components/SessionControls';
import { Notices } from '@/components/Notices';
import { Transcript } from '@/components/Transcript';
import { SettingsPane } from '@/components/SettingsPane';

export type AppController = ReturnType<typeof createAppController>;

export function App({ controller }: { controller: AppController }) {
  const state = useStore(controller.store, (s) => s.state);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);

  // The pane's content must be rendered open before the key input can take focus.
  const openSettings = () => {
    flushSync(() => setSettingsOpen(true));
    keyInput.current?.focus();
  };

  return (
    <div className="flex h-dvh flex-col">
      <StatusBar controller={controller} />
      <SessionControls controller={controller} />
      <Notices controller={controller} onOpenSettings={openSettings} />
      <Transcript transcript={controller.transcript} />
      <SettingsPane
        settings={controller.settings}
        locked={settingsLocked(state)}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        keyInputRef={keyInput}
      />
    </div>
  );
}
