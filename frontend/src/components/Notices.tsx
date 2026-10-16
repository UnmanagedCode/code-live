import { CircleAlertIcon, InfoIcon, MicOffIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/useStore';
import type { AppController } from '@/App';

// Page-level notices derived from the controller and settings state. Display
// only: none of them blocks a control.
export function Notices({ controller, onOpenSettings }: { controller: AppController; onOpenSettings: () => void }) {
  const { modelsError, micBlocked } = useStore(controller.store);
  const { settled, loadError, apiKey } = useStore(controller.settings.store);
  const backendError = modelsError ?? loadError;
  const noKey = settled && !loadError && apiKey?.set === false;
  if (!backendError && !noKey && !micBlocked) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {backendError && (
        <Alert variant="destructive" data-notice="backend">
          <CircleAlertIcon aria-hidden />
          <AlertDescription>Can't reach the code-live backend: {backendError}. Reload the page once it is back.</AlertDescription>
        </Alert>
      )}
      {micBlocked && (
        <Alert variant="destructive" data-notice="mic-blocked">
          <MicOffIcon aria-hidden />
          <AlertDescription>Microphone blocked: allow microphone access for this page, then Disconnect and Connect again.</AlertDescription>
        </Alert>
      )}
      {noKey && (
        <Alert variant="info" role="status" data-notice="no-key">
          <InfoIcon aria-hidden />
          <AlertDescription className="flex flex-wrap items-center gap-x-1">
            No Gemini API key set. Add one in Settings to connect.
            <Button type="button" variant="link" className="h-auto p-0" onClick={onOpenSettings}>Open Settings</Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
