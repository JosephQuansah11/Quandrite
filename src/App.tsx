import { useEffect } from 'react';
import { JoinPage } from '@/pages/JoinPage';
import { RoomPage } from '@/pages/RoomPage';
import { Toasts } from '@/ui/Toasts';
import { useRoute } from '@/services/router';
import { useSession } from '@/services/session';

/**
 * The app: a page per route, and the session that every page shares.
 *
 * There is no page here that is really a mode of another one - the room is the room and
 * the studio is a column inside it, so switching between them never loses the meeting.
 */
export function App() {
  const route = useRoute();
  const session = useSession();

  // One connection, opened as soon as the app is, so the landing page can say whether
  // the server is reachable before anybody has typed anything.
  useEffect(() => {
    session.connect();
  }, [session]);

  const inRoom = route.page === 'room' || route.page === 'studio';

  return (
    <>
      {inRoom ? <RoomPage session={session} /> : <JoinPage session={session} />}
      <Toasts />
    </>
  );
}
