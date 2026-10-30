import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
};

const ToastContext = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);
const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(() =>
  Promise.resolve(false),
);

/** Short confirmation after an action ("Risk recorded"); disappears by itself. */
export const useToast = () => useContext(ToastContext);

/**
 * Asks before an action that cannot be undone. Resolves to true when confirmed. Uses the native
 * <dialog>, which traps focus and closes on Escape.
 */
export const useConfirm = () => useContext(ConfirmContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, text, kind }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 4000);
  }, []);

  const confirm = useCallback((r: ConfirmRequest) => {
    setRequest(r);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  useEffect(() => {
    if (request && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [request]);

  function close(ok: boolean) {
    dialog.current?.close();
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <dialog
          ref={dialog}
          className="confirm"
          aria-labelledby="confirm-title"
          onCancel={(e) => {
            e.preventDefault();
            close(false);
          }}
        >
          {request && (
            <>
              <h2 id="confirm-title">{request.title}</h2>
              {request.body && <p>{request.body}</p>}
              <div className="actions">
                <button type="button" onClick={() => close(false)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className={request.danger ? 'danger solid' : 'primary'}
                  onClick={() => close(true)}
                  autoFocus
                >
                  {request.confirmLabel}
                </button>
              </div>
            </>
          )}
        </dialog>
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((x) => (
            <div key={x.id} className={`toast ${x.kind === 'error' ? 'error' : ''}`}>
              {x.text}
            </div>
          ))}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
