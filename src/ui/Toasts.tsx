import { dismissToast, useToasts } from '@/services/notify';
import { Button } from './Button';

/** The toasts, drawn from the one store in `services/notify`. */
export function Toasts() {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toasts" id="toasts" role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`}>
          <span>{item.text}</span>
          {item.action ? (
            <Button
              label={item.action.label}
              variant="primary"
              onClick={() => {
                dismissToast(item.id);
                item.action?.run();
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
