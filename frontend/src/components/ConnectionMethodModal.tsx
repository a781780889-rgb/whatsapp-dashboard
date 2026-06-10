import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  QrCode, Hash, Building2, X, CheckCircle2, Loader2, Copy,
  Smartphone, Wifi, AlertCircle, RefreshCw, ExternalLink,
  Phone, Key, Globe, ShieldCheck, Send, TestTube2, Eye, EyeOff
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { QRCodeSVG } from 'qrcode.react';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = API.replace('/api/v1', '');

// ── أكواد الدول ──────────────────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════
//  نافذة اختيار طريقة الربط الرئيسية
// ═══════════════════════════════════════════════════════════════════
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
  accountId, accountName, open, onClose, onConnected, showToast
}: ConnectionMethodModalProps) {
  const [method, setMethod] = useState<Method>('select');

  // أعد التهيئة عند الفتح
  useEffect(() => {
    if (open) setMethod('select');
  }, [open]);

  const handleClose = () => {
    setMethod('select');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={cn(
        'max-w-xl w-full p-0 overflow-hidden',
        'bg-[var(--bg-surface)] border border-[var(--border-default)]'
      )}>
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex items-center gap-2 text-[var(--text-primary)] text-lg">
            <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary-light)] flex items-center justify-center">
              <Wifi className="w-4 h-4 text-[var(--brand-primary)]" />
            </div>
            ربط الحساب — {accountName}
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-6 pt-4">
          {method === 'select' && (
            <MethodSelector onSelect={setMethod} />
          )}
          {method === 'qr' && (
            <QRCodeMethod
              accountId={accountId}
              onBack={() => setMethod('select')}
              onConnected={() => { handleClose(); onConnected(); }}
              showToast={showToast}
            />
          )}
          {method === 'pairing' && (
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

// ═══════════════════════════════════════════════════════════════════
//  اختيار الطريقة (3 بطاقات)
// ═══════════════════════════════════════════════════════════════════
function MethodSelector({ onSelect }: { onSelect: (m: Method) => void }) {
  const methods = [
    {
      id: 'qr' as Method,
      icon: QrCode,
      color: 'text-[var(--brand-primary)]',
      bg: 'bg-[var(--brand-primary-light)] border-[var(--brand-primary)]/30',
      title: 'رمز QR Code',
      desc: 'افتح واتساب → الأجهزة المرتبطة → مسح الرمز',
      badge: 'الأسرع',
      badgeColor: 'bg-green-500/15 text-green-400',
    },
    {
      id: 'pairing' as Method,
      icon: Hash,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10 border-blue-500/30',
      title: 'Pairing Code',
      desc: 'أدخل رقم هاتفك واحصل على رمز مكوّن من 8 أرقام',
      badge: 'بدون مسح',
      badgeColor: 'bg-blue-500/15 text-blue-400',
    },
    {
      id: 'business_api' as Method,
      icon: Building2,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10 border-purple-500/30',
      title: 'WhatsApp Business API',
      desc: 'اربط عبر Cloud API الرسمي لـ Meta Business',
      badge: 'للأعمال',
      badgeColor: 'bg-purple-500/15 text-purple-400',
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-muted)] mb-1">اختر طريقة ربط الحساب:</p>
      {methods.map(m => (
        <button
          key={m.id}
          onClick={() => onSelect(m.id)}
          className={cn(
            'flex items-center gap-4 p-4 rounded-xl border text-right',
            'transition-all duration-150 hover:scale-[1.01] hover:shadow-lg',
            'bg-[var(--bg-elevated)] border-[var(--border-default)]',
            'hover:border-[var(--border-strong)] hover:bg-[var(--bg-overlay)]',
            'group w-full'
          )}
        >
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

// ═══════════════════════════════════════════════════════════════════
//  QR Code Method
// ═══════════════════════════════════════════════════════════════════
function QRCodeMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [qr, setQr]             = useState<string | null>(null);
  const [status, setStatus]     = useState<'waiting' | 'connecting' | 'connected'>('connecting');
  const [expired, setExpired]   = useState(false);
  const socketRef               = useRef<Socket | null>(null);
  const timerRef                = useRef<any>(null);

  const startSession = useCallback(async () => {
    setQr(null);
    setExpired(false);
    setStatus('connecting');
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }

    try {
      await authFetch(`${API}/accounts/${accountId}/connect`, { method: 'POST' });
      const socket = io(SOCKET_URL, { transports: ['websocket'] });
      socketRef.current = socket;
      socket.emit('join_account', accountId);

      socket.on('qr_code', ({ qr: code }: any) => {
        setQr(code);
        setStatus('waiting');
        setExpired(false);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setExpired(true), 58_000);
      });
      socket.on('session_cleared', () => { setQr(null); setStatus('connecting'); });
      socket.on('account_status', ({ status: s }: any) => {
        if (s === 'connected') {
          setStatus('connected');
          socket.disconnect();
          socketRef.current = null;
          setTimeout(() => { showToast({ title: 'متصل ✓', description: 'تم ربط الحساب بنجاح', type: 'success' }); onConnected(); }, 1000);
        }
      });
    } catch {
      showToast({ title: 'خطأ', description: 'فشل طلب الاتصال', type: 'error' });
    }
  }, [accountId]);

  useEffect(() => {
    startSession();
    return () => {
      if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [startSession]);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
          تغيير الطريقة
        </button>
        <div className="flex items-center gap-2">
          <span className={cn(
            'w-2 h-2 rounded-full',
            status === 'connected' ? 'bg-green-500' : status === 'waiting' ? 'bg-yellow-400 animate-pulse' : 'bg-gray-500 animate-pulse'
          )} />
          <span className="text-xs text-[var(--text-muted)]">
            {status === 'connected' ? 'متصل' : status === 'waiting' ? 'انتظار المسح' : 'جارٍ التحميل'}
          </span>
        </div>
      </div>

      {/* QR Area */}
      <div className={cn(
        'relative w-56 h-56 rounded-2xl flex items-center justify-center',
        'bg-white border-4 border-[var(--bg-elevated)]',
        expired && 'opacity-40'
      )}>
        {qr && !expired ? (
          <QRCodeSVG value={qr} size={200} bgColor="#ffffff" fgColor="#000000" level="M" />
        ) : status === 'connecting' ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-10 h-10 text-[var(--brand-primary)] animate-spin" />
            <span className="text-xs text-gray-500">جارٍ التحميل...</span>
          </div>
        ) : expired ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/60">
            <AlertCircle className="w-8 h-8 text-orange-400 mb-1" />
            <span className="text-white text-sm font-medium">انتهت الصلاحية</span>
          </div>
        ) : (
          <Loader2 className="w-10 h-10 text-[var(--brand-primary)] animate-spin" />
        )}
        {status === 'connected' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-green-500/90">
            <CheckCircle2 className="w-12 h-12 text-white" />
            <span className="text-white font-bold mt-1">متصل ✓</span>
          </div>
        )}
      </div>

      {expired && (
        <Button onClick={startSession} size="sm" className="bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> تحديث الرمز
        </Button>
      )}

      <div className="text-center text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
        <p className="font-medium text-[var(--text-secondary)] mb-1">خطوات الربط:</p>
        <p>1. افتح <strong className="text-[var(--text-primary)]">واتساب</strong> → الإعدادات</p>
        <p>2. اختر <strong className="text-[var(--text-primary)]">الأجهزة المرتبطة</strong></p>
        <p>3. اضغط <strong className="text-[var(--text-primary)]">ربط جهاز</strong> ثم امسح الرمز</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Pairing Code Method
// ═══════════════════════════════════════════════════════════════════
function PairingCodeMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [countryCode, setCountryCode] = useState('966');
  const [phoneLocal, setPhoneLocal]   = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [status, setStatus]           = useState<'idle' | 'waiting' | 'connected'>('idle');
  const [copied, setCopied]           = useState(false);
  const socketRef                     = useRef<Socket | null>(null);

  useEffect(() => () => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
  }, []);

  const handleRequestCode = async () => {
    const digits = phoneLocal.replace(/\D/g, '');
    if (digits.length < 7) {
      showToast({ title: 'خطأ', description: 'أدخل رقم الهاتف بدون رمز الدولة', type: 'error' });
      return;
    }
    const fullPhone = countryCode + digits;

    setLoading(true);
    setPairingCode(null);

    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/connect-pairing`, {
        method: 'POST',
        body:   JSON.stringify({ phone_number: fullPhone }),
      });
      const data = await res.json();

      if (!data.success) {
        showToast({ title: 'خطأ', description: data.error, type: 'error' });
        setLoading(false);
        return;
      }

      // الاستماع لـ Pairing Code عبر Socket.IO
      if (socketRef.current) { socketRef.current.disconnect(); }
      const socket = io(SOCKET_URL, { transports: ['websocket'] });
      socketRef.current = socket;
      socket.emit('join_account', accountId);

      socket.on('pairing_code', ({ code }: any) => {
        setPairingCode(code);
        setStatus('waiting');
        setLoading(false);
      });
      socket.on('pairing_error', ({ error }: any) => {
        showToast({ title: 'خطأ', description: error, type: 'error' });
        setLoading(false);
      });
      socket.on('account_status', ({ status: s }: any) => {
        if (s === 'connected') {
          setStatus('connected');
          socket.disconnect();
          setTimeout(() => { showToast({ title: 'متصل ✓', description: 'تم الربط بنجاح', type: 'success' }); onConnected(); }, 1200);
        }
      });

    } catch {
      showToast({ title: 'خطأ', description: 'فشل إنشاء Pairing Code', type: 'error' });
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.replace(/-/g, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors w-fit">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
        تغيير الطريقة
      </button>

      {status !== 'connected' && (
        <>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-2 block">رقم الهاتف المرتبط بواتساب</label>
            <div className="flex gap-2">
              {/* Country code selector */}
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                className={cn(
                  'flex-shrink-0 w-36 px-3 py-2.5 text-sm rounded-lg',
                  'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
                  'text-[var(--text-primary)] outline-none',
                  'focus:border-[var(--brand-primary)] transition-colors'
                )}
                dir="ltr"
              >
                {COUNTRY_CODES.map(c => (
                  <option key={c.code} value={c.code}>
                    {c.flag} +{c.code} {c.name}
                  </option>
                ))}
              </select>
              {/* Phone input */}
              <input
                type="tel"
                placeholder="5XXXXXXXX"
                value={phoneLocal}
                onChange={e => setPhoneLocal(e.target.value)}
                dir="ltr"
                className={cn(
                  'flex-1 px-3 py-2.5 text-sm rounded-lg',
                  'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
                  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                  'outline-none focus:border-[var(--brand-primary)] transition-colors'
                )}
              />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1.5">
              الرقم الكامل: <span dir="ltr" className="font-mono text-[var(--text-secondary)]">+{countryCode}{phoneLocal.replace(/\D/g, '')}</span>
            </p>
          </div>

          <Button
            onClick={handleRequestCode}
            disabled={loading || phoneLocal.replace(/\D/g, '').length < 7}
            className="w-full bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Hash className="w-4 h-4" />}
            {loading ? 'جارٍ إنشاء الرمز...' : 'إنشاء Pairing Code'}
          </Button>
        </>
      )}

      {/* عرض الكود */}
      {pairingCode && status !== 'connected' && (
        <div className="bg-[var(--bg-elevated)] border border-[var(--brand-primary)]/30 rounded-xl p-5 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[var(--brand-primary)]">
            <Hash className="w-4 h-4" />
            <span className="text-sm font-medium">رمز الإقران</span>
          </div>
          <div dir="ltr" className="text-4xl font-bold tracking-[0.3em] text-[var(--text-primary)] font-mono select-all">
            {pairingCode}
          </div>
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

      {status === 'connected' && (
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

// ═══════════════════════════════════════════════════════════════════
//  WhatsApp Business API Method
// ═══════════════════════════════════════════════════════════════════
function BusinessAPIMethod({ accountId, onBack, onConnected, showToast }: any) {
  const [form, setForm] = useState({
    phone_number_id: '',
    business_account_id: '',
    access_token: '',
    verify_token: '',
    webhook_url: '',
  });
  const [showToken, setShowToken]   = useState(false);
  const [loading, setLoading]       = useState(false);
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [saved, setSaved]           = useState(false);
  const [webhookInfo, setWebhookInfo] = useState('');

  // جلب الإعدادات الموجودة
  useEffect(() => {
    (async () => {
      try {
        const r = await authFetch(`${API}/accounts/${accountId}/business-api`);
        const d = await r.json();
        if (d.success && d.settings) {
          setForm(prev => ({
            ...prev,
            phone_number_id:    d.settings.phone_number_id || '',
            business_account_id: d.settings.business_account_id || '',
            verify_token:       d.settings.verify_token || '',
            webhook_url:        d.settings.webhook_url || '',
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
      const res  = await authFetch(`${API}/accounts/${accountId}/business-api`, {
        method: 'POST',
        body:   JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        showToast({ title: 'تم الحفظ ✓', description: data.message, type: 'success' });
        setWebhookInfo(data.webhook_url || '');
        setSaved(true);
        setForm(prev => ({ ...prev, access_token: '' })); // مسح Token بعد الحفظ
      } else {
        showToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch {
      showToast({ title: 'خطأ', description: 'فشل الحفظ', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/business-api/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(data);
      if (data.success) {
        showToast({ title: 'اتصال ناجح ✓', description: data.message, type: 'success' });
        onConnected();
      } else {
        showToast({ title: 'فشل الاختبار', description: data.error, type: 'error' });
      }
    } catch {
      showToast({ title: 'خطأ', description: 'فشل اختبار الاتصال', type: 'error' });
    } finally {
      setTesting(false);
    }
  };

  const inputClass = cn(
    'w-full px-3 py-2.5 text-sm rounded-lg',
    'bg-[var(--bg-elevated)] border border-[var(--border-strong)]',
    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
    'outline-none focus:border-[var(--brand-primary)] transition-colors'
  );
  const labelClass = 'text-xs font-medium text-[var(--text-secondary)] mb-1.5 block';

  return (
    <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors w-fit">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
        تغيير الطريقة
      </button>

      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 flex items-start gap-2">
        <Building2 className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-300 leading-relaxed">
          يتطلب هذا الخيار حساب <strong>Meta Business</strong> مع تفعيل WhatsApp Cloud API.
          <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-400 hover:underline mr-1">
            دليل البدء <ExternalLink className="w-3 h-3" />
          </a>
        </p>
      </div>

      {/* Phone Number ID */}
      <div>
        <label className={labelClass}><Phone className="inline w-3 h-3 ml-1" />Phone Number ID</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="1234567890123456"
          value={form.phone_number_id} onChange={e => handleChange('phone_number_id', e.target.value)} />
      </div>

      {/* Business Account ID */}
      <div>
        <label className={labelClass}><Building2 className="inline w-3 h-3 ml-1" />Business Account ID (WABA ID)</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="1234567890123456"
          value={form.business_account_id} onChange={e => handleChange('business_account_id', e.target.value)} />
      </div>

      {/* Access Token */}
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
        {saved && <p className="text-xs text-green-400/80 mt-1">✓ Token محفوظ ومشفّر. أدخل قيمة جديدة لتحديثه فقط.</p>}
      </div>

      {/* Verify Token */}
      <div>
        <label className={labelClass}><ShieldCheck className="inline w-3 h-3 ml-1" />Verify Token (لـ Webhook)</label>
        <input dir="ltr" type="text" className={inputClass} placeholder="my_secure_verify_token_123"
          value={form.verify_token} onChange={e => handleChange('verify_token', e.target.value)} />
        <p className="text-xs text-[var(--text-muted)] mt-1">رمز سري تختاره أنت للتحقق من صحة Webhook</p>
      </div>

      {/* Webhook URL (auto-generated) */}
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

      {/* نتيجة الاختبار */}
      {testResult && (
        <div className={cn(
          'rounded-xl p-3 border text-sm flex items-start gap-2',
          testResult.success
            ? 'bg-green-500/10 border-green-500/20 text-green-300'
            : 'bg-red-500/10 border-red-500/20 text-red-300'
        )}>
          {testResult.success
            ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
            : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <div>
            {testResult.success ? (
              <>
                <p className="font-medium">اتصال ناجح ✓</p>
                {testResult.phone_number && <p className="text-xs mt-0.5">الرقم: {testResult.phone_number}</p>}
                {testResult.verified_name && <p className="text-xs">الاسم: {testResult.verified_name}</p>}
              </>
            ) : (
              <p>{testResult.error}</p>
            )}
          </div>
        </div>
      )}

      {/* أزرار الحفظ والاختبار */}
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
