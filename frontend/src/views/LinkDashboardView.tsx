import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Link as LinkIcon, Search, Download, RefreshCw, Trash2, Users,
  Clock, Calendar, CheckSquare, Square, Activity, Radio, Zap,
  Globe, Play, StopCircle, Upload, Settings2, BarChart3,
  AlertCircle, CheckCircle2, XCircle, RotateCcw, Filter,
  ChevronDown, Eye, PauseCircle, FileText, Wifi, WifiOff,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { cn } from '@/utils/cn';
import { API, authFetch } from '@/utils/api';

// ═══════════════════════════════════════════════════════════════════════
//  أنواع
// ═══════════════════════════════════════════════════════════════════════
interface DiscoveredLink {
  id: string;
  url: string;
  group_name?: string;
  link_type: string;
  group_jid?: string;
  discovered_by_account?: string;
  status: 'new' | 'joined' | 'failed' | 'disabled' | 'blocked';
  join_account_used?: string;
  joined_at?: string;
  join_fail_reason?: string;
  join_attempts: number;
  discovered_at: string;
}

interface ScanJob {
  status: 'idle' | 'running' | 'finished' | 'stopped' | 'error';
  progress: number;
  total: number;
  scanned: number;
  found: number;
  duplicates: number;
  currentChat: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  log: { ts: string; msg: string; url?: string }[];
}

interface DiscoveredStats {
  total: number;
  new: number;
  joined: number;
  failed: number;
  disabled: number;
  blocked: number;
  duplicates: number;
  lastDiscovered: string | null;
  byType: { link_type: string; cnt: number }[];
  joinedToday: number;
  failedToday: number;
  scan: ScanJob;
}

interface Account {
  id: string;
  name?: string;
  phone_number?: string;
  status?: string;
}

// ═══════════════════════════════════════════════════════════════════════
//  ثوابت
// ═══════════════════════════════════════════════════════════════════════
const LINK_TYPE_CFG: Record<string, { label: string; color: string; icon: string }> = {
  whatsapp_group:   { label: 'مجموعة واتساب',  color: '#25D366', icon: '💬' },
  whatsapp_channel: { label: 'قناة واتساب',    color: '#34B7F1', icon: '📢' },
  telegram_group:   { label: 'مجموعة تيليجرام', color: '#2AABEE', icon: '✈️' },
  telegram:         { label: 'تيليجرام',        color: '#2AABEE', icon: '✈️' },
  other:            { label: 'أخرى',            color: '#888',    icon: '🔗' },
};

const STATUS_CFG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  new:      { label: 'جديد',        color: 'text-blue-400',   icon: <AlertCircle className="w-3 h-3" /> },
  joined:   { label: 'تم الانضمام', color: 'text-green-400',  icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:   { label: 'فشل',         color: 'text-red-400',    icon: <XCircle className="w-3 h-3" /> },
  disabled: { label: 'معطل',        color: 'text-yellow-400', icon: <PauseCircle className="w-3 h-3" /> },
  blocked:  { label: 'محظور',       color: 'text-orange-400', icon: <StopCircle className="w-3 h-3" /> },
};

const DELAY_OPTIONS = [
  { label: '10 ث', value: 10 },
  { label: '30 ث', value: 30 },
  { label: '1 د',  value: 60 },
  { label: '3 د',  value: 180 },
  { label: '5 د',  value: 300 },
  { label: 'مخصص', value: -1 },
];

// ═══════════════════════════════════════════════════════════════════════
//  المكوّن الرئيسي
// ═══════════════════════════════════════════════════════════════════════
export default function LinkDashboardView({ accountId }: { accountId: string | null }) {

  // ── علامة التبويب النشطة
  const [activeTab, setActiveTab] = useState<'links' | 'join' | 'settings' | 'log'>('links');

  // ── بيانات
  const [links,    setLinks]    = useState<DiscoveredLink[]>([]);
  const [stats,    setStats]    = useState<DiscoveredStats | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [history,  setHistory]  = useState<any[]>([]);

  // ── تحميل
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);

  // ── فلاتر
  const [search,    setSearch]   = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType,   setFilterType]   = useState('');
  const [sortBy,    setSortBy]   = useState('discovered_at');
  const searchRef = useRef<any>(null);

  // ── تحديد الروابط
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── حالة الفحص
  const [scanJob, setScanJob] = useState<ScanJob | null>(null);
  const [scanAccounts, setScanAccounts] = useState<string[]>([]);
  const scanPollRef = useRef<any>(null);

  // ── حالة الانضمام
  const [joinAccounts,    setJoinAccounts]    = useState<string[]>([]);
  const [joinDelay,       setJoinDelay]       = useState(30);
  const [customDelay,     setCustomDelay]     = useState(60);
  const [randomDelay,     setRandomDelay]     = useState(false);
  const [joinRunning,     setJoinRunning]     = useState(false);
  const [joinResult,      setJoinResult]      = useState<any>(null);
  const [showJoinModal,   setShowJoinModal]   = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importRaw,       setImportRaw]       = useState('');
  const [importResult,    setImportResult]    = useState<any>(null);

  // ── إعدادات الانضمام
  const [joinSettings, setJoinSettings] = useState<any>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // ── سجل الانضمام
  const [showLog, setShowLog] = useState(false);

  // ═════════════════════════════════════════════════════════════════════
  //  جلب البيانات
  // ═════════════════════════════════════════════════════════════════════
  const fetchLinks = useCallback(async () => {
    if (!accountId) return;
    setLoadingLinks(true);
    try {
      const params = new URLSearchParams({ limit: '300', sortBy, sortDir: 'DESC' });
      if (search)       params.set('search',   search);
      if (filterStatus) params.set('status',   filterStatus);
      if (filterType)   params.set('linkType', filterType);

      const r = await authFetch(`${API}/accounts/${accountId}/links/discovered?${params}`);
      const d = await r.json();
      if (d.success) setLinks(d.links || []);
    } catch (e) { console.error(e); }
    finally { setLoadingLinks(false); }
  }, [accountId, search, filterStatus, filterType, sortBy]);

  const fetchStats = useCallback(async () => {
    if (!accountId) return;
    setLoadingStats(true);
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/discovered/stats`);
      const d = await r.json();
      if (d.success) {
        setStats(d.stats);
        setScanJob(d.stats.scan || null);
      }
    } catch (e) { console.error(e); }
    finally { setLoadingStats(false); }
  }, [accountId]);

  const fetchAccounts = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/accounts`);
      const d = await r.json();
      if (d.success) setAccounts(d.accounts || []);
    } catch (_) {}
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/join-history?limit=100`);
      const d = await r.json();
      if (d.success) setHistory(d.history || []);
    } catch (_) {}
  }, [accountId]);

  const fetchScanStatus = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/scan/status`);
      const d = await r.json();
      if (d.success) setScanJob(d.job);
      if (d.job?.status === 'finished' || d.job?.status === 'stopped' || d.job?.status === 'error') {
        clearInterval(scanPollRef.current);
        fetchLinks();
        fetchStats();
      }
    } catch (_) {}
  }, [accountId, fetchLinks, fetchStats]);

  useEffect(() => {
    fetchLinks();
    fetchStats();
    fetchAccounts();
  }, [fetchLinks, fetchStats, fetchAccounts]);

  // polling الفحص
  useEffect(() => {
    if (scanJob?.status === 'running') {
      scanPollRef.current = setInterval(fetchScanStatus, 2000);
    } else {
      clearInterval(scanPollRef.current);
    }
    return () => clearInterval(scanPollRef.current);
  }, [scanJob?.status, fetchScanStatus]);

  // بحث بتأخير
  useEffect(() => {
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(fetchLinks, 400);
    return () => clearTimeout(searchRef.current);
  }, [search]);

  // ═════════════════════════════════════════════════════════════════════
  //  إجراءات البحث عن الروابط
  // ═════════════════════════════════════════════════════════════════════
  const handleStartScan = async () => {
    if (!accountId) return;
    const ids = scanAccounts.length > 0 ? scanAccounts : [accountId];
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/scan/start`, {
        method: 'POST',
        body: JSON.stringify({ accountIds: ids }),
      });
      const d = await r.json();
      if (d.success) {
        setScanJob({ status: 'running', progress: 0, total: 0, scanned: 0, found: 0, duplicates: 0, currentChat: null, startedAt: new Date().toISOString(), finishedAt: null, log: [] });
      }
    } catch (e) { console.error(e); }
  };

  const handleStopScan = async () => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/links/scan/stop`, { method: 'POST' });
    fetchScanStatus();
  };

  // ═════════════════════════════════════════════════════════════════════
  //  إجراءات الانضمام
  // ═════════════════════════════════════════════════════════════════════
  const handleJoin = async () => {
    if (!accountId || selected.size === 0) return;
    setJoinRunning(true);
    setJoinResult(null);
    try {
      const ids = joinAccounts.length > 0 ? joinAccounts : [accountId];
      const delay = joinDelay === -1 ? customDelay : joinDelay;
      const r = await authFetch(`${API}/accounts/${accountId}/links/discovered/join`, {
        method: 'POST',
        body: JSON.stringify({
          linkIds:      Array.from(selected),
          accountIds:   ids,
          delaySeconds: delay,
          randomDelay,
          randomDelayMax: delay * 2,
        }),
      });
      const d = await r.json();
      setJoinResult(d);
      if (d.success) {
        setSelected(new Set());
        setShowJoinModal(false);
        setTimeout(() => { fetchLinks(); fetchStats(); }, 2000);
      }
    } catch (e: any) {
      setJoinResult({ success: false, error: e.message });
    }
    setJoinRunning(false);
  };

  const handleImport = async () => {
    if (!accountId || !importRaw.trim()) return;
    setImportResult(null);
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/discovered/import`, {
        method: 'POST',
        body: JSON.stringify({ raw: importRaw }),
      });
      const d = await r.json();
      setImportResult(d);
      if (d.success) {
        setTimeout(() => { fetchLinks(); fetchStats(); setImportRaw(''); setShowImportModal(false); }, 1500);
      }
    } catch (e: any) {
      setImportResult({ success: false, error: e.message });
    }
  };

  // ═════════════════════════════════════════════════════════════════════
  //  إجراءات الروابط
  // ═════════════════════════════════════════════════════════════════════
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };
  const selectAll   = () => setSelected(new Set(selected.size === links.length ? [] : links.map(l => l.id)));
  const selectByStatus = (status: string) => setSelected(new Set(links.filter(l => l.status === status).map(l => l.id)));

  const handleDeleteLink = async (linkId: string) => {
    if (!confirm('هل تريد حذف هذا الرابط؟')) return;
    await authFetch(`${API}/accounts/${accountId}/links/discovered/${linkId}`, { method: 'DELETE' });
    setLinks(prev => prev.filter(l => l.id !== linkId));
    setSelected(prev => { const s = new Set(prev); s.delete(linkId); return s; });
    fetchStats();
  };

  const handleUpdateStatus = async (linkId: string, status: string) => {
    await authFetch(`${API}/accounts/${accountId}/links/discovered/${linkId}/status`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    });
    setLinks(prev => prev.map(l => l.id === linkId ? { ...l, status: status as any } : l));
    fetchStats();
  };

  const handleDeleteDuplicates = async () => {
    if (!confirm('هل تريد حذف جميع الروابط المكررة؟')) return;
    const r = await authFetch(`${API}/accounts/${accountId}/links/discovered/duplicates`, { method: 'DELETE' });
    const d = await r.json();
    if (d.success) { fetchLinks(); fetchStats(); }
  };

  const handleCleanup = async () => {
    if (!confirm('هل تريد حذف الروابط المعطلة القديمة (أكثر من 7 أيام)؟')) return;
    const r = await authFetch(`${API}/accounts/${accountId}/links/discovered/cleanup`, { method: 'DELETE' });
    const d = await r.json();
    if (d.success) { fetchLinks(); fetchStats(); }
  };

  const handleExportCSV = () => {
    if (!accountId) return;
    const token = localStorage.getItem('wa_token');
    const a = document.createElement('a');
    a.href = `${API}/accounts/${accountId}/links/discovered/export/csv?token=${encodeURIComponent(token || '')}`;
    a.download = `discovered_links_${accountId}.csv`;
    a.click();
  };

  // ═════════════════════════════════════════════════════════════════════
  //  عرض: لا يوجد حساب
  // ═════════════════════════════════════════════════════════════════════
  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center" dir="rtl">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <LinkIcon className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            اختر حساب واتساب نشطاً لبدء نظام مراقبة الروابط الاحترافي.
          </p>
        </div>
      </div>
    );
  }

  const scanRunning = scanJob?.status === 'running';
  const scanDone    = scanJob?.status === 'finished';
  const typeMap: Record<string, number> = {};
  (stats?.byType || []).forEach(t => { typeMap[t.link_type] = t.cnt; });

  // ═════════════════════════════════════════════════════════════════════
  //  عرض رئيسي
  // ═════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden" dir="rtl">

      {/* ── رأس الصفحة ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مراقبة الروابط</h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            نظام احترافي لاكتشاف وإدارة روابط دعوة المجموعات والانضمام التلقائي
          </p>
        </div>

        {/* أزرار التحكم الرئيسية */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline" size="sm" className="h-9 gap-1.5"
            onClick={() => { fetchLinks(); fetchStats(); }}
          >
            <RefreshCw className={cn('w-4 h-4', loadingStats && 'animate-spin')} />
            تحديث
          </Button>

          {/* زر البحث التلقائي */}
          {!scanRunning ? (
            <Button
              size="sm" className="h-9 gap-1.5 bg-blue-600 hover:bg-blue-700 border-0"
              onClick={handleStartScan}
            >
              <Search className="w-4 h-4" />
              بدء البحث عن الروابط
            </Button>
          ) : (
            <Button
              size="sm" variant="outline" className="h-9 gap-1.5 border-red-500/50 text-red-400"
              onClick={handleStopScan}
            >
              <StopCircle className="w-4 h-4" />
              إيقاف البحث
            </Button>
          )}

          {/* زر الانضمام */}
          <Button
            size="sm"
            className={cn('h-9 gap-1.5 border-0', selected.size > 0
              ? 'bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90'
              : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}
            onClick={() => selected.size > 0 && setShowJoinModal(true)}
            disabled={selected.size === 0}
          >
            <Zap className="w-4 h-4" />
            بدء الانضمام {selected.size > 0 && `(${selected.size})`}
          </Button>

          {/* استيراد */}
          <Button
            variant="outline" size="sm" className="h-9 gap-1.5"
            onClick={() => setShowImportModal(true)}
          >
            <Upload className="w-4 h-4" />
            استيراد
          </Button>

          {/* تصدير */}
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleExportCSV}>
            <Download className="w-4 h-4" />
            CSV
          </Button>
        </div>
      </div>

      {/* ── شريط تقدم الفحص ─────────────────────────────────────────── */}
      {scanJob && scanJob.status !== 'idle' && (
        <Card className="card flex-shrink-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={cn('w-2 h-2 rounded-full',
                  scanRunning ? 'bg-blue-400 animate-pulse' :
                  scanDone    ? 'bg-green-400' :
                  scanJob.status === 'error' ? 'bg-red-400' : 'bg-yellow-400'
                )} />
                <span className="font-semibold text-sm text-[var(--text-primary)]">
                  {scanRunning ? 'جاري البحث عن الروابط...' :
                   scanDone    ? 'اكتمل الفحص' :
                   scanJob.status === 'stopped' ? 'تم إيقاف الفحص' :
                   'خطأ في الفحص'}
                </span>
                {scanJob.currentChat && scanRunning && (
                  <span className="text-xs text-[var(--text-muted)] truncate max-w-48">
                    الفحص: {scanJob.currentChat}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                <span>مفحوص: <b className="text-[var(--text-primary)]">{scanJob.scanned}/{scanJob.total}</b></span>
                <span>وُجد: <b className="text-green-400">{scanJob.found}</b></span>
                <span>مكرر: <b className="text-yellow-400">{scanJob.duplicates}</b></span>
              </div>
            </div>
            <Progress value={scanJob.progress} className="h-2" />

            {/* آخر سجلات الفحص */}
            {scanJob.log && scanJob.log.length > 0 && (
              <div className="mt-2 space-y-0.5 max-h-20 overflow-y-auto">
                {scanJob.log.slice(-5).reverse().map((entry, i) => (
                  <div key={i} className="text-[0.7rem] text-[var(--text-muted)] flex gap-2">
                    <span className="opacity-50 flex-shrink-0">
                      {new Date(entry.ts).toLocaleTimeString('ar')}
                    </span>
                    <span>{entry.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── اختيار الحسابات للبحث ──────────────────────────────────── */}
      {!scanRunning && accounts.length > 1 && (
        <div className="flex-shrink-0 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-[var(--text-secondary)]">البحث في:</span>
          <button
            onClick={() => setScanAccounts([])}
            className={cn('text-xs px-2.5 py-1 rounded-lg border transition-all',
              scanAccounts.length === 0
                ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                : 'border-[var(--border-default)] text-[var(--text-muted)]'
            )}
          >
            الحساب الحالي
          </button>
          <button
            onClick={() => setScanAccounts(accounts.map(a => a.id))}
            className={cn('text-xs px-2.5 py-1 rounded-lg border transition-all',
              scanAccounts.length === accounts.length
                ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                : 'border-[var(--border-default)] text-[var(--text-muted)]'
            )}
          >
            جميع الحسابات ({accounts.length})
          </button>
          {accounts.slice(0, 5).map(acc => (
            <button
              key={acc.id}
              onClick={() => setScanAccounts(prev =>
                prev.includes(acc.id) ? prev.filter(id => id !== acc.id) : [...prev, acc.id]
              )}
              className={cn('text-xs px-2.5 py-1 rounded-lg border transition-all',
                scanAccounts.includes(acc.id)
                  ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                  : 'border-[var(--border-default)] text-[var(--text-muted)]'
              )}
            >
              {acc.phone_number || acc.name || acc.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      {/* ── بطاقات الإحصائيات ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 flex-shrink-0">
        {[
          { label: 'إجمالي',       value: stats?.total    ?? '…', color: 'text-blue-400',   bg: 'bg-blue-400/10'   },
          { label: 'جديد',          value: stats?.new      ?? '…', color: 'text-sky-400',    bg: 'bg-sky-400/10'    },
          { label: 'تم الانضمام',   value: stats?.joined   ?? '…', color: 'text-green-400',  bg: 'bg-green-400/10'  },
          { label: 'فشل',           value: stats?.failed   ?? '…', color: 'text-red-400',    bg: 'bg-red-400/10'    },
          { label: 'معطل',          value: stats?.disabled ?? '…', color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
          { label: 'محظور',         value: stats?.blocked  ?? '…', color: 'text-orange-400', bg: 'bg-orange-400/10' },
          { label: 'مكرر',          value: stats?.duplicates ?? '…', color: 'text-purple-400', bg: 'bg-purple-400/10' },
        ].map((s, i) => (
          <Card key={i} className="card">
            <CardContent className="p-3">
              <div className="text-[0.65rem] text-[var(--text-muted)] mb-1">{s.label}</div>
              <div className={cn('text-xl font-bold', s.color)}>
                {loadingStats ? '…' : s.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── توزيع أنواع الروابط ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 flex-shrink-0">
        {Object.entries(LINK_TYPE_CFG).map(([type, cfg]) => (
          <button
            key={type}
            onClick={() => setFilterType(filterType === type ? '' : type)}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all',
              filterType === type
                ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                : 'border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
            )}
          >
            <span>{cfg.icon}</span>
            <span className="flex-1 text-right">{cfg.label}</span>
            <span className="font-bold text-[var(--text-primary)]">{typeMap[type] || 0}</span>
          </button>
        ))}
        {/* إحصائيات اليوم */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] text-xs">
          <span className="text-green-400 font-bold">{stats?.joinedToday || 0}</span>
          <span className="text-[var(--text-muted)]">انضم اليوم</span>
          <span className="text-red-400 font-bold mr-2">{stats?.failedToday || 0}</span>
          <span className="text-[var(--text-muted)]">فشل</span>
        </div>
      </div>

      {/* ── الجدول الرئيسي ─────────────────────────────────────────── */}
      <Card className="card flex-1 overflow-hidden flex flex-col min-h-0">

        {/* شريط أدوات الجدول */}
        <div className="p-3 border-b border-[var(--border-default)] flex flex-wrap gap-2 items-center flex-shrink-0">

          {/* بحث */}
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              className="input pr-9 h-8 text-sm w-48"
              placeholder="بحث في الروابط..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* فلتر الحالة */}
          <select
            className="input h-8 text-xs w-32"
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value); setTimeout(fetchLinks, 100); }}
          >
            <option value="">كل الحالات</option>
            <option value="new">جديد</option>
            <option value="joined">تم الانضمام</option>
            <option value="failed">فشل</option>
            <option value="disabled">معطل</option>
            <option value="blocked">محظور</option>
          </select>

          {/* ترتيب */}
          <select
            className="input h-8 text-xs w-32"
            value={sortBy}
            onChange={e => { setSortBy(e.target.value); setTimeout(fetchLinks, 100); }}
          >
            <option value="discovered_at">الأحدث</option>
            <option value="status">الحالة</option>
            <option value="join_attempts">المحاولات</option>
          </select>

          {/* أزرار التحديد */}
          <div className="flex gap-1">
            <button onClick={selectAll} className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              {selected.size === links.length && links.length > 0 ? 'إلغاء الكل' : 'تحديد الكل'}
            </button>
            <button onClick={() => selectByStatus('new')} className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-blue-400">
              الجدد
            </button>
            <button onClick={() => selectByStatus('failed')} className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-red-400">
              الفاشلة
            </button>
          </div>

          <div className="mr-auto flex gap-2">
            {/* حذف المكرر */}
            <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={handleDeleteDuplicates}>
              <Trash2 className="w-3.5 h-3.5" />
              حذف المكرر
            </Button>
            {/* تنظيف */}
            <Button variant="outline" size="sm" className="h-8 gap-1 text-xs text-yellow-400 border-yellow-400/30" onClick={handleCleanup}>
              <Trash2 className="w-3.5 h-3.5" />
              تنظيف
            </Button>
            {/* سجل الانضمام */}
            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-xs"
              onClick={() => { setShowLog(v => !v); fetchHistory(); }}
            >
              <FileText className="w-3.5 h-3.5" />
              السجل
            </Button>
          </div>
        </div>

        {/* سجل الانضمام */}
        {showLog && (
          <div className="border-b border-[var(--border-default)] bg-[var(--bg-app)] p-3 max-h-44 overflow-y-auto">
            <div className="text-xs font-semibold text-[var(--text-primary)] mb-2">سجل الانضمام</div>
            {history.length === 0 ? (
              <div className="text-xs text-[var(--text-muted)] text-center py-4">لا يوجد سجل انضمام بعد</div>
            ) : (
              <div className="space-y-1">
                {history.map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={h.status === 'joined' ? 'text-green-400' : 'text-red-400'}>
                      {h.status === 'joined' ? '✅' : '❌'}
                    </span>
                    <span className="font-mono text-[var(--text-muted)] dir-ltr text-left truncate max-w-48">
                      {h.url?.replace('https://', '').slice(0, 40)}
                    </span>
                    <span className="text-[var(--text-muted)] opacity-60 text-[0.6rem] mr-auto flex-shrink-0">
                      {new Date(h.attempted_at).toLocaleString('ar-SA')}
                    </span>
                    {h.fail_reason && (
                      <span className="text-red-400 text-[0.6rem] truncate max-w-24">{h.fail_reason}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* الجدول */}
        <div className="flex-1 overflow-auto">
          {loadingLinks ? (
            <div className="flex items-center justify-center h-48 text-[var(--text-muted)]">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" /> تحميل...
            </div>
          ) : links.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-[var(--text-muted)]">
              <LinkIcon className="w-10 h-10 opacity-30" />
              <span className="text-sm">لا توجد روابط مكتشفة بعد</span>
              <Button size="sm" className="gap-1.5 bg-blue-600 hover:bg-blue-700 border-0" onClick={handleStartScan}>
                <Search className="w-4 h-4" />
                ابدأ البحث الآن
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-[var(--bg-elevated)] sticky top-0 z-10">
                <TableRow className="border-[var(--border-default)] hover:bg-transparent">
                  <TableHead className="w-10 text-center py-3">
                    <button onClick={selectAll}>
                      {selected.size > 0 && selected.size === links.length
                        ? <CheckSquare className="w-4 h-4 text-[var(--brand-primary)]" />
                        : <Square className="w-4 h-4 text-[var(--text-muted)]" />}
                    </button>
                  </TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold">الرابط</TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold w-28">النوع</TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold w-24">الحالة</TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold w-16 hidden md:table-cell">المحاولات</TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold w-28 hidden lg:table-cell">تاريخ الاكتشاف</TableHead>
                  <TableHead className="text-right py-3 text-xs font-semibold w-36">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map(link => {
                  const typeInfo   = LINK_TYPE_CFG[link.link_type] || LINK_TYPE_CFG.other;
                  const statusInfo = STATUS_CFG[link.status]       || STATUS_CFG.new;
                  return (
                    <TableRow
                      key={link.id}
                      className={cn(
                        'border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/50 transition-colors',
                        selected.has(link.id) && 'bg-[var(--brand-primary)]/5 border-l-2 border-l-[var(--brand-primary)]'
                      )}
                    >
                      {/* تحديد */}
                      <TableCell className="text-center py-2">
                        <button onClick={() => toggleSelect(link.id)}>
                          {selected.has(link.id)
                            ? <CheckSquare className="w-4 h-4 text-[var(--brand-primary)]" />
                            : <Square className="w-4 h-4 text-[var(--text-muted)]" />}
                        </button>
                      </TableCell>

                      {/* الرابط */}
                      <TableCell className="py-2">
                        <div className="flex flex-col gap-0.5">
                          <a
                            href={link.url.startsWith('http') ? link.url : `https://${link.url}`}
                            target="_blank" rel="noreferrer"
                            className="font-mono text-xs text-[var(--brand-secondary)] hover:underline dir-ltr text-left truncate max-w-52 block"
                          >
                            {link.url.replace('https://', '').replace('http://', '').slice(0, 55)}
                          </a>
                          {link.group_name && (
                            <span className="text-[0.6rem] text-[var(--text-muted)]">
                              من: {link.group_name}
                            </span>
                          )}
                          {link.join_fail_reason && (
                            <span className="text-[0.6rem] text-red-400 truncate max-w-48">
                              ⚠ {link.join_fail_reason}
                            </span>
                          )}
                        </div>
                      </TableCell>

                      {/* النوع */}
                      <TableCell className="py-2">
                        <div className="flex items-center gap-1">
                          <span>{typeInfo.icon}</span>
                          <span className="text-xs" style={{ color: typeInfo.color }}>{typeInfo.label}</span>
                        </div>
                      </TableCell>

                      {/* الحالة */}
                      <TableCell className="py-2">
                        <div className={cn('flex items-center gap-1 text-xs font-medium', statusInfo.color)}>
                          {statusInfo.icon}
                          {statusInfo.label}
                        </div>
                      </TableCell>

                      {/* المحاولات */}
                      <TableCell className="py-2 hidden md:table-cell">
                        <span className="text-xs text-[var(--text-muted)]">{link.join_attempts}</span>
                      </TableCell>

                      {/* التاريخ */}
                      <TableCell className="py-2 hidden lg:table-cell">
                        <span className="text-[0.65rem] text-[var(--text-muted)]">
                          {new Date(link.discovered_at).toLocaleDateString('ar-SA')}
                        </span>
                      </TableCell>

                      {/* الإجراءات */}
                      <TableCell className="py-2">
                        <div className="flex items-center gap-1">
                          {/* انضمام */}
                          <Button
                            variant="outline" size="sm" className="h-6 px-2 text-[0.65rem]"
                            onClick={() => { setSelected(new Set([link.id])); setShowJoinModal(true); }}
                          >
                            <Zap className="w-3 h-3 ml-0.5" /> انضمام
                          </Button>
                          {/* إعادة */}
                          {link.status === 'failed' && (
                            <Button
                              variant="outline" size="sm" className="h-6 px-1.5 text-yellow-400 border-yellow-400/30"
                              onClick={() => handleUpdateStatus(link.id, 'new')}
                            >
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                          {/* تجاهل */}
                          {link.status === 'new' && (
                            <Button
                              variant="outline" size="sm" className="h-6 px-1.5 text-[var(--text-muted)]"
                              onClick={() => handleUpdateStatus(link.id, 'disabled')}
                            >
                              <PauseCircle className="w-3 h-3" />
                            </Button>
                          )}
                          {/* حذف */}
                          <Button
                            variant="outline" size="sm" className="h-6 px-1.5 text-red-400 border-red-400/30"
                            onClick={() => handleDeleteLink(link.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {/* تذييل الجدول */}
        <div className="border-t border-[var(--border-default)] px-4 py-2 flex items-center justify-between text-xs text-[var(--text-muted)] flex-shrink-0">
          <span>
            {selected.size > 0 && (
              <span className="text-[var(--brand-primary)] font-medium">{selected.size} محدد • </span>
            )}
            {links.length} رابط مكتشف
          </span>
          {stats?.lastDiscovered && (
            <span>آخر اكتشاف: {new Date(stats.lastDiscovered).toLocaleString('ar-SA')}</span>
          )}
        </div>
      </Card>

      {/* ═══════════════════════════════════════════════════════════════
          مودال الانضمام التلقائي
      ═══════════════════════════════════════════════════════════════ */}
      {showJoinModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            {/* رأس */}
            <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
              <div>
                <h2 className="font-bold text-[var(--text-primary)]">نظام الانضمام التلقائي</h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{selected.size} رابط محدد</p>
              </div>
              <button onClick={() => { setShowJoinModal(false); setJoinResult(null); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl">✕</button>
            </div>

            <div className="p-5 space-y-4">

              {/* 1. اختيار الحسابات */}
              <div>
                <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1">
                  <Users className="w-4 h-4" /> اختيار حسابات الانضمام
                </label>
                <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto">
                  <button
                    onClick={() => setJoinAccounts([])}
                    className={cn('px-3 py-2 rounded-lg border text-xs text-right transition-all',
                      joinAccounts.length === 0
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)]'
                    )}
                  >
                    الحساب الحالي
                  </button>
                  <button
                    onClick={() => setJoinAccounts(accounts.map(a => a.id))}
                    className={cn('px-3 py-2 rounded-lg border text-xs text-right transition-all',
                      joinAccounts.length === accounts.length && accounts.length > 0
                        ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)]'
                    )}
                  >
                    جميع الحسابات ({accounts.length})
                  </button>
                  {accounts.map(acc => (
                    <button
                      key={acc.id}
                      onClick={() => setJoinAccounts(prev =>
                        prev.includes(acc.id) ? prev.filter(id => id !== acc.id) : [...prev, acc.id]
                      )}
                      className={cn('px-3 py-2 rounded-lg border text-xs text-right flex items-center gap-1.5 transition-all',
                        joinAccounts.includes(acc.id)
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)]'
                      )}
                    >
                      {acc.status === 'connected'
                        ? <Wifi className="w-3 h-3 text-green-400" />
                        : <WifiOff className="w-3 h-3 text-red-400" />}
                      {acc.phone_number || acc.name || acc.id.slice(0, 12)}
                    </button>
                  ))}
                </div>
                {(joinAccounts.length > 0 || accounts.length > 0) && (
                  <div className="text-xs text-[var(--text-muted)] mt-1.5">
                    محدد: <b className="text-[var(--text-primary)]">{joinAccounts.length || 1}</b> حساب
                  </div>
                )}
              </div>

              {/* 2. التأخير */}
              <div>
                <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1">
                  <Clock className="w-4 h-4" /> التأخير بين الروابط
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  {DELAY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setJoinDelay(opt.value)}
                      className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all',
                        joinDelay === opt.value
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] font-semibold'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)]'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {joinDelay === -1 && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number" min="5" max="3600"
                      value={customDelay}
                      onChange={e => setCustomDelay(parseInt(e.target.value) || 60)}
                      className="input h-8 w-20 text-sm text-center"
                    />
                    <span className="text-xs text-[var(--text-secondary)]">ثانية</span>
                  </div>
                )}

                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox" className="w-3.5 h-3.5 rounded"
                    checked={randomDelay}
                    onChange={e => setRandomDelay(e.target.checked)}
                  />
                  <span className="text-xs text-[var(--text-secondary)]">تأخير عشوائي (حماية من الحظر)</span>
                </label>
              </div>

              {/* ملخص */}
              <div className="bg-[var(--bg-elevated)] rounded-xl p-3 text-xs space-y-1 text-[var(--text-secondary)]">
                <div className="flex justify-between">
                  <span>عدد الروابط</span>
                  <span className="font-bold text-[var(--text-primary)]">{selected.size}</span>
                </div>
                <div className="flex justify-between">
                  <span>الحسابات</span>
                  <span className="font-medium">{joinAccounts.length || 1}</span>
                </div>
                <div className="flex justify-between">
                  <span>التأخير</span>
                  <span className="font-medium text-[var(--brand-primary)]">
                    {joinDelay === -1 ? customDelay : joinDelay} ثانية {randomDelay ? '(عشوائي)' : ''}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>الوقت التقريبي</span>
                  <span className="font-medium">
                    {Math.round((selected.size * (joinDelay === -1 ? customDelay : joinDelay)) / 60)} دقيقة
                  </span>
                </div>
              </div>

              {/* نتيجة */}
              {joinResult && (
                <div className={cn(
                  'px-4 py-3 rounded-xl text-sm font-medium',
                  joinResult.success
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                )}>
                  {joinResult.success ? `✅ ${joinResult.message}` : `❌ ${joinResult.error}`}
                </div>
              )}

              {/* زر التنفيذ */}
              <Button
                className="w-full h-10 font-bold gap-2 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90 border-0"
                onClick={handleJoin}
                disabled={joinRunning}
              >
                {joinRunning
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> جاري الانضمام...</>
                  : <><Zap className="w-4 h-4" /> بدء الانضمام التلقائي</>}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          مودال استيراد الروابط
      ═══════════════════════════════════════════════════════════════ */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
              <div>
                <h2 className="font-bold text-[var(--text-primary)]">استيراد الروابط</h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">الصق الروابط من ملف CSV أو TXT</p>
              </div>
              <button onClick={() => { setShowImportModal(false); setImportResult(null); setImportRaw(''); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl">✕</button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">
                  الصق الروابط (سطر لكل رابط أو مفصولة بمسافة)
                </label>
                <textarea
                  className="input w-full h-48 text-xs font-mono resize-none"
                  placeholder="https://chat.whatsapp.com/...\nhttps://t.me/..."
                  value={importRaw}
                  onChange={e => setImportRaw(e.target.value)}
                />
                <div className="text-[0.7rem] text-[var(--text-muted)] mt-1">
                  سيتم استخراج روابط واتساب وتيليجرام تلقائياً من النص
                </div>
              </div>

              {importResult && (
                <div className={cn(
                  'px-4 py-3 rounded-xl text-sm font-medium',
                  importResult.success
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                )}>
                  {importResult.success ? `✅ ${importResult.message}` : `❌ ${importResult.error}`}
                </div>
              )}

              <Button
                className="w-full h-10 font-bold gap-2 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90 border-0"
                onClick={handleImport}
                disabled={!importRaw.trim()}
              >
                <Upload className="w-4 h-4" />
                استيراد الروابط
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
