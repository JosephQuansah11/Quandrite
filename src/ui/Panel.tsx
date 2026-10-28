import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';

/**
 * A row of buttons, in the order given.
 *
 * The meeting bar, the studio's actions and the library's tools are all "a list of
 * buttons", so they are all this component: each caller describes its own controls and
 * knows nothing about how they are drawn.
 */
export type Tool = Omit<ButtonProps, 'tool'> & { key?: string };

export function Toolbar({ tools, className = '', tool = false }: { tools: Tool[]; className?: string; tool?: boolean }) {
  return (
    <div className={className || 'toolbar'} role="toolbar">
      {tools.filter(Boolean).map((item, index) => (
        <Button key={item.key ?? item.label ?? index} tool={tool} {...item} />
      ))}
    </div>
  );
}

/**
 * A titled block of controls: the studio's panes, the library, the people list.
 *
 * `actions` is the same list of buttons as everywhere else, so a panel gains a control
 * by naming it rather than by growing markup.
 */
export function Panel({
  title,
  hint,
  actions = [],
  children,
  className = '',
}: {
  title?: string;
  hint?: string;
  actions?: Tool[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title || actions.length ? (
        <header className="panel-head">
          {title ? <h3>{title}</h3> : null}
          {actions.length ? <Toolbar tools={actions} className="panel-actions" /> : null}
        </header>
      ) : null}
      {hint ? <p className="panel-hint muted">{hint}</p> : null}
      {children}
    </section>
  );
}

/** What a list shows when it has nothing to show. */
export function Empty({ text }: { text: string }) {
  return <p className="empty muted">{text}</p>;
}
