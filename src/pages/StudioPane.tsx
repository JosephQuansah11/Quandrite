import { Panel } from '@/ui/Panel';
import { Button } from '@/ui/Button';
import { Pill } from '@/ui/Pill';
import { Video } from '@/ui/Video';
import { hasControl } from '@/services/session';

/**
 * The studio, docked beside the room.
 *
 * It shares the space rather than covering it: the stage keeps its own column, so the
 * meeting is still there while you work. Opening the studio used to hide the room
 * completely, which is what this pane exists to stop happening.
 *
 * A tab is a pane of the same `Panel`, and the controls are the same `Button` as
 * everywhere else. Scenes, destinations and the library join these two as the port
 * reaches them - a tab is only here when it has something real to show.
 */
const TABS = ['live', 'meeting'] as const;
export type StudioTab = (typeof TABS)[number];

export function StudioPane({
  session,
  tab,
  onTab,
  onClose,
}: {
  session: any;
  tab: StudioTab;
  onTab: (tab: StudioTab) => void;
  onClose: () => void;
}) {
  const { state } = session;
  const live = Boolean(state.program?.mode && state.program.mode !== 'idle');

  return (
    <aside className="studio-panes" aria-label="Studio">
      <header className="studio-head">
        <h2>Studio</h2>
        <Pill
          text={live ? 'on air' : 'off air'}
          tone={live ? 'live' : 'neutral'}
          title={live ? 'The broadcast is going out' : 'Nothing is being broadcast'}
        />
        <Pill text="not recording" tone="neutral" title="Recording is off" />
        <Button label="Close the studio" icon="close" iconOnly variant="ghost" onClick={onClose} />
      </header>

      <nav className="segmented studio-tabs">
        {TABS.map((name) => (
          <Button
            key={name}
            label={name[0].toUpperCase() + name.slice(1)}
            variant={tab === name ? 'primary' : 'ghost'}
            onClick={() => onTab(name)}
          />
        ))}
      </nav>

      {tab === 'meeting' ? <MeetingPane session={session} /> : <LivePane session={session} />}
    </aside>
  );
}

/** The studio's own copy of the meeting controls, icon only: the bar already says the words. */
function MeetingPane({ session }: { session: any }) {
  const { state } = session;
  return (
    <Panel title="Meeting" hint="The same two actions as the meeting bar, with the icon carrying the state.">
      <div className="studio-meeting">
        <Button
          label={state.micOn ? 'Mute' : 'Unmute'}
          icon={state.micOn ? 'mic' : 'micOff'}
          iconOnly
          active={state.micOn}
          onClick={session.toggleMic}
        />
        <Button
          label={state.cameraOn ? 'Stop video' : 'Start video'}
          icon={state.cameraOn ? 'camera' : 'cameraOff'}
          iconOnly
          active={state.cameraOn}
          onClick={session.toggleCamera}
        />
        <span className="muted">{state.members.length} here</span>
      </div>
    </Panel>
  );
}

/** What is going out, and what it is made of. */
function LivePane({ session }: { session: any }) {
  const { state } = session;
  const sources = state.program?.sources ?? [];
  return (
    <Panel title="Go live" hint="What the broadcast is made of right now.">
      <dl className="readout">
        <dt>Mode</dt>
        <dd>{state.program?.mode ?? 'idle'}</dd>
        <dt>Sources</dt>
        <dd>{sources.length}</dd>
        <dt>Your role</dt>
        <dd>{state.role}</dd>
      </dl>
      {hasControl(state.role) ? null : <p className="muted">A host or co-host drives the broadcast.</p>}
    </Panel>
  );
}
