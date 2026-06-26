import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Activity, Users, Send, MousePointerClick, Zap, Calendar, Link as LinkIcon, Code2, Phone } from 'lucide-react';
import { cn } from '@/utils/cn';
import SubscriptionStatusCard from '../components/SubscriptionStatusCard';

const mockData = [
  { name: 'السبت',    messages: 4000, clicks: 2400 },
  { name: 'الأحد',    messages: 3000, clicks: 1398 },
  { name: 'الاثنين', messages: 2000, clicks: 9800 },
  { name: 'الثلاثاء',messages: 2780, clicks: 3908 },
  { name: 'الأربعاء',messages: 1890, clicks: 4800 },
  { name: 'الخميس', messages: 2390, clicks: 3800 },
  { name: 'الجمعة', messages: 3490, clicks: 4300 },
];

const mockPieData = [
  { name: 'متصل',  value: 400, color: '#00A884' },
  { name: 'مفصول', value: 300, color: '#ef4444' },
  { name: 'معلق',  value: 300, color: '#f59e0b' },
];

export default function DashboardHome({ accounts = [] }: { accounts?: any[] }) {
  const [timeRange, setTimeRange] = useState('7d');

  const stats = [
    { title: 'إجمالي الحسابات',  value: accounts.length.toString(), icon: Users,            color: 'text-blue-500',   bg: 'bg-blue-500/10',   change: '+12%', progress: 75 },
    { title: 'الرسائل المُرسلة', value: '1.2M',                     icon: Send,             color: 'text-green-500',  bg: 'bg-green-500/10',  change: '+5.4%',progress: 60 },
    { title: 'النقرات الإجمالية',value: '450K',                     icon: MousePointerClick,color: 'text-purple-500', bg: 'bg-purple-500/10', change: '+18%', progress: 85 },
    { title: 'Ping الخادم',       value: '24ms',                     icon: Zap,              color: 'text-yellow-500', bg: 'bg-yellow-500/10', change: '-2ms', progress: 95 },
  ];

  return (
    <div className="flex flex-col gap-6 animate-fade-in">

      {/* ─── Subscription Status Card (for regular users) ─── */}
      <SubscriptionStatusCard />

      {/* ─── Developer Attribution Banner ─── */}
      <div className="relative flex items-center justify-between px-5 py-4 rounded-2xl overflow-hidden border border-[var(--border-default)] hover:border-[var(--brand-primary)]/40 transition-all duration-300 group bg-gradient-to-l from-[var(--brand-primary)]/6 via-[var(--bg-surface)] to-[var(--bg-surface)]">
        {/* left accent bar */}
        <div className="absolute right-0 top-0 h-full w-1 bg-gradient-to-b from-[var(--brand-primary)] to-[var(--brand-secondary)] rounded-l-full opacity-80" />
        {/* top shimmer */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[var(--brand-primary)]/40 to-transparent" />

        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[var(--brand-primary)]/20 to-[var(--brand-secondary)]/10 border border-[var(--brand-primary)]/25 flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(0,168,132,0.1)] group-hover:shadow-[0_0_16px_rgba(0,168,132,0.2)] transition-shadow">
            <Code2 className="w-5 h-5 text-[var(--brand-primary)]" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-[0.15em]">برمجة وإعداد</span>
            <span className="text-base font-bold text-[var(--text-primary)]">م/ هيثم العقلاني</span>
          </div>
        </div>

        <a
          href="tel:+967781780889"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)]/10 border border-[var(--brand-primary)]/20 hover:bg-[var(--brand-primary)]/20 hover:border-[var(--brand-primary)]/45 hover:shadow-[0_0_14px_rgba(0,168,132,0.18)] transition-all duration-200"
        >
          <Phone className="w-4 h-4 text-[var(--brand-primary)]" />
          <span className="text-sm font-mono font-bold text-[var(--brand-primary)] tracking-wide dir-ltr">
            +967781780889
          </span>
        </a>
      </div>

      {/* ─── Page Header ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مرحباً بك في لوحة التحكم</h1>
          <p className="text-[var(--text-secondary)] mt-1">نظرة عامة على أداء حساباتك وحملاتك</p>
        </div>
        <div className="flex items-center gap-2 bg-[var(--bg-elevated)] border border-[var(--border-default)] px-3 py-1.5 rounded-full text-sm">
          <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)] animate-pulse" />
          <span className="text-[var(--text-secondary)]">النظام يعمل بشكل ممتاز</span>
        </div>
      </div>

      {/* ─── Stats Grid ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 stagger-children">
        {stats.map((stat, i) => (
          <Card key={i} className="card hover:translate-y-[-2px] transition-transform">
            <CardContent className="p-5 flex flex-col gap-4">
              <div className="flex justify-between items-start">
                <div className={cn("p-2.5 rounded-xl", stat.bg)}>
                  <stat.icon className={cn("w-5 h-5", stat.color)} />
                </div>
                <span className={cn("text-xs font-semibold px-2 py-1 rounded-md bg-[var(--bg-elevated)]", stat.change.startsWith('+') ? 'text-green-500' : 'text-green-500')}>
                  {stat.change}
                </span>
              </div>
              <div>
                <p className="text-[var(--text-secondary)] text-sm font-medium">{stat.title}</p>
                <h3 className="text-2xl font-bold text-[var(--text-primary)] mt-1">{stat.value}</h3>
              </div>
              <div className="w-full h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[var(--brand-primary)] to-[var(--brand-secondary)]" style={{ width: `${stat.progress}%` }} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ─── Charts ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="card lg:col-span-2">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-[var(--text-primary)]">أداء الحملات</h3>
              <div className="flex gap-1 bg-[var(--bg-elevated)] p-1 rounded-lg border border-[var(--border-default)]">
                {['7d', '30d', '90d'].map(range => (
                  <button
                    key={range}
                    onClick={() => setTimeRange(range)}
                    className={cn("px-3 py-1 text-xs font-medium rounded-md transition-colors", timeRange === range ? "bg-[var(--bg-surface)] text-[var(--brand-primary)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[300px] w-full dir-ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mockData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorMessages" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--brand-primary)" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="var(--brand-primary)" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F8EF7" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#4F8EF7" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v/1000}k`} />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-default)', borderRadius: '8px', color: 'var(--text-primary)' }}
                    itemStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Area type="monotone" dataKey="messages" name="رسائل" stroke="var(--brand-primary)" fillOpacity={1} fill="url(#colorMessages)" />
                  <Area type="monotone" dataKey="clicks"   name="نقرات"  stroke="#4F8EF7"               fillOpacity={1} fill="url(#colorClicks)"   />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="card">
          <CardContent className="p-6">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-6">حالة الحسابات</h3>
            <div className="h-[200px] w-full dir-ltr flex items-center justify-center relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={mockPieData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value" stroke="none">
                    {mockPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip contentStyle={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-default)', borderRadius: '8px' }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none flex-col">
                <span className="text-2xl font-bold text-[var(--text-primary)]">{accounts.length}</span>
                <span className="text-xs text-[var(--text-muted)]">إجمالي</span>
              </div>
            </div>
            <div className="mt-6 flex flex-col gap-3">
              {mockPieData.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-[var(--text-secondary)]">{item.name}</span>
                  </div>
                  <span className="font-bold text-[var(--text-primary)]">{item.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Activity & Quick Actions ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="card">
          <CardContent className="p-6">
            <h3 className="text-lg font-bold text-[var(--text-primary)] mb-6">الأنشطة الأخيرة</h3>
            <div className="flex flex-col gap-6 relative before:absolute before:right-3.5 before:top-2 before:bottom-2 before:w-px before:bg-[var(--border-default)]">
              {[1, 2, 3].map((_, i) => (
                <div key={i} className="flex items-start gap-4 relative z-10">
                  <div className="w-7 h-7 rounded-full bg-[var(--bg-elevated)] border-2 border-[var(--bg-surface)] flex flex-shrink-0 items-center justify-center text-[var(--brand-primary)]">
                    <Activity className="w-3 h-3" />
                  </div>
                  <div>
                    <p className="text-sm text-[var(--text-primary)] font-medium">تم إطلاق حملة جديدة "عروض الصيف"</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">منذ ساعتين • حساب خدمة العملاء</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="card bg-gradient-to-br from-[rgba(0,168,132,0.1)] to-transparent border-[var(--brand-primary-light)] hover:border-[var(--brand-primary)] group cursor-pointer">
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[var(--brand-primary)] flex items-center justify-center text-white shadow-[var(--shadow-glow)]">
                  <Send className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-[var(--text-primary)] group-hover:text-[var(--brand-primary)] transition-colors">إرسال مباشر</h3>
                  <p className="text-sm text-[var(--text-secondary)]">إرسال رسالة فورية للمجموعات</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="card hover:border-[var(--brand-secondary)] group cursor-pointer">
            <CardContent className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--brand-secondary)]">
                  <Calendar className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-[var(--text-primary)]">جدولة حملة</h3>
                  <p className="text-sm text-[var(--text-secondary)]">إعداد حملة للنشر لاحقاً</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

    </div>
  );
}
