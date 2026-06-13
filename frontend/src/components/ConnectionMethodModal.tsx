import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  QrCode, Hash, Building2, X, CheckCircle2, Loader2, Copy,
  Wifi, AlertCircle, RefreshCw, ExternalLink,
  Phone, Key, Globe, ShieldCheck, TestTube2, Eye, EyeOff,
  AlertTriangle, Clock, RotateCcw,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { QRCodeSVG } from 'qrcode.react';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { io, Socket } from 'socket.io-client';

// ✅ BUG #7 FIX: حساب SOCKET_URL بشكل صحيح لكلا الحالتين:
// - رابط نسبي  (API = '/api/v1')           → SOCKET_URL = '' → يتصل بـ origin الحالي ✓
// - رابط مطلق (API = 'https://x.com/api/v1') → SOCKET_URL = 'https://x.com'      ✓
// السبب: API.replace('/api/v1', '') يُخطئ إذا كان هناك trailing-slash أو path مختلف
const SOCKET_URL = (() => {
  try {
    // رابط مطلق → نستخرج الـ origin فقط (بروتوكول + نطاق + منفذ)
    return new URL(API).origin;
  } catch {
    // رابط نسبي → نتصل بنفس الـ origin (Socket.IO يقبل '' كـ current origin)
    return '';
  }
})();

// ── أكواد الدول ───────────────────────────────────────────────────────────────
const COUNTRY_CODES = [
  { code: '966', flag: '🇸🇦', name: 'السعودية'   },
  { code: '971', flag: '🇦🇪', name: 'الإمارات'   },
  { code: '965', flag: '🇰🇼', name: 'الكويت'     },
  { code: '974', flag: '🇶🇦', name: 'قطر'         },
  { code: '973', flag: '🇧🇭', name: 'البحرين'    },
  { code: '968', flag: '🇴🇲', name: 'عُمان'       },
  { code: '967', flag: '🇾🇪', name: 'اليمن'       },
  { code: '962', flag: '🇯🇴', name: 'الأردن'     },
  { code: '961', flag: '🇱🇧', name: 'لبنان'      },
  { code: '963', flag: '🇸🇾', name: 'سوريا'      },
  { code: '20',  flag: '🇪🇬', name: 'مصر'         },
  { code: '218', flag: '🇱🇾', name: 'ليبيا'      },
  { code: '216', flag: '🇹🇳', name: 'تونس'       },
  { code: '213', flag: '🇩🇿', name: 'الجزائر'    },
  { code: '212', flag: '🇲🇦', name: 'المغرب'     },
  { code: '249', flag: '🇸🇩', name: 'السودان'    },
  { code: '1',   flag: '🇺🇸', name: 'أمريكا'     },
  { code: '44',  flag: '🇬🇧', name: 'بريطانيا'  },
  { code: '49',  flag: '🇩🇪', name: 'ألمانيا'    },
  { code: '33',  flag: '🇫🇷', name: 'فرنسا'      },
  { code: '90',  flag: '🇹🇷', name: 'تركيا'      },
  { code: '92',  flag: '🇵🇰', name: 'باكستان'    },
  { code: '91',  flag: '🇮🇳', name: 'الهند'      },
  { code: '62',  flag: '🇮🇩', name: 'إندونيسيا' },
];

// ── حالات الاتصال وترجمتها ────────────────────────────────────────────────────
type ConnState =
  | 'idle' | 'initializing' | 'qr_generating' | 'qr_ready' | 'scanning'
  | 'connecting' | 'connected' | 'pairing_starting' | 'pairing_generating'
  | 'pairing_ready' | 'disconnected' | 'error';

function stateLabel(s: ConnState, errorMsg?: string): { text: string; color: string; pulse: boolean } {
  const map: Record<ConnState, { text: string; color: string; pulse: boolean }> = {
    idle:               { text: 'جاهز',                              color: 'bg-gray-500',    pulse: false },
    initializing:       { text: 'جارٍ التهيئة...',                  color: 'bg-gray-500',    pulse: true  },
    qr_generating:      { text: 'جارٍ إنشاء QR Code...',           color: 'bg-yellow-400',  pulse: true  },
    qr_ready:           { text: 'بانتظار المسح',                    color: 'bg-yellow-400',  pulse: true  },
    scanning:           { text: 'تم المسح — جارٍ الاتصال',          color: 'bg-blue-400',    pulse: true  },
    connecting:         { text: 'جارٍ الاتصال...',                  color: 'bg-blue-400',    pulse: true  },
    connected:          { text: 'متصل ✓',                           color: 'bg-green-500',   pulse: false },
    pairing_starting:   { text: 'جارٍ التحضير...',                  color: 'bg-gray-500',    pulse: true  },
    pairing_generating: { text: 'جارٍ إنشاء رمز الإقران...',       color: 'bg-blue-400',    pulse: true  },
    pairing_ready:      { text: 'بانتظار إدخال الرمز',              color: 'bg-yellow-400',  pulse: true  },
    disconnected:       { text: 'منقطع',                             color: 'bg-red-500',     pulse: false },
    error:              { text: errorMsg || 'خطأ',                   color: 'bg-red-500',     pulse: false },
  };
  return map[s] ?? { text: s, color: 'bg-gray-500', pulse: false };
}

// ════════════════════════════════════════════════════════════════════
interface ConnectionMethodModalProps {
  accountId: string;
  accountName: string;
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  showToast: (t: { title: string; description?: string; type?: string }) => void;
}

type Method = 'select' | 'qr' | 'pairing' | 'business_api';

export function ConnectionMethodModal({
  accountId, accountName, open, onClose, onConnected, showToast,
}: ConnectionMethodModalProps) {
  const [method, setMethod] = useState<Method>('select');

  useEffect(() => { if (open) setMethod('select'); }, [open]);

  const handleClose = () => { setMethod('select'); onClose(); };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={cn(
        'max-w-xl w-full p-0 overflow-hidden',
        'bg-[var(--bg-surface)] border border-[var(--border-default)]'
      )}>
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2 text-[var(--text-primary)] text-lg">
            <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary-light)] flex items-center justify-center">
              <Wifi className="w-4 h-4 text-[var(--brand-primary)]" />
            </div>
            ربط الحساب — {accountName}
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-6 pt-4">
          {method === 'select'       && <MethodSelector onSelect={setMethod} />}
          {method === 'qr'           && (
            <QRCodeMethod
              accountId={accountId}
              onBack={() => setMethod('select')}
              onConnected={() => { handleClose(); onConnected(); }}
              showToast={showToast}
            />
          )}
          {method === 'pairing'      && (
            <PairingCodeMethod
              accountId={accountId}
              onBack={() => setMethod('select')}
              onConnected={() => { handleClose(); onConnected(); }}
              showToast={showToast}
            />
          )}
          {method === 'business_api' && (
            <BusinessAPIMethod
              accountId={accountId}
              onBack={() => setMethod('select')}
              onConnected={() => { handleClose(); onConnected(); }}
              showToast={showToast}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════
//  اختيار الطريقة
// ════════════════════════════════════════════════════════════════════
function MethodSelector({ onSelect }: { onSelect: (m: Method) => void }) {
  const methods = [
    {
      id: 'qr' as Method, icon: QrCode, color: 'text-[var(--brand-primary)]',
      bg: 'bg-[var(--brand-primary-light)] border-[var(--brand-primary)]/30',
      title: 'رمز QR Code', desc: 'افتح واتساب → الأجهزة المرتبطة → مسح الرمز',
      badge: 'الأسرع', badgeColor: 'bg-green-500/15 text-green-400',
    },
    {
      id: 'pairing' as Method, icon: Hash, color: 'text-blue-400',
      bg: 'bg-blue-500/10 border-blue-500/30',
      title: 'Pairing Code', desc: 'أدخل رقم هاتفك واحصل على رمز مكوّن من 8 أرقام',
      badge: 'بدون مسح', badgeColor: 'bg-blue-500/15 text-blue-400',
    },
    {
      id: 'business_api' as Method, icon: Building2, color: 'text-purple-400',
      bg: 'bg-purple-500/10 border-purple-500/30',
      title: 'WhatsApp Business API', desc: 'اربط عبر Cloud API الرسمي لـ Meta Business',
      badge: 'للأعمال', badgeColor: 'bg-purple-500/15 text-purple-400',
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-muted)] mb-1">اختر طريقة ربط الحساب:</p>
      {methods.map(m => (
        <button key={m.id} onClick={() => onSelect(m.id)} className={cn(
          'flex items-center gap-4 p-4 rounded-xl border text-right transition-all duration-150',
          'hover:scale-[1.01] hover:shadow-lg bg-[var(--bg-elevated)] border-[var(--border-default)]',
          'hover:border-[var(--border-strong)] hover:bg-[var(--bg-overlay)] group w-full'
        )}>
          <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center border flex-shrink-0', m.bg)}>
            <m.icon className={cn('w-6 h-6', m.color)} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-semibold text-[var(--text-primary)] text-sm">{m.title}</span>
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', m.badgeColor)}>{m.badge}</span>
            </div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">{m.desc}</p>
          </div>
          <div className="text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors">
            <svg className="w-4 h-4 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  شريط حالة الاتصال
// ════════════════════════════════════════════════════════════════════
function ConnectionStateBadge({ state, error }: { state: ConnState; error?: string }) {
  const { text, color, pulse } = stateLabel(state, error);
  return (
    <div className="flex items-center gap-2">
      <span className={cn('w-2 h-2 rounded-full', color, pulse && 'animate-pulse')} />
      <span className="text-xs text-[var(--text-muted)]">{text}</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  QR Code Method
// ════════════════════════════════════════════════════════════════════
function QRCodeMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [qr, setQr]           = useState<string | null>(null);
  const [connState, setConn]  = useState<ConnState>('idle');
  const [errorMsg, setError]  = useState('');
  const [expired, setExpired] = useState(false);
  const socketRef             = useRef<Socket | null>(null);
  const expireTimer           = useRef<any>(null);
  const isMounted             = useRef(true);
  // ✅ FIX: ref لتتبع الحالة الحقيقية داخل socket handlers (يحل مشكلة stale closure)
  const connStateRef          = useRef<ConnState>('idle');
  const pollRef               = useRef<any>(null);

  const setConnState = (s: ConnState) => {
    connStateRef.current = s;
    setConn(s);
  };

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const startSession = useCallback(async () => {
    if (!isMounted.current) return;
    setQr(null);
    setExpired(false);
    setError('');
    setConnState('initializing');

    // قطع أي socket سابق + إيقاف polling سابق
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    if (expireTimer.current) { clearTimeout(expireTimer.current); }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    try {
      // 1. إرسال طلب الاتصال للـ backend
      const res  = await authFetch(`${API}/accounts/${accountId}/connect`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'فشل بدء الاتصال');
        setConnState('error');
        return;
      }

      setConnState('qr_generating');

      // 2. الاتصال بـ Socket.IO والانضمام للغرفة
      const socket = io(SOCKET_URL, {
        // [FIX-TRANSPORT] websocket أولاً ثم polling كـ fallback لضمان عمل Railway و reverse proxies
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1500,
        timeout: 20000,
      });
      socketRef.current = socket;

      // دالة مساعدة: تحديث QR وضبط مؤقت الانتهاء
      const applyQR = (qrCode: string, ts?: number) => {
        if (!isMounted.current) return;
        setQr(qrCode);
        setConnState('qr_ready');
        setExpired(false);
        setError('');
        if (expireTimer.current) clearTimeout(expireTimer.current);
        const age       = ts ? Date.now() - ts : 0;
        const remaining = Math.max(55000 - age, 5000);
        expireTimer.current = setTimeout(() => {
          if (isMounted.current) setExpired(true);
        }, remaining);
      };

      socket.on('connect', async () => {
        socket.emit('join_account', accountId);

        // 3. بعد الانضمام للغرفة: تحقق من وجود QR مخزّن (لتجنب Race Condition)
        try {
          const qrRes  = await authFetch(`${API}/accounts/${accountId}/qr-status`, { cache: 'no-store' });
          if (!qrRes.ok) return;
          const qrData = await qrRes.json();
          if (!isMounted.current) return;
          if (qrData.state === 'connected') {
            handleConnected(); return;
          }
          if (qrData.qr) {
            applyQR(qrData.qr, qrData.ts);
          }
        } catch {}
      });

      // ✅ FIX: connect_error — لا نُظهر خطأ إذا كان المستخدم في منتصف المسح
      socket.on('connect_error', (err: any) => {
        if (!isMounted.current) return;
        // تجاهل الخطأ إذا كنا في حالة scanning/connecting — الـ polling سيُكمل
        const cur = connStateRef.current;
        if (cur === 'scanning' || cur === 'connecting' || cur === 'connected') return;
        setError(`خطأ في الاتصال: ${err?.message || 'تحقق من الاتصال'}`);
        setConnState('error');
      });

      // ✅ FIX: disconnect — لا نُظهر خطأ إذا كنا في scanning/connecting
      // الـ polling سيستمر بمفرده ويرصد connected
      socket.on('disconnect', () => {
        if (!isMounted.current) return;
        const cur = connStateRef.current;
        if (cur === 'connected' || cur === 'scanning' || cur === 'connecting') return;
        // لا نُوقف الـ polling — يبقى يعمل مستقلاً
      });

      // ── الأحداث الرئيسية ──────────────────────────────────────────────────
      socket.on('connection_state', ({ state: s, error: e, qr: qrFromState, ts: qrTs }: any) => {
        if (!isMounted.current) return;
        setConnState(s as ConnState);
        if (e) setError(e);
        // [FIX-QR-STATE] إذا جاء QR مع حدث connection_state → عرضه مباشرة
        if (s === 'qr_ready' && qrFromState) {
          applyQR(qrFromState, qrTs);
        }
      });

      socket.on('qr_code', ({ qr: code, ts: qrTs }: any) => {
        if (!isMounted.current) return;
        applyQR(code, qrTs);
      });

      socket.on('session_cleared', () => {
        if (!isMounted.current) return;
        setQr(null);
        setConnState('qr_generating');
      });

      socket.on('connection_error', ({ error: e }: any) => {
        if (!isMounted.current) return;
        setError(e);
        setConnState('error');
      });

      const handleConnected = () => {
        if (!isMounted.current) return;
        if (connStateRef.current === 'connected') return; // منع التكرار
        setConnState('connected');
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
        setTimeout(() => {
          showToast({ title: '✅ متصل', description: 'تم ربط الحساب بنجاح', type: 'success' });
          onConnected();
        }, 1000);
      };

      socket.on('account_status', ({ status: s }: any) => {
        if (!isMounted.current) return;
        if (s === 'connected') {
          handleConnected();
        } else if (s === 'disconnected') {
          const cur = connStateRef.current;
          if (cur !== 'connected' && cur !== 'scanning' && cur !== 'connecting') {
            setConnState('disconnected');
          }
        }
      });

      // [FIX-POLLING] Polling مستقل — يعمل حتى بعد انقطاع Socket ويُحدِّث QR أيضاً
      // هذا يضمن عرض QR حتى لو فشل Socket.IO WebSocket
      pollRef.current = setInterval(async () => {
        if (!isMounted.current) return;
        if (connStateRef.current === 'connected') {
          clearInterval(pollRef.current); pollRef.current = null; return;
        }
        try {
          const r = await authFetch(`${API}/accounts/${accountId}/qr-status`, { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json();
          if (d.state === 'connected') {
            clearInterval(pollRef.current); pollRef.current = null;
            handleConnected();
          } else if (d.state === 'connecting' || d.state === 'scanning') {
            if (isMounted.current && connStateRef.current !== 'connected') {
              setConnState(d.state as ConnState);
            }
          } else if (d.state === 'qr_ready' && d.qr) {
            // [FIX-QR-POLLING] تحديث QR عبر HTTP polling إذا لم يصل عبر Socket
            // هذا يحل مشكلة: Socket.IO WebSocket يفشل على بعض الشبكات/proxies
            if (connStateRef.current !== 'connected' && connStateRef.current !== 'scanning') {
              applyQR(d.qr, d.ts);
            }
          }
        } catch { /* network error, ignore */ }
      }, 2500);

    } catch (err: any) {
      if (isMounted.current) {
        setError('فشل الاتصال بالخادم. تحقق من الإنترنت.');
        setConnState('error');
      }
    }
  }, [accountId]);

  useEffect(() => {
    startSession();
    return () => {
      if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
      if (expireTimer.current) clearTimeout(expireTimer.current);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [startSession]);

  const isConnected = connState === 'connected';
  const isError     = connState === 'error';
  const isLoading   = ['idle', 'initializing', 'qr_generating', 'connecting'].includes(connState);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
          </svg>
          تغيير الطريقة
        </button>
        <ConnectionStateBadge state={connState} error={errorMsg} />
      </div>

      {/* QR Box */}
      <div className={cn(
        'relative w-56 h-56 rounded-2xl flex items-center justify-center',
        'bg-white border-4 border-[var(--bg-elevated)]',
        (expired && !isConnected) && 'opacity-40'
      )}>
        {isConnected ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-green-500/90">
            <CheckCircle2 className="w-12 h-12 text-white" />
            <span className="text-white font-bold mt-1">متصل ✓</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <AlertCircle className="w-10 h-10 text-red-400" />
            <p className="text-xs text-gray-600 leading-relaxed">{errorMsg || 'حدث خطأ'}</p>
          </div>
        ) : qr && !expired ? (
          <QRCodeSVG value={qr} size={200} bgColor="#ffffff" fgColor="#000000" level="M" />
        ) : isLoading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-10 h-10 text-[var(--brand-primary)] animate-spin" />
            <span className="text-xs text-gray-500">
              {connState === 'qr_generating' ? 'جارٍ إنشاء QR...' : 'جارٍ التحميل...'}
            </span>
          </div>
        ) : expired ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/60">
            <AlertCircle className="w-8 h-8 text-orange-400 mb-1" />
            <span className="text-white text-sm font-medium">انتهت الصلاحية</span>
          </div>
        ) : (
          <Loader2 className="w-10 h-10 text-[var(--brand-primary)] animate-spin" />
        )}
      </div>

      {/* تحديث الرمز */}
      {(expired || isError) && !isConnected && (
        <Button onClick={startSession} size="sm"
          className="bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2">
          <RefreshCw className="w-3.5 h-3.5" />
          {isError ? 'إعادة المحاولة' : 'تحديث الرمز'}
        </Button>
      )}

      {/* رسالة الخطأ */}
      {isError && errorMsg && (
        <div className="w-full bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 leading-relaxed">{errorMsg}</p>
        </div>
      )}

      {/* خطوات */}
      {!isError && !isConnected && (
        <div className="text-center text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
          <p className="font-medium text-[var(--text-secondary)] mb-1">خطوات الربط:</p>
          <p>1. افتح <strong className="text-[var(--text-primary)]">واتساب</strong> → الإعدادات</p>
          <p>2. اختر <strong className="text-[var(--text-primary)]">الأجهزة المرتبطة</strong></p>
          <p>3. اضغط <strong className="text-[var(--text-primary)]">ربط جهاز</strong> ثم امسح الرمز</p>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  Pairing Code Method
// ════════════════════════════════════════════════════════════════════
function PairingCodeMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [countryCode, setCountryCode] = useState('966');
  const [phoneLocal, setPhoneLocal]   = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [connState, setConn]          = useState<ConnState>('idle');
  const [errorMsg, setError]          = useState('');
  const [copied, setCopied]           = useState(false);
  const [countdown, setCountdown]     = useState(0);
  const socketRef                     = useRef<Socket | null>(null);
  const countdownRef                  = useRef<any>(null);
  const isMounted                     = useRef(true);
  // ✅ FIX: ref لتتبع الحالة الحقيقية داخل socket handlers (يحل stale closure)
  const connStateRef                  = useRef<ConnState>('idle');
  // ✅ BUG #5 FIX: منع إظهار Toast مُكرَّر عند وصول pairing_code عبر قناتين
  // (connection_state مع code) + (pairing_code مستقل)
  const codeToastShownRef             = useRef(false);
  const pollRef                       = useRef<any>(null);

  const setConnState = (s: ConnState) => {
    connStateRef.current = s;
    setConn(s);
  };

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, []);

  // مؤقت عكسي للـ pairing code
  const startCountdown = (seconds: number) => {
    setCountdown(seconds);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(countdownRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const handleRequestCode = async () => {
    let digits = phoneLocal.replace(/\D/g, '');
    // ✅ FIX: إزالة الصفر البادئ (0) من الرقم المحلي إذا أدخله المستخدم
    // مثال: 05XXXXXXXX → 5XXXXXXXX
    if (digits.startsWith('0')) digits = digits.substring(1);

    if (digits.length < 7) {
      showToast({ title: 'خطأ', description: 'أدخل رقم الهاتف بدون رمز الدولة ودون صفر في البداية', type: 'error' });
      return;
    }
    const fullPhone = countryCode + digits;
    // ✅ FIX: تحقق من الطول الكلي
    if (fullPhone.length < 10 || fullPhone.length > 15) {
      showToast({ title: 'خطأ', description: `الرقم "${fullPhone}" يبدو غير صحيح. تحقق من رمز الدولة والرقم.`, type: 'error' });
      return;
    }

    setError('');
    setPairingCode(null);
    setConnState('pairing_starting');
    codeToastShownRef.current = false; // ✅ BUG #5 FIX: إعادة ضبط guard عند كل طلب جديد

    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    try {
      // 1. إرسال طلب Pairing
      const res  = await authFetch(`${API}/accounts/${accountId}/connect-pairing`, {
        method: 'POST',
        body:   JSON.stringify({ phone_number: fullPhone }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'فشل إنشاء الرمز');
        setConnState('error');
        return;
      }

      // 2. الاتصال بـ Socket.IO
      const socket = io(SOCKET_URL, {
        // [FIX-TRANSPORT] websocket أولاً ثم polling كـ fallback
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1500,
        timeout: 20000,
      });
      socketRef.current = socket;

      socket.on('connect', async () => {
        socket.emit('join_account', accountId);
        // تحقق من وجود pairing code مخزّن (للـ late-joiners)
        try {
          const r = await authFetch(`${API}/accounts/${accountId}/qr-status`, { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json();
          if (!isMounted.current) return;
          if (d.state === 'connected') { handlePairingConnected(); return; }
          if (d.state === 'pairing_ready' && d.code) {
            setPairingCode(d.code);
            setConnState('pairing_ready');
            startCountdown(120);
          }
        } catch {}
      });

      // ── أحداث الـ Pairing ────────────────────────────────────────────────
      socket.on('connection_state', ({ state: s, error: e, code }: any) => {
        if (!isMounted.current) return;
        setConnState(s as ConnState);
        if (e) setError(e);
        // استقبال الرمز من حدث connection_state
        // ✅ BUG #5 FIX: تحقق من codeToastShownRef لمنع Toast مُكرَّر
        // (قد يصل الكود من connection_state + pairing_code في نفس الوقت)
        if (s === 'pairing_ready' && code) {
          setPairingCode(code);
          startCountdown(120);
          if (!codeToastShownRef.current) {
            codeToastShownRef.current = true;
            showToast({ title: '✅ تم إنشاء رمز الإقران', description: 'أدخله في واتساب خلال دقيقتين', type: 'success' });
          }
        }
      });

      socket.on('pairing_code', ({ code }: any) => {
        if (!isMounted.current) return;
        console.log('[Pairing] Received code from socket:', code);
        setPairingCode(code);
        setConnState('pairing_ready');
        setError('');
        startCountdown(120);
        // ✅ BUG #5 FIX: إظهار Toast مرة واحدة فقط حتى لو وصل الكود من قناتين
        if (!codeToastShownRef.current) {
          codeToastShownRef.current = true;
          showToast({ title: '✅ تم إنشاء رمز الإقران', description: 'أدخله في واتساب خلال دقيقتين', type: 'success' });
        }
      });

      socket.on('pairing_error', ({ error: e }: any) => {
        if (!isMounted.current) return;
        setError(e);
        setConnState('error');
        showToast({ title: '❌ فشل إنشاء الرمز', description: e, type: 'error' });
      });

      socket.on('connection_error', ({ error: e }: any) => {
        if (!isMounted.current) return;
        // تجاهل الأخطاء إذا كنا في مرحلة الانتظار بعد إدخال الكود
        const cur = connStateRef.current;
        if (cur === 'pairing_ready' || cur === 'connecting' || cur === 'connected') return;
        setError(e);
        setConnState('error');
      });

      const handlePairingConnected = () => {
        if (!isMounted.current) return;
        if (connStateRef.current === 'connected') return; // منع التكرار
        setConnState('connected');
        if (countdownRef.current) clearInterval(countdownRef.current);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
        setTimeout(() => {
          showToast({ title: '✅ متصل', description: 'تم ربط الحساب بنجاح', type: 'success' });
          onConnected();
        }, 1200);
      };

      socket.on('account_status', ({ status: s }: any) => {
        if (!isMounted.current) return;
        if (s === 'connected') {
          handlePairingConnected();
        }
      });

      // ✅ FIX: Polling مستقل — لا يُوقَف عند انقطاع Socket
      // هذا ضروري لأن: بعد إدخال الكود → 515 → initSession → يستغرق وقتاً → Socket ينقطع
      pollRef.current = setInterval(async () => {
        if (!isMounted.current) return;
        if (connStateRef.current === 'connected') {
          clearInterval(pollRef.current); pollRef.current = null; return;
        }
        try {
          const r = await authFetch(`${API}/accounts/${accountId}/qr-status`, { cache: 'no-store' });
          if (!r.ok) return;
          const d = await r.json();
          if (d.state === 'connected') {
            clearInterval(pollRef.current); pollRef.current = null;
            handlePairingConnected();
          } else if (d.state === 'connecting') {
            // إبلاغ المستخدم أن الاتصال جارٍ (بعد إدخال الكود)
            if (isMounted.current && connStateRef.current !== 'connected') {
              setConnState('connecting');
            }
          }
        } catch { /* network error, ignore */ }
      }, 2500);

      // ✅ FIX: عند انقطاع Socket، نبقي الـ polling يعمل — لا نوقفه
      socket.on('disconnect', () => {
        // لا نفعل شيئاً — الـ polling سيستمر
      });

    } catch {
      setError('فشل الاتصال بالخادم. تحقق من الإنترنت.');
      setConnState('error');
    }
  };

  const handleRetry = () => {
    setPairingCode(null);
    setError('');
    setConnState('idle');
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const handleCopy = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.replace(/-/g, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isLoading   = ['pairing_starting', 'pairing_generating', 'connecting'].includes(connState);
  const isConnected = connState === 'connected';
  const isError     = connState === 'error';
  const canSubmit   = phoneLocal.replace(/\D/g, '').length >= 7 && !isLoading;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors w-fit">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
          </svg>
          تغيير الطريقة
        </button>
        {connState !== 'idle' && <ConnectionStateBadge state={connState} error={errorMsg} />}
      </div>

      {/* نموذج الإدخال */}
      {!isConnected && !pairingCode && (
        <>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-2 block">
              رقم الهاتف المرتبط بواتساب
            </label>
            <div className="flex gap-2">
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                disabled={isLoading}
                className={cn(
                  'flex-shrink-0 w-36 px-3 py-2.5 text-sm rounded-lg',
                  'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
                  'text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)] transition-colors',
                  isLoading && 'opacity-50 cursor-not-allowed'
                )}
                dir="ltr"
              >
                {COUNTRY_CODES.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} +{c.code} {c.name}</option>
                ))}
              </select>
              <input
                type="tel"
                placeholder="5XXXXXXXX"
                value={phoneLocal}
                onChange={e => setPhoneLocal(e.target.value)}
                disabled={isLoading}
                dir="ltr"
                className={cn(
                  'flex-1 px-3 py-2.5 text-sm rounded-lg',
                  'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
                  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                  'outline-none focus:border-[var(--brand-primary)] transition-colors',
                  isLoading && 'opacity-50 cursor-not-allowed'
                )}
              />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1.5">
              الرقم الكامل:{' '}
              <span dir="ltr" className="font-mono text-[var(--text-secondary)]">
                +{countryCode}{phoneLocal.replace(/\D/g, '').replace(/^0/, '')}
              </span>
              {phoneLocal.replace(/\D/g, '').startsWith('0') && (
                <span className="text-orange-400 mr-2">⚠ احذف الصفر البادئ</span>
              )}
            </p>
          </div>

          <Button
            onClick={handleRequestCode}
            disabled={!canSubmit}
            className="w-full bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Hash className="w-4 h-4" />}
            {isLoading ? (
              connState === 'pairing_generating'
                ? 'جارٍ إنشاء رمز الإقران...'
                : 'جارٍ التحضير...'
            ) : 'إنشاء Pairing Code'}
          </Button>

          {/* شرح العملية */}
          {isLoading && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3">
              <div className="flex items-center gap-2 text-blue-300 text-xs mb-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                <span className="font-medium">
                  {connState === 'pairing_generating'
                    ? 'يتواصل مع خوادم واتساب لإنشاء رمز الإقران...'
                    : 'يتصل بواتساب ويطلب رمز الإقران...'}
                </span>
              </div>
              <p className="text-xs text-blue-400/70">قد يستغرق هذا حتى 30 ثانية. لا تغلق النافذة.</p>
            </div>
          )}
        </>
      )}

      {/* عرض الـ Pairing Code */}
      {pairingCode && !isConnected && (
        <div className="bg-[var(--bg-elevated)] border border-[var(--brand-primary)]/30 rounded-xl p-5 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--brand-primary)]">
            <Hash className="w-4 h-4" />
            <span className="text-sm font-medium">رمز الإقران</span>
          </div>

          <div dir="ltr" className="text-4xl font-bold tracking-[0.3em] text-[var(--text-primary)] font-mono select-all">
            {pairingCode}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleCopy}
              className={cn(
                'flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg transition-colors',
                copied
                  ? 'bg-green-500/15 text-green-400'
                  : 'bg-[var(--bg-overlay)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}
            >
              {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'تم النسخ!' : 'نسخ الرمز'}
            </button>

            {countdown > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-yellow-400">
                <Clock className="w-3.5 h-3.5" />
                <span>صالح لـ {countdown}ث</span>
              </div>
            )}
          </div>

          <div className="text-xs text-[var(--text-muted)] text-center leading-relaxed">
            <p>افتح واتساب → الإعدادات → الأجهزة المرتبطة</p>
            <p>اضغط <strong className="text-[var(--text-secondary)]">ربط جهاز</strong> → <strong className="text-[var(--text-secondary)]">ربط برمز الهاتف</strong></p>
            <p>أدخل رقمك ثم اكتب هذا الرمز في واتساب</p>
          </div>

          <div className="flex items-center gap-2 text-yellow-400 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>بانتظار تأكيد الربط في واتساب...</span>
          </div>
        </div>
      )}

      {/* خطأ */}
      {isError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-300">فشل إنشاء رمز الإقران</p>
              <p className="text-xs text-red-400/80 mt-0.5 leading-relaxed">{errorMsg}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleRetry} size="sm" variant="outline"
              className="flex-1 border-red-500/30 text-red-300 hover:bg-red-500/10 gap-2">
              <RotateCcw className="w-3.5 h-3.5" />
              تغيير الرقم والمحاولة مجدداً
            </Button>
            <Button onClick={handleRequestCode} size="sm"
              className="flex-1 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2"
              disabled={phoneLocal.replace(/\D/g, '').length < 7}>
              <RefreshCw className="w-3.5 h-3.5" />
              إعادة المحاولة
            </Button>
          </div>
        </div>
      )}

      {/* نجاح */}
      {isConnected && (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
            <CheckCircle2 className="w-9 h-9 text-green-400" />
          </div>
          <p className="font-bold text-[var(--text-primary)]">تم الربط بنجاح ✓</p>
          <p className="text-xs text-[var(--text-muted)]">سيتم إغلاق هذه النافذة تلقائياً</p>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  WhatsApp Business API Method
// ════════════════════════════════════════════════════════════════════
function BusinessAPIMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [form, setForm] = useState({
    phone_number_id: '', business_account_id: '',
    access_token: '', verify_token: '', webhook_url: '',
  });
  const [showToken, setShowToken]     = useState(false);
  const [loading, setLoading]         = useState(false);
  const [testing, setTesting]         = useState(false);
  const [testResult, setTestResult]   = useState<any>(null);
  const [saved, setSaved]             = useState(false);
  const [webhookInfo, setWebhookInfo] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await authFetch(`${API}/accounts/${accountId}/business-api`);
        const d = await r.json();
        if (d.success && d.settings) {
          setForm(prev => ({
            ...prev,
            phone_number_id:     d.settings.phone_number_id || '',
            business_account_id: d.settings.business_account_id || '',
            verify_token:        d.settings.verify_token || '',
            webhook_url:         d.settings.webhook_url || '',
          }));
          setWebhookInfo(d.settings.webhook_url || '');
          setSaved(true);
        }
      } catch {}
    })();
  }, [accountId]);

  const handleChange = (field: string, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/business-api`, { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json();
      if (data.success) {
        showToast({ title: 'تم الحفظ ✓', description: data.message, type: 'success' });
        setWebhookInfo(data.webhook_url || '');
        setSaved(true);
        setForm(prev => ({ ...prev, access_token: '' }));
      } else {
        showToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch { showToast({ title: 'خطأ', description: 'فشل الحفظ', type: 'error' }); }
    finally { setLoading(false); }
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/business-api/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(data);
      if (data.success) { showToast({ title: 'اتصال ناجح ✓', description: data.message, type: 'success' }); onConnected(); }
      else { showToast({ title: 'فشل الاختبار', description: data.error, type: 'error' }); }
    } catch { showToast({ title: 'خطأ', description: 'فشل اختبار الاتصال', type: 'error' }); }
    finally { setTesting(false); }
  };

  const inputClass = cn('w-full px-3 py-2.5 text-sm rounded-lg',
    'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
    'outline-none focus:border-[var(--brand-primary)] transition-colors');
  const labelClass = 'text-xs font-medium text-[var(--text-secondary)] mb-1.5 block';

  return (
    <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors w-fit">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
        </svg>
        تغيير الطريقة
      </button>

      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 flex items-start gap-2">
        <Building2 className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-300 leading-relaxed">
          يتطلب هذا الخيار حساب <strong>Meta Business</strong> مع تفعيل WhatsApp Cloud API.
          <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
            target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-blue-400 hover:underline mr-1">
            دليل البدء <ExternalLink className="w-3 h-3" />
          </a>
        </p>
      </div>

      <div>
        <label className={labelClass}><Phone className="inline w-3 h-3 ml-1" />Phone Number ID</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="1234567890123456"
          value={form.phone_number_id} onChange={e => handleChange('phone_number_id', e.target.value)} />
      </div>
      <div>
        <label className={labelClass}><Building2 className="inline w-3 h-3 ml-1" />Business Account ID (WABA ID)</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="1234567890123456"
          value={form.business_account_id} onChange={e => handleChange('business_account_id', e.target.value)} />
      </div>
      <div>
        <label className={labelClass}><Key className="inline w-3 h-3 ml-1" />Access Token</label>
        <div className="relative">
          <input dir="ltr" type={showToken ? 'text' : 'password'} className={cn(inputClass, 'pr-10')}
            placeholder={saved ? '••••••••••••••••••••• (محفوظ)' : 'EAAxxxxxxxxxx...'}
            value={form.access_token} onChange={e => handleChange('access_token', e.target.value)} />
          <button onClick={() => setShowToken(!showToken)}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {saved && <p className="text-xs text-green-400/80 mt-1">✓ Token محفوظ ومشفّر.</p>}
      </div>
      <div>
        <label className={labelClass}><ShieldCheck className="inline w-3 h-3 ml-1" />Verify Token (لـ Webhook)</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="my_secure_verify_token_123"
          value={form.verify_token} onChange={e => handleChange('verify_token', e.target.value)} />
      </div>
      {webhookInfo && (
        <div>
          <label className={labelClass}><Globe className="inline w-3 h-3 ml-1" />Webhook URL (للنسخ في Meta)</label>
          <div className="flex gap-2">
            <input dir="ltr" type="text" readOnly className={cn(inputClass, 'bg-[var(--bg-app)] text-[var(--text-muted)] cursor-default flex-1')}
              value={webhookInfo} />
            <button onClick={() => { navigator.clipboard.writeText(webhookInfo); showToast({ title: 'تم النسخ', type: 'success' }); }}
              className="px-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
              <Copy className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      {testResult && (
        <div className={cn('rounded-xl p-3 border text-sm flex items-start gap-2',
          testResult.success ? 'bg-green-500/10 border-green-500/20 text-green-300' : 'bg-red-500/10 border-red-500/20 text-red-300')}>
          {testResult.success ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <div>
            {testResult.success ? (
              <>
                <p className="font-medium">اتصال ناجح ✓</p>
                {testResult.phone_number && <p className="text-xs mt-0.5">الرقم: {testResult.phone_number}</p>}
              </>
            ) : <p>{testResult.error}</p>}
          </div>
        </div>
      )}
      <div className="flex gap-2 pt-1 sticky bottom-0 bg-[var(--bg-surface)] pb-1">
        <Button onClick={handleSave} disabled={loading} className="flex-1 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {loading ? 'جارٍ الحفظ...' : 'حفظ الإعدادات'}
        </Button>
        <Button onClick={handleTest} disabled={testing || !saved} variant="outline" className="gap-2 border-[var(--border-strong)]">
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
          {testing ? 'اختبار...' : 'اختبار'}
        </Button>
      </div>
    </div>
  );
}
