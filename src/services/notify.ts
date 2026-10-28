/**
 * Saying things out loud: toasts on screen, and the desktop notification when it is
 * allowed and the news is worth interrupting for.
 *
 * One list, one hook, and no component keeps its own idea of what has been announced.
 */
import { useEffect, useState } from 'react';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export type Toast = { id: number; text: string; kind: ToastKind; action?: { label: string; run: () => void } | null };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<(list: Toast[]) => void>();

function emit() {
  const snapshot = [...toasts];
  for (const listener of listeners) listener(snapshot);
}

/** Show a message. `action` adds the one button a toast is allowed to have. */
export function toast(text: string, kind: ToastKind = 'info', action: Toast['action'] = null, timeoutMs?: number) {
  const id = nextId++;
  toasts = [...toasts, { id, text, kind, action }];
  emit();
  const ttl = timeoutMs ?? (kind === 'error' ? 9000 : action ? 12000 : 5000);
  setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export function useToasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/** Is the browser allowed to announce things? Nothing is asked without a click. */
export function notificationsAllowed() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function askToNotify() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  const answer = await Notification.requestPermission();
  return answer === 'granted';
}

/**
 * Announce something - a private message, a breakout invitation, feedback.
 *
 * Nothing already on screen is announced twice: `force` is for the things a person
 * must not miss (a howl being suppressed), and `onClick` opens what the message is
 * about rather than leaving the reader to find it.
 */
export function notify(title: string, body = '', { tag = 'quandrite', force = false, onClick = null }: any = {}) {
  if (!notificationsAllowed()) return false;
  if (document.hasFocus() && !force) return false;
  try {
    const note = new Notification(title, { body, tag, silent: false });
    if (onClick) note.onclick = () => { window.focus(); onClick(); };
    return true;
  } catch {
    return false;
  }
}
