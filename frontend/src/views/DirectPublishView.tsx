import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Smartphone, Send, Search, Users, ChevronDown, ChevronUp,
  MessageSquare, UserX, BookOpen, RefreshCw, Clock, AlertTriangle,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

interface Group {
  id: string;
  group_jid: string;
  name: string;
  members_count?: number;
  publish_status?: 'green' | 'yellow' | 'red';
}

interface Ad {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  use_count?: number;
}

interface PublishLogDetail {
  group_jid: string;
  group_sent: number;
  group_failed: number;
  members_targeted: number;
  members_sent: number;
  members_failed: number;
  errors: string[];
}

interface PublishLog {
  id: string;
  status: 'sent' | 'partial' | string;
  ad_name?: string | null;
  ad_names?: string[];
  custom_content?: string;
  target_group_jids: string[];
  groups_targeted?: number;
  groups_sent?: number;
  groups_failed?: number;
  send_to_members: boolean;
  exclude_admins: boolean;
  members_sent: number;
  members_targeted?: number;
  members_failed?: number;
  details?: PublishLogDetail[];
  sent_at: string;
}

// ── Helper: تطبيع استجابة الـ groups بصرف النظر عن شكلها (id أو group_jid) ──
function normalizeGroup(raw: any): Group {
  return {
    id: raw.group_jid || raw.id,
    group_jid: raw.group_jid || raw.id,
    name: raw.name || 'مجموعة بدون اسم',
    members_count: raw.members_count ?? raw.participants_count ?? 0,
    publish_status: raw.publish_status || 'green',
  };
}

export default function DirectPublishView({ accountId, accounts }: { accountId: string | null, accounts: any[] }) {
  // ── المجموعات ──────────────────────────────────────────────────────────────
  const [groups, setGroups]                 = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading]    = useState(false);
  const [groupsError, setGroupsError]        = useState('');
  const [selectedGroups, setSelectedGroups]  = useState<Set<string>>(new Set());
  const [search, setSearch]                  = useState('');
  const [syncing, setSyncing]                = useState(false);
  const [statusFilter, setStatusFilter]      = useState<'all' | 'green' | 'yellow' | 'red'>('all');

  // ── محتوى الرسالة ─────────────────────────────────────────────────────────
  const [message, setMessage]                 = useState('');
  const [useLibraryMode, setUseLibraryMode]    = useState(false); // false = نص يدوي, true = من المكتبة

  // ── مكتبة الإعلانات ───────────────────────────────────────────────────────
  const [ads, setAds]                       = useState<Ad[]>([]);
  const [adsLoading, setAdsLoading]         = useState(false);
  const [selectedAds, setSelectedAds]       = useState<string[]>([]); // ترتيب الاختيار محفوظ
  const [adSearch, setAdSearch]             = useState('');

  // ── خيارات الإرسال ────────────────────────────────────────────────────────
  const [sendToMembers, setSendToMembers]   = useState(false);
  const [excludeAdmins, setExcludeAdmins]   = useState(true);
  const [memberDelaySec, setMemberDelaySec] = useState(2);   // ثوانٍ بين كل رسالة خاصة
  const [adDelaySec, setAdDelaySec]         = useState(2);   // ثوانٍ بين كل إعلان عند التعدد

  // ── الإرسال والسجل ────────────────────────────────────────────────────────
  const [sending, setSending]               = useState(false);
  const [logs, setLogs]                     = useState<PublishLog[]>([]);
  const [showLog, setShowLog]               = useState(false);
  const [lastResult, setLastResult]         = useState<{ ok: boolean; text: string } | null>(null);
  const [expandedLogId, setExpandedLogId]   = useState<string | null>(null);

  // ── جلب المجموعات: مع مزامنة تلقائية إذا رجعت فارغة لأول مرة ────────────────
  const loadGroups = useCallback(async (forceRefresh = false) => {
    if (!accountId) return;
    if (forceRefresh) setSyncing(true); else setGroupsLoading(true);
    setGroupsError('');
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (forceRefresh) params.set('refresh', '1');
      const url = `${API}/accounts/${accountId}/groups?${params.toString()}`;
      const res  = await authFetch(url);
      const data = await res.json();
      if (data.success) {
        const normalized = (data.groups || []).map(normalizeGroup);
        setGroups(normalized);
        if (data.warning) setGroupsError(data.warning);
      } else {
        setGroupsError(data.error || 'فشل جلب المجموعات');
        setGroups([]);
      }
    } catch (e: any) {
      setGroupsError('خطأ في الاتصال بالخادم أثناء جلب المجموعات');
      setGroups([]);
    } finally {
      setGroupsLoading(false);
      setSyncing(false);
    }
  }, [accountId]);

  const loadAds = useCallback(async () => {
    if (!accountId) return;
    setAdsLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/ads`);
      const data = await res.json();
      if (data.success) setAds((data.ads || []).filter((a: Ad) => a.is_active));
    } catch {
      // تجاهل بصمت — تبقى الكتابة اليدوية متاحة
    } finally {
      setAdsLoading(false);
    }
  }, [accountId]);

  const loadLogs = useCallback(async () => {
    if (!accountId) return;
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/broadcast/log`);
      const data = await res.json();
      if (data.success) setLogs(data.logs || []);
    } catch {
      // تجاهل بصمت
    }
  }, [accountId]);

  // إعادة الضبط وجلب البيانات عند تغيير الحساب
  useEffect(() => {
    setSelectedGroups(new Set());
    setSelectedAds([]);
    setMessage('');
    setUseLibraryMode(false);
    setLastResult(null);
    if (!accountId) return;
    loadGroups(false);
    loadAds();
    loadLogs();
  }, [accountId, loadGroups, loadAds, loadLogs]);

  const toggleGroup = (id: string) => {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const filteredGroups = useMemo(
    () => groups.filter(g => {
      const matchSearch = g.name.toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === 'all' || (g.publish_status || 'green') === statusFilter;
      return matchSearch && matchStatus;
    }),
    [groups, search, statusFilter]
  );

  const toggleAll = () => {
    if (filteredGroups.length > 0 && filteredGroups.every(g => selectedGroups.has(g.id))) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(filteredGroups.map(g => g.id)));
    }
  };

  const filteredAds = useMemo(
    () => ads.filter(a =>
      a.name.toLowerCase().includes(adSearch.toLowerCase()) ||
      (a.content || '').toLowerCase().includes(adSearch.toLowerCase())
    ),
    [ads, adSearch]
  );

  const toggleAd = (id: string) => {
    setSelectedAds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const adShortDesc = (content: string) => {
    const clean = (content || '').replace(/\s+/g, ' ').trim();
    return clean.length > 80 ? clean.slice(0, 80) + '…' : (clean || 'بدون نص');
  };

  const canSend = selectedGroups.size > 0 && !sending &&
    (useLibraryMode ? selectedAds.length > 0 : message.trim().length > 0);

  const handleSend = async () => {
    if (!canSend || !accountId) return;
    setSending(true);
    setLastResult(null);
    try {
      const body: any = {
        target_group_jids: Array.from(selectedGroups),
        send_to_members: sendToMembers,
        exclude_admins: excludeAdmins,
        member_delay_ms: Math.max(0, memberDelaySec) * 1000,
        ad_delay_ms: Math.max(0, adDelaySec) * 1000,
      };
      if (useLibraryMode && selectedAds.length > 0) {
        body.ad_library_ids = selectedAds;
      } else {
        body.custom_content = message;
      }

      const r = await authFetch(`${API}/accounts/${accountId}/broadcast/direct`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        setLastResult({ ok: true, text: d.message || 'تم الإرسال بنجاح' });
        await loadLogs();
        setShowLog(true);
      } else {
        setLastResult({ ok: false, text: d.error || 'فشل الإرسال' });
      }
    } catch (e: any) {
      setLastResult({ ok: false, text: 'خطأ في الإرسال: ' + e.message });
    }
    setSending(false);
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط للبدء في النشر المباشر.</p>
        </div>
      </div>
    );
  }

  const selectedAccount = accounts.find(a => a.id === accountId);

  return (
    <div className="flex flex-col gap-4 h-full flex-1">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">النشر المباشر</h1>
          <p className="text-[var(--text-secondary)] mt-1">إرسال رسالة فورية للمجموعات المحددة عبر {selectedAccount?.name}</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 flex-1 overflow-hidden">

        {/* Left: Groups */}
        <Card className="card w-full lg:w-1/3 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[var(--border-default)] bg-[var(--bg-app)]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--text-muted)]" /> المجموعات
                {selectedGroups.size > 0 && (
                  <Badge className="bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-0">{selectedGroups.size} محددة</Badge>
                )}
              </h3>
              <button
                onClick={() => loadGroups(true)}
                disabled={syncing}
                title="إعادة المزامنة من واتساب"
                className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] disabled:opacity-50"
              >
                <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
              </button>
            </div>
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input className="input pr-9 bg-[var(--bg-surface)]" placeholder="بحث في المجموعات..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {/* فلتر الحالة */}
            <div className="flex gap-1 mt-2">
              {([
                { key: 'all',    label: 'الكل' },
                { key: 'green',  label: 'غير مقيدة',  color: 'bg-green-500/10 text-green-500 border-green-500/30' },
                { key: 'yellow', label: 'مقيدة',       color: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30' },
                { key: 'red',    label: 'محظورة',      color: 'bg-red-500/10 text-red-500 border-red-500/30' },
              ] as const).map(({ key, label, color }) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className={cn(
                    'flex-1 text-[10px] font-medium px-1 py-1 rounded-lg border transition-all',
                    statusFilter === key
                      ? (color || 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-[var(--brand-primary)]/30')
                      : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {groupsError && (
            <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              <p className="text-xs text-yellow-500">{groupsError}</p>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {groupsLoading || syncing ? (
              <div className="flex flex-col gap-2 p-2">
                {[...Array(5)].map((_, i) => <div key={i} className="h-14 bg-[var(--bg-elevated)] rounded-lg animate-pulse" />)}
                {syncing && <p className="text-center text-xs text-[var(--text-muted)] mt-2">جاري المزامنة مع واتساب...</p>}
              </div>
            ) : (
              <>
                <label onClick={toggleAll} className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer">
                  <input type="checkbox" readOnly checked={filteredGroups.length > 0 && filteredGroups.every(g => selectedGroups.has(g.id))} className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
                  <span className="font-bold text-[var(--brand-primary)]">تحديد الكل ({filteredGroups.length})</span>
                </label>
                <div className="w-full h-px bg-[var(--border-default)] my-1" />
                {filteredGroups.length === 0 && (
                  <div className="text-center py-8 px-4">
                    <p className="text-sm text-[var(--text-muted)]">لا توجد مجموعات</p>
                    <button onClick={() => loadGroups(true)} className="text-xs text-[var(--brand-primary)] mt-2 hover:underline">
                      اضغط لإعادة المزامنة من واتساب
                    </button>
                  </div>
                )}
                {filteredGroups.map(g => (
                  <label key={g.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer transition-colors">
                    <input type="checkbox" checked={selectedGroups.has(g.id)} onChange={() => toggleGroup(g.id)} className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-[var(--text-primary)] text-sm truncate">{g.name}</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">{g.members_count || 0} عضو</p>
                    </div>
                    {g.publish_status === 'red' && (
                      <Badge className="bg-red-500/10 text-red-500 border-0 text-[10px] shrink-0">محظورة</Badge>
                    )}
                    {g.publish_status === 'yellow' && (
                      <Badge className="bg-yellow-500/10 text-yellow-500 border-0 text-[10px] shrink-0">مقيدة</Badge>
                    )}
                    {(!g.publish_status || g.publish_status === 'green') && (
                      <Badge className="bg-green-500/10 text-green-500 border-0 text-[10px] shrink-0">نشطة</Badge>
                    )}
                  </label>
                ))}
              </>
            )}
          </div>
        </Card>

        {/* Right: Message + Options */}
        <Card className="card w-full lg:w-2/3 flex flex-col overflow-hidden">
          <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-6">

            {/* محتوى الرسالة */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[var(--text-primary)]">محتوى الرسالة</label>
                <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                  <button
                    onClick={() => setUseLibraryMode(false)}
                    className={cn('px-3 py-1 text-xs font-medium rounded-md transition-colors', !useLibraryMode ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}
                  >
                    نص يدوي
                  </button>
                  <button
                    onClick={() => setUseLibraryMode(true)}
                    className={cn('px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1', useLibraryMode ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}
                  >
                    <BookOpen className="w-3 h-3" /> من المكتبة
                  </button>
                </div>
              </div>

              {!useLibraryMode ? (
                <textarea
                  className="input min-h-[120px] font-mono text-sm leading-relaxed"
                  placeholder="اكتب رسالتك هنا..."
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                />
              ) : (
                <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
                  <div className="p-3 border-b border-[var(--border-default)] bg-[var(--bg-app)] flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2 shrink-0">
                      <BookOpen className="w-4 h-4 text-[var(--brand-primary)]" /> اختر إعلانًا من مكتبة الإعلانات
                    </h4>
                    {selectedAds.length > 0 && (
                      <Badge className="bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-0 shrink-0">{selectedAds.length} محدد</Badge>
                    )}
                  </div>
                  <div className="p-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
                    <div className="relative">
                      <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
                      <input
                        className="input h-8 pr-8 text-sm bg-[var(--bg-app)]"
                        placeholder="بحث في الإعلانات..."
                        value={adSearch}
                        onChange={e => setAdSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto flex flex-col">
                    {adsLoading && <p className="text-center text-xs text-[var(--text-muted)] py-6">جاري تحميل الإعلانات...</p>}
                    {!adsLoading && filteredAds.length === 0 && (
                      <p className="text-center text-xs text-[var(--text-muted)] py-6">لا توجد إعلانات نشطة في المكتبة</p>
                    )}
                    {filteredAds.map(ad => {
                      const order = selectedAds.indexOf(ad.id);
                      const isSelected = order !== -1;
                      return (
                        <label
                          key={ad.id}
                          className={cn(
                            'flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 cursor-pointer transition-colors',
                            isSelected ? 'bg-[var(--brand-primary)]/5' : 'hover:bg-[var(--bg-elevated)]'
                          )}
                        >
                          <input type="checkbox" checked={isSelected} onChange={() => toggleAd(ad.id)} className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)] shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-[var(--text-primary)] text-sm truncate">{ad.name}</p>
                            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{adShortDesc(ad.content)}</p>
                          </div>
                          {isSelected && (
                            <Badge className="bg-[var(--brand-primary)] text-white border-0 text-[10px] shrink-0">{order + 1}</Badge>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  {selectedAds.length > 1 && (
                    <div className="p-2 border-t border-[var(--border-default)] bg-[var(--bg-app)] flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                      <span className="text-xs text-[var(--text-muted)] shrink-0">التأخير بين الإعلانات:</span>
                      <input
                        type="number" min={0} max={120}
                        value={adDelaySec}
                        onChange={e => setAdDelaySec(Math.max(0, parseInt(e.target.value) || 0))}
                        className="input h-7 w-16 text-xs text-center bg-[var(--bg-surface)]"
                      />
                      <span className="text-xs text-[var(--text-muted)]">ثانية</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* خيارات الإرسال */}
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border-default)] pb-2">خيارات الإرسال</h4>

              {/* Toggle: إرسال للمجموعة (دائم) */}
              <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">النشر في المجموعة</p>
                    <p className="text-xs text-[var(--text-muted)]">إرسال الرسالة لـ chat المجموعة</p>
                  </div>
                </div>
                <div className="w-10 h-6 bg-[var(--brand-primary)] rounded-full relative opacity-50 cursor-not-allowed">
                  <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                </div>
              </div>

              {/* Toggle: إرسال للأعضاء خاص */}
              <div
                onClick={() => setSendToMembers(!sendToMembers)}
                className={cn(
                  'flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all',
                  sendToMembers
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                    : 'border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', sendToMembers ? 'bg-[var(--brand-primary)]/10' : 'bg-[var(--bg-surface)]')}>
                    <MessageSquare className={cn('w-4 h-4', sendToMembers ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]')} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">إرسال للأعضاء (خاص)</p>
                    <p className="text-xs text-[var(--text-muted)]">إرسال رسالة خاصة لكل عضو في المجموعة</p>
                  </div>
                </div>
                <div className={cn('w-10 h-6 rounded-full relative transition-colors', sendToMembers ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                  <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', sendToMembers ? 'right-1' : 'left-1')} />
                </div>
              </div>

              {/* Toggle: استبعاد المشرفين + تأخير الإرسال — يظهر فقط إذا كان sendToMembers مفعلاً */}
              {sendToMembers && (
                <>
                  <div
                    onClick={() => setExcludeAdmins(!excludeAdmins)}
                    className={cn(
                      'flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all mr-6',
                      excludeAdmins
                        ? 'border-orange-500/40 bg-orange-500/5'
                        : 'border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', excludeAdmins ? 'bg-orange-500/10' : 'bg-[var(--bg-surface)]')}>
                        <UserX className={cn('w-4 h-4', excludeAdmins ? 'text-orange-500' : 'text-[var(--text-muted)]')} />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">استبعاد المشرفين</p>
                        <p className="text-xs text-[var(--text-muted)]">لا ترسل للمشرفين (Admins/Creators) عند الإرسال الخاص</p>
                      </div>
                    </div>
                    <div className={cn('w-10 h-6 rounded-full relative transition-colors', excludeAdmins ? 'bg-orange-500' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                      <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', excludeAdmins ? 'right-1' : 'left-1')} />
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] mr-6">
                    <Clock className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    <span className="text-sm text-[var(--text-primary)] flex-1">التأخير بين كل رسالة خاصة</span>
                    <input
                      type="number" min={0} max={60}
                      value={memberDelaySec}
                      onChange={e => setMemberDelaySec(Math.max(0, parseInt(e.target.value) || 0))}
                      className="input h-8 w-16 text-sm text-center bg-[var(--bg-surface)]"
                    />
                    <span className="text-xs text-[var(--text-muted)]">ثانية</span>
                  </div>
                </>
              )}
            </div>

            {/* Summary badge */}
            {selectedGroups.size > 0 && (
              <div className="rounded-xl border border-[var(--brand-primary)]/20 bg-[var(--brand-primary)]/5 p-3 flex items-center gap-3">
                <div className="flex flex-col gap-0.5 flex-1">
                  <p className="text-sm font-medium text-[var(--text-primary)]">ملخص الإرسال</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    ✅ {selectedGroups.size} مجموعة
                    {useLibraryMode && selectedAds.length > 0 && <> &nbsp;•&nbsp; 📚 {selectedAds.length} إعلان بالترتيب</>}
                    {sendToMembers && <> &nbsp;+&nbsp; ✉️ رسائل خاصة لأعضاء كل مجموعة {excludeAdmins ? '(بدون مشرفين)' : '(بما فيهم المشرفين)'}</>}
                  </p>
                </div>
              </div>
            )}

          </div>

          {/* زر الإرسال — ثابت خارج منطقة السكرول */}
          <div className="px-6 pb-4 pt-3 border-t border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0">
            <Button
              disabled={!canSend}
              onClick={handleSend}
              className="w-full h-14 text-lg font-bold shadow-[var(--shadow-glow)] bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e] disabled:opacity-50"
            >
              {sending ? (
                <span className="flex items-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> جاري الإرسال...</span>
              ) : (
                <><Send className="w-5 h-5 ml-2" /> إرسال الآن ({selectedGroups.size} مجموعة{sendToMembers ? ' + أعضاء' : ''})</>
              )}
            </Button>
            {lastResult && (
              <p className={cn('mt-3 text-center text-sm font-medium', lastResult.ok ? 'text-green-500' : 'text-red-500')}>
                {lastResult.text}
              </p>
            )}
          </div>

          {/* Publish Log Strip */}
          <div
            className="border-t border-[var(--border-default)] bg-[var(--bg-app)] p-3 px-6 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-elevated)] transition-colors"
            onClick={() => setShowLog(!showLog)}
          >
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium text-[var(--text-secondary)]">سجل الإرسال ({logs.length})</span>
            </div>
            {showLog ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />}
          </div>
          {showLog && (
            <div className="border-t border-[var(--border-default)] max-h-64 overflow-y-auto bg-[var(--bg-app)]">
              {logs.length === 0 && <p className="text-center text-sm text-[var(--text-muted)] py-6">لا يوجد سجل بعد</p>}
              {logs.map((log) => {
                const isExpanded = expandedLogId === log.id;
                const title = (log.ad_names && log.ad_names.length > 0)
                  ? log.ad_names.join(' + ')
                  : (log.ad_name || 'رسالة مخصصة');
                return (
                  <div key={log.id} className="border-b border-[var(--border-default)] last:border-0">
                    <div
                      className="flex items-center justify-between px-6 py-2.5 cursor-pointer hover:bg-[var(--bg-elevated)]"
                      onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Badge variant="outline" className={cn('border-0 text-xs shrink-0', log.status === 'sent' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500')}>
                          {log.status === 'sent' ? 'أُرسل' : 'جزئي'}
                        </Badge>
                        <span className="text-sm text-[var(--text-primary)] truncate">{title}</span>
                        {log.send_to_members && <Badge className="bg-blue-500/10 text-blue-500 border-0 text-xs shrink-0">+ أعضاء ({log.members_sent || 0})</Badge>}
                      </div>
                      <span className="text-xs text-[var(--text-muted)] shrink-0">{log.groups_targeted ?? log.target_group_jids?.length ?? 0} مجموعة</span>
                    </div>
                    {isExpanded && (
                      <div className="px-6 pb-3 flex flex-col gap-2 bg-[var(--bg-surface)]/40">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                          <div className="flex items-center gap-1.5 text-[var(--text-secondary)]"><Users className="w-3 h-3" /> مجموعات: {log.groups_targeted ?? log.target_group_jids?.length ?? 0}</div>
                          <div className="flex items-center gap-1.5 text-green-500"><CheckCircle2 className="w-3 h-3" /> ناجحة: {log.groups_sent ?? '-'}</div>
                          <div className="flex items-center gap-1.5 text-red-500"><XCircle className="w-3 h-3" /> فاشلة: {log.groups_failed ?? 0}</div>
                          <div className="flex items-center gap-1.5 text-[var(--text-secondary)]"><Clock className="w-3 h-3" /> {new Date(log.sent_at).toLocaleString('ar-SA')}</div>
                        </div>
                        {log.send_to_members && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs border-t border-[var(--border-default)] pt-2">
                            <div className="text-[var(--text-secondary)]">أعضاء مستهدفون: {log.members_targeted ?? 0}</div>
                            <div className="text-green-500">أعضاء تم إرسالهم: {log.members_sent ?? 0}</div>
                            <div className="text-red-500">أعضاء فاشلون: {log.members_failed ?? 0}</div>
                          </div>
                        )}
                        {Array.isArray(log.details) && log.details.some(d => d.errors?.length) && (
                          <div className="border-t border-[var(--border-default)] pt-2 flex flex-col gap-1">
                            {log.details.filter(d => d.errors?.length).map((d, i) => (
                              <div key={i} className="text-xs text-red-400 flex items-start gap-1.5">
                                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>{d.group_jid.split('@')[0]}: {d.errors.join(' / ')}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
