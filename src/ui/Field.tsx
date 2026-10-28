import type { ReactNode } from 'react';
import { Button } from './Button';

/**
 * A labelled control.
 *
 * Every form in the app is fields: the join form, the password page, the studio's
 * scene form, the destinations. `as` picks the element (`input`, `select`, `textarea`)
 * and the rest is passed straight through, so a new field is one line.
 */
export function Field({
  label,
  as = 'input',
  value,
  onChange,
  hint,
  children,
  className = '',
  ...rest
}: {
  label: string;
  as?: 'input' | 'select' | 'textarea';
  value?: any;
  onChange?: (value: any, event: any) => void;
  hint?: string;
  children?: ReactNode;
  className?: string;
  [key: string]: any;
}) {
  const Tag = as as any;
  const id = rest.id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const handle = (event: any) => onChange?.(event.target.value, event);
  return (
    <label className={`field ${className}`.trim()} htmlFor={id}>
      <span className="field-label">{label}</span>
      {as === 'select' || children ? (
        <Tag id={id} value={value} onChange={handle} {...rest}>
          {children}
        </Tag>
      ) : (
        <Tag id={id} value={value ?? ''} onChange={handle} {...rest} />
      )}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

/** A row of buttons under a form. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}

export { Button };
