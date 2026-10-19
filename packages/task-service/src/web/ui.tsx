import { createContext, useContext, useEffect, useMemo, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const cx = (...values: Array<string | undefined | false>) => values.filter(Boolean).join(" ");

type Variant = "default" | "outline" | "ghost" | "destructive" | "accent" | "secondary" | "warning" | "error" | "info" | "success";

export function Button({ variant = "default", size = "md", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return <button className={cx("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)} {...props} />;
}

export function Badge({ variant = "secondary", size = "md", className, ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return <span className={cx("ui-badge", `ui-badge-${variant}`, `ui-badge-${size}`, `bg-${variant}-soft`, className)} {...props} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-skeleton", className)} {...props} />;
}

export function Alert({ severity = "info", className, ...props }: HTMLAttributes<HTMLDivElement> & { severity?: "error" | "warning" | "info" }) {
  return <div role={props.role ?? "status"} className={cx("ui-alert", `ui-alert-${severity}`, className)} {...props} />;
}

export function EmptyState({ title, className, ...props }: HTMLAttributes<HTMLDivElement> & { title: ReactNode; size?: "sm" | "md" }) {
  return <div className={cx("ui-empty-state", className)} {...props}><span>{title}</span></div>;
}

export function StatusTag({ status, label, className }: { status?: string; label: ReactNode; className?: string }) {
  return <span className={cx("ui-status-tag", status && `ui-status-${status}`, className)}>{label}</span>;
}

const selectContext = createContext<{ value: string | null | undefined; setValue: (value: string) => void; register: (items: Array<{ value: string; label: ReactNode }>) => void; items: Array<{ value: string; label: ReactNode }> } | null>(null);

export function Select({ value, onValueChange, children }: { value?: string | null; onValueChange?: (value: string | null) => void; children: ReactNode }) {
  const [items, setItems] = useState<Array<{ value: string; label: ReactNode }>>([]);
  const setValue = (next: string) => onValueChange?.(next);
  const register = (next: Array<{ value: string; label: ReactNode }>) => setItems((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  const context = useMemo(() => ({ value, setValue, register }), [value]);
  return <selectContext.Provider value={{ ...context, items }}>{children}</selectContext.Provider>;
}

export function SelectTrigger({ placeholder, className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string }) {
  const context = useContext(selectContext);
  const selected = (context?.items ?? []).find((item) => item.value === context?.value);
  const chooseNext = () => {
    const items = context?.items ?? [];
    if (items.length === 0) return;
    const index = Math.max(0, items.findIndex((item) => item.value === context?.value));
    context?.setValue(items[(index + 1) % items.length]?.value ?? "");
  };
  return <button type="button" data-slot="select-trigger" aria-label={props["aria-label"]} className={cx("ui-select", className)} onClick={chooseNext}>{selected?.label ?? placeholder ?? "选择"}</button>;
}

export function SelectContent({ children }: { children: ReactNode }) {
  const context = useContext(selectContext);
  useEffect(() => {
    const items: Array<{ value: string; label: ReactNode }> = [];
    const collect = (node: ReactNode): void => {
      if (!node || typeof node === "boolean") return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (typeof node === "object" && "props" in node) {
        const element = node as { type?: unknown; props?: { value?: string; children?: ReactNode } };
        if (element.props?.value !== undefined) items.push({ value: element.props.value, label: element.props.children });
        else collect(element.props?.children);
      }
    };
    collect(children);
    context?.register(items);
  }, [children]);
  return null;
}
export function SelectItem({ children }: { value: string; children: ReactNode }) { return <>{children}</>; }

export function DropdownMenu({ children }: { children: ReactNode }) { return <div className="ui-dropdown">{children}</div>; }
export function DropdownMenuTrigger({ children, asChild: _asChild, ...props }: { children: ReactNode; asChild?: boolean } & HTMLAttributes<HTMLDivElement>) { return <div {...props}>{children}</div>; }
export function DropdownMenuContent({ children, className }: { children: ReactNode; align?: string; className?: string }) { return <div className={cx("ui-dropdown-content", className)}>{children}</div>; }
export function DropdownMenuGroup({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function DropdownMenuLabel({ children }: { children: ReactNode }) { return <div className="ui-dropdown-label">{children}</div>; }
export function DropdownMenuSeparator() { return <hr className="ui-dropdown-separator" />; }
export function DropdownMenuItem({ children, onClick }: { children: ReactNode; onClick?: () => void }) { return <button type="button" className="ui-dropdown-item" onClick={onClick}>{children}</button>; }

function Overlay({ children, className }: { children: ReactNode; className?: string }) { return <div className={cx("ui-overlay", className)}>{children}</div>; }
export function Dialog({ open, children }: { open: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) { return open ? <Overlay>{children}</Overlay> : null; }
export const DialogContent = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement> & { showCloseButton?: boolean }) => <div className={cx("ui-dialog", className)} {...props}>{children}</div>;
export const DialogHeader = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div className="ui-dialog-header" {...props}>{children}</div>;
export const DialogTitle = ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => <h2 className="ui-dialog-title" {...props}>{children}</h2>;
export const DialogDescription = ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => <p className="ui-dialog-description" {...props}>{children}</p>;
export const DialogBody = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div className="ui-dialog-body" {...props}>{children}</div>;
export const DialogFooter = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div className="ui-dialog-footer" {...props}>{children}</div>;
export function Modal({ open, children }: { open: boolean; onOpenChange?: (open: boolean) => void; size?: string; children: ReactNode }) { return open ? <Overlay>{children}</Overlay> : null; }
export const ModalContent = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => <div className={cx("ui-modal", className)} {...props}>{children}</div>;
export const ModalHeader = ({ children, showClose: _showClose, ...props }: HTMLAttributes<HTMLDivElement> & { showClose?: boolean }) => <div className="ui-modal-header" {...props}>{children}</div>;
export const ModalTitle = ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => <h2 className="ui-modal-title" {...props}>{children}</h2>;
export const ModalBody = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div className="ui-modal-body" {...props}>{children}</div>;

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} />; }

type ToastListener = (message: { kind: string; text: string }) => void;
const listeners = new Set<ToastListener>();
export const toast = {
  success(text: string) { listeners.forEach((listener) => listener({ kind: "success", text })); },
  error(text: string) { listeners.forEach((listener) => listener({ kind: "error", text })); },
  info(text: string) { listeners.forEach((listener) => listener({ kind: "info", text })); }
};
export function Toaster({ position = "top-center" }: { position?: string; theme?: string }) {
  const [messages, setMessages] = useState<Array<{ kind: string; text: string; id: number }>>([]);
  useEffect(() => { const listener: ToastListener = (message) => { const id = Date.now() + Math.random(); setMessages((current) => [...current, { ...message, id }]); window.setTimeout(() => setMessages((current) => current.filter((item) => item.id !== id)), 5000); }; listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return <div className={cx("ui-toaster", `ui-toaster-${position}`)}>{messages.map((message) => <div key={message.id} className={cx("ui-toast", `ui-toast-${message.kind}`)}>{message.text}</div>)}</div>;
}

export type Status = string;
