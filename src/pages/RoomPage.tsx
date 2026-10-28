import { useMemo, useState } from 'react';
import { Button } from '@/ui/Button';
import { Pill } from '@/ui/Pill';
import { Tile } from '@/ui/Tile';
import { Toolbar } from '@/ui/Panel';
import { Video } from '@/ui/Video';
import { StudioPane, type StudioTab } from './StudioPane';
import { hasControl } from '@/services/session';

/**
 * The room.
 *
 * The stage is the pictures and the bar along the bottom is the controls. The studio is
 * a **column beside the stage, not a cover over it**: opening it used to hide the
 * meeting entirely, which is why `.studio-open` now splits the room in two instead of
 * floating the panes on top of it.
 */
export function RoomPage({ session }: { session: any }) {
  const { state, camera } = session;
  const [studio, setStudio] = useState(false);
  const [tab, setTab] = useState<StudioTab>('live');
  const [view, setView] = useState<'people' | 'program' | 'split'>('split');

  /** My own picture, so the self view and my tile show the same stream. */
  const myStream = useMemo(() => {
    const mine = camera?.list?.().find((source: any) => source.kind === 'camera');
    return (mine?.stream ?? null) as MediaStream | null;
  }, [camera, state.cameraOn]);

  const others = state.members.filter((member: any) => member.id !== state.clientId);
  const views: Array<{ key: typeof view; label: string }> = [
    { key: 'program', label: 'Program' },
    { key: 'people', label: 'People' },
    { key: 'split', label: 'Split' },
  ];

  return (
    <main className={`room ${studio ? 'studio-open' : ''}`}>
      <header className="room-bar">
        <div className="room-heading">
          <strong>{state.roomId || 'Quandrite room'}</strong>
          <small className="muted">{state.role} - {hasControl(state.role) ? 'you can run the show' : 'you are watching'}</small>
        </div>
        <div className="room-bar-actions">
          <Pill text={`${state.members.length} here`} tone="neutral" />
          <div className="segmented">
            {views.map((item) => (
              <Button
                key={item.key}
                label={item.label}
                variant={view === item.key ? 'primary' : 'ghost'}
                onClick={() => setView(item.key)}
              />
            ))}
          </div>
          <Button
            label={studio ? 'Hide the studio' : 'Studio'}
            icon="screen"
            variant={studio ? 'primary' : 'default'}
            onClick={() => setStudio((open) => !open)}
          />
        </div>
      </header>

      <section className={`room-stage view-${view}`}>
        <div className="stage-view program-view">
          <div className="program-frame">
            {/* Nothing is on air until a host puts something there, and the frame says
                so rather than showing an empty rectangle. */}
            <p className="empty muted">off air</p>
          </div>
        </div>
        <div className="stage-view people-view">
          <div className="room-grid">
            {others.length === 0 ? (
              <p className="empty muted">Nobody else is here yet. Share the room code.</p>
            ) : (
              others.map((member: any) => <Tile key={member.id} member={member} />)
            )}
          </div>
          {myStream ? (
            <div className="self-view">
              <Video stream={myStream} mirror />
              <span className="self-view-name">{state.name} (you)</span>
            </div>
          ) : null}
        </div>
      </section>

      <footer className="room-toolbar">
        <Toolbar
          className="room-toolbar-inner"
          tool
          tools={[
            {
              // The icon carries the state, the way the landing page's pre-join toggles do:
              // a struck-through microphone means muted.
              label: state.micOn ? 'Mute' : 'Unmute',
              icon: state.micOn ? 'mic' : 'micOff',
              iconOnly: true,
              active: state.micOn,
              onClick: session.toggleMic,
            },
            {
              label: state.cameraOn ? 'Stop video' : 'Start video',
              icon: state.cameraOn ? 'camera' : 'cameraOff',
              iconOnly: true,
              active: state.cameraOn,
              onClick: session.toggleCamera,
            },
            { label: 'Leave', icon: 'leave', variant: 'danger', onClick: session.leave },
          ]}
        />
      </footer>

      {studio ? <StudioPane session={session} tab={tab} onTab={setTab} onClose={() => setStudio(false)} /> : null}
    </main>
  );
}
