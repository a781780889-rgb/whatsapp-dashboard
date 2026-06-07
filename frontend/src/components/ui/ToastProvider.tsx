import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface ToastContextType {
  addToast: (t: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { ...t, id }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <div className="fixed top-4 left-4 z-[100] flex flex-col gap-3 w-full max-w-sm pointer-events-none">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onRemove, 4000);
    return () => clearTimeout(timer);
  }, [onRemove]);

  const icons = {
    success: <CheckCircle2 className="w-5 h-5 text-green-500" />,
    error: <XCircle className="w-5 h-5 text-red-500" />,
    warning: <AlertCircle className="w-5 h-5 text-yellow-500" />,
    info: <Info className="w-5 h-5 text-blue-500" />
  };

  const bgs = {
    success: 'bg-green-500/10 border-green-500/20',
    error: 'bg-red-500/10 border-red-500/20',
    warning: 'bg-yellow-500/10 border-yellow-500/20',
    info: 'bg-blue-500/10 border-blue-500/20'
  };

  return (
    <div className={cn(
      "pointer-events-auto flex items-start gap-3 p-4 rounded-xl border backdrop-blur-md shadow-elevated",
      "animate-slide-in-r transition-all duration-300",
      "bg-surface", bgs[toast.type]
    )}>
      {icons[toast.type]}
      <div className="flex-1">
        <h4 className="text-sm font-semibold text-primary">{toast.title}</h4>
        {toast.description && <p className="text-xs text-secondary mt-1">{toast.description}</p>}
      </div>
      <button onClick={onRemove} className="text-muted hover:text-primary transition-colors">
        <X className="w-4 h-4" />
      </button>
      <div className="absolute bottom-0 left-0 h-1 bg-current opacity-20 animate-[shimmer_4s_linear_forwards]" />
    </div>
  );
}
