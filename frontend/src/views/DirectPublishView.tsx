import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import {
  Smartphone, Send, Search, Users, RefreshCw, Clock, AlertTriangle,
  CheckCircle2, XCircle, Play, Pause, Square, BookOpen, MessageSquare,
  UserX, ChevronRight, ChevronLeft, Zap, Activity, BarChart2,
  Timer, TrendingUp, Hash, Wifi, WifiOff, Image, X, Info,
  Radio, CheckCheck,
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

// ════════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════════
interface Account {
  id: string; name: string; phone_number?: string;
  status?: string; jid?: string; is_ready?: boolean;
}

interface Group {
  group_jid: string; name: string;
  members_count?: number; publish_status?: 'green' | 'yellow' | 'red';
  accountId?: string;
}

interface Ad {
  id: string; name: string; content: string;
  is_active: boolean; media_paths?: string[] | string;
}

interface LogEntry {
  id: string; timestamp: number;
  level: 'info' | 'success' | 'error' | 'warning';
  message: string; details?: string | null;
}

interface LiveProgress {
  sessionId: string;
  status: 'running' | 'paused' | 'stopped' | 'complete' | 'error';
  totalGroups: number; completedGroups: number;
  totalMessages: number; sentMessages: number; failedMessages: number;
  totalMembers: number; sentMembers: number; failedMembers: number;
  eligibleMembers: number; excludedAdmins: number; excludedNonSaudi: number;
  errorCount: number; percentComplete: number;
  speed: number; startTime: number; elapsedMs: number; etaMs: number | null;
  currentAccountId: string | null; currentAccountName: string | null;
  currentGroupJid: string | null; currentGroupName: string | null;
  currentAdName: string | null;
}

// ════════════════════════════════════════════════════════════
//  Constants & Helpers
// ════════════════════════════════════════════════════════════
const SOCKET_URL = (() => {
  try { return new URL(API).origin; } catch { return ''; }
})();

// [إصلاح استمرارية اللوحة] مفتاح تخزين محلي لحفظ sessionId الجاري حالياً،
// حتى تُعاد قراءته فور فتح الصفحة من جديد (خروج/دخول، تحديث المتصفح، تبديل
// تبويب) بدل فقدانه بمجرد إعادة تركيب الكومبوننت.
const LIVE_SESSION_KEY = 'live_publish_active_session_id';

const STEPS = [
  { id: 1, label: 'الحسابات',  icon: Smartphone },
  { id: 2, label: 'المجموعات', icon: Users },
  { id: 3, label: 'الإرسال',   icon: Send },
  { id: 4, label: 'الإعلانات', icon: BookOpen },
  { id: 5, label: 'التوقيت',   icon: Timer },
];

function normalizeGroup(raw: any): Group {
  return {
    group_jid:     raw.group_jid || raw.id || '',
    name:          raw.name || 'مجموعة',
    members_count: raw.members_count ?? raw.participants_count ?? 0,
    publish_status: raw.publish_status || 'green',
  };
}

// [إصلاح تزامن النشر المباشر] دمج سجلات قادمة من مصدرين (Socket.IO والبولينج
// الاحتياطي) بدون تكرار، معتمدين على id الفريد لكل سجل، ومرتّبة زمنياً.
function mergeLogs(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const map = new Map<string, LogEntry>();
  for (const l of prev) map.set(l.id, l);
  for (const l of incoming) map.set(l.id, l);
  return Array.from(map.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-500);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '٠:٠٠';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusColor(ps?: string) {
  if (ps === 'red') return 'bg-red-500/10 text-red-400 border-red-500/20';
  if (ps === 'yellow') return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20';
  return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
}

function statusLabel(ps?: string) {
  if (ps === 'red') return 'محظورة';
  if (ps === 'yellow') return 'مقيدة';
  return 'نشطة';
}

// ════════════════════════════════════════════════════════════
//  Sub-components
// ════════════════════════════════════════════════════════════

// ── Step Indicator ──────────────────────────────────────────
function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-6 select-none">
      {STEPS.map((step, idx) => {
        const done    = step.id < current;
        const active  = step.id === current;
        const Icon    = step.icon;
        return (
          <React.Fragment key={step.id}>
            <div className="flex flex-col items-center gap-1.5">
              <div className={cn(
                'w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all duration-300',
                done   ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]'
                       : active ? 'bg-[var(--brand-primary)]/15 border-[var(--brand-primary)]'
                                : 'bg-[var(--bg-elevated)] border-[var(--border-strong)]'
              )}>
                {done
                  ? <CheckCircle2 className="w-4 h-4 text-white" />
                  : <Icon className={cn('w-4 h-4', active ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]')} />
                }
              </div>
              <span className={cn(
                'text-[10px] font-medium transition-colors whitespace-nowrap',
                active ? 'text-[var(--brand-primary)]' : done ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
              )}>{step.label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={cn(
                'h-0.5 w-10 mb-4 mx-1 rounded-full transition-all duration-300',
                step.id < current ? 'bg-[var(--brand-primary)]' : 'bg-[var(--border-strong)]'
              )} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Stat Card ───────────────────────────────────────────────
function StatCard({
  label, value, sub, icon: Icon, color = 'text-[var(--text-primary)]', bg = 'bg-[var(--bg-elevated)]',
}: { label: string; value: string | number; sub?: string; icon: any; color?: string; bg?: string }) {
  return (
    <div className={cn('rounded-xl p-3 border border-[var(--border-default)]', bg)}>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className={cn('w-3.5 h-3.5', color)} />
        <span className="text-[10px] text-[var(--text-muted)] font-medium">{label}</span>
      </div>
      <p className={cn('text-xl font-bold', color)}>{value}</p>
      {sub && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Log Row ─────────────────────────────────────────────────
function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const cfg = {
    success: { icon: CheckCircle2, cls: 'text-emerald-400' },
    error:   { icon: XCircle,      cls: 'text-red-400' },
    warning: { icon: AlertTriangle, cls: 'text-yellow-400' },
    info:    { icon: Info,          cls: 'text-blue-400' },
  }[entry.level] ?? { icon: Info, cls: 'text-[var(--text-muted)]' };
  const CfgIcon = cfg.icon;

  return (
    <div
      className={cn(
        'flex gap-2 px-3 py-1.5 rounded-lg text-xs hover:bg-[var(--bg-elevated)] cursor-default transition-colors',
        entry.details && 'cursor-pointer'
      )}
      onClick={() => entry.details && setOpen(o => !o)}
    >
      <CfgIcon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', cfg.cls)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)] shrink-0">{formatTime(entry.timestamp)}</span>
          <span className="text-[var(--text-primary)] truncate">{entry.message}</span>
        </div>
        {open && entry.details && (
          <p className="mt-1 text-[var(--text-muted)] break-all text-[10px] pr-1 border-r-2 border-red-500/30">
            {entry.details}
          </p>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
//  Main component
// ════════════════════════════════════════════════════════════
export default function DirectPublishView({
  accountId, accounts,
}: { accountId: string | null; accounts: Account[] }) {

  // ── Wizard ──────────────────────────────────────────────────
  const [step, setStep]               = useState(1);
  const [selAccounts, setSelAccounts] = useState<string[]>(() => accountId ? [accountId] : []);
  const [groups,      setGroups]      = useState<Group[]>([]);
  const [grpLoading,  setGrpLoading]  = useState(false);
  const [selGroups,   setSelGroups]   = useState<Set<string>>(new Set());
  const [grpSearch,   setGrpSearch]   = useState('');
  const [grpFilter,   setGrpFilter]   = useState<'all'|'green'|'yellow'|'red'>('all');
  const [syncing,     setSyncing]     = useState(false);

  const [sendMode,     setSendMode]     = useState<'groups'|'both'>('groups'); // groups | both
  const [excludeAdmins, setExcludeAdmins] = useState(true);

  const [ads,       setAds]       = useState<Ad[]>([]);
  const [adsLoading, setAdsLoading] = useState(false);
  const [selAds,    setSelAds]    = useState<string[]>([]);
  const [adSearch,  setAdSearch]  = useState('');
  const [useLib,    setUseLib]    = useState(true);   // true = مكتبة | false = نص مخصص
  const [customTxt, setCustomTxt] = useState('');

  const [groupDelay,  setGroupDelay]  = useState(2);
  const [memberDelay, setMemberDelay] = useState(2);
  const [adDelay,     setAdDelay]     = useState(3);
  const [delayUnit,   setDelayUnit]   = useState<'sec'|'min'>('sec');

  // ── Live session ────────────────────────────────────────────
  // [إصلاح استمرارية اللوحة] القيمة الابتدائية تُقرأ من localStorage مباشرة
  // بدل idle/null دائماً — بهذا لا تُغلق اللوحة بمجرد إعادة تركيب الكومبوننت
  // (خروج من الصفحة والعودة إليها)، وتبدأ بعرض "جارٍ التحقق" ريثما يتأكد
  // useEffect أدناه من حالة الجلسة الحقيقية من الخادم.
  const [sessionId,   setSessionId]   = useState<string|null>(() => {
    try { return localStorage.getItem(LIVE_SESSION_KEY); } catch { return null; }
  });
  const [liveStatus,  setLiveStatus]  = useState<'idle'|'running'|'paused'|'stopped'|'complete'|'error'>(() => {
    try { return localStorage.getItem(LIVE_SESSION_KEY) ? 'running' : 'idle'; } catch { return 'idle'; }
  });
  const [liveProgress, setLiveProgress] = useState<LiveProgress|null>(null);
  const [liveLogs,    setLiveLogs]    = useState<LogEntry[]>([]);
  const [starting,    setStarting]    = useState(false);
  const [ctrlLoading, setCtrlLoading] = useState(false);
  const socketRef = useRef<Socket|null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // ── [إصلاح استمرارية اللوحة] عند فتح الصفحة: تحقّق من وجود جلسة نشطة فعلياً
  // على الخادم. حالتان:
  //  1) لدينا sessionId محفوظ محلياً → نجلب حالتها مباشرة عبر status endpoint
  //     (تعبئة فورية لكل الأرقام بدل انتظار أول حدث Socket.IO القادم).
  //  2) لا يوجد شيء محفوظ محلياً (متصفح/جهاز آخر، أو localStorage مُسح) →
  //     نسأل الخادم صراحة عبر /live-publish/active إن كانت هناك جلسة جارية
  //     مرتبطة بأي من حسابات المستخدم الحالية، ونلتحق بها تلقائياً.
  useEffect(() => {
    let cancelled = false;

    async function reconnectToActiveSession() {
      const savedId = (() => { try { return localStorage.getItem(LIVE_SESSION_KEY); } catch { return null; } })();

      if (savedId) {
        try {
          const res  = await authFetch(`${API}/live-publish/${savedId}/status`);
          const data = await res.json();
          if (cancelled) return;
          if (data.success && (data.status === 'running' || data.status === 'paused')) {
            setSessionId(savedId);
            setLiveStatus(data.status);
            setLiveProgress(data as any);
            setLiveLogs(data.logs || []);
            return;
          }
          // الجلسة المحفوظة لم تعد قائمة (اكتملت/حُذفت) — تنظيف
          try { localStorage.removeItem(LIVE_SESSION_KEY); } catch {}
          setSessionId(null); setLiveStatus('idle');
        } catch { /* سنحاول البحث عبر active أدناه كخط دفاع ثانٍ */ }
      }

      // لا يوجد sessionId محفوظ (أو تعذّر التحقق منه) — نسأل الخادم مباشرة
      const accIds = accountId ? [accountId] : accounts.map(a => a.id);
      if (!accIds.length) return;
      try {
        const res  = await authFetch(`${API}/live-publish/active?account_ids=${accIds.join(',')}`);
        const data = await res.json();
        if (cancelled || !data.success || !data.session) return;
        const s = data.session;
        setSessionId(s.sessionId);
        setLiveStatus(s.status);
        setLiveProgress(s as any);
        setLiveLogs(s.logs || []);
        try { localStorage.setItem(LIVE_SESSION_KEY, s.sessionId); } catch {}
      } catch { /* لا توجد جلسة نشطة — الوضع الطبيعي */ }
    }

    reconnectToActiveSession();
    return () => { cancelled = true; };
    // يُنفَّذ مرة واحدة فقط عند تركيب الكومبوننت (فتح الصفحة)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll log ─────────────────────────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveLogs.length]);

  // ── Load groups for selected accounts ───────────────────────
  const loadGroups = useCallback(async (force = false) => {
    if (!selAccounts.length) { setGroups([]); return; }
    force ? setSyncing(true) : setGrpLoading(true);
    try {
      const results = await Promise.all(
        selAccounts.map(id =>
          authFetch(`${API}/accounts/${id}/groups?limit=500${force ? '&refresh=1' : ''}`)
            .then(r => r.json())
            .then(d => d.success ? (d.groups || []).map((g: any) => ({ ...normalizeGroup(g), accountId: id })) : [])
            .catch(() => [])
        )
      );
      const merged = new Map<string, Group>();
      for (const arr of results) {
        for (const g of arr) {
          if (!merged.has(g.group_jid)) merged.set(g.group_jid, g);
        }
      }
      setGroups(Array.from(merged.values()));
    } finally {
      setGrpLoading(false); setSyncing(false);
    }
  }, [selAccounts]);

  useEffect(() => { loadGroups(); }, [selAccounts]); // eslint-disable-line

  // ── Load ads ────────────────────────────────────────────────
  const loadAds = useCallback(async () => {
    const accId = selAccounts[0] || accountId;
    if (!accId) return;
    setAdsLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accId}/ads`);
      const data = await res.json();
      if (data.success) setAds((data.ads || []).filter((a: Ad) => a.is_active));
    } finally { setAdsLoading(false); }
  }, [selAccounts, accountId]);

  useEffect(() => { loadAds(); }, [selAccounts]); // eslint-disable-line

  // ── Socket.IO ───────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const socket = io(SOCKET_URL || undefined, {
      transports: ['websocket', 'polling'], reconnection: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => socket.emit('join', `live_publish:${sessionId}`));

    // [إصلاح تزامن النشر المباشر] لقطة فورية يرسلها الخادم عند الانضمام
    // المتأخر لغرفة الجلسة — تُعبّئ التقدّم والسجل دفعة واحدة بدل انتظار
    // أحداث قد تكون انبعثت وضاعت قبل اكتمال الاتصال (جلسات سريعة الإنهاء).
    socket.on('live_publish:snapshot', (d: any) => {
      if (!d || d.sessionId !== sessionId) return;
      setLiveProgress(d as any);
      setLiveStatus(d.status);
      if (Array.isArray(d.logs) && d.logs.length) {
        setLiveLogs(prev => mergeLogs(prev, d.logs));
      }
    });

    socket.on('live_publish:progress', (d: LiveProgress) => {
      if (d.sessionId !== sessionId) return;
      setLiveProgress(d);
      setLiveStatus(d.status as any);
    });

    socket.on('live_publish:log', (entry: LogEntry & { sessionId: string }) => {
      if (entry.sessionId !== sessionId) return;
      setLiveLogs(prev => [...prev.slice(-499), entry]);
    });

    socket.on('live_publish:complete', (d: any) => {
      if (d.sessionId !== sessionId) return;
      setLiveStatus(d.status || 'complete');
      // [إصلاح استمرارية اللوحة] الجلسة انتهت فعلياً — لا داعٍ للاحتفاظ
      // بمعرّفها محلياً بعد الآن (تفادي محاولة استرجاع جلسة منتهية لاحقاً)
      try { localStorage.removeItem(LIVE_SESSION_KEY); } catch {}
    });

    return () => {
      socket.emit('leave', `live_publish:${sessionId}`);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId]);

  // ── [إصلاح استمرارية اللوحة] بولينج احتياطي (كل 5 ثوانٍ) بجانب Socket.IO ──
  // شبكات الموبايل قد تقطع اتصال الويب سوكيت مؤقتاً دون أن يُعاد الاتصال
  // فوراً؛ هذا البولينج يضمن بقاء الأرقام محدثة دائماً بغضّ النظر عن حالة
  // السوكيت، ويوقف نفسه تلقائياً بمجرد اكتمال/إيقاف الجلسة.
  useEffect(() => {
    if (!sessionId) return;
    if (liveStatus === 'complete' || liveStatus === 'stopped' || liveStatus === 'error') return;

    const fetchStatus = async () => {
      try {
        const res  = await authFetch(`${API}/live-publish/${sessionId}/status`);
        const data = await res.json();
        if (!data.success) return;
        setLiveProgress(data as any);
        setLiveStatus(data.status);
        // [إصلاح النشر المباشر] كانت data.logs تُجلب من الخادم هنا ثم تُهمَل
        // بالكامل — فلم يكن السجل المباشر ("النشاط الحالي" / سجل الأحداث)
        // يتعبّأ أبداً إن ضاعت أحداث Socket.IO (كما يحدث عند اكتمال جلسة
        // النشر خلال أجزاء من الثانية قبل أن يتصل السوكيت). الآن تُدمَج
        // فعلياً في liveLogs، فتظهر تفاصيل اللوحة أونلاين دائماً بغض النظر
        // عن حالة السوكيت.
        if (Array.isArray(data.logs) && data.logs.length) {
          setLiveLogs(prev => mergeLogs(prev, data.logs));
        }
      } catch { /* سيُعاد المحاولة في الدورة التالية */ }
    };

    // جلب فوري عند بدء/استئناف المتابعة بدل انتظار أول جولة بعد 5 ثوانٍ
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);

    return () => clearInterval(interval);
  }, [sessionId, liveStatus]);

  // ── Derived state ────────────────────────────────────────────
  const filteredGroups = useMemo(() =>
    groups.filter(g => {
      const ms = grpSearch.toLowerCase();
      return g.name.toLowerCase().includes(ms)
        && (grpFilter === 'all' || (g.publish_status || 'green') === grpFilter);
    }),
  [groups, grpSearch, grpFilter]);

  const filteredAds = useMemo(() =>
    ads.filter(a =>
      a.name.toLowerCase().includes(adSearch.toLowerCase()) ||
      (a.content || '').toLowerCase().includes(adSearch.toLowerCase())
    ),
  [ads, adSearch]);

  const delayMs = (v: number) => v * (delayUnit === 'min' ? 60_000 : 1_000);

  const canStart = useMemo(() => {
    if (!selAccounts.length || !selGroups.size) return false;
    if (useLib) return selAds.length > 0;
    return customTxt.trim().length > 0;
  }, [selAccounts, selGroups, useLib, selAds, customTxt]);

  // ── Actions ──────────────────────────────────────────────────
  const toggleAccount = (id: string) =>
    setSelAccounts(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const toggleGroup = (jid: string) =>
    setSelGroups(prev => { const n = new Set(prev); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });

  const toggleAd = (id: string) =>
    setSelAds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const body: any = {
        account_ids:       selAccounts,
        target_group_jids: Array.from(selGroups),
        send_to_members:   sendMode === 'both',
        exclude_admins:    excludeAdmins,
        member_delay_ms:   delayMs(memberDelay),
        group_delay_ms:    delayMs(groupDelay),
        ad_delay_ms:       delayMs(adDelay),
      };
      if (useLib && selAds.length) {
        body.ad_library_ids = selAds;
      } else {
        body.custom_content = customTxt;
      }

      const res  = await authFetch(`${API}/live-publish/start`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        setSessionId(data.sessionId);
        setLiveStatus('running');
        setLiveLogs([]);
        setLiveProgress(null);
        // [إصلاح استمرارية اللوحة] حفظ فوري — لو خرج المستخدم من الصفحة
        // مباشرة بعد الضغط على "بدء" نستطيع استرجاع الجلسة عند عودته
        try { localStorage.setItem(LIVE_SESSION_KEY, data.sessionId); } catch {}
      }
    } catch { /* ignore */ }
    setStarting(false);
  };

  const handleControl = async (action: 'pause'|'resume'|'stop') => {
    if (!sessionId) return;
    setCtrlLoading(true);
    try {
      await authFetch(`${API}/live-publish/${sessionId}/control`, {
        method: 'POST', body: JSON.stringify({ action }),
      });
    } catch { /* socket will update */ }
    setCtrlLoading(false);
  };

  const resetToWizard = () => {
    setSessionId(null); setLiveStatus('idle');
    setLiveProgress(null); setLiveLogs([]);
    setStep(1);
    // [إصلاح استمرارية اللوحة] تنظيف المفتاح المحلي — الجلسة انتهت فعلياً
    try { localStorage.removeItem(LIVE_SESSION_KEY); } catch {}
  };

  // ════════════════════════════════════════════════════════════
  //  RENDER: No account selected
  // ════════════════════════════════════════════════════════════
  if (!accounts.length) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-10 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-14 h-14 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">لا توجد حسابات</h3>
          <p className="text-sm text-[var(--text-secondary)]">أضف حساب واتساب نشط أولاً من صفحة الحسابات.</p>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  RENDER: Live Dashboard
  // ════════════════════════════════════════════════════════════
  if (liveStatus !== 'idle') {
    const p = liveProgress;
    const isRunning  = liveStatus === 'running';
    const isPaused   = liveStatus === 'paused';
    const isDone     = liveStatus === 'complete' || liveStatus === 'stopped' || liveStatus === 'error';
    const pct        = p?.percentComplete ?? 0;
    const remaining  = Math.max(0, (p?.totalMessages ?? 0) - (p?.sentMessages ?? 0) - (p?.failedMessages ?? 0));

    const statusCfg = {
      running:  { label: 'جارٍ النشر',      color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400 animate-pulse' },
      paused:   { label: 'متوقف مؤقتاً',    color: 'text-yellow-400',  bg: 'bg-yellow-500/10 border-yellow-500/30',  dot: 'bg-yellow-400' },
      stopped:  { label: 'تم الإيقاف',       color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/30',        dot: 'bg-red-400' },
      complete: { label: 'اكتملت العملية',   color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
      error:    { label: 'حدث خطأ',          color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/30',        dot: 'bg-red-400' },
      idle:     { label: '',                  color: '',                  bg: '',                                      dot: '' },
    }[liveStatus];

    return (
      <div className="flex flex-col gap-4 h-full">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Radio className="w-5 h-5 text-[var(--brand-primary)]" />
              لوحة النشر المباشر
            </h1>
            <p className="text-[var(--text-secondary)] text-sm mt-0.5">
              {selAccounts.length} حساب · {selGroups.size} مجموعة · {useLib ? selAds.length : 1} إعلان
            </p>
          </div>
          <div className={cn('flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium', statusCfg.bg, statusCfg.color)}>
            <span className={cn('w-2 h-2 rounded-full', statusCfg.dot)} />
            {statusCfg.label}
          </div>
        </div>

        {/* ── Progress bar ── */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--text-secondary)]">إجمالي التقدم</span>
            <span className="font-bold text-[var(--brand-primary)]">{pct}%</span>
          </div>
          <div className="relative h-3 rounded-full overflow-hidden bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <div
              className="absolute inset-y-0 right-0 rounded-full transition-all duration-500"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(to left, #00A884, #008f6e)',
                boxShadow: '0 0 12px rgba(0,168,132,0.4)',
              }}
            />
          </div>
        </div>

        {/* ── Stats grid ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-8 gap-2.5">
          <StatCard label="رسائل مُرسلة"   value={p?.sentMessages ?? 0}   icon={CheckCheck}   color="text-emerald-400" bg="bg-emerald-500/5" />
          <StatCard label="رسائل فاشلة"    value={p?.failedMessages ?? 0}  icon={XCircle}      color="text-red-400"     bg="bg-red-500/5" />
          <StatCard label="مجموعات مكتملة" value={`${p?.completedGroups ?? 0}/${p?.totalGroups ?? 0}`} icon={Users} color="text-blue-400" bg="bg-blue-500/5" />
          <StatCard label="أعضاء مُرسَل لهم" value={p?.sentMembers ?? 0}  icon={MessageSquare} color="text-purple-400"  bg="bg-purple-500/5" />
          <StatCard label="سرعة الإرسال"   value={`${p?.speed ?? 0}/د`}   icon={Zap}          color="text-yellow-400"  bg="bg-yellow-500/5" />
          <StatCard label="وقت منقضٍ"      value={formatDuration(p?.elapsedMs ?? 0)} icon={Timer}  color="text-[var(--text-secondary)]" />
          <StatCard label="متبقٍ"           value={remaining}              icon={Hash}          color="text-[var(--text-secondary)]" />
          <StatCard label="وقت انتهاء متوقع" value={p?.etaMs ? formatDuration(p.etaMs) : '—'} icon={TrendingUp} color="text-[var(--text-secondary)]" />
        </div>

        {/* ── فلتر السعودية + استثناء المشرفين — إحصائيات ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <StatCard label="أعضاء مؤهلون للإرسال" value={p?.eligibleMembers ?? 0}  icon={Users}   color="text-emerald-400" bg="bg-emerald-500/5" />
          <StatCard label="مشرفون مستثناة"      value={p?.excludedAdmins ?? 0}    icon={UserX}   color="text-orange-400"  bg="bg-orange-500/5" />
          <StatCard label="أرقام غير سعودية مستبعدة" value={p?.excludedNonSaudi ?? 0} icon={XCircle} color="text-red-400" bg="bg-red-500/5" />
        </div>

        {/* ── Current activity + Controls ── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 flex-1 min-h-0">

          {/* Activity panel */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            <Card className="card p-4 flex flex-col gap-3">
              <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2 pb-2 border-b border-[var(--border-default)]">
                <Activity className="w-4 h-4 text-[var(--brand-primary)]" /> النشاط الحالي
              </h3>

              {[
                { label: 'الحساب',   val: p?.currentAccountName, icon: Smartphone },
                { label: 'المجموعة', val: p?.currentGroupName,   icon: Users },
                { label: 'الإعلان',  val: p?.currentAdName,      icon: BookOpen },
              ].map(({ label, val, icon: Icon }) => (
                <div key={label} className="flex items-center gap-3 p-2.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                  <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-[var(--brand-primary)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{val || '—'}</p>
                  </div>
                </div>
              ))}

              {/* Error counter — [إصلاح النشر المباشر] نعرض الآن آخر خطأ فعلي
                  نصياً (من liveLogs) بدل رقم مجرّد، حتى يعرف المستخدم فوراً
                  سبب الخطأ (مثلاً: "الحساب لا يزال يتصل بواتساب") دون
                  الحاجة للبحث في السجل أسفل الصفحة. */}
              {(p?.errorCount ?? 0) > 0 && (() => {
                const lastError = [...liveLogs].reverse().find(l => l.level === 'error');
                return (
                  <div className="flex flex-col gap-1 p-2.5 rounded-xl bg-red-500/5 border border-red-500/20">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                      <span className="text-sm text-red-400 font-medium">{p!.errorCount} خطأ</span>
                    </div>
                    {lastError && (
                      <p className="text-xs text-red-400/80 pr-6 truncate" title={lastError.message}>
                        {lastError.message}
                      </p>
                    )}
                  </div>
                );
              })()}
            </Card>

            {/* Controls */}
            <Card className="card p-4 flex flex-col gap-2.5">
              <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2 pb-2 border-b border-[var(--border-default)]">
                <BarChart2 className="w-4 h-4 text-[var(--brand-primary)]" /> التحكم
              </h3>

              {!isDone && (
                <>
                  {isRunning && (
                    <Button
                      onClick={() => handleControl('pause')}
                      disabled={ctrlLoading}
                      className="w-full justify-center gap-2 h-10 bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/20"
                    >
                      <Pause className="w-4 h-4" /> إيقاف مؤقت
                    </Button>
                  )}
                  {isPaused && (
                    <Button
                      onClick={() => handleControl('resume')}
                      disabled={ctrlLoading}
                      className="w-full justify-center gap-2 h-10 bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border border-[var(--brand-primary)]/30 hover:bg-[var(--brand-primary)]/20"
                    >
                      <Play className="w-4 h-4" /> استئناف النشر
                    </Button>
                  )}
                  <Button
                    onClick={() => handleControl('stop')}
                    disabled={ctrlLoading}
                    className="w-full justify-center gap-2 h-10 bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20"
                  >
                    <Square className="w-4 h-4" /> إيقاف نهائي
                  </Button>
                </>
              )}

              {isDone && (
                <Button
                  onClick={resetToWizard}
                  className="w-full justify-center gap-2 h-10 bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)]"
                >
                  <RefreshCw className="w-4 h-4" /> نشر جديد
                </Button>
              )}

              {/* Summary when done */}
              {isDone && p && (
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--border-default)]">
                  <div className="text-center p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                    <p className="text-lg font-bold text-emerald-400">{p.sentMessages}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">مجموعات ✅</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-purple-500/5 border border-purple-500/20">
                    <p className="text-lg font-bold text-purple-400">{p.sentMembers}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">أعضاء ✅</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-red-500/5 border border-red-500/20">
                    <p className="text-lg font-bold text-red-400">{p.failedMessages + p.failedMembers}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">فشل ❌</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                    <p className="text-lg font-bold text-[var(--text-primary)]">{formatDuration(p.elapsedMs)}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">وقت منقضٍ</p>
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* Live log */}
          <Card className="card lg:col-span-3 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
              <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                السجل المباشر
              </h3>
              <div className="flex items-center gap-2">
                <Badge className="text-[10px] bg-[var(--bg-elevated)] text-[var(--text-muted)] border-0">
                  {liveLogs.length} حدث
                </Badge>
                {isRunning && <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)] animate-pulse" />}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
              {liveLogs.length === 0 && (
                <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
                  في انتظار بدء الأحداث…
                </div>
              )}
              {liveLogs.map(entry => <LogRow key={entry.id} entry={entry} />)}
              <div ref={logsEndRef} />
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  RENDER: Wizard
  // ════════════════════════════════════════════════════════════
  const connectedAccounts = accounts.filter(a => {
    const statusOnline = a.status === 'connected' || a.status === 'ready' || a.status === 'open';
    return a.is_ready !== undefined ? (statusOnline && a.is_ready) : statusOnline;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Send className="w-5 h-5 text-[var(--brand-primary)]" /> النشر المباشر
        </h1>
        <p className="text-[var(--text-secondary)] text-sm mt-0.5">أرسل إعلاناتك فوراً إلى مجموعاتك المحددة</p>
      </div>

      <Card className="card p-5">
        <StepIndicator current={step} />

        {/* ══ Step 1: Accounts ══════════════════════════════════ */}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-[var(--text-primary)]">اختيار الحسابات</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelAccounts(connectedAccounts.map(a => a.id))}
                  className="text-xs text-[var(--brand-primary)] hover:underline"
                >
                  تحديد الكل
                </button>
                <span className="text-[var(--border-strong)]">·</span>
                <button
                  onClick={() => setSelAccounts([])}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                  إلغاء الكل
                </button>
              </div>
            </div>

            {connectedAccounts.length === 0 ? (
              <div className="text-center py-10 text-[var(--text-muted)]">
                <WifiOff className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm">لا توجد حسابات متصلة</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {accounts.map(acc => {
                  const isSelected = selAccounts.includes(acc.id);
                  const statusOnline = acc.status === 'connected' || acc.status === 'ready' || acc.status === 'open';
                  // [إصلاح النشر المباشر] status='connected' بقاعدة البيانات لا يعني
                  // بالضرورة أن الحساب جاهز فعلياً للإرسال الآن — قد يكون لا يزال
                  // يعيد الاتصال بواتساب في الخلفية بعد إعادة تشغيل الخادم. عندما
                  // يتوفر is_ready من الخادم نعتمد عليه كمصدر حقيقة أدق؛ إن لم يتوفر
                  // (توافق عكسي) نرجع لحالة status وحدها.
                  const isOnline = acc.is_ready !== undefined ? (statusOnline && acc.is_ready) : statusOnline;
                  const isReconnecting = statusOnline && acc.is_ready === false;
                  return (
                    <div
                      key={acc.id}
                      onClick={() => isOnline && toggleAccount(acc.id)}
                      className={cn(
                        'relative rounded-xl border p-4 transition-all cursor-pointer select-none',
                        !isOnline && 'opacity-40 cursor-not-allowed',
                        isSelected
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/8 shadow-[0_0_0_1px_var(--brand-primary)]'
                          : 'border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                          isOnline ? 'bg-[var(--brand-primary)]/15' : 'bg-[var(--bg-surface)]'
                        )}>
                          <Smartphone className={cn('w-5 h-5', isOnline ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]')} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-[var(--text-primary)] truncate">{acc.name}</p>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{acc.phone_number || acc.jid || '—'}</p>
                          <div className={cn(
                            'mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border',
                            isOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : isReconnecting ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                              : 'bg-[var(--bg-surface)] text-[var(--text-muted)] border-[var(--border-default)]'
                          )}>
                            {isOnline ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
                            {isOnline ? 'متصل' : isReconnecting ? 'جارٍ إعادة الاتصال...' : 'غير متصل'}
                          </div>
                        </div>
                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-[var(--brand-primary)] flex items-center justify-center shrink-0">
                            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {selAccounts.length > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 text-sm text-[var(--brand-primary)]">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                تم اختيار <strong>{selAccounts.length}</strong> حساب
              </div>
            )}
          </div>
        )}

        {/* ══ Step 2: Groups ════════════════════════════════════ */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-[var(--text-primary)]">اختيار المجموعات</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => loadGroups(true)}
                  disabled={syncing}
                  className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"
                  title="مزامنة من واتساب"
                >
                  <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelGroups(new Set(filteredGroups.map(g => g.group_jid)))}
                    className="text-xs text-[var(--brand-primary)] hover:underline"
                  >
                    تحديد الكل
                  </button>
                  <span className="text-[var(--border-strong)]">·</span>
                  <button
                    onClick={() => setSelGroups(new Set())}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  >
                    إلغاء الكل
                  </button>
                </div>
              </div>
            </div>

            {/* Search + filter */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  className="input pr-9 bg-[var(--bg-elevated)] w-full"
                  placeholder="بحث في المجموعات..."
                  value={grpSearch}
                  onChange={e => setGrpSearch(e.target.value)}
                />
              </div>
              <div className="flex gap-1">
                {(['all','green','yellow','red'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setGrpFilter(f)}
                    className={cn(
                      'px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all',
                      grpFilter === f
                        ? f === 'all' ? 'bg-[var(--brand-primary)]/10 border-[var(--brand-primary)]/40 text-[var(--brand-primary)]'
                          : f === 'green' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : f === 'yellow' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
                          : 'bg-red-500/10 border-red-500/30 text-red-400'
                        : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
                    )}
                  >
                    {f === 'all' ? 'الكل' : f === 'green' ? 'نشطة' : f === 'yellow' ? 'مقيدة' : 'محظورة'}
                  </button>
                ))}
              </div>
            </div>

            {/* Groups list */}
            <div className="border border-[var(--border-default)] rounded-xl overflow-hidden" style={{ maxHeight: '360px', overflowY: 'auto' }}>
              {grpLoading && (
                <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2" /> تحميل المجموعات...
                </div>
              )}
              {!grpLoading && filteredGroups.length === 0 && (
                <div className="py-10 text-center text-[var(--text-muted)] text-sm">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  لا توجد مجموعات
                </div>
              )}
              {filteredGroups.map(g => {
                const isSelected = selGroups.has(g.group_jid);
                return (
                  <label
                    key={g.group_jid}
                    className={cn(
                      'flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 cursor-pointer transition-colors',
                      isSelected ? 'bg-[var(--brand-primary)]/5' : 'hover:bg-[var(--bg-elevated)]'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleGroup(g.group_jid)}
                      className="w-4 h-4 rounded accent-[var(--brand-primary)] shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">{g.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">{g.members_count ?? 0} عضو</p>
                    </div>
                    <span className={cn('text-[10px] px-2 py-0.5 rounded-full border shrink-0', statusColor(g.publish_status))}>
                      {statusLabel(g.publish_status)}
                    </span>
                  </label>
                );
              })}
            </div>

            {selGroups.size > 0 && (
              <div className="p-3 rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 text-sm text-[var(--brand-primary)] flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                تم اختيار <strong>{selGroups.size}</strong> مجموعة
              </div>
            )}
          </div>
        )}

        {/* ══ Step 3: Publish Method ════════════════════════════ */}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <h2 className="text-base font-bold text-[var(--text-primary)]">طريقة النشر</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Groups card */}
              <div className="rounded-xl border p-5 bg-blue-500/5 border-blue-500/30">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center shrink-0">
                    <Users className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-[var(--text-primary)] text-sm mb-1">النشر داخل المجموعات</p>
                    <p className="text-xs text-[var(--text-muted)] leading-relaxed">إرسال الإعلان مباشرةً لـ chat المجموعة — مفعّل دائماً</p>
                    <span className="mt-2 inline-flex items-center gap-1 text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full font-medium">
                      <CheckCircle2 className="w-2.5 h-2.5" /> مفعّل
                    </span>
                  </div>
                </div>
              </div>

              {/* DM card */}
              <div
                onClick={() => setSendMode(m => m === 'both' ? 'groups' : 'both')}
                className={cn(
                  'rounded-xl border p-5 cursor-pointer transition-all',
                  sendMode === 'both'
                    ? 'bg-[var(--brand-primary)]/8 border-[var(--brand-primary)] shadow-[0_0_0_1px_var(--brand-primary)]'
                    : 'bg-[var(--bg-elevated)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                    sendMode === 'both' ? 'bg-[var(--brand-primary)]/15' : 'bg-[var(--bg-surface)]'
                  )}>
                    <MessageSquare className={cn('w-5 h-5', sendMode === 'both' ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]')} />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-[var(--text-primary)] text-sm mb-1">إرسال خاص للأعضاء (DM)</p>
                    <p className="text-xs text-[var(--text-muted)] leading-relaxed">إرسال رسالة خاصة لكل عضو في المجموعات المحددة</p>
                    <div className={cn(
                      'mt-2 w-9 h-5 rounded-full relative transition-colors',
                      sendMode === 'both' ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]'
                    )}>
                      <div className={cn(
                        'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow',
                        sendMode === 'both' ? 'right-0.5' : 'left-0.5'
                      )} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* DM options */}
            {sendMode === 'both' && (
              <div
                onClick={() => setExcludeAdmins(e => !e)}
                className={cn(
                  'flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all',
                  excludeAdmins
                    ? 'bg-orange-500/5 border-orange-500/30'
                    : 'bg-[var(--bg-elevated)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', excludeAdmins ? 'bg-orange-500/15' : 'bg-[var(--bg-surface)]')}>
                    <UserX className={cn('w-4 h-4', excludeAdmins ? 'text-orange-400' : 'text-[var(--text-muted)]')} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">استبعاد المشرفين</p>
                    <p className="text-xs text-[var(--text-muted)]">لا يُرسَل للمشرفين عند الإرسال الخاص</p>
                  </div>
                </div>
                <div className={cn('w-9 h-5 rounded-full relative transition-colors', excludeAdmins ? 'bg-orange-500' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                  <div className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow', excludeAdmins ? 'right-0.5' : 'left-0.5')} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-center text-sm p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <div>
                <p className="text-[var(--text-muted)] text-xs mb-1">المجموعات المختارة</p>
                <p className="font-bold text-[var(--text-primary)]">{selGroups.size}</p>
              </div>
              <div>
                <p className="text-[var(--text-muted)] text-xs mb-1">وضع الإرسال</p>
                <p className="font-bold text-[var(--text-primary)]">{sendMode === 'both' ? 'مجموعات + رسائل خاصة' : 'مجموعات فقط'}</p>
              </div>
            </div>
          </div>
        )}

        {/* ══ Step 4: Ads ══════════════════════════════════════ */}
        {step === 4 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-[var(--text-primary)]">اختيار الإعلانات</h2>
              {/* Source toggle */}
              <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                {([['lib','من المكتبة'],['custom','نص مخصص']] as const).map(([v, l]) => (
                  <button
                    key={v}
                    onClick={() => { setUseLib(v === 'lib'); setSelAds([]); }}
                    className={cn('px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                      (useLib ? v === 'lib' : v === 'custom')
                        ? 'bg-[var(--brand-primary)] text-white shadow-sm'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {useLib ? (
              <>
                {/* Library search */}
                <div className="relative">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                  <input
                    className="input pr-9 bg-[var(--bg-elevated)] w-full"
                    placeholder="بحث في الإعلانات..."
                    value={adSearch}
                    onChange={e => setAdSearch(e.target.value)}
                  />
                </div>

                {/* Ads list */}
                <div className="border border-[var(--border-default)] rounded-xl overflow-hidden" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                  {adsLoading && (
                    <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
                      <RefreshCw className="w-4 h-4 animate-spin mr-2" /> تحميل...
                    </div>
                  )}
                  {!adsLoading && filteredAds.length === 0 && (
                    <div className="py-8 text-center text-[var(--text-muted)] text-sm">
                      <BookOpen className="w-7 h-7 mx-auto mb-2 opacity-40" />
                      لا توجد إعلانات نشطة
                    </div>
                  )}
                  {filteredAds.map(ad => {
                    const order = selAds.indexOf(ad.id);
                    const isSel = order !== -1;
                    const hasMed = (() => {
                      try { const p = typeof ad.media_paths === 'string' ? JSON.parse(ad.media_paths) : ad.media_paths; return Array.isArray(p) && p.length > 0; } catch { return false; }
                    })();
                    return (
                      <label
                        key={ad.id}
                        className={cn(
                          'flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 cursor-pointer transition-colors',
                          isSel ? 'bg-[var(--brand-primary)]/5' : 'hover:bg-[var(--bg-elevated)]'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleAd(ad.id)}
                          className="w-4 h-4 rounded accent-[var(--brand-primary)] shrink-0"
                        />
                        {hasMed && (
                          <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                            <Image className="w-4 h-4 text-[var(--brand-primary)]" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{ad.name}</p>
                          <p className="text-xs text-[var(--text-muted)] truncate">{(ad.content || '').slice(0, 80) || 'بدون نص'}</p>
                        </div>
                        {isSel && (
                          <div className="w-6 h-6 rounded-full bg-[var(--brand-primary)] text-white text-xs font-bold flex items-center justify-center shrink-0">
                            {order + 1}
                          </div>
                        )}
                      </label>
                    );
                  })}
                </div>

                {selAds.length > 0 && (
                  <div className="p-3 rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20 text-sm text-[var(--brand-primary)] flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    تم اختيار <strong>{selAds.length}</strong> إعلان بالترتيب
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <label className="text-sm text-[var(--text-secondary)] font-medium">نص الرسالة المخصصة</label>
                <textarea
                  className="input min-h-[160px] font-mono text-sm leading-relaxed resize-none"
                  placeholder="اكتب رسالتك هنا..."
                  value={customTxt}
                  onChange={e => setCustomTxt(e.target.value)}
                />
                <p className="text-xs text-[var(--text-muted)] text-left">{customTxt.length} حرف</p>
              </div>
            )}
          </div>
        )}

        {/* ══ Step 5: Timing ═══════════════════════════════════ */}
        {step === 5 && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-[var(--text-primary)]">إعداد الفاصل الزمني</h2>
              {/* Unit toggle */}
              <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                {(['sec','min'] as const).map(u => (
                  <button
                    key={u}
                    onClick={() => setDelayUnit(u)}
                    className={cn('px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                      delayUnit === u ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]'
                    )}
                  >
                    {u === 'sec' ? 'ثوانٍ' : 'دقائق'}
                  </button>
                ))}
              </div>
            </div>

            {/* Delay inputs */}
            <div className="flex flex-col gap-3">
              {[
                { key: 'group', label: 'الفاصل بين كل مجموعة', icon: Users, val: groupDelay, set: setGroupDelay, desc: 'وقت الانتظار قبل الانتقال للمجموعة التالية' },
                ...(sendMode === 'both' ? [{ key: 'member', label: 'الفاصل بين كل رسالة خاصة', icon: MessageSquare, val: memberDelay, set: setMemberDelay, desc: 'وقت الانتظار بين رسائل الأعضاء (يحمي من الحظر)' }] : []),
                ...((useLib ? selAds.length : 1) > 1 ? [{ key: 'ad', label: 'الفاصل بين كل إعلان', icon: BookOpen, val: adDelay, set: setAdDelay, desc: 'وقت الانتظار بين إرسال كل إعلان' }] : []),
              ].map(({ key, label, icon: Icon, val, set, desc }) => (
                <div key={key} className="flex items-center gap-4 p-4 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                  <div className="w-9 h-9 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-[var(--brand-primary)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{desc}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => set(v => Math.max(0, v - 1))} className="w-7 h-7 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] font-bold hover:bg-[var(--bg-overlay)] transition-colors">−</button>
                    <input
                      type="number" min={0} max={300}
                      value={val}
                      onChange={e => set(Math.max(0, parseInt(e.target.value) || 0))}
                      className="input w-16 text-center text-sm h-8 bg-[var(--bg-surface)]"
                    />
                    <button onClick={() => set(v => Math.min(300, v + 1))} className="w-7 h-7 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-primary)] font-bold hover:bg-[var(--bg-overlay)] transition-colors">+</button>
                    <span className="text-xs text-[var(--text-muted)] w-12">{delayUnit === 'sec' ? 'ثانية' : 'دقيقة'}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div className="rounded-xl border border-[var(--brand-primary)]/25 bg-[var(--brand-primary)]/5 p-4">
              <h4 className="text-sm font-bold text-[var(--text-primary)] mb-2 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-[var(--brand-primary)]" /> ملخص العملية
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                {[
                  ['🖥', 'الحسابات', selAccounts.length],
                  ['👥', 'المجموعات', selGroups.size],
                  ['📢', 'الإعلانات', useLib ? selAds.length : 1],
                  ['📨', 'وضع الإرسال', sendMode === 'both' ? 'مجموعات + خاص' : 'مجموعات فقط'],
                  ['⏱', 'فاصل المجموعة', `${groupDelay} ${delayUnit === 'sec' ? 'ث' : 'د'}`],
                  ...(sendMode === 'both' ? [['💬', 'فاصل الأعضاء', `${memberDelay} ${delayUnit === 'sec' ? 'ث' : 'د'}`]] : []),
                ].map(([icon, k, v]) => (
                  <div key={String(k)} className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <span>{icon}</span>
                    <span className="text-[var(--text-muted)]">{k}:</span>
                    <span className="font-semibold text-[var(--text-primary)]">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Launch button */}
            <Button
              disabled={!canStart || starting}
              onClick={handleStart}
              className="w-full h-14 text-base font-bold gap-2 bg-gradient-to-l from-[var(--brand-primary)] to-[#00c99a] disabled:opacity-50 mt-1"
              style={{ boxShadow: '0 0 20px rgba(0,168,132,0.3)' }}
            >
              {starting ? (
                <>
                  <RefreshCw className="w-5 h-5 animate-spin" />
                  جارٍ البدء...
                </>
              ) : (
                <>
                  <Radio className="w-5 h-5" />
                  بدء النشر المباشر
                </>
              )}
            </Button>
          </div>
        )}

        {/* ── Navigation ─────────────────────────────────────── */}
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-[var(--border-default)]">
          <Button
            onClick={() => setStep(s => Math.max(1, s - 1))}
            disabled={step === 1}
            className="gap-2 bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-default)] hover:bg-[var(--bg-overlay)] disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4" /> السابق
          </Button>

          <span className="text-xs text-[var(--text-muted)]">
            الخطوة {step} من {STEPS.length}
          </span>

          {step < STEPS.length ? (
            <Button
              onClick={() => setStep(s => Math.min(STEPS.length, s + 1))}
              disabled={
                (step === 1 && selAccounts.length === 0) ||
                (step === 2 && selGroups.size === 0)
              }
              className="gap-2 bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)] disabled:opacity-40"
            >
              التالي <ChevronLeft className="w-4 h-4" />
            </Button>
          ) : (
            <div /> /* launch handled by in-step button */
          )}
        </div>
      </Card>
    </div>
  );
}
