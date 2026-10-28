import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Toolbar, type Tool } from './Panel';

/**
 * The one modal.
 *
 * A real `<dialog>`, so Escape, focus and the backdrop behave without any of it being
 * re-implemented. The body is children, the buttons are the same `Tool` list as
 * everywhere else - Share, Chat, People and the breakout picker are all this.
 */
export function Dialog({
  open,
  title,
  onClose,
  actions = [],
  children,
  className = '',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  actions?: Tool[];
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`.trim()}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <Button label="Close" icon="close" iconOnly variant="ghost" onClick={onClose} />
      </header>
      <div className="dialog-body">{children}</div>
      {actions.length ? <Toolbar tools={actions} className="dialog-actions" /> : null}
    </dialog>
  );
}
