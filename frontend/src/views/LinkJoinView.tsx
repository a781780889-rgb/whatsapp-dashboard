import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitMerge, Search, RefreshCw, Users,
  CheckCircle2, XCircle, AlertCircle, PauseCircle, StopCircle,
  Play, Square, Settings2, BarChart3, Filter,
  Plus, Upload, Zap, Radio, Activity,
  Shield, TrendingUp, Link2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/utils/cn';
import { API, authFetch } from '@/utils/api';

// ═══════════════════════════════════════════════════════════════════════
//  أنواع البيانات
// ═══════════════════════════════════════════════════════════════════════
interface Account {
  id: string;
  name?: string;
  phone_number?: string;
  status?: string;
}

interface JoinLink {
  id: string;
  url: string;
  group_name?: string;
  link_type: string;
  status: string;
  join_account_used?: string;
  joined_at?: string;
  join_fail_reason?: string;
  join_attempts: number;
  discovered_at: string;
  accountId: string;
  accountName: string;
}

interface Dashboard {
  totalLinks: number;
  totalNew: number;
  totalJoined: number;
  totalFailed: number;
  totalBlocked: number;
  totalDisabled: number;
  joinedToday: number;
  failedToday: number;
  accountsCount: number;
  byAccount: { accountId: string; name: string; phone?: string; total: number; new: number; joined: number; failed: number }[];
  byType: { link_type: string; cnt: number }[];
  autoMode: { isRunning: boolean; startedAt?: string; totalJoined: number; totalFailed: number; runCount: number };
}

interface AutoSettings {
  accountIds: string[];
  delaySeconds: number;
  randomDelay: boolean;
  randomDelayMax: number;
  linkTypes: string[];
  maxPerRun: number;
  intervalMinutes: number;
  distributionMode: string;
  sourceAccountId?: string;
  sourceAccountCount: number; // 1 | 2 | 3 | -1 (كل الحسابات)
}

interface Props {
  accountId: string | null;
  accounts: Account[];
}

// ═══════════════════════════════════════════════════════════════════════
//  إعدادات ثابتة
// ═══════════════════════════════════════════════════════════════════════
const STATUS_CFG: Record<string, { label: string; color: string; bg: string; border: string; icon: React.ReactNode }> = {
  new:      { label: 'جديد',          color: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/20',   icon: <AlertCircle className="w-3 h-3" /> },
  joined:   { label: 'تم الانضمام',   color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:   { label: 'فشل',           color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    icon: <XCircle className="w-3 h-3" /> },
  disabled: { label: 'معطل',          color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20', icon: <PauseCircle className="w-3 h-3" /> },
  blocked:  { label: 'محظور',         color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20', icon: <StopCircle className="w-3 h-3" /> },
};

const TYPE_CFG: Record<string, { label: string; emoji: string; color: string; bg: string }> = {
  whatsapp_group:   { label: 'مجموعة واتساب',   emoji: '💬', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  whatsapp_channel: { label: 'قناة واتساب',     emoji: '📢', color: 'text-emerald-300', bg: 'bg-emerald-500/8'  },
  telegram_group:   { label: 'مجموعة تيليجرام', emoji: '✈️', color: 'text-blue-400',    bg: 'bg-blue-500/10'    },
  telegram:         { label: 'تيليجرام',         emoji: '✈️', color: 'text-blue-400',    bg: 'bg-blue-500/10'    },
  other:            { label: 'أخرى',             emoji: '🔗', color: 'text-violet-400',  bg: 'bg-violet-500/10'  },
};

const DELAY_OPTIONS = [
  { label: '10 ث',  value: 10 },
  { label: '30 ث',  value: 30 },
  { label: '1 د',   value: 60 },
  { label: '3 د',   value: 180 },
  { label: '5 د',   value: 300 },
];

// خيارات عدد حسابات المصدر — قابلة للتوسع بسهولة بإضافة عنصر جديد هنا
const SOURCE_COUNT_OPTIONS: { label: string; value: number }[] = [
  { label: 'حساب واحد',   value: 1  },
  { label: 'حسابان',      value: 2  },
  { label: '3 حسابات',   value: 3  },
  { label: 'كل الحسابات', value: -1 },
];

const TABS = [
  { id: 'dashboard',   label: 'لوحة التحكم',       icon: BarChart3 },
  { id: 'all',         label: 'جميع الروابط',       icon: GitMerge },
  { id: 'joined',      label: 'تم الانضمام',        icon: CheckCircle2 },
  { id: 'unjoined',    label: 'غير المنضم إليها',   icon: XCircle },
  { id: 'join-engine', label: 'محرك الانضمام',      icon: Zap },
  { id: 'auto-mode',   label: 'الوضع التلقائي',     icon: Radio },
];

// ═══════════════════════════════════════════════════════════════════════
//  مكوّن StatusBadge — شارة الحالة
// ═══════════════════════════════════════════════════════════════════════
function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.new;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
      cfg.color, cfg.bg, cfg.border
    )}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  مكوّن StatCard — بطاقة الإحصاء مع تدرج لوني
// ═══════════════════════════════════════════════════════════════════════
function StatCard({
  label, value, colorClass, gradientFrom, gradientTo, icon, pulse = false
}: {
  label: string;
  value: number | string;
  colorClass: string;
  gradientFrom: string;
  gradientTo: string;
  icon: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <div className={cn(
      'relative overflow-hidden rounded-2xl border p-4 transition-all duration-200 group hover:scale-[1.02] hover:shadow-lg cursor-default',
      'bg-[var(--bg-surface)] border-[var(--border-default)]',
    )}
      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
    >
      {/* خلفية التدرج */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: `linear-gradient(135deg, ${gradientFrom}15, ${gradientTo}08)` }}
      />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-[var(--text-muted)] font-medium">{label}</span>
          <div
            className={cn('w-8 h-8 rounded-xl flex items-center justify-center', colorClass, 'bg-opacity-15')}
            style={{ background: `${gradientFrom}20` }}
          >
            <span className={colorClass}>{icon}</span>
          </div>
        </div>
        <div className={cn('text-3xl font-extrabold tabular-nums', colorClass)}>
          {value}
          {pulse && (
            <span className={cn('inline-block w-2 h-2 rounded-full mr-1.5 mb-0.5 animate-pulse', colorClass.replace('text-', 'bg-'))} />
          )}
        </div>
      </div>

      {/* خط زخرفي */}
      <div
        className="absolute bottom-0 right-0 left-0 h-0.5 opacity-30"
        style={{ background: `linear-gradient(90deg, transparent, ${gradientFrom}, transparent)` }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  مكوّن ProgressBar — شريط التقدم
// ═══════════════════════════════════════════════════════════════════════
function ProgressBar({ value, max, colorClass }: { value: number; max: number; colorClass: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-[var(--bg-elevated)] rounded-full h-1.5 overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all duration-700', colorClass)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  المكوّن الرئيسي — LinkJoinView
// ═══════════════════════════════════════════════════════════════════════
export default function LinkJoinView({ accountId, accounts }: Props) {
  const [tab, setTab] = useState('dashboard');

  // ── حالة البيانات ─────────────────────────────────────────────────
  const [dashboard, setDashboard]           = useState<Dashboard | null>(null);
  const [allLinks,  setAllLinks]            = useState<JoinLink[]>([]);
  const [joinedLinks,   setJoinedLinks]     = useState<JoinLink[]>([]);
  const [unjoinedLinks, setUnjoinedLinks]   = useState<JoinLink[]>([]);

  // ── حالة الفلاتر ──────────────────────────────────────────────────
  const [filterAccId,  setFilterAccId]  = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType,   setFilterType]   = useState('');
  const [searchText,   setSearchText]   = useState('');

  // ── حالة محرك الانضمام ────────────────────────────────────────────
  const [joinLinks,       setJoinLinks]       = useState('');
  const [joinAccountIds,  setJoinAccountIds]  = useState<string[]>([]);
  const [joinDelay,       setJoinDelay]       = useState(30);
  const [joinRandomDelay, setJoinRandomDelay] = useState(false);
  const [joinMode,        setJoinMode]        = useState<'single'|'pair'|'multiple'|'all'>('single');
  const [activeJob,       setActiveJob]       = useState<any>(null);
  const [jobId,           setJobId]           = useState<string | null>(null);

  // ── حالة الوضع التلقائي ───────────────────────────────────────────
  const [autoSettings, setAutoSettings] = useState<AutoSettings>({
    accountIds: [], delaySeconds: 30, randomDelay: false, randomDelayMax: 60,
    linkTypes: ['whatsapp_group'], maxPerRun: 20, intervalMinutes: 5,
    distributionMode: 'all', sourceAccountId: accountId || '',
    sourceAccountCount: 1,
  });
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStats,   setAutoStats]   = useState<any>(null);

  // ── إضافة روابط ───────────────────────────────────────────────────
  const [addLinksText,    setAddLinksText]    = useState('');
  const [addLinksAccount, setAddLinksAccount] = useState(accountId || '');
  const [addLinksLoading, setAddLinksLoading] = useState(false);

  const [loading, setLoading] = useState(false);
  const [toast,   setToast]   = useState<{ msg: string; type: 'success'|'error' } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Toast ──────────────────────────────────────────────────────────
  const showToast = (msg: string, type: 'success'|'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Fetch helpers ──────────────────────────────────────────────────
  const fetchDashboard = useCallback(async () => {
    try {
      const res  = await authFetch(`${API}/links/join/dashboard`);
      const data = await res.json();
      if (data.success) setDashboard(data.dashboard);
    } catch { /* silent */ }
  }, []);

  const fetchAllLinks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterAccId)  params.set('accountIds', filterAccId);
      if (filterStatus) params.set('status',     filterStatus);
      if (filterType)   params.set('linkType',   filterType);
      if (searchText)   params.set('search',     searchText);
      params.set('limit', '100');
      const res  = await authFetch(`${API}/links/join/all-links?${params}`);
      const data = await res.json();
      if (data.success) setAllLinks(data.links);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [filterAccId, filterStatus, filterType, searchText]);

  const fetchJoined = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterAccId) params.set('accountIds', filterAccId);
      params.set('limit', '100');
      const res  = await authFetch(`${API}/links/join/joined-links?${params}`);
      const data = await res.json();
      if (data.success) setJoinedLinks(data.links);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [filterAccId]);

  const fetchUnjoined = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterAccId) params.set('accountIds', filterAccId);
      params.set('limit', '100');
      const res  = await authFetch(`${API}/links/join/unjoined-links?${params}`);
      const data = await res.json();
      if (data.success) setUnjoinedLinks(data.links);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [filterAccId]);

  const fetchAutoMode = useCallback(async () => {
    try {
      const res  = await authFetch(`${API}/links/join/auto-mode`);
      const data = await res.json();
      if (data.success) {
        setAutoRunning(data.autoMode.isRunning);
        setAutoStats(data.autoMode);
        if (data.autoMode.settings) {
          setAutoSettings(prev => ({ ...prev, ...data.autoMode.settings }));
        }
      }
    } catch { /* silent */ }
  }, []);

  // ── Poll job status ────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res  = await authFetch(`${API}/links/join/job/${jobId}`);
        const data = await res.json();
        setActiveJob(data);
        if (data.status === 'finished' || data.status === 'not_found') {
          if (pollRef.current) clearInterval(pollRef.current);
          if (data.status === 'finished') {
            showToast(`✅ اكتمل الانضمام: ${data.succeeded || 0} نجح، ${data.failed || 0} فشل`);
            fetchDashboard();
          }
        }
      } catch { /* silent */ }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId]); // eslint-disable-line

  // ── التحميل الأولي ────────────────────────────────────────────────
  useEffect(() => {
    fetchDashboard();
    fetchAutoMode();
  }, []); // eslint-disable-line

  useEffect(() => {
    if (tab === 'all')       fetchAllLinks();
    if (tab === 'joined')    fetchJoined();
    if (tab === 'unjoined')  fetchUnjoined();
    if (tab === 'auto-mode') fetchAutoMode();
  }, [tab, filterAccId, filterStatus, filterType]); // eslint-disable-line

  // ── تنفيذ الانضمام ────────────────────────────────────────────────
  const handleExecuteJoin = async () => {
    if (!accountId) return showToast('اختر حساباً أولاً', 'error');
    const lines = joinLinks.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return showToast('أدخل روابط للانضمام', 'error');

    const useAccIds = joinMode === 'all'
      ? accounts.map(a => a.id)
      : joinAccountIds.length > 0 ? joinAccountIds : [accountId];

    setLoading(true);
    try {
      const res  = await authFetch(`${API}/links/join/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId:  accountId,
          links:            lines.map(url => ({ url })),
          accountIds:       useAccIds,
          delaySeconds:     joinDelay,
          randomDelay:      joinRandomDelay,
          distributionMode: joinMode,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setJobId(data.jobId);
        setActiveJob({ status: 'running', total: lines.length, done: 0, succeeded: 0, failed: 0 });
        showToast(`🚀 ${data.message}`);
      } else {
        showToast(data.error || 'خطأ في الانضمام', 'error');
      }
    } catch { showToast('خطأ في الاتصال', 'error'); } finally { setLoading(false); }
  };

  // ── إضافة روابط يدوياً ────────────────────────────────────────────
  const handleAddLinks = async () => {
    if (!addLinksAccount) return showToast('اختر حساباً', 'error');
    const urls = addLinksText.split('\n').map(l => l.trim()).filter(Boolean);
    if (urls.length === 0) return showToast('أدخل روابط', 'error');

    setAddLinksLoading(true);
    try {
      const res  = await authFetch(`${API}/links/join/add-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: addLinksAccount, urls }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`✅ ${data.message}`);
        setAddLinksText('');
        fetchDashboard();
      } else {
        showToast(data.error || 'خطأ في الإضافة', 'error');
      }
    } catch { showToast('خطأ في الاتصال', 'error'); } finally { setAddLinksLoading(false); }
  };

  // ── تشغيل/إيقاف الوضع التلقائي ────────────────────────────────────
  const handleToggleAutoMode = async () => {
    if (autoRunning) {
      try {
        const res  = await authFetch(`${API}/links/join/auto-mode/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data.success) { setAutoRunning(false); showToast('⏹️ تم إيقاف الوضع التلقائي'); }
      } catch { showToast('خطأ', 'error'); }
    } else {
      const srcId = autoSettings.sourceAccountId || accountId;
      if (!srcId) return showToast('اختر حساباً رئيسياً', 'error');
      try {
        const res  = await authFetch(`${API}/links/join/auto-mode/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...autoSettings, sourceAccountId: srcId }),
        });
        const data = await res.json();
        if (data.success) { setAutoRunning(true); showToast('▶️ تم تشغيل الوضع التلقائي'); }
        else showToast(data.error || 'خطأ', 'error');
      } catch { showToast('خطأ', 'error'); }
    }
  };

  // ── حفظ إعدادات الوضع التلقائي ────────────────────────────────────
  const handleSaveAutoSettings = async () => {
    try {
      const res  = await authFetch(`${API}/links/join/auto-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(autoSettings),
      });
      const data = await res.json();
      if (data.success) showToast('✅ تم حفظ الإعدادات');
      else showToast(data.error || 'خطأ', 'error');
    } catch { showToast('خطأ', 'error'); }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  مكوّن الفلاتر المشترك
  // ═══════════════════════════════════════════════════════════════════
  const Filters = () => (
    <div className="flex flex-wrap gap-2 mb-4">
      {/* أيقونة الفلتر */}
      <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-muted)] text-xs">
        <Filter className="w-3.5 h-3.5" />
        <span>فلتر</span>
      </div>
      <select
        value={filterAccId}
        onChange={e => setFilterAccId(e.target.value)}
        className="flex-1 min-w-[150px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2 focus:border-[var(--brand-primary)] outline-none"
      >
        <option value="">جميع الحسابات</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number || a.id}</option>)}
      </select>
      <select
        value={filterStatus}
        onChange={e => setFilterStatus(e.target.value)}
        className="flex-1 min-w-[120px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2 focus:border-[var(--brand-primary)] outline-none"
      >
        <option value="">كل الحالات</option>
        <option value="new">جديد</option>
        <option value="joined">تم الانضمام</option>
        <option value="failed">فشل</option>
        <option value="blocked">محظور</option>
        <option value="disabled">معطل</option>
      </select>
      <select
        value={filterType}
        onChange={e => setFilterType(e.target.value)}
        className="flex-1 min-w-[150px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2 focus:border-[var(--brand-primary)] outline-none"
      >
        <option value="">كل الأنواع</option>
        <option value="whatsapp_group">مجموعة واتساب</option>
        <option value="whatsapp_channel">قناة واتساب</option>
        <option value="telegram_group">مجموعة تيليجرام</option>
        <option value="other">أخرى</option>
      </select>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  //  جدول الروابط المحسّن
  // ═══════════════════════════════════════════════════════════════════
  const LinksTable = ({ links }: { links: JoinLink[] }) => (
    <div className="rounded-2xl border border-[var(--border-default)] overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-[var(--bg-elevated)] border-[var(--border-default)] hover:bg-[var(--bg-elevated)]">
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold py-3 px-4">الرابط</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">النوع</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">الحالة</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">الحساب</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">وقت الانضمام</TableHead>
            <TableHead className="text-center text-[var(--text-muted)] text-xs font-semibold">المحاولات</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {links.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-[var(--text-muted)] py-16">
                <div className="flex flex-col items-center gap-3">
                  <Link2 className="w-8 h-8 opacity-30" />
                  <span className="text-sm">لا توجد روابط</span>
                </div>
              </TableCell>
            </TableRow>
          ) : links.map((link) => {
            const type = TYPE_CFG[link.link_type] || TYPE_CFG.other;
            return (
              <TableRow
                key={`${link.id}-${link.accountId}`}
                className="border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/60 transition-colors"
              >
                <TableCell className="px-4 py-3">
                  <div className="font-mono text-xs text-blue-400 truncate max-w-[200px]" title={link.url}>{link.url}</div>
                  {link.group_name && <div className="text-[var(--text-muted)] text-xs mt-0.5">{link.group_name}</div>}
                </TableCell>
                <TableCell>
                  <span className={cn('text-xs font-medium px-2 py-0.5 rounded-lg', type.bg, type.color)}>
                    {type.emoji} {type.label}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={link.status} />
                  {link.join_fail_reason && (
                    <div className="text-red-400 text-xs mt-0.5 max-w-[140px] truncate" title={link.join_fail_reason}>
                      {link.join_fail_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-muted)]">{link.accountName}</TableCell>
                <TableCell className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                  {link.joined_at ? new Date(link.joined_at).toLocaleString('ar') : '—'}
                </TableCell>
                <TableCell className="text-center">
                  <span className={cn(
                    'text-xs font-bold px-2 py-0.5 rounded-lg',
                    link.join_attempts > 2 ? 'text-red-400 bg-red-500/10' : 'text-[var(--text-muted)] bg-[var(--bg-elevated)]'
                  )}>
                    {link.join_attempts}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════
  //  Render الرئيسي
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-full overflow-hidden" dir="rtl">

      {/* ── Toast Notification ─────────────────────────────────────── */}
      {toast && (
        <div className={cn(
          'fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl shadow-2xl text-sm font-bold transition-all animate-slide-up flex items-center gap-2',
          toast.type === 'success'
            ? 'bg-emerald-500/95 text-white border border-emerald-400/30'
            : 'bg-red-500/95 text-white border border-red-400/30'
        )}>
          {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* ── رأس الصفحة ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-default)] shrink-0 bg-[var(--bg-surface)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #10b98120, #10b98108)', border: '1px solid #10b98130' }}
          >
            <GitMerge className="w-5 h-5" style={{ color: '#10b981' }} />
          </div>
          <div>
            <h1 className="text-base font-bold text-[var(--text-primary)] leading-tight">الانضمام بالروابط</h1>
            <p className="text-[10px] text-[var(--text-muted)]">نظام متكامل لإدارة الروابط والانضمام الاحترافي</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* زر إيقاف/تشغيل الكامل */}
          <button
            onClick={handleToggleAutoMode}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all',
              autoRunning
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30'
                : 'text-white hover:brightness-110 border border-transparent'
            )}
            style={!autoRunning ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
          >
            {autoRunning
              ? <><Square className="w-3.5 h-3.5" /> إيقاف اللوحة</>
              : <><Play  className="w-3.5 h-3.5" /> تشغيل اللوحة</>
            }
          </button>

          <button
            onClick={() => { fetchDashboard(); if (tab !== 'dashboard') fetchAllLinks(); }}
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* ── شريط حالة الوضع التلقائي ──────────────────────────────── */}
      {autoRunning && (
        <div className="px-5 py-2.5 border-b shrink-0 flex items-center gap-2.5"
          style={{
            background: 'linear-gradient(90deg, rgba(16,185,129,0.08), rgba(16,185,129,0.04))',
            borderColor: 'rgba(16,185,129,0.2)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <span className="text-emerald-400 text-xs font-bold">الوضع التلقائي يعمل الآن</span>
          </div>
          {autoStats && (
            <div className="flex items-center gap-4 mr-auto text-xs">
              <span className="text-emerald-300">
                <CheckCircle2 className="w-3 h-3 inline ml-1" />
                انضمام: {autoStats.totalJoined}
              </span>
              <span className="text-red-400">
                <XCircle className="w-3 h-3 inline ml-1" />
                فشل: {autoStats.totalFailed}
              </span>
              <span className="text-blue-400">
                <Activity className="w-3 h-3 inline ml-1" />
                عمليات: {autoStats.runCount}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── شريط تقدم المهمة الجارية ──────────────────────────────── */}
      {activeJob && activeJob.status === 'running' && (
        <div className="px-5 py-2.5 border-b shrink-0"
          style={{ background: 'rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.15)' }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold text-blue-400 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 animate-pulse" />
              جاري الانضمام... {activeJob.done}/{activeJob.total}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              ✅ {activeJob.succeeded || 0} &nbsp;|&nbsp; ❌ {activeJob.failed || 0}
            </span>
          </div>
          <div className="w-full bg-[var(--bg-elevated)] rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${activeJob.total > 0 ? (activeJob.done / activeJob.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
              }}
            />
          </div>
        </div>
      )}

      {/* ── التبويبات ─────────────────────────────────────────────── */}
      <div className="flex border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-2 gap-0.5 shrink-0 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap transition-all border-b-2 -mb-px rounded-t-lg',
              tab === t.id
                ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50'
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════
          محتوى التبويبات
      ══════════════════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">

        {/* ── لوحة التحكم الرئيسية ─────────────────────────────────── */}
        {tab === 'dashboard' && (
          <div className="space-y-5 animate-fade-in">
            {dashboard ? (
              <>
                {/* صف الإحصاء الأول */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard
                    label="إجمالي الروابط"
                    value={dashboard.totalLinks}
                    colorClass="text-violet-400"
                    gradientFrom="#8b5cf6"
                    gradientTo="#7c3aed"
                    icon={<GitMerge className="w-4 h-4" />}
                  />
                  <StatCard
                    label="جديدة"
                    value={dashboard.totalNew}
                    colorClass="text-blue-400"
                    gradientFrom="#3b82f6"
                    gradientTo="#2563eb"
                    icon={<AlertCircle className="w-4 h-4" />}
                  />
                  <StatCard
                    label="تم الانضمام"
                    value={dashboard.totalJoined}
                    colorClass="text-emerald-400"
                    gradientFrom="#10b981"
                    gradientTo="#059669"
                    icon={<CheckCircle2 className="w-4 h-4" />}
                  />
                  <StatCard
                    label="فشل الانضمام"
                    value={dashboard.totalFailed}
                    colorClass="text-red-400"
                    gradientFrom="#ef4444"
                    gradientTo="#dc2626"
                    icon={<XCircle className="w-4 h-4" />}
                  />
                </div>

                {/* صف الإحصاء الثاني */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard
                    label="عدد الحسابات"
                    value={dashboard.accountsCount}
                    colorClass="text-cyan-400"
                    gradientFrom="#06b6d4"
                    gradientTo="#0891b2"
                    icon={<Users className="w-4 h-4" />}
                  />
                  <StatCard
                    label="انضمامات اليوم"
                    value={dashboard.joinedToday}
                    colorClass="text-amber-400"
                    gradientFrom="#f59e0b"
                    gradientTo="#d97706"
                    icon={<TrendingUp className="w-4 h-4" />}
                    pulse={dashboard.joinedToday > 0}
                  />
                  <StatCard
                    label="معطل"
                    value={dashboard.totalDisabled}
                    colorClass="text-yellow-400"
                    gradientFrom="#eab308"
                    gradientTo="#ca8a04"
                    icon={<PauseCircle className="w-4 h-4" />}
                  />
                  <StatCard
                    label="محظور"
                    value={dashboard.totalBlocked}
                    colorClass="text-orange-400"
                    gradientFrom="#f97316"
                    gradientTo="#ea580c"
                    icon={<StopCircle className="w-4 h-4" />}
                  />
                </div>

                {/* إحصائيات حسب الحساب */}
                {dashboard.byAccount.length > 0 && (
                  <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                    {/* رأس القسم */}
                    <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{ background: 'rgba(139,92,246,0.15)' }}
                      >
                        <Users className="w-3.5 h-3.5 text-violet-400" />
                      </div>
                      <h3 className="font-bold text-sm text-[var(--text-primary)]">إحصائيات حسب الحساب</h3>
                      <span className="mr-auto text-xs text-[var(--text-muted)] bg-[var(--bg-overlay)] px-2 py-0.5 rounded-lg">
                        {dashboard.byAccount.length} حساب
                      </span>
                    </div>

                    {/* جدول الحسابات */}
                    <div className="divide-y divide-[var(--border-default)]">
                      {dashboard.byAccount.map((acc, idx) => (
                        <div key={acc.accountId}
                          className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--bg-elevated)]/50 transition-colors group"
                        >
                          {/* رقم وأيقونة الحساب */}
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold text-white"
                              style={{ background: `hsl(${idx * 60 + 160}, 60%, 45%)` }}
                            >
                              {(acc.name || acc.phone || '؟').charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
                                {acc.name || acc.phone || acc.accountId}
                              </div>
                              <div className="text-xs text-[var(--text-muted)]">
                                الإجمالي: <span className="font-bold text-violet-400">{acc.total}</span>
                              </div>
                            </div>
                          </div>

                          {/* أشرطة التقدم */}
                          <div className="hidden md:flex flex-col gap-1 w-36">
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-emerald-400">انضم: {acc.joined}</span>
                              <span className="text-[var(--text-muted)] text-[10px]">
                                {acc.total > 0 ? Math.round((acc.joined / acc.total) * 100) : 0}%
                              </span>
                            </div>
                            <ProgressBar value={acc.joined} max={acc.total} colorClass="bg-emerald-500" />
                          </div>

                          {/* الأرقام */}
                          <div className="flex items-center gap-3 text-xs shrink-0">
                            <div className="text-center">
                              <div className="font-bold text-blue-400">{acc.new}</div>
                              <div className="text-[10px] text-[var(--text-muted)]">جديد</div>
                            </div>
                            <div className="w-px h-6 bg-[var(--border-default)]" />
                            <div className="text-center">
                              <div className="font-bold text-emerald-400">{acc.joined}</div>
                              <div className="text-[10px] text-[var(--text-muted)]">انضم</div>
                            </div>
                            <div className="w-px h-6 bg-[var(--border-default)]" />
                            <div className="text-center">
                              <div className="font-bold text-red-400">{acc.failed}</div>
                              <div className="text-[10px] text-[var(--text-muted)]">فشل</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* الروابط حسب النوع */}
                {dashboard.byType.length > 0 && (
                  <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                    <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                        style={{ background: 'rgba(59,130,246,0.15)' }}
                      >
                        <Link2 className="w-3.5 h-3.5 text-blue-400" />
                      </div>
                      <h3 className="font-bold text-sm text-[var(--text-primary)]">الروابط حسب النوع</h3>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-0 divide-y md:divide-y-0 md:divide-x-reverse md:divide-x divide-[var(--border-default)]">
                      {(() => {
                        const total = dashboard.byType.reduce((s, t) => s + t.cnt, 0);
                        return dashboard.byType.map(t => {
                          const cfg = TYPE_CFG[t.link_type] || TYPE_CFG.other;
                          const pct = total > 0 ? Math.round((t.cnt / total) * 100) : 0;
                          return (
                            <div key={t.link_type}
                              className="flex flex-col items-center justify-center gap-2 py-6 px-4 hover:bg-[var(--bg-elevated)]/40 transition-colors"
                            >
                              <span className="text-3xl">{cfg.emoji}</span>
                              <span className={cn('text-2xl font-extrabold', cfg.color)}>{t.cnt}</span>
                              <span className="text-xs text-[var(--text-muted)] text-center leading-tight">{cfg.label}</span>
                              <div className="w-full px-2">
                                <ProgressBar value={t.cnt} max={total} colorClass={cfg.color.replace('text-', 'bg-')} />
                              </div>
                              <span className="text-[10px] text-[var(--text-muted)]">{pct}%</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-[var(--text-muted)]">
                <RefreshCw className="w-8 h-8 animate-spin opacity-40" />
                <span className="text-sm">جاري تحميل البيانات...</span>
              </div>
            )}
          </div>
        )}

        {/* ── جميع الروابط ─────────────────────────────────────────── */}
        {tab === 'all' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-sm flex items-center gap-2">
                <GitMerge className="w-4 h-4 text-[var(--brand-primary)]" />
                جميع الروابط
                <span className="text-[var(--text-muted)] font-normal text-xs">({allLinks.length})</span>
              </h2>
              <button
                onClick={fetchAllLinks}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} /> تحديث
              </button>
            </div>
            <Filters />
            {/* بحث */}
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
              <input
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && fetchAllLinks()}
                placeholder="البحث في الروابط..."
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl pr-9 pl-4 py-2.5 focus:border-[var(--brand-primary)] outline-none transition-colors"
              />
            </div>
            <LinksTable links={allLinks} />
          </div>
        )}

        {/* ── الروابط التي تم الانضمام إليها ──────────────────────── */}
        {tab === 'joined' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-sm flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                الروابط التي تم الانضمام إليها
                <span className="text-[var(--text-muted)] font-normal text-xs">({joinedLinks.length})</span>
              </h2>
              <button
                onClick={fetchJoined}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} /> تحديث
              </button>
            </div>
            <div className="flex gap-2 mb-4">
              <select
                value={filterAccId}
                onChange={e => setFilterAccId(e.target.value)}
                className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2 focus:border-emerald-500 outline-none"
              >
                <option value="">جميع الحسابات</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
              </select>
            </div>
            <LinksTable links={joinedLinks} />
          </div>
        )}

        {/* ── الروابط غير المنضم إليها ─────────────────────────────── */}
        {tab === 'unjoined' && (
          <div className="space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-sm flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-400" />
                الروابط غير المنضم إليها
                <span className="text-[var(--text-muted)] font-normal text-xs">({unjoinedLinks.length})</span>
              </h2>
              <button
                onClick={fetchUnjoined}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} /> تحديث
              </button>
            </div>
            <div className="flex gap-2 mb-4">
              <select
                value={filterAccId}
                onChange={e => setFilterAccId(e.target.value)}
                className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2 outline-none"
              >
                <option value="">جميع الحسابات</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
              </select>
            </div>
            <LinksTable links={unjoinedLinks} />
          </div>
        )}

        {/* ── محرك الانضمام ────────────────────────────────────────── */}
        {tab === 'join-engine' && (
          <div className="space-y-4 animate-fade-in">

            {/* عنوان */}
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #f59e0b20, #f59e0b08)', border: '1px solid #f59e0b30' }}
              >
                <Zap className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h2 className="font-bold text-sm text-[var(--text-primary)]">محرك الانضمام الاحترافي</h2>
                <p className="text-[10px] text-[var(--text-muted)]">إضافة وتنفيذ الانضمام للروابط فورياً</p>
              </div>
            </div>

            {/* بطاقة: إضافة روابط */}
            <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                <Plus className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-sm font-semibold">إضافة روابط إلى قاعدة البيانات</span>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">الحساب الرئيسي</label>
                  <select
                    value={addLinksAccount}
                    onChange={e => setAddLinksAccount(e.target.value)}
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-[var(--brand-primary)] outline-none"
                  >
                    <option value="">اختر حساباً</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">
                    الروابط <span className="text-blue-400">(رابط في كل سطر)</span>
                  </label>
                  <textarea
                    value={addLinksText}
                    onChange={e => setAddLinksText(e.target.value)}
                    rows={4}
                    placeholder="https://chat.whatsapp.com/..."
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2.5 font-mono resize-none focus:border-[var(--brand-primary)] outline-none transition-colors"
                    dir="ltr"
                  />
                  {addLinksText && (
                    <div className="text-[10px] text-[var(--text-muted)] mt-1">
                      {addLinksText.split('\n').filter(Boolean).length} رابط
                    </div>
                  )}
                </div>
                <button
                  onClick={handleAddLinks}
                  disabled={addLinksLoading || !addLinksText || !addLinksAccount}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)' }}
                >
                  {addLinksLoading
                    ? <><RefreshCw className="w-4 h-4 animate-spin" /> جاري الحفظ...</>
                    : <><Upload className="w-4 h-4" /> حفظ الروابط</>
                  }
                </button>
              </div>
            </div>

            {/* بطاقة: تنفيذ الانضمام */}
            <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-sm font-semibold">تنفيذ الانضمام الفوري</span>
              </div>
              <div className="p-5 space-y-4">
                {/* الروابط الفورية */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">
                    روابط الانضمام الفورية <span className="text-amber-400">(رابط في كل سطر)</span>
                  </label>
                  <textarea
                    value={joinLinks}
                    onChange={e => setJoinLinks(e.target.value)}
                    rows={4}
                    placeholder="https://chat.whatsapp.com/..."
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-xs rounded-xl px-3 py-2.5 font-mono resize-none focus:border-amber-500 outline-none transition-colors"
                    dir="ltr"
                  />
                </div>

                {/* توزيع الحسابات */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block font-medium">توزيع الحسابات</label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { id: 'single',   label: 'حساب واحد',     icon: '👤' },
                      { id: 'pair',     label: 'حسابان',        icon: '👥' },
                      { id: 'multiple', label: 'حسابات محددة',  icon: '🎯' },
                      { id: 'all',      label: 'كل الحسابات',   icon: '🌐' },
                    ].map(m => (
                      <button
                        key={m.id}
                        onClick={() => setJoinMode(m.id as any)}
                        className={cn(
                          'flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl text-xs font-medium border transition-all',
                          joinMode === m.id
                            ? 'text-white border-transparent'
                            : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-amber-500/40'
                        )}
                        style={joinMode === m.id ? { background: 'linear-gradient(135deg, #f59e0b, #d97706)' } : {}}
                      >
                        <span>{m.icon}</span>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* اختيار حسابات محددة */}
                {joinMode === 'multiple' && (
                  <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
                    <div className="px-3 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] text-xs text-[var(--text-muted)]">
                      اختر الحسابات
                    </div>
                    <div className="divide-y divide-[var(--border-default)] max-h-40 overflow-y-auto">
                      {accounts.map(a => (
                        <label key={a.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--bg-elevated)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={joinAccountIds.includes(a.id)}
                            onChange={e => setJoinAccountIds(prev =>
                              e.target.checked ? [...prev, a.id] : prev.filter(id => id !== a.id)
                            )}
                            className="rounded"
                          />
                          <span className="text-sm flex-1">{a.name || a.phone_number}</span>
                          <span className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded-md',
                            a.status === 'connected' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-500/15 text-gray-400'
                          )}>
                            {a.status || 'غير متصل'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* التأخير */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block font-medium">التأخير بين كل انضمام</label>
                  <div className="flex flex-wrap gap-2">
                    {DELAY_OPTIONS.map(d => (
                      <button
                        key={d.value}
                        onClick={() => setJoinDelay(d.value)}
                        className={cn(
                          'px-3 py-1.5 rounded-xl text-xs font-bold border transition-all',
                          joinDelay === d.value
                            ? 'border-transparent text-white'
                            : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--brand-primary)]/40'
                        )}
                        style={joinDelay === d.value ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* تأخير عشوائي */}
                <label className="flex items-center gap-2.5 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={joinRandomDelay}
                    onChange={e => setJoinRandomDelay(e.target.checked)}
                    className="w-4 h-4 rounded accent-emerald-500"
                  />
                  <span className="text-sm text-[var(--text-secondary)]">تفعيل التأخير العشوائي (لتجنب الحظر)</span>
                </label>

                {/* زر بدء الانضمام */}
                <button
                  onClick={handleExecuteJoin}
                  disabled={loading || !joinLinks || !accountId || (activeJob?.status === 'running')}
                  className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-lg active:scale-[0.99]"
                  style={{ background: 'linear-gradient(135deg, #10b981, #059669, #047857)' }}
                >
                  {activeJob?.status === 'running' ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" /> جاري الانضمام...</>
                  ) : (
                    <><Zap className="w-5 h-5" /> بدء الانضمام</>
                  )}
                </button>
              </div>
            </div>

          </div>
        )}

        {/* ── الوضع التلقائي ───────────────────────────────────────── */}
        {tab === 'auto-mode' && (
          <div className="space-y-4 animate-fade-in">

            {/* عنوان */}
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}
              >
                <Radio className={cn('w-4 h-4', autoRunning ? 'text-emerald-400 animate-pulse' : 'text-[var(--text-muted)]')} />
              </div>
              <div>
                <h2 className="font-bold text-sm text-[var(--text-primary)]">الوضع التلقائي</h2>
                <p className="text-[10px] text-[var(--text-muted)]">انضمام تلقائي مجدوَل في الخلفية</p>
              </div>
            </div>

            {/* بطاقة الحالة */}
            <div className={cn(
              'rounded-2xl border-2 overflow-hidden transition-all duration-300',
              autoRunning
                ? 'border-emerald-500/40'
                : 'border-[var(--border-default)]'
            )}
              style={autoRunning
                ? { background: 'linear-gradient(135deg, rgba(16,185,129,0.06), rgba(5,150,105,0.03))' }
                : { background: 'var(--bg-surface)' }
              }
            >
              <div className="p-5">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-12 h-12 rounded-2xl flex items-center justify-center transition-all',
                      autoRunning ? 'bg-emerald-500/20' : 'bg-[var(--bg-elevated)]'
                    )}>
                      {autoRunning ? (
                        <span className="relative flex h-6 w-6">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                          <Radio className="relative w-6 h-6 text-emerald-400" />
                        </span>
                      ) : (
                        <Radio className="w-6 h-6 text-[var(--text-muted)]" />
                      )}
                    </div>
                    <div>
                      <p className="font-bold text-base">
                        {autoRunning ? (
                          <span className="text-emerald-400">يعمل الآن 🟢</span>
                        ) : (
                          <span className="text-[var(--text-muted)]">متوقف 🔴</span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {autoRunning ? 'يبحث عن روابط جديدة للانضمام في الخلفية' : 'النظام في وضع الانتظار'}
                      </p>
                    </div>
                  </div>

                  {/* زر تشغيل/إيقاف */}
                  <button
                    onClick={handleToggleAutoMode}
                    className={cn(
                      'flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all hover:brightness-110',
                      autoRunning
                        ? 'bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25'
                        : 'text-white border border-transparent'
                    )}
                    style={!autoRunning ? { background: 'linear-gradient(135deg, #10b981, #059669)' } : {}}
                  >
                    {autoRunning
                      ? <><Square className="w-4 h-4" /> إيقاف</>
                      : <><Play  className="w-4 h-4" /> تشغيل</>
                    }
                  </button>
                </div>

                {/* إحصائيات الوضع التلقائي */}
                {autoStats && autoRunning && (
                  <div className="grid grid-cols-3 gap-3 mt-2">
                    <div className="flex flex-col items-center gap-1 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                      <span className="text-2xl font-extrabold text-emerald-400">{autoStats.totalJoined || 0}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">إجمالي الانضمام</span>
                    </div>
                    <div className="flex flex-col items-center gap-1 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
                      <span className="text-2xl font-extrabold text-red-400">{autoStats.totalFailed || 0}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">إجمالي الفشل</span>
                    </div>
                    <div className="flex flex-col items-center gap-1 py-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                      <span className="text-2xl font-extrabold text-blue-400">{autoStats.runCount || 0}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">عدد العمليات</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* بطاقة الإعدادات */}
            <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                <Settings2 className="w-3.5 h-3.5 text-violet-400" />
                <span className="text-sm font-semibold">إعدادات الوضع التلقائي</span>
              </div>
              <div className="p-5 space-y-5">

                {/* الحساب الرئيسي */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">الحساب الرئيسي (مصدر الروابط)</label>
                  <select
                    value={autoSettings.sourceAccountId || ''}
                    onChange={e => setAutoSettings(p => ({ ...p, sourceAccountId: e.target.value }))}
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                  >
                    <option value="">اختر حساباً</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
                  </select>
                </div>

                {/* عدد الحسابات (مصدر الروابط) */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">
                    عدد الحسابات (مصدر الروابط)
                  </label>
                  <select
                    value={autoSettings.sourceAccountCount ?? 1}
                    onChange={e => setAutoSettings(p => ({ ...p, sourceAccountCount: Number(e.target.value) }))}
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                  >
                    {SOURCE_COUNT_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {autoSettings.sourceAccountCount > 1 && autoSettings.sourceAccountCount !== -1 && (
                    <p className="text-[10px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                      سيتم استخدام الحساب الرئيسي + {autoSettings.sourceAccountCount - 1} حساب إضافي.
                      إن كان عدد الحسابات المتوفرة أقل، يستخدم النظام جميعها تلقائياً.
                    </p>
                  )}
                  {autoSettings.sourceAccountCount === -1 && (
                    <p className="text-[10px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                      سيتم جلب الروابط من جميع الحسابات المتاحة بالتناوب.
                    </p>
                  )}
                </div>

                {/* نوع الروابط */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block font-medium">نوع الروابط للانضمام التلقائي</label>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { id: 'whatsapp_group',   label: '💬 مجموعات واتساب' },
                      { id: 'whatsapp_channel', label: '📢 قنوات واتساب' },
                      { id: 'telegram_group',   label: '✈️ مجموعات تيليجرام' },
                    ].map(t => (
                      <button
                        key={t.id}
                        onClick={() => setAutoSettings(p => ({
                          ...p,
                          linkTypes: p.linkTypes.includes(t.id)
                            ? p.linkTypes.filter(x => x !== t.id)
                            : [...p.linkTypes, t.id]
                        }))}
                        className={cn(
                          'px-3 py-1.5 rounded-xl text-xs font-bold border transition-all',
                          autoSettings.linkTypes.includes(t.id)
                            ? 'text-white border-transparent'
                            : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-violet-500/40'
                        )}
                        style={autoSettings.linkTypes.includes(t.id)
                          ? { background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)' }
                          : {}
                        }
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* التأخير والحد الأقصى */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">التأخير (ثانية)</label>
                    <input
                      type="number" min={5}
                      value={autoSettings.delaySeconds}
                      onChange={e => setAutoSettings(p => ({ ...p, delaySeconds: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">الحد الأقصى/تشغيل</label>
                    <input
                      type="number" min={1}
                      value={autoSettings.maxPerRun}
                      onChange={e => setAutoSettings(p => ({ ...p, maxPerRun: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                    />
                  </div>
                </div>

                {/* فترة التكرار وتوزيع الحسابات */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">فترة التكرار (دقيقة)</label>
                    <input
                      type="number" min={1}
                      value={autoSettings.intervalMinutes}
                      onChange={e => setAutoSettings(p => ({ ...p, intervalMinutes: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">توزيع الحسابات</label>
                    <select
                      value={autoSettings.distributionMode}
                      onChange={e => setAutoSettings(p => ({ ...p, distributionMode: e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                    >
                      <option value="single">حساب واحد</option>
                      <option value="pair">حسابان</option>
                      <option value="multiple">حسابات محددة</option>
                      <option value="all">كل الحسابات</option>
                    </select>
                  </div>
                </div>

                {/* تأخير عشوائي */}
                <label className="flex items-center gap-2.5 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={autoSettings.randomDelay}
                    onChange={e => setAutoSettings(p => ({ ...p, randomDelay: e.target.checked }))}
                    className="w-4 h-4 rounded accent-violet-500"
                  />
                  <span className="text-sm text-[var(--text-secondary)]">تفعيل التأخير العشوائي لتجنب الحظر</span>
                </label>

                {autoSettings.randomDelay && (
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1.5 block font-medium">الحد الأقصى للتأخير العشوائي (ثانية)</label>
                    <input
                      type="number"
                      min={autoSettings.delaySeconds}
                      value={autoSettings.randomDelayMax}
                      onChange={e => setAutoSettings(p => ({ ...p, randomDelayMax: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 focus:border-violet-500 outline-none"
                    />
                  </div>
                )}

                {/* زر حفظ الإعدادات */}
                <button
                  onClick={handleSaveAutoSettings}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white transition-all hover:brightness-110"
                  style={{ background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)' }}
                >
                  <Settings2 className="w-4 h-4" />
                  حفظ الإعدادات
                </button>
              </div>
            </div>

            {/* تحذير هام */}
            <div className="rounded-2xl border border-yellow-500/25 overflow-hidden"
              style={{ background: 'rgba(234,179,8,0.05)' }}
            >
              <div className="flex gap-3 p-4">
                <div className="w-8 h-8 rounded-xl bg-yellow-500/15 flex items-center justify-center shrink-0">
                  <Shield className="w-4 h-4 text-yellow-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-yellow-400 mb-1">تنبيه هام</p>
                  <p className="text-xs text-yellow-300/80 leading-relaxed">
                    الانضمام المتكرر قد يؤدي لحظر الحساب. يُنصح باستخدام تأخير لا يقل عن 30 ثانية بين كل انضمام،
                    وتفعيل التأخير العشوائي لتقليل خطر الحظر.
                  </p>
                </div>
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
