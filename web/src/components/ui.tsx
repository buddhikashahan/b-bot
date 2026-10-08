import { Check, CircleAlert, LoaderCircle, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// --- layout -----------------------------------------------------------------------------------

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children && <div className="p-5">{children}</div>}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  const tones = {
    info: 'bg-accent-soft text-ink',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger'
  };
  return <div className={cx('rounded-lg px-4 py-3 text-sm', tones[tone])}>{children}</div>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cx('h-4 w-4 animate-spin', className)} />;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'danger'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-raised text-muted',
    good: 'bg-accent-soft text-accent',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger'
  };
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

// --- controls ---------------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'md', busy, icon, children, className, disabled, ...rest }: ButtonProps) {
  const variants = {
    primary: 'glow bg-accent text-on-accent hover:opacity-90',
    secondary: 'border border-line bg-panel hover:bg-raised',
    ghost: 'text-muted hover:bg-raised hover:text-ink',
    danger: 'border border-danger/40 text-danger hover:bg-danger-soft'
  };
  const sizes = { sm: 'h-8 px-2.5 text-xs', md: 'h-10 px-4 text-sm' };
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className
      )}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-sm text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-line'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-5'
          )}
        />
      </button>
    </div>
  );
}

const fieldClass =
  'w-full rounded-lg border border-line bg-panel px-3 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none disabled:opacity-60';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldClass, 'h-10', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(fieldClass, 'h-10', className)}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(fieldClass, 'py-2 leading-relaxed', className)} />;
}

/** Mutually exclusive choice shown as a row of buttons. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg bg-raised p-1">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => option.value !== value && onChange(option.value)}
          className={cx(
            'flex items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors',
            option.value === value ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink'
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Text or number input that saves when you leave it or press Enter, so
 * settings never need a separate Save button and are never saved mid-typing.
 */
export function CommitInput({
  value,
  onCommit,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string | number; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => draft !== String(value) && onCommit(draft);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
    />
  );
}

export function CommitTextarea({
  value,
  onCommit,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <Textarea {...rest} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => draft !== value && onCommit(draft)} />;
}

/** Removable pills, e.g. a list of phone numbers. */
export function Chips({ items, onRemove, empty }: { items: { key: string; label: string }[]; onRemove: (key: string) => void; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <li key={item.key} className="inline-flex items-center gap-1 rounded-full bg-raised py-1 pr-1 pl-3 text-sm">
          <span className="max-w-56 truncate">{item.label}</span>
          <button type="button" aria-label={`Remove ${item.label}`} onClick={() => onRemove(item.key)} className="rounded-full p-0.5 text-muted hover:bg-panel hover:text-danger">
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Saving... / Saved" marker for pages whose settings save on their own. */
export function SaveIndicator({ state, error }: { state: 'idle' | 'saving' | 'saved' | 'error'; error?: string }) {
  if (state === 'idle') return <span className="text-xs text-muted">Changes save automatically</span>;
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" /> Saving…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span role="alert" className="flex items-center gap-1.5 text-xs text-danger" title={error}>
        <CircleAlert className="h-3.5 w-3.5" /> Not saved{error ? `: ${error}` : ''}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-accent">
      <Check className="h-3.5 w-3.5" /> Saved
    </span>
  );
}

// --- toasts -----------------------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'good' | 'danger';
  message: string;
}

const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(toast => toast.id !== id)), []);
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'good') => {
      const id = nextId.current++;
      setToasts(list => [...list.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'danger' ? 7000 : 3500);
    },
    [dismiss]
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={cx(
              'pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg',
              toast.tone === 'danger' ? 'border-danger/40 bg-danger-soft text-danger' : 'border-line bg-panel'
            )}
          >
            <span className="min-w-0 break-words">{toast.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="opacity-60 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// --- formatting -------------------------------------------------------------------------------

export function formatDateTime(value: string | number | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "just now", "5 min ago", "3 h ago", then a date. */
export function relativeTime(value: string | number, now = Date.now()): string {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
