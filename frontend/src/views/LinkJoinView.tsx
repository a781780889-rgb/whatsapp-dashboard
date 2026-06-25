import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitMerge, Search, RefreshCw, Trash2, Users, Clock,
  CheckCircle2, XCircle, AlertCircle, PauseCircle, StopCircle,
  Play, Square, Settings2, BarChart3, Filter, ChevronDown,
  Plus, Upload, Download, Zap, Radio, Activity,
  ArrowRight, Eye, RotateCcw, Shield,
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
//  أنواع
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
}

interface Props {
  accountId: string | null;
  accounts: Account[];
}

// ═══════════════════════════════════════════════════════════════════════
//  إعدادات ثابتة
// ═══════════════════════════════════════════════════════════════════════
const STATUS_CFG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  new:      { label: 'جديد',          color: 'text-blue-400',   bg: 'bg-blue-500/10',   icon: <AlertCircle className="w-3 h-3" /> },
  joined:   { label: 'تم الانضمام',   color: 'text-green-400',  bg: 'bg-green-500/10',  icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:   { label: 'فشل',           color: 'text-red-400',    bg: 'bg-red-500/10',    icon: <XCircle className="w-3 h-3" /> },
  disabled: { label: 'معطل',          color: 'text-yellow-400', bg: 'bg-yellow-500/10', icon: <PauseCircle className="w-3 h-3" /> },
  blocked:  { label: 'محظور',         color: 'text-orange-400', bg: 'bg-orange-500/10', icon: <StopCircle className="w-3 h-3" /> },
};

const TYPE_CFG: Record<string, { label: string; emoji: string }> = {
  whatsapp_group:   { label: 'مجموعة واتساب',  emoji: '💬' },
  whatsapp_channel: { label: 'قناة واتساب',    emoji: '📢' },
  telegram_group:   { label: 'مجموعة تيليجرام', emoji: '✈️' },
  telegram:         { label: 'تيليجرام',        emoji: '✈️' },
  other:            { label: 'أخرى',            emoji: '🔗' },
};

const DELAY_OPTIONS = [
  { label: '10 ثانية', value: 10 },
  { label: '30 ثانية', value: 30 },
  { label: '1 دقيقة',  value: 60 },
  { label: '3 دقائق',  value: 180 },
  { label: '5 دقائق',  value: 300 },
];

const TABS = [
  { id: 'dashboard',   label: 'لوحة التحكم',             icon: BarChart3 },
  { id: 'all',         label: 'جميع الروابط',             icon: GitMerge },
  { id: 'joined',      label: 'تم الانضمام',              icon: CheckCircle2 },
  { id: 'unjoined',    label: 'غير المنضم إليها',         icon: XCircle },
  { id: 'join-engine', label: 'محرك الانضمام',            icon: Zap },
  { id: 'auto-mode',   label: 'الوضع التلقائي',           icon: Radio },
];

// ═══════════════════════════════════════════════════════════════════════
//  مكوّن StatusBadge
// ═══════════════════════════════════════════════════════════════════════
function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.new;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', cfg.color, cfg.bg)}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  مكوّن StatCard
// ═══════════════════════════════════════════════════════════════════════
function StatCard({ label, value, color, icon }: { label: string; value: number | string; color: string; icon: React.ReactNode }) {
  return (
    <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--text-muted)]">{label}</span>
          <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center', color)}>{icon}</span>
        </div>
        <p className={cn('text-2xl font-bold', color)}>{value}</p>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  المكوّن الرئيسي
// ═══════════════════════════════════════════════════════════════════════
export default function LinkJoinView({ accountId, accounts }: Props) {
  const [tab, setTab] = useState('dashboard');

  // بيانات
  const [dashboard, setDashboard]       = useState<Dashboard | null>(null);
  const [allLinks,  setAllLinks]        = useState<JoinLink[]>([]);
  const [joinedLinks, setJoinedLinks]   = useState<JoinLink[]>([]);
  const [unjoinedLinks, setUnjoinedLinks] = useState<JoinLink[]>([]);
  const [history, setHistory]           = useState<any[]>([]);

  // فلاتر
  const [filterAccId,   setFilterAccId]   = useState('');
  const [filterStatus,  setFilterStatus]  = useState('');
  const [filterType,    setFilterType]    = useState('');
  const [searchText,    setSearchText]    = useState('');

  // محرك الانضمام
  const [joinLinks,      setJoinLinks]      = useState('');
  const [joinAccountIds, setJoinAccountIds] = useState<string[]>([]);
  const [joinDelay,      setJoinDelay]      = useState(30);
  const [joinRandomDelay, setJoinRandomDelay] = useState(false);
  const [joinMode,       setJoinMode]       = useState<'single'|'pair'|'multiple'|'all'>('single');
  const [activeJob,      setActiveJob]      = useState<any>(null);
  const [jobId,          setJobId]          = useState<string | null>(null);

  // الوضع التلقائي
  const [autoSettings, setAutoSettings] = useState<AutoSettings>({
    accountIds: [], delaySeconds: 30, randomDelay: false, randomDelayMax: 60,
    linkTypes: ['whatsapp_group'], maxPerRun: 20, intervalMinutes: 5,
    distributionMode: 'all', sourceAccountId: accountId || '',
  });
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStats, setAutoStats] = useState<any>(null);

  // إضافة روابط يدوياً
  const [addLinksText,     setAddLinksText]     = useState('');
  const [addLinksAccount,  setAddLinksAccount]  = useState(accountId || '');
  const [addLinksLoading,  setAddLinksLoading]  = useState(false);

  const [loading, setLoading] = useState(false);
  const [toast,   setToast]   = useState<{ msg: string; type: 'success'|'error' } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Toast ──────────────────────────────────────────────────────────────
  const showToast = (msg: string, type: 'success'|'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Fetch helpers ──────────────────────────────────────────────────────
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
      if (filterStatus) params.set('status', filterStatus);
      if (filterType)   params.set('linkType', filterType);
      if (searchText)   params.set('search', searchText);
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

  // ── Poll job status ────────────────────────────────────────────────────
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

  // ── Initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchDashboard();
    fetchAutoMode();
  }, []); // eslint-disable-line

  useEffect(() => {
    if (tab === 'all')      fetchAllLinks();
    if (tab === 'joined')   fetchJoined();
    if (tab === 'unjoined') fetchUnjoined();
    if (tab === 'auto-mode') fetchAutoMode();
  }, [tab, filterAccId, filterStatus, filterType]); // eslint-disable-line

  // ── تنفيذ الانضمام ────────────────────────────────────────────────────
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

  // ── إضافة روابط يدوياً ────────────────────────────────────────────────
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

  // ── تشغيل/إيقاف الوضع التلقائي ────────────────────────────────────────
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

  // ── حفظ إعدادات الوضع التلقائي ────────────────────────────────────────
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

  // ═══════════════════════════════════════════════════════════════════════
  //  مكوّن الفلاتر المشترك
  // ═══════════════════════════════════════════════════════════════════════
  const Filters = () => (
    <div className="flex flex-wrap gap-3 mb-4">
      <select
        value={filterAccId}
        onChange={e => setFilterAccId(e.target.value)}
        className="flex-1 min-w-[160px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2"
      >
        <option value="">جميع الحسابات</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number || a.id}</option>)}
      </select>

      <select
        value={filterStatus}
        onChange={e => setFilterStatus(e.target.value)}
        className="flex-1 min-w-[130px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2"
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
        className="flex-1 min-w-[160px] bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2"
      >
        <option value="">كل أنواع الروابط</option>
        <option value="whatsapp_group">مجموعة واتساب</option>
        <option value="whatsapp_channel">قناة واتساب</option>
        <option value="telegram_group">مجموعة تيليجرام</option>
        <option value="other">أخرى</option>
      </select>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════
  //  جدول الروابط
  // ═══════════════════════════════════════════════════════════════════════
  const LinksTable = ({ links }: { links: JoinLink[] }) => (
    <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-[var(--bg-elevated)] border-[var(--border-default)]">
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">الرابط</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">النوع</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">الحالة</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">الحساب</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">وقت الانضمام</TableHead>
            <TableHead className="text-right text-[var(--text-muted)] text-xs font-semibold">المحاولات</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {links.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-[var(--text-muted)] py-12">
                لا توجد روابط
              </TableCell>
            </TableRow>
          ) : links.map((link) => {
            const type = TYPE_CFG[link.link_type] || TYPE_CFG.other;
            return (
              <TableRow key={`${link.id}-${link.accountId}`} className="border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/50">
                <TableCell className="font-mono text-xs max-w-[220px]">
                  <div className="truncate text-[var(--text-secondary)]" title={link.url}>{link.url}</div>
                  {link.group_name && <div className="text-[var(--text-muted)] text-xs mt-0.5">{link.group_name}</div>}
                </TableCell>
                <TableCell>
                  <span className="text-sm">{type.emoji} {type.label}</span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={link.status} />
                  {link.join_fail_reason && (
                    <div className="text-red-400 text-xs mt-0.5 max-w-[160px] truncate" title={link.join_fail_reason}>
                      {link.join_fail_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-muted)]">{link.accountName}</TableCell>
                <TableCell className="text-xs text-[var(--text-muted)]">
                  {link.joined_at ? new Date(link.joined_at).toLocaleString('ar') : '—'}
                </TableCell>
                <TableCell className="text-center text-sm font-bold">{link.join_attempts}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-full overflow-hidden" dir="rtl">
      {/* Toast */}
      {toast && (
        <div className={cn(
          'fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-medium transition-all',
          toast.type === 'success' ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'
        )}>{toast.msg}</div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)] shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/20 flex items-center justify-center">
            <GitMerge className="w-5 h-5 text-[var(--brand-primary)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--text-primary)]">الانضمام بالروابط</h1>
            <p className="text-xs text-[var(--text-muted)]">نظام متكامل لإدارة الروابط والانضمام الاحترافي</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* زر إيقاف/تشغيل الكامل */}
          <Button
            size="sm"
            onClick={handleToggleAutoMode}
            className={cn(
              'text-xs gap-1.5 font-bold rounded-xl px-4',
              autoRunning
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                : 'bg-[var(--brand-primary)] text-white'
            )}
          >
            {autoRunning ? <><Square className="w-3.5 h-3.5" /> إيقاف اللوحة</> : <><Play className="w-3.5 h-3.5" /> تشغيل اللوحة</>}
          </Button>

          <Button
            size="sm" variant="outline"
            onClick={() => { fetchDashboard(); if (tab !== 'dashboard') fetchAllLinks(); }}
            className="text-xs rounded-xl border-[var(--border-default)]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Auto Mode Status Bar */}
      {autoRunning && (
        <div className="px-6 py-2 bg-green-500/10 border-b border-green-500/20 flex items-center gap-2 shrink-0">
          <Radio className="w-4 h-4 text-green-400 animate-pulse" />
          <span className="text-green-400 text-sm font-medium">الوضع التلقائي يعمل الآن</span>
          {autoStats && (
            <span className="text-green-300 text-xs mr-auto">
              إجمالي الانضمام: {autoStats.totalJoined} | الفشل: {autoStats.totalFailed} | العمليات: {autoStats.runCount}
            </span>
          )}
        </div>
      )}

      {/* Active Job Progress */}
      {activeJob && activeJob.status === 'running' && (
        <div className="px-6 py-2.5 bg-[var(--brand-primary)]/10 border-b border-[var(--brand-primary)]/20 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-[var(--brand-primary)]">
              <Zap className="w-4 h-4 inline ml-1" />
              جاري الانضمام... {activeJob.done}/{activeJob.total}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              ✅ {activeJob.succeeded || 0} | ❌ {activeJob.failed || 0}
            </span>
          </div>
          <div className="w-full bg-[var(--bg-elevated)] rounded-full h-1.5">
            <div
              className="bg-[var(--brand-primary)] h-1.5 rounded-full transition-all"
              style={{ width: `${activeJob.total > 0 ? (activeJob.done / activeJob.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-[var(--border-default)] px-4 gap-1 shrink-0 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap transition-all border-b-2 -mb-px',
              tab === t.id
                ? 'text-[var(--brand-primary)] border-[var(--brand-primary)]'
                : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)]'
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* ── لوحة التحكم الرئيسية ─────────────────────────────────────── */}
        {tab === 'dashboard' && (
          <div className="space-y-6">
            {/* إحصائيات عامة */}
            {dashboard ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard label="إجمالي الروابط" value={dashboard.totalLinks}  color="text-[var(--brand-primary)]" icon={<GitMerge className="w-4 h-4" />} />
                  <StatCard label="جديدة"           value={dashboard.totalNew}    color="text-blue-400"   icon={<AlertCircle className="w-4 h-4" />} />
                  <StatCard label="تم الانضمام"     value={dashboard.totalJoined} color="text-green-400"  icon={<CheckCircle2 className="w-4 h-4" />} />
                  <StatCard label="فشل"             value={dashboard.totalFailed} color="text-red-400"    icon={<XCircle className="w-4 h-4" />} />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard label="محظور"       value={dashboard.totalBlocked}  color="text-orange-400" icon={<StopCircle className="w-4 h-4" />} />
                  <StatCard label="معطل"        value={dashboard.totalDisabled} color="text-yellow-400" icon={<PauseCircle className="w-4 h-4" />} />
                  <StatCard label="انضمام اليوم" value={dashboard.joinedToday}  color="text-cyan-400"   icon={<Activity className="w-4 h-4" />} />
                  <StatCard label="عدد الحسابات" value={dashboard.accountsCount} color="text-violet-400" icon={<Users className="w-4 h-4" />} />
                </div>

                {/* إحصائيات حسب الحساب */}
                <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
                  <CardContent className="p-4">
                    <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
                      <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                      إحصائيات حسب الحساب
                    </h3>
                    <div className="space-y-3">
                      {dashboard.byAccount.map(acc => (
                        <div key={acc.accountId} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-elevated)]">
                          <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/20 flex items-center justify-center">
                            <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                          </div>
                          <div className="flex-1">
                            <div className="text-sm font-medium">{acc.name}</div>
                            <div className="text-xs text-[var(--text-muted)]">الإجمالي: {acc.total}</div>
                          </div>
                          <div className="flex gap-3 text-xs">
                            <span className="text-blue-400">جديد: {acc.new}</span>
                            <span className="text-green-400">انضم: {acc.joined}</span>
                            <span className="text-red-400">فشل: {acc.failed}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* أنواع الروابط */}
                {dashboard.byType.length > 0 && (
                  <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
                    <CardContent className="p-4">
                      <h3 className="font-semibold text-sm mb-4">الروابط حسب النوع</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {dashboard.byType.map(t => {
                          const cfg = TYPE_CFG[t.link_type] || TYPE_CFG.other;
                          return (
                            <div key={t.link_type} className="flex items-center gap-2 p-3 rounded-xl bg-[var(--bg-elevated)]">
                              <span className="text-xl">{cfg.emoji}</span>
                              <div>
                                <div className="text-xs text-[var(--text-muted)]">{cfg.label}</div>
                                <div className="font-bold text-lg">{t.cnt}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center py-20 text-[var(--text-muted)]">
                <RefreshCw className="w-6 h-6 animate-spin ml-2" /> جاري التحميل...
              </div>
            )}
          </div>
        )}

        {/* ── جميع الروابط ─────────────────────────────────────────────── */}
        {tab === 'all' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-[var(--text-muted)]">
                جميع الروابط ({allLinks.length})
              </h2>
              <Button size="sm" variant="outline" onClick={fetchAllLinks} className="text-xs rounded-xl border-[var(--border-default)]">
                <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              </Button>
            </div>

            <Filters />

            {/* بحث */}
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && fetchAllLinks()}
                placeholder="البحث في الروابط..."
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl pr-10 pl-4 py-2.5"
              />
            </div>

            <LinksTable links={allLinks} />
          </div>
        )}

        {/* ── الروابط التي تم الانضمام إليها ──────────────────────────── */}
        {tab === 'joined' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-[var(--text-muted)]">
                الروابط التي تم الانضمام إليها ({joinedLinks.length})
              </h2>
              <Button size="sm" variant="outline" onClick={fetchJoined} className="text-xs rounded-xl border-[var(--border-default)]">
                <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              </Button>
            </div>

            <div className="flex gap-3 mb-4">
              <select
                value={filterAccId}
                onChange={e => setFilterAccId(e.target.value)}
                className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2"
              >
                <option value="">جميع الحسابات</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
              </select>
            </div>

            <LinksTable links={joinedLinks} />
          </div>
        )}

        {/* ── الروابط غير المنضم إليها ─────────────────────────────────── */}
        {tab === 'unjoined' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-[var(--text-muted)]">
                الروابط غير المنضم إليها ({unjoinedLinks.length})
              </h2>
              <Button size="sm" variant="outline" onClick={fetchUnjoined} className="text-xs rounded-xl border-[var(--border-default)]">
                <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              </Button>
            </div>

            <div className="flex gap-3 mb-4">
              <select
                value={filterAccId}
                onChange={e => setFilterAccId(e.target.value)}
                className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2"
              >
                <option value="">جميع الحسابات</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
              </select>
            </div>

            <LinksTable links={unjoinedLinks} />
          </div>
        )}

        {/* ── محرك الانضمام ────────────────────────────────────────────── */}
        {tab === 'join-engine' && (
          <div className="space-y-5">
            <h2 className="font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--brand-primary)]" />
              محرك الانضمام الاحترافي
            </h2>

            {/* إدخال الروابط */}
            <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
              <CardContent className="p-5 space-y-4">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Plus className="w-4 h-4" /> إضافة روابط للانضمام
                </h3>

                {/* الحساب الرئيسي */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1 block">الحساب الرئيسي</label>
                  <select
                    value={addLinksAccount}
                    onChange={e => setAddLinksAccount(e.target.value)}
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                  >
                    <option value="">اختر حساباً</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
                  </select>
                </div>

                {/* روابط للإضافة */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1 block">الروابط (رابط في كل سطر)</label>
                  <textarea
                    value={addLinksText}
                    onChange={e => setAddLinksText(e.target.value)}
                    rows={5}
                    placeholder="https://chat.whatsapp.com/..."
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 font-mono resize-none"
                    dir="ltr"
                  />
                </div>

                <Button
                  onClick={handleAddLinks}
                  disabled={addLinksLoading || !addLinksText || !addLinksAccount}
                  className="bg-[var(--brand-primary)] text-white text-sm rounded-xl px-5 py-2"
                >
                  {addLinksLoading ? <RefreshCw className="w-4 h-4 animate-spin ml-2" /> : <Upload className="w-4 h-4 ml-2" />}
                  حفظ الروابط في قاعدة البيانات
                </Button>
              </CardContent>
            </Card>

            {/* إعدادات الانضمام */}
            <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
              <CardContent className="p-5 space-y-4">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Settings2 className="w-4 h-4" /> إعدادات الانضمام
                </h3>

                {/* الروابط المُدخلة */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1 block">روابط الانضمام الفورية (رابط في كل سطر)</label>
                  <textarea
                    value={joinLinks}
                    onChange={e => setJoinLinks(e.target.value)}
                    rows={5}
                    placeholder="https://chat.whatsapp.com/..."
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5 font-mono resize-none"
                    dir="ltr"
                  />
                </div>

                {/* توزيع الحسابات */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block">توزيع الحسابات</label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { id: 'single',   label: 'حساب واحد' },
                      { id: 'pair',     label: 'حسابان' },
                      { id: 'multiple', label: 'حسابات محددة' },
                      { id: 'all',      label: 'كل الحسابات' },
                    ].map(m => (
                      <button
                        key={m.id}
                        onClick={() => setJoinMode(m.id as any)}
                        className={cn(
                          'px-3 py-2 rounded-xl text-xs font-medium border transition-all',
                          joinMode === m.id
                            ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                            : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--brand-primary)]/50'
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* اختيار حسابات محددة */}
                {joinMode === 'multiple' && (
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-2 block">اختر الحسابات</label>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {accounts.map(a => (
                        <label key={a.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={joinAccountIds.includes(a.id)}
                            onChange={e => setJoinAccountIds(prev =>
                              e.target.checked ? [...prev, a.id] : prev.filter(id => id !== a.id)
                            )}
                            className="rounded"
                          />
                          <span className="text-sm">{a.name || a.phone_number}</span>
                          <Badge className={cn('text-xs', a.status === 'connected' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400')}>
                            {a.status || 'غير متصل'}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* التأخير */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block">التأخير بين كل انضمام</label>
                  <div className="flex flex-wrap gap-2">
                    {DELAY_OPTIONS.map(d => (
                      <button
                        key={d.value}
                        onClick={() => setJoinDelay(d.value)}
                        className={cn(
                          'px-3 py-1.5 rounded-xl text-xs font-medium border transition-all',
                          joinDelay === d.value
                            ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                            : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--brand-primary)]/50'
                        )}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* تأخير عشوائي */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={joinRandomDelay}
                    onChange={e => setJoinRandomDelay(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm">تفعيل التأخير العشوائي (لتجنب الحظر)</span>
                </label>

                {/* زر الانضمام */}
                <Button
                  onClick={handleExecuteJoin}
                  disabled={loading || !joinLinks || !accountId || (activeJob?.status === 'running')}
                  className="w-full bg-[var(--brand-primary)] text-white text-sm rounded-xl py-2.5 font-bold"
                >
                  {activeJob?.status === 'running' ? (
                    <><RefreshCw className="w-4 h-4 animate-spin ml-2" /> جاري الانضمام...</>
                  ) : (
                    <><Zap className="w-4 h-4 ml-2" /> بدء الانضمام</>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── الوضع التلقائي ───────────────────────────────────────────── */}
        {tab === 'auto-mode' && (
          <div className="space-y-5">
            {/* حالة الوضع التلقائي */}
            <Card className={cn(
              'border-2',
              autoRunning
                ? 'bg-green-500/5 border-green-500/30'
                : 'bg-[var(--bg-surface)] border-[var(--border-default)]'
            )}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center',
                      autoRunning ? 'bg-green-500/20' : 'bg-[var(--bg-elevated)]'
                    )}>
                      <Radio className={cn('w-5 h-5', autoRunning ? 'text-green-400 animate-pulse' : 'text-[var(--text-muted)]')} />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm">الوضع التلقائي</h3>
                      <p className="text-xs text-[var(--text-muted)]">
                        {autoRunning ? 'يعمل في الخلفية ويبحث عن روابط جديدة للانضمام' : 'متوقف'}
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={handleToggleAutoMode}
                    className={cn(
                      'font-bold rounded-xl px-5 py-2 text-sm',
                      autoRunning
                        ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                        : 'bg-[var(--brand-primary)] text-white'
                    )}
                  >
                    {autoRunning ? <><Square className="w-4 h-4 ml-1.5" /> إيقاف</> : <><Play className="w-4 h-4 ml-1.5" /> تشغيل</>}
                  </Button>
                </div>

                {autoStats && autoRunning && (
                  <div className="grid grid-cols-3 gap-3 mt-4">
                    <div className="p-3 rounded-xl bg-[var(--bg-elevated)] text-center">
                      <div className="text-lg font-bold text-green-400">{autoStats.totalJoined || 0}</div>
                      <div className="text-xs text-[var(--text-muted)]">إجمالي الانضمام</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[var(--bg-elevated)] text-center">
                      <div className="text-lg font-bold text-red-400">{autoStats.totalFailed || 0}</div>
                      <div className="text-xs text-[var(--text-muted)]">إجمالي الفشل</div>
                    </div>
                    <div className="p-3 rounded-xl bg-[var(--bg-elevated)] text-center">
                      <div className="text-lg font-bold text-[var(--brand-primary)]">{autoStats.runCount || 0}</div>
                      <div className="text-xs text-[var(--text-muted)]">عدد العمليات</div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* إعدادات الوضع التلقائي */}
            <Card className="bg-[var(--bg-surface)] border border-[var(--border-default)]">
              <CardContent className="p-5 space-y-5">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Settings2 className="w-4 h-4" /> إعدادات الوضع التلقائي
                </h3>

                {/* الحساب الرئيسي للوضع التلقائي */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-1 block">الحساب الرئيسي (مصدر الروابط)</label>
                  <select
                    value={autoSettings.sourceAccountId || ''}
                    onChange={e => setAutoSettings(p => ({ ...p, sourceAccountId: e.target.value }))}
                    className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                  >
                    <option value="">اختر حساباً</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number}</option>)}
                  </select>
                </div>

                {/* نوع الروابط */}
                <div>
                  <label className="text-xs text-[var(--text-muted)] mb-2 block">نوع الروابط للانضمام التلقائي</label>
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
                          'px-3 py-1.5 rounded-xl text-xs font-medium border transition-all',
                          autoSettings.linkTypes.includes(t.id)
                            ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                            : 'border-[var(--border-default)] text-[var(--text-muted)]'
                        )}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* التأخير */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1 block">التأخير بين الانضمامات (ثانية)</label>
                    <input
                      type="number"
                      min={5}
                      value={autoSettings.delaySeconds}
                      onChange={e => setAutoSettings(p => ({ ...p, delaySeconds: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1 block">الحد الأقصى لكل تشغيل</label>
                    <input
                      type="number"
                      min={1}
                      value={autoSettings.maxPerRun}
                      onChange={e => setAutoSettings(p => ({ ...p, maxPerRun: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1 block">فترة التكرار (دقيقة)</label>
                    <input
                      type="number"
                      min={1}
                      value={autoSettings.intervalMinutes}
                      onChange={e => setAutoSettings(p => ({ ...p, intervalMinutes: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1 block">توزيع الحسابات</label>
                    <select
                      value={autoSettings.distributionMode}
                      onChange={e => setAutoSettings(p => ({ ...p, distributionMode: e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                    >
                      <option value="single">حساب واحد</option>
                      <option value="pair">حسابان</option>
                      <option value="multiple">حسابات محددة</option>
                      <option value="all">كل الحسابات</option>
                    </select>
                  </div>
                </div>

                {/* تأخير عشوائي */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoSettings.randomDelay}
                    onChange={e => setAutoSettings(p => ({ ...p, randomDelay: e.target.checked }))}
                    className="rounded"
                  />
                  <span className="text-sm">تفعيل التأخير العشوائي لتجنب الحظر</span>
                </label>

                {autoSettings.randomDelay && (
                  <div>
                    <label className="text-xs text-[var(--text-muted)] mb-1 block">الحد الأقصى للتأخير العشوائي (ثانية)</label>
                    <input
                      type="number"
                      min={autoSettings.delaySeconds}
                      value={autoSettings.randomDelayMax}
                      onChange={e => setAutoSettings(p => ({ ...p, randomDelayMax: +e.target.value }))}
                      className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-primary)] text-sm rounded-xl px-3 py-2.5"
                    />
                  </div>
                )}

                <Button
                  onClick={handleSaveAutoSettings}
                  className="w-full bg-[var(--brand-primary)] text-white text-sm rounded-xl py-2.5 font-bold"
                >
                  <Settings2 className="w-4 h-4 ml-2" /> حفظ الإعدادات
                </Button>
              </CardContent>
            </Card>

            {/* تحذير */}
            <Card className="bg-yellow-500/5 border border-yellow-500/20">
              <CardContent className="p-4 flex gap-3">
                <Shield className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-yellow-400">تنبيه هام</p>
                  <p className="text-xs text-yellow-300/80 mt-1">
                    الانضمام المتكرر قد يؤدي لحظر الحساب. يُنصح باستخدام تأخير لا يقل عن 30 ثانية بين كل انضمام،
                    وتفعيل التأخير العشوائي لتقليل خطر الحظر.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
