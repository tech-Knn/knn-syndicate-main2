'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './ui.module.css';

export { DateRangePicker, type DateRange } from './date-range';
export { SearchSelect, type SearchOption } from './search-select';

export function Spinner({ className }: { className?: string }) {
  return <span className={`${styles.spinner} ${className ?? ''}`} aria-hidden />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
  block?: boolean;
  loading?: boolean;
};

const buttonVariantClass: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
  danger: styles.danger,
  'danger-solid': styles['danger-solid'],
};

export function Button({
  variant = 'primary',
  block,
  loading,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={[styles.btn, buttonVariantClass[variant], block ? styles.block : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {loading && <span className={styles.srOnly}>Loading, </span>}
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${styles.card} ${className ?? ''}`} {...rest}>
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const toneClass: Record<Tone, string> = {
  neutral: styles.neutral,
  brand: styles.brand,
  success: styles.success,
  warning: styles.warning,
  danger: styles['danger-badge'],
};

export function Badge({
  tone = 'neutral',
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${toneClass[tone]}`}>
      {dot && <span className={styles.dot} aria-hidden />}
      {children}
    </span>
  );
}

const subTone: Record<'pos' | 'neg' | 'neutral', string> = {
  pos: styles['sub-pos'] ?? '',
  neg: styles['sub-neg'] ?? '',
  neutral: '',
};

export function StatTile({
  label,
  value,
  valueTitle,
  sub,
  tone = 'neutral',
  spark,
}: {
  label: string;
  value: ReactNode;
  /** Full/untruncated value for the title tooltip when `value` is compacted. */
  valueTitle?: string;
  sub?: ReactNode;
  tone?: 'pos' | 'neg' | 'neutral';
  spark?: ReactNode;
}) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} title={valueTitle}>
        {value}
      </span>
      <div className={styles.statFoot}>
        {sub != null && <span className={`${styles.statSub} ${subTone[tone]}`}>{sub}</span>}
        {spark && <span className={styles.statSpark}>{spark}</span>}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: React.KeyboardEvent) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next >= 0) {
      e.preventDefault();
      const opt = options[next];
      if (opt) onChange(opt.value);
    }
  };
  return (
    <div className={styles.segmented} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`${styles.segItem} ${active ? styles.segActive : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={`${styles.skeleton} ${className ?? ''}`} aria-hidden />;
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
  requiredMark?: boolean;
  trailing?: ReactNode;
};

export function TextField({ label, id, error, hint, requiredMark, trailing, className, ...rest }: TextFieldProps) {
  const autoId = useId();
  const fid = id ?? autoId;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={fid}>
        {label}
        {requiredMark && (
          <span className={styles.req} aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      <div className={styles.inputWrap}>
        <input
          id={fid}
          className={`${styles.input} ${error ? styles.inputError : ''} ${className ?? ''}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {trailing && <span className={styles.trailing}>{trailing}</span>}
      </div>
      {hint && !error && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} className={styles.errorText} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- EmptyState */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.emptyState} ${className ?? ''}`}>
      {icon && (
        <div className={styles.emptyIcon} aria-hidden>
          {icon}
        </div>
      )}
      <h3 className={styles.emptyTitle}>{title}</h3>
      {description && <p className={styles.emptyDesc}>{description}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------- Banner */

type BannerTone = 'info' | 'success' | 'warning' | 'error';

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  role,
}: {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  role?: 'alert' | 'status';
}) {
  const liveRole = role ?? (tone === 'error' ? 'alert' : 'status');
  return (
    <div className={`${styles.banner} ${styles[`banner-${tone}`] ?? ''}`} role={liveRole}>
      <div className={styles.bannerBody}>
        {title && <strong className={styles.bannerTitle}>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className={styles.bannerAction}>{action}</div>}
      {onDismiss && (
        <button type="button" className={styles.bannerX} aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- Modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  initialFocusSelector,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  initialFocusSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    const target = (initialFocusSelector && node?.querySelector<HTMLElement>(initialFocusSelector)) || focusables()[0] || node;
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) {
          e.preventDefault();
          return;
        }
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1]?.focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      lastFocused.current?.focus?.();
    };
  }, [open, onClose, initialFocusSelector]);

  if (!open || !mounted) return null;
  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`${styles.modal} ${styles[`modal-${size}`] ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
      >
        {title && (
          <div className={styles.modalHead}>
            <h2 id={titleId} className={styles.modalTitle}>
              {title}
            </h2>
            <button type="button" className={styles.modalX} aria-label="Close dialog" onClick={onClose}>
              ×
            </button>
          </div>
        )}
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFoot}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------- Toast provider */

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}
interface ToastApi {
  toast: (message: ReactNode, tone?: ToastTone) => void;
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}
const ToastCtx = createContext<ToastApi | null>(null);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = (seq.current += 1);
      setToasts((t) => [...t, { id, message, tone }]);
      setTimeout(() => remove(id), tone === 'error' ? 6500 : 4000);
    },
    [remove],
  );
  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (m) => push(m, 'success'),
      error: (m) => push(m, 'error'),
      info: (m) => push(m, 'info'),
    }),
    [push],
  );
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className={styles.toastWrap} aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`${styles.toast} ${styles[`toast-${t.tone}`] ?? ''}`}
          >
            <span className={styles.toastDot} aria-hidden />
            <span className={styles.toastMsg}>{t.message}</span>
            <button type="button" className={styles.toastX} aria-label="Dismiss" onClick={() => remove(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within <UIProvider>');
  return ctx;
}

/* ------------------------------------------------------- Confirm / Prompt */

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
}
interface PromptOpts {
  title: string;
  body?: ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}
interface ConfirmApi {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
}
const ConfirmCtx = createContext<ConfirmApi | null>(null);

type Pending =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? '');
        setErr(null);
        setPending({ kind: 'prompt', opts, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (result: boolean | string | null) => {
      if (!pending) return;
      (pending.resolve as (v: boolean | string | null) => void)(result);
      setPending(null);
    },
    [pending],
  );

  const onCancel = () => settle(pending?.kind === 'prompt' ? null : false);
  const onConfirm = () => {
    if (pending?.kind === 'prompt') {
      const v = value.trim();
      const ve = pending.opts.validate ? pending.opts.validate(v) : null;
      if (ve) {
        setErr(ve);
        return;
      }
      settle(v);
    } else {
      settle(true);
    }
  };

  const api = useMemo<ConfirmApi>(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <ConfirmCtx.Provider value={api}>
      {children}
      <Modal
        open={pending !== null}
        onClose={onCancel}
        title={pending?.opts.title}
        size="sm"
        initialFocusSelector={pending?.kind === 'prompt' ? 'input' : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={onCancel}>
              {(pending?.kind === 'confirm' ? pending.opts.cancelLabel : undefined) ?? 'Cancel'}
            </Button>
            <Button
              variant={pending?.kind === 'confirm' && pending.opts.tone === 'danger' ? 'danger-solid' : 'primary'}
              onClick={onConfirm}
            >
              {pending?.opts.confirmLabel ?? (pending?.kind === 'prompt' ? 'Save' : 'Confirm')}
            </Button>
          </>
        }
      >
        {pending?.opts.body && <p className={styles.modalText}>{pending.opts.body}</p>}
        {pending?.kind === 'prompt' && (
          <TextField
            label={pending.opts.label ?? pending.opts.title}
            placeholder={pending.opts.placeholder}
            value={value}
            error={err ?? undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (err) setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm();
              }
            }}
          />
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOpts) => Promise<boolean> {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm must be used within <UIProvider>');
  return ctx.confirm;
}

export function usePrompt(): (opts: PromptOpts) => Promise<string | null> {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('usePrompt must be used within <UIProvider>');
  return ctx.prompt;
}

/** Mount once near the app root: provides toasts + confirm/prompt dialogs. */
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
