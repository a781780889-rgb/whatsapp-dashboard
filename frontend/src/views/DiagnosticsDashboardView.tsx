import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity, Cpu, Database, Radio, Zap, QrCode, Key, Bot,
  Server, RefreshCw, AlertTriangle, CheckCircle2, XCircle,
  Clock, TrendingUp, BarChart3, Wifi, WifiOff, ChevronDown,
  ChevronUp, Eye, AlertCircle, Shield, HardDrive, MemoryStick,
  Layers, GitBranch
} from 'lucide-react';
import { API, authFetch } from '../utils/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InfraStats {
  process: { pid: number; nodeVersion: string; uptimeHuman: string; heapUsedMB: number; heapTotalMB: number; heapUsagePct: number; rssMB: number };
  system: { totalMemMB: number; usedMemMB: number; sysMemPct: number; cpuCount: number; loadAvg: number[] };
  cpu: { usagePct: number };
  postgres: { connected: boolean; responseMs: number; status: string };
  redis: { connected: boolean; responseMs: number; status: string };
  bullmq: { available: boolean; status: string; stats: { waiting: number; active: number; completed: number; failed: number; delayed: number } };
  analyzedAt: string;
}

interface InfraReport {
  overallStatus: 'healthy' | 'warning' | 'critical';
  healthScore: number;
  issues: Array<{ code: string; severity: string; message: string; value?: number }>;
  components: {
    process: any;
    postgres: any;
    redis: any;
    bullmq: any;
  };
  analyzedAt: string;
  durationMs: number;
}

interface AccountDiag {
  accountId: string;
  status: string;
  issues: any[];
  lastScan?: string;
}

interface QRStats { totalGenerated: number; totalScanned: number; totalExpired: number; totalFailed: number; avgLatencyMs: number }
interface PairingStats { totalRequested: number; totalConfirmed: number; totalFailed: number; avgLatencyMs: number }
interface BaileysStats { totalEvents: number; totalErrors: number; reconnects: number; avgEventProcessMs: number }
interface SessionStats { totalSessions: number; activeSessions: number; staleSessions: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  healthy:  '#22c55e',
  warning:  '#f59e0b',
  critical: '#ef4444',
};

const STATUS_BG: Record<string, string> = {
  healthy:  'rgba(34,197,94,0.10)',
  warning:  'rgba(245,158,11,0.10)',
  critical: 'rgba(239,68,68,0.10)',
};

const STATUS_AR: Record<string, string> = {
  healthy:  'سليم',
  warning:  'تحذير',
  critical: 'حرج',
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || '#6b7280';
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status !== 'healthy' && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: color }} />
      )}
      <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: color }} />
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || '#6b7280';
  const bg = STATUS_BG[status] || 'rgba(107,114,128,0.10)';
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ color, background: bg }}>
      <StatusDot status={status} />
      {STATUS_AR[status] || status}
    </span>
  );
}

function MiniBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="w-full h-1.5 bg-[var(--bg-overlay)] rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function MetricCard({
  icon: Icon, label, value, sub, color = 'var(--brand-primary)', badge, progress, progressMax, onClick
}: {
  icon: any; label: string; value: string | number; sub?: string;
  color?: string; badge?: React.ReactNode; progress?: number; progressMax?: number; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex flex-col gap-3 hover:border-[var(--border-strong)] transition-all duration-200 ${onClick ? 'cursor-pointer hover:scale-[1.01]' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${color}18` }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        {badge}
      </div>
      <div>
        <p className="text-xl font-bold leading-tight">{value}</p>
        <p className="text-sm text-[var(--text-secondary)] mt-0.5">{label}</p>
        {sub && <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub}</p>}
      </div>
      {progress !== undefined && progressMax !== undefined && (
        <MiniBar value={progress} max={progressMax} color={color} />
      )}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, sub, color = 'var(--brand-primary)', action }: { icon: any; title: string; sub?: string; color?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${color}18` }}>
          <Icon className="w-4.5 h-4.5" style={{ color }} />
        </div>
        <div>
          <h2 className="font-bold text-base">{title}</h2>
          {sub && <p className="text-xs text-[var(--text-muted)]">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function HealthScore({ score }: { score: number }) {
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative flex items-center justify-center w-24 h-24">
      <svg width="96" height="96" className="-rotate-90">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
        <circle cx="48" cy="48" r={radius} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" className="transition-all duration-1000" />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-xl font-black leading-none" style={{ color }}>{score}</span>
        <span className="text-[10px] text-[var(--text-muted)] font-medium mt-0.5">نقطة</span>
      </div>
    </div>
  );
}

function IssueItem({ issue }: { issue: { code: string; severity: string; message: string; value?: number } }) {
  const icon = issue.severity === 'critical' ? XCircle : AlertTriangle;
  const Icon = icon;
  const color = issue.severity === 'critical' ? '#ef4444' : '#f59e0b';
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-[var(--border-default)] last:border-0">
      <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{issue.message}</p>
        <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{issue.code}</p>
      </div>
      {issue.value !== undefined && (
        <span className="text-xs font-bold px-2 py-0.5 rounded-full shrink-0" style={{ color, background: `${color}18` }}>
          {issue.value}%
        </span>
      )}
    </div>
  );
}

// ─── Sub-section: Infrastructure ─────────────────────────────────────────────

function InfraSection({ accountId }: { accountId: string | null }) {
  const [report, setReport] = useState<InfraReport | null>(null);
  const [stats, setStats] = useState<InfraStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        authFetch(`${API}/admin/infra/report`).then(r => r.json()),
        authFetch(`${API}/admin/infra/stats`).then(r => r.json()),
      ]);
      if (r1.success) setReport(r1.report ?? r1.data ?? r1);
      if (r2.success) setStats(r2.stats ?? r2.data ?? r2);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 animate-pulse h-48" />
  );

  const status = report?.overallStatus || 'healthy';
  const score = report?.healthScore ?? 100;
  const issues = report?.issues ?? [];

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={Server}
        title="البنية التحتية"
        sub="CPU · Memory · PostgreSQL · Redis · BullMQ"
        color="#4F8EF7"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      {/* Top row: Health Score + status badges */}
      <div className="flex flex-wrap items-center gap-5 mb-5">
        <HealthScore score={score} />
        <div className="flex-1 flex flex-col gap-2 min-w-[200px]">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-muted)]">الحالة العامة</span>
            <StatusBadge status={status} />
          </div>
          {stats && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--text-muted)]">CPU</span>
                <span className="font-mono font-semibold">{stats.cpu?.usagePct ?? '—'}%</span>
              </div>
              <MiniBar
                value={stats.cpu?.usagePct ?? 0}
                color={stats.cpu?.usagePct > 70 ? '#ef4444' : '#22c55e'}
              />
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--text-muted)]">Heap (Node.js)</span>
                <span className="font-mono font-semibold">{stats.process?.heapUsagePct ?? '—'}%</span>
              </div>
              <MiniBar
                value={stats.process?.heapUsagePct ?? 0}
                color={stats.process?.heapUsagePct > 85 ? '#ef4444' : stats.process?.heapUsagePct > 70 ? '#f59e0b' : '#22c55e'}
              />
            </>
          )}
        </div>
      </div>

      {/* Component pills */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'PostgreSQL', ok: report?.components?.postgres?.connected !== false, ms: report?.components?.postgres?.responseMs },
          { label: 'Redis', ok: report?.components?.redis?.connected !== false, ms: report?.components?.redis?.responseMs },
          { label: 'BullMQ', ok: report?.components?.bullmq?.available !== false, ms: null },
          { label: 'Process', ok: true, ms: null },
        ].map(({ label, ok, ms }) => (
          <div key={label} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)]">
            {ok ? <Wifi className="w-4 h-4 text-green-400 shrink-0" /> : <WifiOff className="w-4 h-4 text-red-400 shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold truncate">{label}</p>
              {ms != null && <p className="text-[10px] text-[var(--text-muted)] font-mono">{ms}ms</p>}
            </div>
          </div>
        ))}
      </div>

      {/* BullMQ quick stats */}
      {stats?.bullmq?.stats && (
        <div className="grid grid-cols-5 gap-2 mb-4">
          {[
            { label: 'انتظار', val: stats.bullmq.stats.waiting, color: '#f59e0b' },
            { label: 'نشطة', val: stats.bullmq.stats.active, color: '#3b82f6' },
            { label: 'مكتملة', val: stats.bullmq.stats.completed, color: '#22c55e' },
            { label: 'فاشلة', val: stats.bullmq.stats.failed, color: '#ef4444' },
            { label: 'مؤجلة', val: stats.bullmq.stats.delayed, color: '#8b5cf6' },
          ].map(({ label, val, color }) => (
            <div key={label} className="text-center p-2 rounded-xl bg-[var(--bg-elevated)]">
              <p className="text-sm font-bold" style={{ color }}>{val ?? 0}</p>
              <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Issues */}
      {issues.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between text-sm font-semibold text-[var(--text-secondary)] py-2 hover:text-[var(--text-primary)] transition-colors"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-[var(--warning-500)]" />
              {issues.length} مشكلة مكتشفة
            </span>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {expanded && (
            <div className="mt-2">
              {issues.map((iss, i) => <IssueItem key={i} issue={iss} />)}
            </div>
          )}
        </div>
      )}

      {issues.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-green-400 mt-1">
          <CheckCircle2 className="w-4 h-4" />
          لا توجد مشاكل مكتشفة
        </div>
      )}

      {stats?.analyzedAt && (
        <p className="text-[10px] text-[var(--text-muted)] mt-3 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          آخر فحص: {new Date(stats.analyzedAt).toLocaleTimeString('ar')}
        </p>
      )}
    </div>
  );
}

// ─── Sub-section: QR + Pairing ────────────────────────────────────────────────

function QRPairingSection({ accountId }: { accountId: string | null }) {
  const [qrStats, setQrStats] = useState<QRStats | null>(null);
  const [pairingStats, setPairingStats] = useState<PairingStats | null>(null);
  const [adminQr, setAdminQr] = useState<any>(null);
  const [adminPairing, setAdminPairing] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const promises: Promise<any>[] = [
        authFetch(`${API}/admin/qr/stats`).then(r => r.json()),
        authFetch(`${API}/admin/pairing/stats`).then(r => r.json()),
      ];
      if (accountId) {
        promises.push(authFetch(`${API}/accounts/${accountId}/qr/stats`).then(r => r.json()));
        promises.push(authFetch(`${API}/accounts/${accountId}/pairing/stats`).then(r => r.json()));
      }
      const [aq, ap, q, p] = await Promise.all(promises);
      if (aq?.success) setAdminQr(aq.stats ?? aq.data);
      if (ap?.success) setAdminPairing(ap.stats ?? ap.data);
      if (q?.success) setQrStats(q.stats ?? q.data);
      if (p?.success) setPairingStats(p.stats ?? p.data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const qr = qrStats || adminQr;
  const pairing = pairingStats || adminPairing;

  if (loading) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 animate-pulse h-40" />
  );

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={QrCode}
        title="QR Code & Pairing"
        sub="إحصائيات الاتصال بالمسح والرمز"
        color="#00A884"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {qr && (
          <>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-[var(--brand-primary)]">{qr.totalGenerated ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">QR مُولَّد</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-green-400">{qr.totalScanned ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">QR ممسوح</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-yellow-400">{qr.totalExpired ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">QR منتهي</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-blue-400">{qr.avgLatencyMs ?? 0}ms</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">متوسط زمن QR</p>
            </div>
          </>
        )}
      </div>
      {pairing && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black" style={{ color: '#8b5cf6' }}>{pairing.totalRequested ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">Pairing مطلوب</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-green-400">{pairing.totalConfirmed ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">مُأكَّد</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-red-400">{pairing.totalFailed ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">فاشل</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-blue-400">{pairing.avgLatencyMs ?? 0}ms</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">متوسط زمن Pairing</p>
          </div>
        </div>
      )}
      {!qr && !pairing && (
        <p className="text-sm text-[var(--text-muted)] text-center py-4">لا توجد بيانات — حدد حساباً أو ابدأ الاتصال</p>
      )}
    </div>
  );
}

// ─── Sub-section: Baileys + Session ──────────────────────────────────────────

function BaileysSessionSection({ accountId }: { accountId: string | null }) {
  const [baileys, setBaileys] = useState<BaileysStats | null>(null);
  const [session, setSession] = useState<SessionStats | null>(null);
  const [adminBaileys, setAdminBaileys] = useState<any>(null);
  const [adminSession, setAdminSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const promises: Promise<any>[] = [
        authFetch(`${API}/admin/baileys/stats`).then(r => r.json()),
        authFetch(`${API}/admin/session/stats`).then(r => r.json()),
      ];
      if (accountId) {
        promises.push(authFetch(`${API}/accounts/${accountId}/baileys/stats`).then(r => r.json()));
        promises.push(authFetch(`${API}/accounts/${accountId}/session/stats`).then(r => r.json()));
      }
      const [ab, as_, b, s] = await Promise.all(promises);
      if (ab?.success) setAdminBaileys(ab.stats ?? ab.data);
      if (as_?.success) setAdminSession(as_.stats ?? as_.data);
      if (b?.success) setBaileys(b.stats ?? b.data);
      if (s?.success) setSession(s.stats ?? s.data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const bl = baileys || adminBaileys;
  const sess = session || adminSession;

  if (loading) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 animate-pulse h-40" />
  );

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={Bot}
        title="Baileys & الجلسات"
        sub="محرك الاتصال وحالة الجلسات"
        color="#f59e0b"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      {bl && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-blue-400">{bl.totalEvents ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">أحداث Baileys</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-red-400">{bl.totalErrors ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">أخطاء</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-yellow-400">{bl.reconnects ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">إعادة اتصال</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-green-400">{bl.avgEventProcessMs ?? 0}ms</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">متوسط معالجة</p>
          </div>
        </div>
      )}

      {sess && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-[var(--brand-primary)]">{sess.totalSessions ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">إجمالي الجلسات</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-green-400">{sess.activeSessions ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">جلسات نشطة</p>
          </div>
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <p className="text-lg font-black text-yellow-400">{sess.staleSessions ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">جلسات قديمة</p>
          </div>
        </div>
      )}

      {!bl && !sess && (
        <p className="text-sm text-[var(--text-muted)] text-center py-4">لا توجد بيانات</p>
      )}
    </div>
  );
}

// ─── Sub-section: Connection Cycle + Runtime ──────────────────────────────────

function CycleRuntimeSection({ accountId }: { accountId: string | null }) {
  const [cycle, setCycle] = useState<any>(null);
  const [runtime, setRuntime] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!accountId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [c, r] = await Promise.all([
        authFetch(`${API}/accounts/${accountId}/cycle/stats`).then(r => r.json()),
        authFetch(`${API}/accounts/${accountId}/runtime/stats`).then(r => r.json()),
      ]);
      if (c?.success) setCycle(c.stats ?? c.data);
      if (r?.success) setRuntime(r.stats ?? r.data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 animate-pulse h-40" />
  );

  if (!accountId) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 flex items-center justify-center gap-3 text-[var(--text-muted)]">
      <Activity className="w-5 h-5" />
      <span className="text-sm">اختر حساباً لعرض دورة الاتصال</span>
    </div>
  );

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={GitBranch}
        title="دورة الاتصال والأداء"
        sub={`حساب: ${accountId.slice(0, 8)}...`}
        color="#3b82f6"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cycle && (
          <>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-blue-400">{cycle.totalCycles ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">دورات الاتصال</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-green-400">{cycle.successfulCycles ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">ناجحة</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-yellow-400">{cycle.avgDurationMs ? `${Math.round(cycle.avgDurationMs)}ms` : '—'}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">متوسط المدة</p>
            </div>
          </>
        )}
        {runtime && (
          <>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-[var(--brand-primary)]">{runtime.totalAttempts ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">محاولات الاتصال</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-red-400">{runtime.totalErrors ?? 0}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">أخطاء Runtime</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black" style={{ color: '#8b5cf6' }}>{runtime.avgAttemptMs ? `${Math.round(runtime.avgAttemptMs)}ms` : '—'}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">متوسط المحاولة</p>
            </div>
          </>
        )}
        {!cycle && !runtime && (
          <div className="col-span-3 text-center py-4 text-sm text-[var(--text-muted)]">لا توجد بيانات لهذا الحساب</div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-section: Database + Redis ───────────────────────────────────────────

function DBRedisSection({ accountId }: { accountId: string | null }) {
  const [dbHealth, setDbHealth] = useState<any>(null);
  const [redisReport, setRedisReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const promises: Promise<any>[] = [
        authFetch(`${API}/admin/db/report`).then(r => r.json()),
        authFetch(`${API}/admin/redis/report`).then(r => r.json()),
      ];
      if (accountId) {
        promises.push(authFetch(`${API}/accounts/${accountId}/db/health`).then(r => r.json()));
      }
      const [dr, rr, dh] = await Promise.all(promises);
      if (dr?.success) setDbHealth(dr.report ?? dr.data);
      if (rr?.success) setRedisReport(rr.report ?? rr.data);
      if (dh?.success && dh.health) setDbHealth((prev: any) => ({ ...prev, ...(dh.health) }));
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 animate-pulse h-40" />
  );

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={Database}
        title="قاعدة البيانات & Redis"
        sub="PostgreSQL وتحليل Redis"
        color="#22c55e"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {dbHealth && (
          <>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <div className="flex items-center gap-1.5 mb-1">
                {dbHealth.connected !== false ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <XCircle className="w-3.5 h-3.5 text-red-400" />}
                <p className="text-xs text-[var(--text-muted)]">PostgreSQL</p>
              </div>
              <p className="text-sm font-bold">{dbHealth.sizePretty ?? dbHealth.dbSize ?? '—'}</p>
              <p className="text-[10px] text-[var(--text-muted)]">حجم قاعدة البيانات</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-blue-400">{dbHealth.tableCount ?? dbHealth.tables ?? '—'}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">عدد الجداول</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-yellow-400">{dbHealth.activeConnections ?? dbHealth.connections ?? '—'}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">اتصالات نشطة</p>
            </div>
          </>
        )}
        {redisReport && (
          <>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <div className="flex items-center gap-1.5 mb-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                <p className="text-xs text-[var(--text-muted)]">Redis</p>
              </div>
              <p className="text-sm font-bold">{redisReport.usedMemMB ?? redisReport.memory?.usedMemMB ?? '—'} MB</p>
              <p className="text-[10px] text-[var(--text-muted)]">ذاكرة مستخدمة</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-[var(--brand-primary)]">{redisReport.totalKeys ?? redisReport.stats?.totalKeys ?? '—'}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">إجمالي المفاتيح</p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
              <p className="text-lg font-black text-green-400">{redisReport.hitRate ?? redisReport.stats?.hitRate ?? '—'}%</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Hit Rate</p>
            </div>
          </>
        )}
        {!dbHealth && !redisReport && (
          <div className="col-span-3 text-center py-4 text-sm text-[var(--text-muted)]">لا توجد بيانات</div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-section: Admin-level problematic accounts ───────────────────────────

function ProblematicAccountsSection() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ba, qr, pa] = await Promise.all([
        authFetch(`${API}/admin/baileys/problematic?limit=10`).then(r => r.json()),
        authFetch(`${API}/admin/qr/slow?limit=10`).then(r => r.json()),
        authFetch(`${API}/admin/pairing/problematic?limit=10`).then(r => r.json()),
      ]);
      const all: any[] = [
        ...(ba?.accounts || ba?.data || []).map((a: any) => ({ ...a, type: 'Baileys' })),
        ...(qr?.accounts || qr?.data || []).map((a: any) => ({ ...a, type: 'QR بطيء' })),
        ...(pa?.accounts || pa?.data || []).map((a: any) => ({ ...a, type: 'Pairing' })),
      ];
      setAccounts(all);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const TYPE_COLOR: Record<string, string> = { 'Baileys': '#f59e0b', 'QR بطيء': '#ef4444', 'Pairing': '#8b5cf6' };

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
      <SectionHeader
        icon={AlertTriangle}
        title="الحسابات الإشكالية"
        sub="Baileys · QR البطيء · Pairing المشكل"
        color="#ef4444"
        action={
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      {loading && <div className="animate-pulse h-20 bg-[var(--bg-elevated)] rounded-xl" />}

      {!loading && accounts.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-green-400 py-2">
          <CheckCircle2 className="w-4 h-4" />
          لا توجد حسابات إشكالية حالياً
        </div>
      )}

      {!loading && accounts.length > 0 && (
        <>
          <div className="space-y-2">
            {(expanded ? accounts : accounts.slice(0, 5)).map((a, i) => (
              <div key={i} className="flex items-center gap-3 py-2 border-b border-[var(--border-default)] last:border-0">
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                  style={{ color: TYPE_COLOR[a.type] || '#6b7280', background: `${TYPE_COLOR[a.type] || '#6b7280'}18` }}>
                  {a.type}
                </span>
                <span className="text-sm font-mono truncate flex-1 text-[var(--text-secondary)]">
                  {a.accountId || a.id || '—'}
                </span>
                {a.errorCount !== undefined && (
                  <span className="text-xs text-red-400 font-bold shrink-0">{a.errorCount} خطأ</span>
                )}
              </div>
            ))}
          </div>
          {accounts.length > 5 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-3 w-full text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center gap-1 py-1 transition-colors"
            >
              {expanded ? <><ChevronUp className="w-3 h-3" /> عرض أقل</> : <><ChevronDown className="w-3 h-3" /> عرض الكل ({accounts.length})</>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DiagnosticsDashboardView({ accountId }: { accountId: string | null }) {
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  return (
    <div className="flex flex-col gap-6 animate-fade-in" dir="rtl">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">لوحة التشخيص</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">
            مراقبة شاملة لحالة النظام — البنية التحتية، الاتصال، القاعدة، والجلسات
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all ${autoRefresh ? 'bg-[var(--brand-primary)]/10 border-[var(--brand-primary)]/40 text-[var(--brand-primary)]' : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'}`}
          >
            <Activity className={`w-4 h-4 ${autoRefresh ? 'animate-pulse' : ''}`} />
            {autoRefresh ? 'تحديث تلقائي' : 'تحديث يدوي'}
          </button>
          <button
            onClick={refresh}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            تحديث
          </button>
        </div>
      </div>

      {/* ── Timestamp ── */}
      <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 -mt-4">
        <Clock className="w-3.5 h-3.5" />
        آخر تحديث: {lastUpdate.toLocaleTimeString('ar')}
        {autoRefresh && <span className="text-[var(--brand-primary)]">• يتحدث كل 30 ثانية</span>}
      </p>

      {/* ── Infrastructure (full-width) ── */}
      <InfraSection key={`infra-${refreshKey}`} accountId={accountId} />

      {/* ── QR + Pairing / Baileys + Session ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <QRPairingSection key={`qr-${refreshKey}`} accountId={accountId} />
        <BaileysSessionSection key={`baileys-${refreshKey}`} accountId={accountId} />
      </div>

      {/* ── Cycle + Runtime / DB + Redis ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CycleRuntimeSection key={`cycle-${refreshKey}`} accountId={accountId} />
        <DBRedisSection key={`db-${refreshKey}`} accountId={accountId} />
      </div>

      {/* ── Problematic Accounts (full-width) ── */}
      <ProblematicAccountsSection key={`prob-${refreshKey}`} />

      {/* ── Footer note ── */}
      <p className="text-xs text-[var(--text-muted)] text-center pb-2">
        المرحلة 11 — واجهة Diagnostics Dashboard • جميع البيانات حية من 70 نقطة API
      </p>
    </div>
  );
}
