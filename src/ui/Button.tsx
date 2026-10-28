import { Icon } from './Icon';

/**
 * Every button in the app.
 *
 * A button is a name, an icon and the thing it does, so that is all this takes. One
 * component draws the meeting bar, the dialog actions, the studio panes and the tools
 * on a grid tile - which is why there is no per-feature button anywhere in `src/`, and
 * why adding a control is one line rather than a block of markup.
 */
export type ButtonProps = {
  /** What it says. Also its tooltip and its accessible name. */
  label: string;
  /** Which icon to draw. The same `label` words the state: `Mute` becomes `Unmute`. */
  icon?: string;
  onClick?: (event: any) => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  /** Drawn as a tool in the meeting bar rather than a plain button. */
  tool?: boolean;
  disabled?: boolean;
  active?: boolean;
  /** A count or dot in the corner - unread chat, say. */
  badge?: number | string | null;
  /** Icon only, with the words left to the tooltip. */
  iconOnly?: boolean;
  size?: number;
  className?: string;
  hidden?: boolean;
  /** What the button acts on, for handlers that are shared across a list. */
  value?: string;
  title?: string;
};

export function Button({
  label,
  icon,
  onClick,
  variant = 'default',
  tool = false,
  disabled = false,
  active = false,
  badge = null,
  iconOnly = false,
  size,
  className = '',
  hidden = false,
  value,
  title,
}: ButtonProps) {
  if (hidden) return null;
  const classes = ['btn', variant, tool ? 'room-tool' : '', active ? 'active' : '', iconOnly ? 'icon-only' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      data-value={value}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size={size} /> : null}
      {iconOnly ? null : <span className="btn-label">{label}</span>}
      {badge === null || badge === undefined || badge === 0 ? null : <span className="badge">{badge}</span>}
    </button>
  );
}
