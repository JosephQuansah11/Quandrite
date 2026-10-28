/**
 * Pages, and the one place that decides which is showing.
 *
 * The app is page based: `/` is the landing page, `/room/:id` the meeting, `/studio`
 * the studio over it, `/library` the recordings. A page is a component, and this is the
 * only thing that knows about the address bar - no page reads `location` itself.
 */
import { useEffect, useState } from 'react';

export type Route = {
  /** The page name: `join`, `password`, `room`, `studio`, `library`. */
  page: string;
  /** The room code from the path, when there is one. */
  roomId: string;
  query: URLSearchParams;
};

const PAGES = ['join', 'password', 'room', 'studio', 'library'];

export function parse(pathname: string, search = ''): Route {
  const parts = pathname.split('/').filter(Boolean);
  const named = PAGES.includes(parts[0]) ? parts[0] : 'join';
  // `/room/<code>` carries the code in the path, so a link can be pasted anywhere.
  const roomId = named === 'room' ? parts[1] || '' : '';
  return { page: named, roomId, query: new URLSearchParams(search) };
}

/** Go to a page. The address bar and the app agree because this is the only writer. */
export function navigate(to: string) {
  if (to === `${location.pathname}${location.search}`) return;
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const onPop = () => setRoute(parse(location.pathname, location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
