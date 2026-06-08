import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Link as LinkIcon, Shield, ShieldAlert, Star, Search, Download,
  RefreshCw, Trash2, Users, Clock, Calendar, CheckSquare,
  Square, ChevronDown, Activity, Radio, Zap, Globe,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { cn } from '@/utils/cn';
import { API, authFetch } from '@/utils/api';

// ── أنواع ─────────────────────────────────────────────────────────────────
interface LinkRow {
  id: string; url: string; domain: string;
  link_type: string; country: string; keywords: string;
  ai_rating: number; is_spam: boolean;
  extracted_at: string; category_name?: string;
  category_color?: string; group_jid?: string;
}

interface LinkStats {
  total: number; spam: number; safe: number; avgRating: number;
  byType: { link_type: string; cnt: number }[];
  topDomains: { domain: string; cnt: number }[];
  lastDiscovered: string | null;
  monitor?: { active: boolean; messagesScanned: number; linksFound: number; whatsappGroups: number; telegramLinks: number };
}

// ── ثوابت ──────────────────────────────────────────────────────────────────
const LINK_TYPE_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  whatsapp_group:   { label: 'مجموعة واتساب',  color: '#25D366', icon: '💬' },
  whatsapp_channel: { label: 'قناة واتساب',    color: '#34B7F1', icon: '📢' },
  telegram:         { label: 'تيليجرام',        color: '#2AABEE', icon: '✈️' },
  telegram_group:   { label: 'مجموعة تيليجرام', color: '#2AABEE', icon: '✈️' },
  other:            { label: 'أخرى',            color: '#888',    icon: '🔗' },
};

const DELAY_OPTIONS = [
  { label: '10 ثواني', value: 10 },
  { label: '30 ثانية', value: 30 },
  { label: 'دقيقة',    value: 60 },
  { label: '5 دقائق',  value: 300 },
  { label: 'مخصص',     value: -1  },
];

// ══════════════════════════════════════════════════════════════════════════════
//  المكوّن الرئيسي
// ══════════════════════════════════════════════════════════════════════════════
export default function LinkDashboardView({ accountId }: { accountId: string | null }) {

  // ── حالة البيانات ────────────────────────────────────────────────────────
  const [links,        setLinks]        = useState<LinkRow[]>([]);
  const [stats,        setStats]        = useState<LinkStats | null>(null);
  const [categories,   setCategories]   = useState<any[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);

  // ── حالة الفلاتر ─────────────────────────────────────────────────────────
  const [search,    setSearch]    = useState('');
  const [country,   setCountry]   = useState('');
  const [linkType,  setLinkType]  = useState('');
  const [sortBy,    setSortBy]    = useState('extracted_at');
  const [hideSpam,  setHideSpam]  = useState(false);
  const searchTimeout = useRef<any>(null);

  // ── حالة التحديد والانضمام ───────────────────────────────────────────────
  const [selected,      setSelected]      = useState<Set<string>>(new Set());
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinLoading,   setJoinLoading]   = useState(false);
  const [joinResult,    setJoinResult]    = useState<any>(null);

  // ── إعدادات الانضمام ─────────────────────────────────────────────────────
  const [joinMode,         setJoinMode]         = useState<'immediate'|'delayed'|'scheduled'>('immediate');
  const [delayOption,      setDelayOption]       = useState(30);
  const [customDelay,      setCustomDelay]       = useState(60);
  const [distributionMode, setDistributionMode]  = useState<'single'|'pair'|'multiple'|'all'>('single');
  const [scheduledAt,      setScheduledAt]       = useState('');

  // ── طابور الانضمام ───────────────────────────────────────────────────────
  const [queue,        setQueue]        = useState<any>(null);
  const [queueVisible, setQueueVisible] = useState(false);

  // ══════════════════════════════════════════════════════════════════════════
  //  جلب البيانات
  // ══════════════════════════════════════════════════════════════════════════
  const fetchLinks = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200', sortBy, sortDir: 'DESC' });
      if (search)   params.set('search',   search);
      if (country)  params.set('country',  country);
      if (linkType) params.set('linkType', linkType);
      if (hideSpam) params.set('hideSpam', 'true');

      const r = await authFetch(`${API}/accounts/${accountId}/links?${params}`);
      const d = await r.json();
      if (d.success) setLinks(d.links || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [accountId, search, country, linkType, hideSpam, sortBy]);

  const fetchStats = useCallback(async () => {
    if (!accountId) return;
    setStatsLoading(true);
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/stats`);
      const d = await r.json();
      if (d.success) setStats(d.stats);
    } catch (e) { console.error(e); }
    finally { setStatsLoading(false); }
  }, [accountId]);

  const fetchQueue = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await authFetch(`${API}/accounts/${accountId}/links/auto-join/queue`);
      const d = await r.json();
      if (d.success) setQueue(d.queue);
    } catch {}
  }, [accountId]);

  useEffect(() => {
    fetchLinks();
    fetchStats();
  }, [fetchLinks, fetchStats]);

  // تحديث البحث بتأخير
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(fetchLinks, 400);
    return () => clearTimeout(searchTimeout.current);
  }, [search]);

  // تحديث الطابور كل 5 ثواني إذا كان ظاهراً
  useEffect(() => {
    if (!queueVisible) return;
    fetchQueue();
    const iv = setInterval(fetchQueue, 5000);
    return () => clearInterval(iv);
  }, [queueVisible, fetchQueue]);

  // ══════════════════════════════════════════════════════════════════════════
  //  إجراءات
  // ══════════════════════════════════════════════════════════════════════════
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const selectAll = () => {
    if (selected.size === links.length) setSelected(new Set());
    else setSelected(new Set(links.map(l => l.id)));
  };

  const handleDelete = async (linkId: string) => {
    if (!confirm('هل تريد حذف هذا الرابط؟')) return;
    await authFetch(`${API}/accounts/${accountId}/links/${linkId}`, { method: 'DELETE' });
    setLinks(prev => prev.filter(l => l.id !== linkId));
    setSelected(prev => { const s = new Set(prev); s.delete(linkId); return s; });
    fetchStats();
  };

  const handleJoinNow = (link: LinkRow) => {
    setSelected(new Set([link.id]));
    setJoinMode('immediate');
    setShowJoinModal(true);
  };

  const handleBulkJoin = () => {
    if (selected.size === 0) return;
    setShowJoinModal(true);
  };

  const submitJoin = async () => {
    if (!accountId || selected.size === 0) return;
    setJoinLoading(true);
    setJoinResult(null);
    try {
      const delaySeconds = delayOption === -1 ? customDelay : delayOption;
      const body: any = {
        linkIds:         Array.from(selected),
        joinMode,
        delaySeconds,
        distributionMode,
        accountIds:      [accountId],
      };
      if (joinMode === 'scheduled' && scheduledAt) {
        body.scheduledAt = new Date(scheduledAt).toISOString();
      }

      const r = await authFetch(
        `${API}/accounts/${accountId}/links/auto-join/bulk`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      const d = await r.json();
      setJoinResult(d);
      if (d.success) {
        setSelected(new Set());
        fetchQueue();
        setQueueVisible(true);
      }
    } catch (e: any) {
      setJoinResult({ success: false, error: e.message });
    }
    setJoinLoading(false);
  };

  const handleExportCSV = () => {
    if (!accountId) return;
    const token = localStorage.getItem('wa_token');
    const url = `${API}/accounts/${accountId}/links/export/csv`;
    const a   = document.createElement('a');
    a.href    = url + `?token=${encodeURIComponent(token || '')}`;
    a.download = `links_${accountId}.csv`;
    a.click();
  };

  const clearQueue = async () => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/links/auto-join/queue`, { method: 'DELETE' });
    fetchQueue();
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  لا يوجد حساب محدد
  // ══════════════════════════════════════════════════════════════════════════
  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <LinkIcon className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            اختر حساب واتساب نشطاً لعرض الروابط الملتقطة ونظام المراقبة.
          </p>
        </div>
      </div>
    );
  }

  // ── إحصائيات نوع الروابط ─────────────────────────────────────────────────
  const typeMap: Record<string, number> = {};
  (stats?.byType || []).forEach(t => { typeMap[t.link_type] = t.cnt; });

  // ══════════════════════════════════════════════════════════════════════════
  //  عرض رئيسي
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden" dir="rtl">

      {/* ── رأس الصفحة ─────────────────────────────────────────────────── */}
      <div className="flex justify-between items-start flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مراقبة الروابط</h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            روابط دعوة المجموعات الملتقطة تلقائياً من رسائل الواتساب
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => { fetchLinks(); fetchStats(); }}
            className="h-9 gap-1.5"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            تحديث
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => { setQueueVisible(v => !v); fetchQueue(); }}
            className={cn('h-9 gap-1.5', queueVisible && 'border-[var(--brand-primary)] text-[var(--brand-primary)]')}
          >
            <Activity className="w-4 h-4" />
            الطابور
            {(queue?.pending || 0) > 0 && (
              <span className="bg-[var(--brand-primary)] text-white text-xs rounded-full px-1.5 py-0.5">
                {queue.pending}
              </span>
            )}
          </Button>
        </div>
      </div>

      {/* ── بطاقات الإحصائيات ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-shrink-0">
        {[
          { label: 'إجمالي الروابط',    value: stats?.total    ?? '…', icon: LinkIcon,    color: 'text-blue-400',   bg: 'bg-blue-400/10'   },
          { label: 'روابط آمنة',         value: stats?.safe     ?? '…', icon: Shield,      color: 'text-green-400',  bg: 'bg-green-400/10'  },
          { label: 'مشبوهة (Spam)',      value: stats?.spam     ?? '…', icon: ShieldAlert, color: 'text-red-400',    bg: 'bg-red-400/10'    },
          { label: 'متوسط التقييم',      value: stats?.avgRating ? `${stats.avgRating}/5` : '…', icon: Star, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-[var(--text-secondary)]">{stat.label}</span>
                <div className="text-2xl font-bold text-[var(--text-primary)] mt-1">
                  {statsLoading ? <span className="opacity-50">…</span> : stat.value}
                </div>
              </div>
              <div className={cn('p-2.5 rounded-xl', stat.bg, stat.color)}>
                <stat.icon className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── توزيع أنواع الروابط ───────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 flex-shrink-0">
          {Object.entries(LINK_TYPE_LABELS).map(([type, cfg]) => (
            <button
              key={type}
              onClick={() => setLinkType(linkType === type ? '' : type)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all',
                linkType === type
                  ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                  : 'border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
            >
              <span>{cfg.icon}</span>
              <span className="flex-1 text-right text-xs">{cfg.label}</span>
              <span className="font-bold text-[var(--text-primary)] text-xs">
                {typeMap[type] || 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── حالة المراقبة ─────────────────────────────────────────────── */}
      {stats?.monitor && (
        <div className="flex-shrink-0 flex items-center gap-4 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)]">
          <div className="flex items-center gap-1.5">
            <span className={cn('w-2 h-2 rounded-full', stats.monitor.active ? 'bg-green-400 animate-pulse' : 'bg-gray-400')} />
            <Radio className="w-3 h-3" />
            <span>{stats.monitor.active ? 'المراقبة نشطة' : 'المراقبة غير نشطة'}</span>
          </div>
          <span className="opacity-30">|</span>
          <span>رسائل مفحوصة: <b className="text-[var(--text-primary)]">{stats.monitor.messagesScanned.toLocaleString()}</b></span>
          <span>روابط مكتشفة: <b className="text-[var(--text-primary)]">{stats.monitor.linksFound.toLocaleString()}</b></span>
          <span>واتساب: <b className="text-green-400">{stats.monitor.whatsappGroups}</b></span>
          <span>تيليجرام: <b className="text-blue-400">{stats.monitor.telegramLinks}</b></span>
        </div>
      )}

      {/* ── طابور الانضمام ─────────────────────────────────────────────── */}
      {queueVisible && queue && (
        <Card className="card flex-shrink-0">
          <CardContent className="p-3">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Activity className={cn('w-4 h-4', queue.processing && 'text-[var(--brand-primary)] animate-pulse')} />
                <span className="font-semibold text-[var(--text-primary)] text-sm">
                  طابور الانضمام التلقائي
                </span>
                {queue.processing && (
                  <Badge variant="outline" className="text-[0.65rem] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-[var(--brand-primary)]">
                    يعالج الآن
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <span>معالج: <b>{queue.totalProcessed || 0}</b></span>
                <span>نجح: <b className="text-green-400">{queue.totalSucceeded || 0}</b></span>
                <span>في الانتظار: <b className="text-yellow-400">{queue.pending}</b></span>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={clearQueue}>
                  مسح الطابور
                </Button>
              </div>
            </div>
            {queue.results && queue.results.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {queue.results.slice().reverse().slice(0, 8).map((r: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={r.result?.success ? 'text-green-400' : 'text-red-400'}>
                      {r.result?.success ? '✅' : '❌'}
                    </span>
                    <span className="text-[var(--text-muted)] font-mono truncate max-w-48 dir-ltr text-left">
                      {r.link?.replace('https://', '')}
                    </span>
                    <span className="text-[var(--text-muted)] mr-auto">
                      {r.accountId?.slice(0, 8)}…
                    </span>
                    {r.result?.error && (
                      <span className="text-red-400 truncate max-w-32">{r.result.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── الجدول الرئيسي ─────────────────────────────────────────────── */}
      <Card className="card flex-1 overflow-hidden flex flex-col min-h-0">
        {/* شريط الأدوات */}
        <div className="p-3 border-b border-[var(--border-default)] bg-[var(--bg-app)] flex flex-wrap gap-2 items-center flex-shrink-0">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              className="input pr-9 h-8 text-sm w-52"
              placeholder="بحث في الروابط..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <select
            className="input h-8 text-sm w-36"
            value={country}
            onChange={e => { setCountry(e.target.value); setTimeout(fetchLinks, 100); }}
          >
            <option value="">كل الدول</option>
            {['Saudi Arabia','UAE','Egypt','Kuwait','Qatar','Bahrain','Oman'].map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            className="input h-8 text-sm w-36"
            value={sortBy}
            onChange={e => { setSortBy(e.target.value); setTimeout(fetchLinks, 100); }}
          >
            <option value="extracted_at">الأحدث</option>
            <option value="ai_rating">أعلى تقييم</option>
            <option value="domain">النطاق</option>
          </select>

          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 rounded"
              checked={hideSpam}
              onChange={e => { setHideSpam(e.target.checked); setTimeout(fetchLinks, 100); }}
            />
            إخفاء المشبوه
          </label>

          <div className="mr-auto flex gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={handleExportCSV}>
              <Download className="w-3.5 h-3.5" /> CSV
            </Button>
            {selected.size > 0 && (
              <Button
                size="sm"
                className="h-8 gap-1 text-xs bg-[var(--brand-secondary)] hover:bg-[var(--brand-secondary)]/90 border-0"
                onClick={handleBulkJoin}
              >
                <Zap className="w-3.5 h-3.5" />
                انضمام تلقائي ({selected.size})
              </Button>
            )}
          </div>
        </div>

        {/* الجدول */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-48 text-[var(--text-muted)]">
              <RefreshCw className="w-5 h-5 animate-spin mr-2" /> تحميل...
            </div>
          ) : links.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-[var(--text-muted)]">
              <LinkIcon className="w-10 h-10 opacity-30" />
              <span className="text-sm">لا توجد روابط بعد — يتم التجميع تلقائياً من الرسائل الواردة</span>
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
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs">الرابط</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs w-28">النوع</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs w-24">الدولة</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs hidden md:table-cell">الكلمات</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs w-20">التقييم</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs w-20">الحالة</TableHead>
                  <TableHead className="text-right py-3 font-semibold text-[var(--text-primary)] text-xs w-32">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map(link => {
                  const typeInfo = LINK_TYPE_LABELS[link.link_type] || LINK_TYPE_LABELS.other;
                  return (
                    <TableRow
                      key={link.id}
                      className={cn(
                        'border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/50 transition-colors',
                        selected.has(link.id) && 'bg-[var(--brand-primary)]/5 border-l-2 border-l-[var(--brand-primary)]'
                      )}
                    >
                      <TableCell className="text-center py-2">
                        <button onClick={() => toggleSelect(link.id)}>
                          {selected.has(link.id)
                            ? <CheckSquare className="w-4 h-4 text-[var(--brand-primary)]" />
                            : <Square className="w-4 h-4 text-[var(--text-muted)]" />}
                        </button>
                      </TableCell>

                      <TableCell className="py-2">
                        <div className="flex flex-col gap-0.5">
                          <a
                            href={link.url.startsWith('http') ? link.url : `https://${link.url}`}
                            target="_blank" rel="noreferrer"
                            className="font-mono text-xs text-[var(--brand-secondary)] hover:underline dir-ltr text-left truncate max-w-52 block"
                          >
                            {link.url.replace('https://', '').replace('http://', '')}
                          </a>
                          {link.group_jid && (
                            <span className="text-[0.65rem] text-[var(--text-muted)]">
                              من: {link.group_jid.replace('@g.us', '')}
                            </span>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="py-2">
                        <div className="flex items-center gap-1">
                          <span className="text-sm">{typeInfo.icon}</span>
                          <span className="text-xs" style={{ color: typeInfo.color }}>
                            {typeInfo.label}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="text-[var(--text-secondary)] text-xs py-2">
                        <div className="flex items-center gap-1">
                          <Globe className="w-3 h-3 opacity-50" />
                          {link.country === 'Unknown' ? '—' : link.country}
                        </div>
                      </TableCell>

                      <TableCell className="py-2 hidden md:table-cell">
                        <span className="text-[var(--text-muted)] text-xs line-clamp-1">
                          {link.keywords || '—'}
                        </span>
                      </TableCell>

                      <TableCell className="py-2">
                        <div className="flex items-center gap-1">
                          <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                          <span className="text-xs font-medium dir-ltr">{link.ai_rating?.toFixed(1) || '—'}</span>
                        </div>
                      </TableCell>

                      <TableCell className="py-2">
                        <Badge variant="outline" className={cn(
                          'text-[0.65rem] border-0 font-medium px-1.5',
                          link.is_spam ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-400'
                        )}>
                          {link.is_spam ? 'مشبوه' : 'آمن'}
                        </Badge>
                      </TableCell>

                      <TableCell className="py-2">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline" size="sm"
                            className="h-6 px-2 text-[0.65rem]"
                            onClick={() => handleJoinNow(link)}
                          >
                            انضمام
                          </Button>
                          <Button
                            variant="outline" size="sm"
                            className="h-6 px-1.5 text-red-400 hover:text-red-300 border-red-400/30"
                            onClick={() => handleDelete(link.id)}
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
            {links.length} رابط
          </span>
          {stats?.lastDiscovered && (
            <span>
              آخر اكتشاف: {new Date(stats.lastDiscovered).toLocaleString('ar-SA')}
            </span>
          )}
        </div>
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          مودال الانضمام التلقائي المتقدم
      ══════════════════════════════════════════════════════════════════ */}
      {showJoinModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            {/* رأس المودال */}
            <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
              <div>
                <h2 className="font-bold text-[var(--text-primary)]">نظام الانضمام التلقائي</h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {selected.size} رابط محدد للانضمام
                </p>
              </div>
              <button
                onClick={() => { setShowJoinModal(false); setJoinResult(null); }}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* 1. وضع الانضمام */}
              <div>
                <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">
                  وضع الانضمام
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { v: 'immediate', icon: <Zap className="w-4 h-4" />,      label: 'فوري' },
                    { v: 'delayed',   icon: <Clock className="w-4 h-4" />,     label: 'مؤجل' },
                    { v: 'scheduled', icon: <Calendar className="w-4 h-4" />,  label: 'مجدول' },
                  ].map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setJoinMode(opt.v as any)}
                      className={cn(
                        'flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all text-sm font-medium',
                        joinMode === opt.v
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      {opt.icon}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. الفاصل الزمني (إذا كان مؤجل) */}
              {joinMode === 'delayed' && (
                <div>
                  <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">
                    الفاصل بين كل انضمام
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {DELAY_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setDelayOption(opt.value)}
                        className={cn(
                          'px-2 py-2 rounded-lg border text-xs text-center transition-all',
                          delayOption === opt.value
                            ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] font-semibold'
                            : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {delayOption === -1 && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number" min="1" max="3600"
                        value={customDelay}
                        onChange={e => setCustomDelay(parseInt(e.target.value) || 60)}
                        className="input h-8 w-24 text-sm text-center"
                      />
                      <span className="text-xs text-[var(--text-secondary)]">ثانية</span>
                    </div>
                  )}
                </div>
              )}

              {/* 3. وقت الجدولة (إذا كان مجدول) */}
              {joinMode === 'scheduled' && (
                <div>
                  <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">
                    وقت الانضمام المجدول
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={e => setScheduledAt(e.target.value)}
                    className="input h-9 text-sm w-full"
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
              )}

              {/* 4. توزيع الحسابات */}
              <div>
                <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">
                  <Users className="w-4 h-4 inline mr-1" />
                  توزيع الحسابات
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { v: 'single',   label: 'حساب واحد',      desc: 'حساب محدد فقط' },
                    { v: 'pair',     label: 'حسابان',          desc: 'توزيع على اثنين' },
                    { v: 'multiple', label: 'عدة حسابات',      desc: 'تحديد يدوي' },
                    { v: 'all',      label: 'جميع الحسابات',   desc: 'توزيع تلقائي' },
                  ].map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setDistributionMode(opt.v as any)}
                      className={cn(
                        'flex flex-col items-start gap-0.5 p-3 rounded-xl border transition-all text-right',
                        distributionMode === opt.v
                          ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10'
                          : 'border-[var(--border-default)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      <span className={cn(
                        'text-sm font-semibold',
                        distributionMode === opt.v ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'
                      )}>
                        {opt.label}
                      </span>
                      <span className="text-[0.7rem] text-[var(--text-muted)]">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ملخص العملية */}
              <div className="bg-[var(--bg-elevated)] rounded-xl p-3 text-xs space-y-1 text-[var(--text-secondary)]">
                <div className="flex justify-between">
                  <span>عدد الروابط</span>
                  <span className="font-bold text-[var(--text-primary)]">{selected.size}</span>
                </div>
                <div className="flex justify-between">
                  <span>وضع الانضمام</span>
                  <span className="font-medium text-[var(--brand-primary)]">
                    {joinMode === 'immediate' ? 'فوري' : joinMode === 'delayed' ? `مؤجل ${delayOption === -1 ? customDelay : delayOption}s` : 'مجدول'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>توزيع الحسابات</span>
                  <span className="font-medium">
                    {distributionMode === 'single' ? 'حساب واحد' : distributionMode === 'pair' ? 'حسابان' : distributionMode === 'multiple' ? 'متعدد' : 'الكل'}
                  </span>
                </div>
              </div>

              {/* نتيجة العملية */}
              {joinResult && (
                <div className={cn(
                  'px-4 py-3 rounded-xl text-sm font-medium',
                  joinResult.success ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
                )}>
                  {joinResult.success ? `✅ ${joinResult.message}` : `❌ ${joinResult.error}`}
                </div>
              )}

              {/* زر التنفيذ */}
              <Button
                className="w-full h-10 font-bold gap-2 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90 border-0"
                onClick={submitJoin}
                disabled={joinLoading || (joinMode === 'scheduled' && !scheduledAt)}
              >
                {joinLoading
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> جاري الجدولة...</>
                  : <><Zap className="w-4 h-4" /> تنفيذ الانضمام التلقائي</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
