import { useEffect, useState, type ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { getDemoStore, subscribeDemoStore } from './data';

export function useDemoActor() {
  const [actor, setActor] = useState(() => getDemoStore().getActor());
  useEffect(() => subscribeDemoStore(() => setActor((current) => {
    const next = getDemoStore().getActor();
    return current?.id === next?.id && current?.role === next?.role && current?.portalRole === next?.portalRole
      && JSON.stringify(current?.capabilities) === JSON.stringify(next?.capabilities) ? current : next;
  })), []);
  return actor;
}
export function DemoSession({ children }: { children: ReactNode }) {
  const actor = useDemoActor();
  // The actual provider reads current role/capabilities from the local transport,
  // so editing permissions is reflected after a new session mount or reload.
  return <SessionProvider key={actor ? `${actor.id}:${actor.role}:${actor.capabilities.join(',')}` : 'signed-out'}>{children}</SessionProvider>;
}
