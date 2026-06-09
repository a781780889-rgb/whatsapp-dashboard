import React, { useState } from 'react';
import { cn } from '@/utils/cn';
import {
  Brain, Zap, BookOpen, ClipboardList, TrendingUp, Settings2,
  MessageSquareText, RefreshCcw, ToggleLeft, ToggleRight,
  ChevronDown, ChevronUp, Sparkles, Bot, BarChart2, Timer,
  Layers, Search, Archive, FlaskConical, Shield, Play, Square,
  Eye, Lightbulb, Download, Upload, FileText, Users2, Target,
  Cpu, Activity, AlertCircle, CheckCircle2, Clock, Star,
} from 'lucide-react';

/* ─── Types ─────────────────────────────────────────────── */
interface SystemCard {
  id: number;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  color: string;
  glow: string;
  features: string[];
  status: 'active' | 'idle' | 'learning' | 'off';
}

interface ToggleState {
  [key: string]: boolean;
}

/* ─── Data ───────────────────────────────────────────────── */
const SYSTEMS: SystemCard[] = [
  {
    id: 1,
    icon: Brain,
    title: 'محرك التعلم السلوكي',
    subtitle: 'Behavioral Learning Engine',
    color: 'text-violet-400',
    glow: 'rgba(139,92,246,0.18)',
    status: 'learning',
    features: [
      'تعلم أسلوب الرد والمصطلحات الشائعة',
      'تعلم طريقة الترحيب والإقناع والشرح',
      'تعلم أسلوب كل مشرف وردود المجموعات',
      'بناء قاعدة معرفة تلقائية',
      'تحليل اللهجات والاختصارات',
      'تصنيف الأسئلة وتقييم جودة الرد',
    ],
  },
  {
    id: 2,
    icon: MessageSquareText,
    title: 'الرد الذكي التلقائي',
    subtitle: 'Smart Auto-Reply Engine',
    color: 'text-emerald-400',
    glow: 'rgba(52,211,153,0.18)',
    status: 'active',
    features: [
      'رد تلقائي على الأسئلة الشائعة',
      'رد حسب الوقت والقسم واللغة',
      'رد شبه تلقائي ورد اليدوي المساعد',
      'تأخير زمني مخصص ومراجعة قبل الإرسال',
      'تصحيح الصياغة وتلخيص المحادثات',
      'توليد ردود متعددة واقتراح أفضلها',
    ],
  },
  {
    id: 3,
    icon: BookOpen,
    title: 'قاعدة المعرفة الذكية',
    subtitle: 'Intelligent Knowledge Base',
    color: 'text-sky-400',
    glow: 'rgba(56,189,248,0.18)',
    status: 'active',
    features: [
      'إنشاء مكتبة معرفة وفهرسة الأسئلة',
      'بحث ذكي وتحديث المعرفة تلقائياً',
      'تصنيف المعلومات وأرشفة المحادثات',
      'اكتشاف المعلومات الجديدة تلقائياً',
      'إزالة التكرار وتقييم جودة المعلومات',
    ],
  },
  {
    id: 4,
    icon: ClipboardList,
    title: 'المساعد الإداري',
    subtitle: 'Administrative Assistant',
    color: 'text-amber-400',
    glow: 'rgba(251,191,36,0.18)',
    status: 'idle',
    features: [
      'تقارير يومية وأسبوعية وشهرية',
      'تحليل النشاط والأداء والمجموعات',
      'تحليل الحسابات والحملات والتفاعل',
    ],
  },
  {
    id: 5,
    icon: TrendingUp,
    title: 'الذكاء التنبؤي',
    subtitle: 'Predictive Intelligence',
    color: 'text-rose-400',
    glow: 'rgba(251,113,133,0.18)',
    status: 'idle',
    features: [
      'توقع أوقات الذروة والنشاط والتفاعل',
      'توقع نجاح الحملات والأسئلة القادمة',
      'توقع احتياجات المستخدمين',
      'توقع أفضل أوقات النشر',
    ],
  },
  {
    id: 6,
    icon: Settings2,
    title: 'أتمتة المهام',
    subtitle: 'Task Automation Engine',
    color: 'text-orange-400',
    glow: 'rgba(251,146,60,0.18)',
    status: 'active',
    features: [
      'جدولة المهام وتشغيلها تلقائياً',
      'إعادة المحاولة الذكية ومعالجة الأخطاء',
      'توزيع المهام وإدارة الطوابير',
      'مراقبة التنفيذ وإدارة الأولويات',
      'إيقاف الطوارئ واستئناف المهام',
    ],
  },
  {
    id: 7,
    icon: BarChart2,
    title: 'تحليل المحادثات',
    subtitle: 'Conversation Analytics',
    color: 'text-cyan-400',
    glow: 'rgba(34,211,238,0.18)',
    status: 'active',
    features: [
      'تحليل المشاعر ورضا المستخدم',
      'تحليل الكلمات والمواضيع والأسئلة',
      'تحليل الاعتراضات والمشاكل',
      'تحليل الأداء والتفاعل والنتائج',
    ],
  },
  {
    id: 8,
    icon: RefreshCcw,
    title: 'التعلم المستمر',
    subtitle: 'Continuous Learning',
    color: 'text-lime-400',
    glow: 'rgba(163,230,53,0.18)',
    status: 'learning',
    features: [
      'التعلم من المحادثات والقرارات',
      'التعلم من التصحيحات والتقييمات',
      'التعلم من الأخطاء والنجاحات',
      'التعلم من المشرفين والمستخدمين',
    ],
  },
];

const STATUS_CONFIG = {
  active:   { label: 'نشط',       color: 'text-emerald-400', bg: 'bg-emerald-400/10', dot: 'bg-emerald-400', pulse: true  },
  learning: { label: 'يتعلم',     color: 'text-violet-400',  bg: 'bg-violet-400/10',  dot: 'bg-violet-400',  pulse: true  },
  idle:     { label: 'في الانتظار', color: 'text-amber-400',  bg: 'bg-amber-400/10',   dot: 'bg-amber-400',   pulse: false },
  off:      { label: 'متوقف',     color: 'text-red-400',     bg: 'bg-red-400/10',     dot: 'bg-red-400',     pulse: false },
};

const QUICK_ACTIONS = [
  { icon: Play,     label: 'تشغيل الذكاء',     key: 'ai_on',       color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20' },
  { icon: Square,   label: 'إيقاف الذكاء',     key: 'ai_off',      color: 'text-red-400',    bg: 'bg-red-400/10',    border: 'border-red-400/20'    },
  { icon: Brain,    label: 'وضع التعلم',       key: 'learn_mode',  color: 'text-violet-400', bg: 'bg-violet-400/10', border: 'border-violet-400/20' },
  { icon: Eye,      label: 'وضع المراقبة',     key: 'watch_mode',  color: 'text-sky-400',    bg: 'bg-sky-400/10',    border: 'border-sky-400/20'    },
  { icon: Lightbulb,label: 'وضع الاقتراح',    key: 'suggest_mode',color: 'text-amber-400',  bg: 'bg-amber-400/10',  border: 'border-amber-400/20'  },
  { icon: Bot,      label: 'الرد التلقائي',    key: 'auto_reply',  color: 'text-cyan-400',   bg: 'bg-cyan-400/10',   border: 'border-cyan-400/20'   },
  { icon: FlaskConical, label: 'تدريب النظام', key: 'train',       color: 'text-rose-400',   bg: 'bg-rose-400/10',   border: 'border-rose-400/20'   },
  { icon: RefreshCcw,   label: 'إعادة التدريب',key: 'retrain',     color: 'text-orange-400', bg: 'bg-orange-400/10', border: 'border-orange-400/20' },
  { icon: Download, label: 'تصدير المعرفة',    key: 'export',      color: 'text-indigo-400', bg: 'bg-indigo-400/10', border: 'border-indigo-400/20' },
  { icon: Upload,   label: 'استيراد المعرفة',  key: 'import',      color: 'text-teal-400',   bg: 'bg-teal-400/10',   border: 'border-teal-400/20'   },
];

const ADVANCED_TOOLS = [
  { icon: FileText,    label: 'مساعد كتابة الردود',    badge: 'جديد'    },
  { icon: Sparkles,    label: 'مولد الإعلانات',        badge: null      },
  { icon: MessageSquareText, label: 'مولد الرسائل',   badge: null      },
  { icon: BarChart2,   label: 'مولد التقارير',         badge: null      },
  { icon: Search,      label: 'مولد الأسئلة الشائعة', badge: null      },
  { icon: Archive,     label: 'تلخيص المحادثات',       badge: null      },
  { icon: Target,      label: 'استخراج المهام',        badge: 'قريباً'  },
  { icon: Layers,      label: 'استخراج القرارات',      badge: 'قريباً'  },
];

const AGENTS = [
  { icon: Users2,  label: 'وكيل خدمة العملاء',  color: '#00A884' },
  { icon: Shield,  label: 'وكيل الدعم الفني',    color: '#4F8EF7' },
  { icon: FileText,label: 'وكيل التقارير',       color: '#a78bfa' },
  { icon: Layers,  label: 'وكيل إدارة المحتوى', color: '#f59e0b' },
  { icon: Target,  label: 'وكيل الحملات',        color: '#f43f5e' },
  { icon: BarChart2,label: 'وكيل تحليل البيانات',color: '#22d3ee' },
  { icon: FlaskConical, label: 'وكيل التدريب',  color: '#84cc16' },
  { icon: Star,    label: 'وكيل الجودة',         color: '#fb923c' },
];

/* ─── Sub-components ─────────────────────────────────────── */
function StatusBadge({ status }: { status: keyof typeof STATUS_CONFIG }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={cn('flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full', cfg.color, cfg.bg)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot, cfg.pulse && 'animate-pulse')} />
      {cfg.label}
    </span>
  );
}

function SystemCard({ sys, isExpanded, onToggle }: {
  sys: SystemCard;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden transition-all duration-300 hover:border-[var(--border-strong)]"
      style={{ boxShadow: isExpanded ? `0 0 24px ${sys.glow}` : undefined }}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-4 px-5 py-4 text-right hover:bg-[var(--bg-elevated)] transition-colors"
      >
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border"
          style={{ background: sys.glow, borderColor: sys.glow }}
        >
          <sys.icon className={cn('w-5 h-5', sys.color)} />
        </div>
        <div className="flex-1 min-w-0 text-right">
          <p className="text-sm font-bold text-[var(--text-primary)] truncate">{sys.title}</p>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{sys.subtitle}</p>
        </div>
        <StatusBadge status={sys.status} />
        <div className="text-[var(--text-muted)] mr-1">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {/* Expanded features */}
      {isExpanded && (
        <div className="px-5 pb-5 pt-1 border-t border-[var(--border-default)]">
          <ul className="mt-3 flex flex-col gap-2">
            {sys.features.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]">
                <CheckCircle2 className={cn('w-4 h-4 mt-0.5 shrink-0', sys.color)} />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button className={cn(
              'flex-1 py-2 rounded-xl text-xs font-bold border transition-all',
              'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-[var(--brand-primary)]/25 hover:bg-[var(--brand-primary)]/20'
            )}>
              إعدادات النظام
            </button>
            <button className={cn(
              'flex-1 py-2 rounded-xl text-xs font-bold border transition-all',
              'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)] hover:text-[var(--text-primary)]'
            )}>
              عرض التقرير
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────────── */
export default function AIAutomationView() {
  const [expandedSystem, setExpandedSystem] = useState<number | null>(1);
  const [toggles, setToggles] = useState<ToggleState>({
    ai_on: true,
    auto_reply: true,
    watch_mode: false,
    suggest_mode: true,
    learn_mode: true,
    ai_off: false,
    train: false,
    retrain: false,
    export: false,
    import: false,
  });

  const activeCount  = SYSTEMS.filter(s => s.status === 'active').length;
  const learningCount = SYSTEMS.filter(s => s.status === 'learning').length;

  const toggle = (key: string) => setToggles(p => ({ ...p, [key]: !p[key] }));

  return (
    <div className="flex flex-col gap-6 animate-fade-in" dir="rtl">

      {/* ── Page Header ───────────────────────────────────── */}
      <div className="relative flex items-center justify-between px-5 py-4 rounded-2xl overflow-hidden border border-[var(--border-default)] bg-gradient-to-l from-violet-500/6 via-[var(--bg-surface)] to-[var(--bg-surface)]">
        <div className="absolute right-0 top-0 h-full w-1 bg-gradient-to-b from-violet-500 to-[var(--brand-primary)] rounded-l-full opacity-80" />
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/30 to-transparent" />

        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center shadow-[0_0_16px_rgba(139,92,246,0.15)]">
            <Cpu className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.15em]">قسم الذكاء والأتمتة</p>
            <h1 className="text-lg font-bold text-[var(--text-primary)]">AI Automation Center</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 bg-[var(--bg-elevated)] border border-[var(--border-default)] px-3 py-1.5 rounded-full text-sm">
          <div className="w-2 h-2 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.5)] animate-pulse" />
          <span className="text-[var(--text-secondary)] text-xs">المحرك نشط</span>
        </div>
      </div>

      {/* ── Stats Row ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { icon: Activity,  label: 'الأنظمة النشطة',    value: `${activeCount} / ${SYSTEMS.length}`, color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
          { icon: Brain,     label: 'في وضع التعلم',     value: learningCount.toString(),             color: 'text-violet-400',  bg: 'bg-violet-400/10'  },
          { icon: Timer,     label: 'متوسط وقت الرد',    value: '1.2 ث',                              color: 'text-sky-400',     bg: 'bg-sky-400/10'     },
          { icon: Star,      label: 'دقة التنبؤ',         value: '94.7%',                              color: 'text-amber-400',   bg: 'bg-amber-400/10'   },
        ].map((s, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
            <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', s.bg)}>
              <s.icon className={cn('w-5 h-5', s.color)} />
            </div>
            <div>
              <p className="text-[var(--text-muted)] text-xs">{s.label}</p>
              <p className="text-xl font-bold text-[var(--text-primary)]">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Main Grid ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* Left — Systems list (2/3 width) */}
        <div className="xl:col-span-2 flex flex-col gap-3">
          <h2 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4" /> الأنظمة الأساسية
          </h2>
          {SYSTEMS.map(sys => (
            <SystemCard
              key={sys.id}
              sys={sys}
              isExpanded={expandedSystem === sys.id}
              onToggle={() => setExpandedSystem(prev => prev === sys.id ? null : sys.id)}
            />
          ))}
        </div>

        {/* Right — Controls panel (1/3 width) */}
        <div className="flex flex-col gap-4">

          {/* Quick Action Buttons */}
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" /> أزرار التحكم السريع
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {QUICK_ACTIONS.map(action => (
                <button
                  key={action.key}
                  onClick={() => toggle(action.key)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-all duration-200',
                    action.bg, action.color, action.border,
                    'hover:brightness-110'
                  )}
                >
                  {toggles[action.key]
                    ? <ToggleRight className="w-4 h-4 shrink-0" />
                    : <ToggleLeft  className="w-4 h-4 shrink-0 opacity-50" />}
                  <span className="truncate">{action.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Advanced Tools */}
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sky-400" /> أدوات متقدمة
            </h2>
            <div className="flex flex-col gap-1.5">
              {ADVANCED_TOOLS.map((tool, i) => (
                <button
                  key={i}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors text-right"
                >
                  <tool.icon className="w-4 h-4 text-[var(--brand-primary)] shrink-0" />
                  <span className="flex-1 truncate">{tool.label}</span>
                  {tool.badge && (
                    <span className={cn(
                      'text-[10px] font-bold px-1.5 py-0.5 rounded-md',
                      tool.badge === 'جديد'   ? 'bg-emerald-400/15 text-emerald-400' :
                      tool.badge === 'قريباً' ? 'bg-amber-400/15 text-amber-400' : ''
                    )}>
                      {tool.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* ── AI Agents Section ─────────────────────────────── */}
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
            <Bot className="w-4 h-4 text-[var(--brand-primary)]" /> وكلاء الذكاء الاصطناعي المتخصصون
          </h2>
          <span className="text-xs text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-full font-semibold flex items-center gap-1.5">
            <Clock className="w-3 h-3" /> المرحلة المتقدمة (401-500)
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {AGENTS.map((agent, i) => (
            <div
              key={i}
              className="relative flex flex-col items-center gap-3 px-4 py-5 rounded-2xl border border-[var(--border-default)] hover:border-[var(--border-strong)] bg-[var(--bg-elevated)] transition-all duration-200 group cursor-pointer overflow-hidden"
            >
              <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ background: `radial-gradient(circle at 50% 0%, ${agent.color}12, transparent 70%)` }}
              />
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center border"
                style={{ background: `${agent.color}18`, borderColor: `${agent.color}30` }}
              >
                <agent.icon className="w-5 h-5" style={{ color: agent.color }} />
              </div>
              <p className="text-xs font-semibold text-[var(--text-secondary)] text-center leading-snug">
                {agent.label}
              </p>
              <span className="text-[10px] text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full">
                قريباً
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Roadmap ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
        <h2 className="text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider mb-5 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[var(--brand-primary)]" /> خارطة التطوير
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { range: '1 – 130',   label: 'المرحلة الأساسية',        desc: 'الأنظمة الأساسية الثمانية + الأدوات المتقدمة',       status: 'done',    color: '#00A884' },
            { range: '131 – 200', label: 'إدارة المعرفة المؤسسية',  desc: 'أنظمة إدارة المعرفة على مستوى المؤسسة',              status: 'active',  color: '#4F8EF7' },
            { range: '201 – 300', label: 'التحليل التنبؤي',         desc: 'توصيات ذكية وتحليل متقدم للبيانات',                  status: 'soon',    color: '#a78bfa' },
            { range: '301 – 500', label: 'وكلاء الذكاء المستقل',    desc: 'وكلاء AI متخصصون ومراقبة ذاتية للأداء',              status: 'planned', color: '#f59e0b' },
          ].map((phase, i) => (
            <div key={i} className="flex flex-col gap-3 p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-[var(--text-muted)]">{phase.range}</span>
                <span className={cn(
                  'text-[10px] font-bold px-2 py-0.5 rounded-full',
                  phase.status === 'done'    ? 'bg-emerald-400/15 text-emerald-400' :
                  phase.status === 'active'  ? 'bg-sky-400/15 text-sky-400'        :
                  phase.status === 'soon'    ? 'bg-amber-400/15 text-amber-400'    :
                                               'bg-[var(--bg-overlay)] text-[var(--text-muted)]'
                )}>
                  {phase.status === 'done' ? 'مكتمل' : phase.status === 'active' ? 'نشط' : phase.status === 'soon' ? 'قريباً' : 'مخطط'}
                </span>
              </div>
              <div className="h-1 rounded-full bg-[var(--bg-overlay)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: phase.status === 'done' ? '100%' : phase.status === 'active' ? '45%' : phase.status === 'soon' ? '10%' : '0%',
                    background: phase.color,
                  }}
                />
              </div>
              <p className="text-sm font-bold text-[var(--text-primary)]">{phase.label}</p>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{phase.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Warning notice ────────────────────────────────── */}
      <div className="flex items-start gap-3 px-5 py-4 rounded-2xl border border-amber-500/20 bg-amber-500/5">
        <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-400">ملاحظة مهمة</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
            الوكلاء الذكيون والتحليل التنبؤي المتقدم (المرحلة 201-500) قيد التطوير حالياً. سيتم إطلاقها تدريجياً خلال 2026-2027 بعد اكتمال بنية التعلم الأساسية. تأكد من تهيئة متغيرات البيئة <code className="font-mono text-amber-400">AI_PROVIDER</code> و <code className="font-mono text-amber-400">ANTHROPIC_API_KEY</code> لتفعيل محرك الذكاء.
          </p>
        </div>
      </div>

    </div>
  );
}
