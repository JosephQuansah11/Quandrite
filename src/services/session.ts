/**
 * The room session: one connection, one roster, one set of my own devices.
 *
 * Every page reads this and nothing else - a page never touches the socket, the camera
 * manager or the mixer itself. That is what keeps the pages small: they render state and
 * call a named action, and the wiring lives here.
 *
 * This is the first tranche of the port: connection, roster, my microphone and camera,
 * the program picture and chat. The studio's own machinery (sources, scenes,
 * destinations, breakouts, relay) is wired in the same way as it is ported.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QuandriteSocket } from '@/lib/ws';
import { CameraManager } from '@/lib/devices';
import { CLIENT, SERVER } from '@shared/protocol';
import { toast } from './notify';
import { navigate } from './router';

export type SessionState = {
  connected: boolean;
  clientId: string;
  roomId: string;
  name: string;
  role: string;
  members: any[];
  program: any;
  chat: any[];
  unread: number;
  micOn: boolean;
  cameraOn: boolean;
};

const EMPTY: SessionState = {
  connected: false,
  clientId: '',
  roomId: '',
  name: '',
  role: 'viewer',
  members: [],
  program: { mode: 'idle', sources: [] },
  chat: [],
  unread: 0,
  micOn: false,
  cameraOn: false,
};

/** Who can drive the broadcast: the same rule the server enforces. */
export const hasControl = (role: string) => role === 'host' || role === 'cohost';

export function useSession() {
  const [state, setState] = useState<SessionState>(EMPTY);
  const socketRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const patch = useCallback((changes: Partial<SessionState>) => setState((was) => ({ ...was, ...changes })), []);

  /** One connection for the life of the page, opened on first use. */
  const connect = useCallback(() => {
    if (socketRef.current) return socketRef.current;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const socket = new QuandriteSocket({ url });
    socketRef.current = socket;
    cameraRef.current = new CameraManager({ socket });
    socket.on('open', () => patch({ connected: true }));
    socket.on('close', () => patch({ connected: false }));
    socket.on(SERVER.WELCOME, (message: any) => patch({ clientId: message.clientId }));
    socket.on(SERVER.MEMBERS_UPDATE, (members: any[]) => patch({ members: members || [] }));
    socket.on(SERVER.PROGRAM_UPDATE, (program: any) => patch({ program: program || EMPTY.program }));
    socket.on(SERVER.CHAT_NEW, (message: any) => {
      setState((was) => ({ ...was, chat: [...was.chat, message], unread: was.unread + 1 }));
    });
    return socket;
  }, [patch]);

  useEffect(() => () => socketRef.current?.close(), []);

  const send = useCallback((type: string, payload: any = {}) => socketRef.current?.send(type, payload), []);

  const join = useCallback(
    async ({ name, roomId, role, password }: any) => {
      const socket = connect();
      const message: any = await socket.send(CLIENT.JOIN, { name, roomId, role, password });
      patch({ roomId, name, role: message?.role ?? role });
      navigate(`/room/${roomId}`);
      return message;
    },
    [connect, patch],
  );

  const leave = useCallback(async () => {
    await cameraRef.current?.stopAll();
    send(CLIENT.LEAVE, {});
    patch({ roomId: '', members: [], chat: [], micOn: false, cameraOn: false });
    navigate('/');
  }, [patch, send]);

  /** My microphone: one track, on or off, never a shared screen's audio. */
  const toggleMic = useCallback(async () => {
    const camera = cameraRef.current;
    const on = state.micOn;
    if (on) {
      for (const source of camera?.list?.() ?? []) {
        for (const track of source.stream?.getAudioTracks?.() ?? []) track.enabled = false;
      }
      patch({ micOn: false });
      return;
    }
    if (!camera?.list?.().some((source: any) => source.stream?.getAudioTracks?.().length)) {
      await camera?.addMicrophone({});
    }
    for (const source of camera?.list?.() ?? []) {
      for (const track of source.stream?.getAudioTracks?.() ?? []) track.enabled = true;
    }
    patch({ micOn: true });
  }, [patch, state.micOn]);

  const toggleCamera = useCallback(async () => {
    const camera = cameraRef.current;
    if (state.cameraOn) {
      for (const source of camera?.list?.() ?? []) {
        if (source.kind !== 'camera') continue;
        for (const track of source.stream?.getVideoTracks?.() ?? []) track.enabled = false;
      }
      patch({ cameraOn: false });
      return;
    }
    const mine = camera?.list?.().find((source: any) => source.kind === 'camera');
    if (mine) {
      for (const track of mine.stream.getVideoTracks()) track.enabled = true;
    } else {
      try {
        await camera?.addCamera({});
      } catch {
        toast('No camera available', 'warn');
        return;
      }
    }
    patch({ cameraOn: true });
  }, [patch, state.cameraOn]);

  const sendChat = useCallback((text: string, to: string | null = null) => send(CLIENT.CHAT_SEND, { text, to }), [send]);
  const markChatRead = useCallback(() => patch({ unread: 0 }), [patch]);

  const me = useMemo(() => state.members.find((member) => member.id === state.clientId) ?? null, [state.clientId, state.members]);

  return { state, me, camera: cameraRef.current, socket: socketRef.current, connect, join, leave, send, toggleMic, toggleCamera, sendChat, markChatRead, patch };
}
