import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Clock, Play, Pause, Zap, RefreshCw,
  ChevronDown, ChevronUp, Send, StopCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Schedule {
  id: string;
  name: string;
  status: string;
  target_group_jids: string[];
  ad_library_ids: string[];
  active_days: number[];
  publish_times: string[];
  max_per_day: number;
  send_to_members: boolean;
}

interface PrivateCampaign {
  id: string;
  name: string;
  status: string;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  interval_seconds: number;
  messages_sent: number | null;
  messages_limit: number | null;
  messages_failed: number | null;
}

interface MonitorData {
  schedules: Schedule[];
  summary: {
    totalSchedules: number;
    activeSchedules: number;
    pausedSchedules: number;
    totalGroupCount: number;
    publishedToday: number;
    remainingGroups: number;
  };
  nextPublish: {
    isoString: string;
    scheduleId: string;
    scheduleName: string;
  } | null;
  privateCampaigns: PrivateCampaign[];
}

interface AccountInfo {
  id: string;
  name?: string;
  phone?: string;
  status?: string;
}

interface Props {
  accounts: AccountInfo[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCountdown(targetIso: string): string {
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return '00:00:00';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ar-SA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function statusColor(status: string) {
  if (status === 'active' || status === 'running') return 'text-green-400';
  if (status === 'paused') return 'text-yellow-400';
  return 'text-red-400';
}

function statusBg(status: string) {
  if (status === 'active' || status === 'running') return 'bg-green-500/10 border-green-500/20 text-green-400';
  if (status === 'paused') return 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400';
  return 'bg-red-500/10 border-red-500/20 text-red-400';
}

function statusLabel(status: string) {
  if (status === 'active' || status === 'running') return 'نشط';
  if (status === 'paused') return 'موقوف';
  if (status === 'draft') return 'مسودة';
  if (status === 'completed') return 'مكتمل';
  return status;
}

// ── Countdown Hook ────────────────────────────────────────────────────────────

function useCountdown(targetIso: string | null | undefined): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!targetIso) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  if (!targetIso) return '';
  return formatCountdown(targetIso);
}

// ── Progress Bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, max, color = 'bg-[var(--brand-primary)]' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 bg-[var(--bg-surface)] rounded-full overflow-hidden">
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Account Monitor Card ──────────────────────────────────────────────────────

function AccountMonitorCard({ account }: { account: AccountInfo }) {
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [actionLoading, setActionLoading] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API}/accounts/${account.id}/broadcast/monitor`);
      if (res.ok) {
        const json = await res.json();
        if (json.success) setData(json);
      }
    } catch (e) {
      console.error('[Monitor] load error', e);
    } finally {
      setLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000); // تحديث كل 30 ثانية
    return () => clearInterval(id);
  }, [load]);

  const countdown = useCountdown(data?.nextPublish?.isoString);

  // ── الجدول النشط الأول (للعرض المبسط) ─────────────────────────────────────
  const activeSchedules = data?.schedules.filter(s => s.status === 'active') ?? [];
  const firstActive     = activeSchedules[0];

  // ── إجمالي المجموعات للجداول النشطة ────────────────────────────────────────
  const totalGroups     = data?.summary.totalGroupCount ?? 0;
  const publishedToday  = data?.summary.publishedToday ?? 0;
  const remainingGroups = data?.summary.remainingGroups ?? 0;

  // ── الحملة الخاصة النشطة (أو آخر واحدة) ───────────────────────────────────
  const activeCampaign  = data?.privateCampaigns.find(c => c.status === 'running')
                       ?? data?.privateCampaigns[0];

  const privateTotal    = activeCampaign?.total_targets ?? 0;
  const privateSent     = activeCampaign?.sent_count ?? 0;
  const privateRemaining = Math.max(0, privateTotal - privateSent);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleGroupAction = async (action: 'publish-now' | 'pause' | 'resume') => {
    if (!firstActive && action !== 'publish-now') return;
    setActionLoading(action);
    try {
      if (action === 'publish-now' && firstActive) {
        await authFetch(`${API}/accounts/${account.id}/broadcast/publish-now`, {
          method: 'POST',
          body: JSON.stringify({ scheduleId: firstActive.id }),
        });
      } else if (action === 'pause' && firstActive) {
        await authFetch(`${API}/accounts/${account.id}/broadcast/schedules/${firstActive.id}/pause`, { method: 'POST' });
      } else if (action === 'resume' && firstActive) {
        await authFetch(`${API}/accounts/${account.id}/broadcast/schedules/${firstActive.id}/start`, { method: 'POST' });
      }
      await load();
    } catch (e) {
      console.error('[Monitor] action error', e);
    } finally {
      setActionLoading('');
    }
  };

  const handlePrivateAction = async (action: 'send-now' | 'pause' | 'resume') => {
    if (!activeCampaign) return;
    setActionLoading('pc-' + action);
    try {
      if (action === 'pause') {
        await authFetch(`${API}/private-campaigns/${activeCampaign.id}/pause`, { method: 'POST' });
      } else if (action === 'resume') {
        await authFetch(`${API}/private-campaigns/${activeCampaign.id}/start`, { method: 'POST' });
      }
      await load();
    } catch (e) {
      console.error('[Monitor] pc action error', e);
    } finally {
      setActionLoading('');
    }
  };

  const accountStatus = account.status === 'connected' ? 'active' : 'stopped';
  const displayName   = account.name || account.phone || account.id;

  return (
    <Card className="card border border-[var(--border-default)] overflow-hidden">
      {/* ── رأس البطاقة ────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-2.5 h-2.5 rounded-full',
            accountStatus === 'active' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]' : 'bg-red-400'
          )} />
          <span className="font-semibold text-[var(--text-primary)] text-sm">{displayName}</span>
          <Badge variant="outline" className={cn('text-xs px-2 py-0.5 border', statusBg(accountStatus))}>
            {accountStatus === 'active' ? 'متصل' : 'غير متصل'}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />}
          {collapsed ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />}
        </div>
      </div>

      {!collapsed && (
        <CardContent className="p-0">
          {/* ── عداد الوقت المتبقي ───────────────────────────────────────── */}
          {data?.nextPublish && (
            <div className="px-4 py-3 bg-[var(--brand-primary)]/5 border-b border-[var(--border-default)] flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-[var(--brand-primary)]" />
                <span className="text-xs text-[var(--text-secondary)]">النشر القادم بعد:</span>
                <span className="font-mono font-bold text-[var(--brand-primary)] text-base tabular-nums dir-ltr">
                  {countdown}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>موعد النشر:</span>
                <span className="dir-ltr font-mono">{formatDateTime(data.nextPublish.isoString)}</span>
              </div>
              <span className="text-xs text-[var(--text-muted)] hidden sm:inline">
                بناءً على الجدول: {data.nextPublish.scheduleName}
              </span>
            </div>
          )}

          {/* ── القسمان الرئيسيان ────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x md:divide-x-reverse divide-[var(--border-default)]">

            {/* ── أ) النشر بالمجموعات ───────────────────────────────────── */}
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">النشر في المجموعات</h4>
              </div>

              {activeSchedules.length === 0 && !loading ? (
                <p className="text-xs text-[var(--text-muted)] py-2">لا توجد جداول نشطة</p>
              ) : (
                <>
                  {/* الحالة */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--text-muted)]">الحالة</span>
                    <Badge variant="outline" className={cn('text-xs border', statusBg(firstActive?.status ?? 'stopped'))}>
                      {firstActive ? statusLabel(firstActive.status) : 'لا يوجد'}
                    </Badge>
                  </div>

                  {/* الإحصائيات */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: 'المجموعات', value: totalGroups, color: 'text-blue-400' },
                      { label: 'تم النشر', value: publishedToday, color: 'text-green-400' },
                      { label: 'المتبقي', value: remainingGroups, color: 'text-yellow-400' },
                    ].map(stat => (
                      <div key={stat.label} className="bg-[var(--bg-elevated)] rounded-lg p-2">
                        <div className={cn('text-xl font-bold tabular-nums', stat.color)}>{stat.value}</div>
                        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{stat.label}</div>
                      </div>
                    ))}
                  </div>

                  <ProgressBar value={publishedToday} max={totalGroups} color="bg-green-500" />

                  {/* الوقت المتبقي */}
                  {data?.nextPublish && (
                    <div className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>النشر القادم بعد:</span>
                      <span className="font-mono dir-ltr font-semibold text-[var(--text-primary)]">{countdown}</span>
                    </div>
                  )}

                  {/* الأزرار */}
                  <div className="flex gap-2 flex-wrap mt-1">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90"
                      onClick={() => handleGroupAction('publish-now')}
                      disabled={!!actionLoading || !firstActive}
                    >
                      <Zap className="w-3 h-3" />
                      نشر مباشر
                    </Button>
                    {firstActive?.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                        onClick={() => handleGroupAction('pause')}
                        disabled={!!actionLoading}
                      >
                        <Pause className="w-3 h-3" />
                        إيقاف
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 border-green-500/50 text-green-400 hover:bg-green-500/10"
                        onClick={() => handleGroupAction('resume')}
                        disabled={!!actionLoading || !firstActive}
                      >
                        <Play className="w-3 h-3" />
                        استئناف
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── ب) النشر الخاص للأعضاء ───────────────────────────────── */}
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 mb-1">
                <Send className="w-4 h-4 text-purple-400" />
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">النشر الخاص للأعضاء</h4>
              </div>

              {!activeCampaign && !loading ? (
                <p className="text-xs text-[var(--text-muted)] py-2">لا توجد حملات خاصة نشطة</p>
              ) : (
                <>
                  {/* الحالة */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--text-muted)]">الحالة</span>
                    <Badge variant="outline" className={cn('text-xs border', statusBg(activeCampaign?.status ?? 'stopped'))}>
                      {activeCampaign ? statusLabel(activeCampaign.status) : '—'}
                    </Badge>
                  </div>

                  {/* الإحصائيات */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: 'المستهدفون', value: privateTotal, color: 'text-blue-400' },
                      { label: 'تم الإرسال', value: privateSent, color: 'text-green-400' },
                      { label: 'المتبقي', value: privateRemaining, color: 'text-yellow-400' },
                    ].map(stat => (
                      <div key={stat.label} className="bg-[var(--bg-elevated)] rounded-lg p-2">
                        <div className={cn('text-xl font-bold tabular-nums', stat.color)}>{stat.value}</div>
                        <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{stat.label}</div>
                      </div>
                    ))}
                  </div>

                  <ProgressBar value={privateSent} max={privateTotal} color="bg-purple-500" />

                  {/* الفاصل الزمني */}
                  {activeCampaign?.interval_seconds && (
                    <div className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>الفاصل بين الرسائل:</span>
                      <span className="font-mono dir-ltr font-semibold text-[var(--text-primary)]">
                        {activeCampaign.interval_seconds}ث
                      </span>
                    </div>
                  )}

                  {/* اسم الحملة */}
                  {activeCampaign?.name && (
                    <p className="text-[10px] text-[var(--text-muted)] truncate">
                      الحملة: {activeCampaign.name}
                    </p>
                  )}

                  {/* الأزرار */}
                  <div className="flex gap-2 flex-wrap mt-1">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 bg-purple-600 hover:bg-purple-500"
                      onClick={() => handlePrivateAction('send-now')}
                      disabled={!!actionLoading || !activeCampaign}
                    >
                      <Zap className="w-3 h-3" />
                      إرسال مباشر
                    </Button>
                    {activeCampaign?.status === 'running' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                        onClick={() => handlePrivateAction('pause')}
                        disabled={!!actionLoading}
                      >
                        <StopCircle className="w-3 h-3" />
                        إيقاف الإرسال
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 border-green-500/50 text-green-400 hover:bg-green-500/10"
                        onClick={() => handlePrivateAction('resume')}
                        disabled={!!actionLoading || !activeCampaign}
                      >
                        <Play className="w-3 h-3" />
                        استئناف الإرسال
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>

          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ── Global Countdown (أقرب موعد نشر بين كل الحسابات) ────────────────────────

function GlobalNextPublish({ accounts }: { accounts: AccountInfo[] }) {
  const [globalNext, setGlobalNext] = useState<{ isoString: string; accountName: string } | null>(null);
  const countdown = useCountdown(globalNext?.isoString);

  useEffect(() => {
    if (accounts.length === 0) return;

    let cancelled = false;
    async function fetchAll() {
      let best: { isoString: string; accountName: string } | null = null;
      await Promise.all(accounts.map(async acc => {
        try {
          const res = await authFetch(`${API}/accounts/${acc.id}/broadcast/monitor`);
          if (!res.ok) return;
          const data = await res.json();
          if (data.success && data.nextPublish) {
            const dt = new Date(data.nextPublish.isoString);
            if (!best || dt < new Date(best.isoString)) {
              best = {
                isoString: data.nextPublish.isoString,
                accountName: acc.name || acc.phone || acc.id,
              };
            }
          }
        } catch (_) {}
      }));
      if (!cancelled) setGlobalNext(best);
    }

    fetchAll();
    const id = setInterval(fetchAll, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [accounts]);

  if (!globalNext) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] text-sm text-[var(--text-muted)]">
        <Clock className="w-4 h-4" />
        <span>لا توجد عمليات نشر مجدولة</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 rounded-xl border border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-[var(--brand-primary)]" />
        <span className="text-sm text-[var(--text-secondary)]">النشر القادم بعد:</span>
        <span className="font-mono font-bold text-[var(--brand-primary)] text-xl tabular-nums dir-ltr">
          {countdown}
        </span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--text-muted)]">موعد النشر:</span>
        <span className="font-mono dir-ltr text-[var(--text-primary)]">{formatDateTime(globalNext.isoString)}</span>
      </div>
      <span className="text-xs text-[var(--text-muted)]">
        الحساب: {globalNext.accountName} — تم الحساب بناءً على أقرب مهمة نشر مجدولة نشطة
      </span>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export default function ScheduleMonitorPanel({ accounts }: Props) {
  const connectedAccounts = accounts; // نعرض كل الحسابات

  if (connectedAccounts.length === 0) return null;

  return (
    <section className="flex flex-col gap-4 mt-2">
      {/* ── عنوان القسم ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-[var(--border-default)]" />
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] whitespace-nowrap flex items-center gap-2">
          <Clock className="w-4 h-4" />
          لوحة متابعة النشر المجدول
        </h2>
        <div className="h-px flex-1 bg-[var(--border-default)]" />
      </div>

      {/* ── عداد الوقت العالمي ───────────────────────────────────────────── */}
      <GlobalNextPublish accounts={connectedAccounts} />

      {/* ── بطاقة لكل حساب ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        {connectedAccounts.map(acc => (
          <AccountMonitorCard key={acc.id} account={acc} />
        ))}
      </div>
    </section>
  );
}
