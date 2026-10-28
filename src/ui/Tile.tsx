import { Video } from './Video';
import { Toolbar, type Tool } from './Panel';
import { Icon } from './Icon';
import { initials } from '@/lib/format';

/**
 * One person in the grid.
 *
 * A tile is a picture, a name and whatever can be done to that person - the host's
 * tools arrive as the same `Tool` list as every other row of buttons, so moderating
 * somebody is a list of two entries rather than a second kind of control.
 */
export function Tile({
  member,
  stream,
  tools = [],
  speaking = false,
  onAir = false,
  compact = false,
}: {
  member: any;
  stream?: MediaStream | null;
  tools?: Tool[];
  speaking?: boolean;
  onAir?: boolean;
  compact?: boolean;
}) {
  return (
    <figure
      className={`tile ${speaking ? 'speaking' : ''} ${onAir ? 'on-air' : ''} ${compact ? 'compact' : ''}`}
      data-requires={tools.length ? 'control' : undefined}
    >
      {stream ? (
        <Video stream={stream} className="tile-video" mirror={Boolean(member.local)} />
      ) : (
        <div className="tile-fallback">{initials(member.name)}</div>
      )}
      <figcaption>
        <span className={`role-dot ${member.role}`} />
        <span className="tile-name">{member.name}</span>
        {member.muted ? <Icon name="micOff" size={13} /> : null}
        {member.cameraOff ? <Icon name="cameraOff" size={13} /> : null}
        {onAir ? <span className="tile-on-air">on air</span> : null}
      </figcaption>
      {tools.length ? <Toolbar tools={tools} className="tile-tools" /> : null}
    </figure>
  );
}
