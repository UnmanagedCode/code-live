import { Badge } from '@/components/ui/badge';
import { useStore } from '@/lib/useStore';
import type { AppController } from '@/App';

type BadgeVariant = 'outline' | 'warning' | 'success' | 'destructive';

const STATE_VARIANT: Record<string, BadgeVariant> = {
  idle: 'outline',
  connecting: 'warning',
  live: 'success',
  reconnecting: 'warning',
  error: 'destructive',
};

export function StatusBar({ controller }: { controller: AppController }) {
  const { state, micPaused, hostConnected } = useStore(controller.store);
  return (
    <header className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-3">
      <h1 className="mr-auto text-base font-semibold">Code Live</h1>
      <Badge id="state" variant={STATE_VARIANT[state] ?? 'outline'}>{state}</Badge>
      <Badge id="mic" variant="warning" hidden={!micPaused}>Mic paused</Badge>
      <Badge id="host" variant={hostConnected ? 'success' : 'outline'}>{hostConnected ? 'Host connected' : 'Host disconnected'}</Badge>
    </header>
  );
}
