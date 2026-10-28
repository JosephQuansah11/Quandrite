/**
 * A status pill: one word, a colour, and the whole story in the tooltip.
 *
 * Connection, on air, recording, role, breakouts - everything that reports state is one
 * of these, so they read the same wherever they appear. A pill with `onClick` is a
 * button, which is how the breakout pill opens the picker.
 */
export type Tone = 'neutral' | 'ok' | 'warn' | 'live' | 'rec' | 'accent' | 'danger';

export function Pill({
  text,
  tone = 'neutral',
  title,
  onClick,
  className = '',
}: {
  text: string;
  tone?: Tone;
  title?: string;
  onClick?: () => void;
  className?: string;
}) {
  const classes = `pill ${tone} ${onClick ? 'pill-button' : ''} ${className}`.trim();
  const label = title ?? text;
  if (onClick) {
    return (
      <button type="button" className={classes} title={label} onClick={onClick}>
        {text}
      </button>
    );
  }
  return (
    <span className={classes} title={label}>
      {text}
    </span>
  );
}
