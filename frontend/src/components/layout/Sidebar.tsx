import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Library, Send, Calendar,
  Megaphone, Link as LinkIcon, LogOut, ChevronRight,
  UsersRound, BarChart3, Crown, Shield, Rocket, Brain, Activity,
  GitMerge, MessageCircle, CreditCard
} from 'lucide-react';
import { cn } from '@/utils/cn';

interface SidebarProps {
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
  currentUser: any;
  onLogout: () => void;
  isConnected: boolean;
}

export function Sidebar({ isCollapsed, setIsCollapsed, currentUser, onLogout }: SidebarProps) {
  const isAdmin = ['super_admin', 'admin'].includes(currentUser?.role);

  const navItems = [
    {
      section: 'العام',
      items: [
        { to: '/', icon: LayoutDashboard, label: 'لوحة التحكم', exact: true },
        { to: '/accounts', icon: Users, label: 'الحسابات' },
      ]
    },
    {
      section: 'النشر',
      items: [
        { to: '/ad-library',        icon: Library,   label: 'مكتبة الإعلانات'   },
        { to: '/direct-publish',    icon: Send,       label: 'النشر المباشر'     },
        { to: '/schedules',         icon: Calendar,   label: 'النشر المجدول'     },
        { to: '/campaigns',         icon: Megaphone,  label: 'الحملات'           },
        { to: '/private-campaigns', icon: Rocket,     label: 'حملات النشر الخاص' },
        { to: '/groups',            icon: UsersRound, label: 'المجموعات'         },
      ]
    },
    {
      section: 'الروابط والحماية',
      items: [
        { to: '/links',      icon: LinkIcon,  label: 'مراقبة الروابط'      },
        { to: '/link-join',  icon: GitMerge,  label: 'الانضمام بالروابط'   },
        { to: '/protection', icon: Shield,    label: 'نظام الحماية'         },
      ]
    },
  
    {
      section: 'الذكاء الاصطناعي',
      items: [
        { to: '/ai-automation', icon: Brain, label: 'مركز الذكاء والأتمتة' },
      ]
    },
    {
      section: 'التشخيص',
      items: [
        { to: '/diagnostics', icon: Activity, label: 'لوحة التشخيص' },
      ]
    },
  ];

  const adminItems = isAdmin ? [
    {
      section: 'الإدارة',
      admin: true,
      items: [
        { to: '/admin/stats',         icon: BarChart3,     label: 'الإحصائيات'   },
        { to: '/admin/subscriptions', icon: CreditCard,    label: 'الاشتراكات'   },
        { to: '/telegram',            icon: MessageCircle, label: '📱 تيليجرام'  },
      ]
    }
  ] : [];

  // زر تيلجرام للمشتركين العاديين (يظهر فقط إذا فعّله الأدمن)
  const telegramUserItems = (!isAdmin && currentUser?.enableTelegram) ? [
    {
      section: 'التيلجرام التفاعلي',
      items: [
        { to: '/telegram', icon: MessageCircle, label: '📱 تيليجرام' },
      ]
    }
  ] : [];

  const allSections = [...navItems, ...telegramUserItems, ...adminItems];

  const roleLabel = { super_admin: 'Super Admin', admin: 'Admin', moderator: 'Moderator', user: 'User' }[currentUser?.role] || 'User';
  const roleColor = { super_admin: '#f59e0b', admin: '#8b5cf6', moderator: '#3b82f6', user: '#6b7280' }[currentUser?.role] || '#6b7280';

  return (
    <aside className={cn(
      "flex flex-col bg-[var(--bg-sidebar)] border-l border-[var(--border-default)] transition-all duration-300 z-10",
      isCollapsed ? "w-20" : "w-64"
    )}>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-[var(--border-default)]">
        {!isCollapsed && (
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold shadow-[var(--shadow-glow)]">W</div>
            <span className="font-bold text-lg whitespace-nowrap">هيثم العقلاني</span>
          </div>
        )}
        {isCollapsed && (
          <div className="w-full flex justify-center">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold">W</div>
          </div>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={cn("p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors", isCollapsed && "hidden")}>
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-5">
        {allSections.map((section, idx) => (
          <div key={idx}>
            {!isCollapsed && (
              <h4 className={cn(
                "text-xs font-semibold mb-2 px-3 uppercase tracking-wider flex items-center gap-1.5",
                (section as any).admin ? "text-[var(--brand-primary)]/70" : "text-[var(--text-muted)]"
              )}>
                {(section as any).admin && <Crown className="w-3 h-3"/>}
                {section.section}
              </h4>
            )}
            <ul className="flex flex-col gap-1">
              {section.items.map((item, i) => (
                <li key={i}>
                  <NavLink
                    to={item.to}
                    end={(item as any).exact}
                    className={({ isActive }) => cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 text-sm font-medium group",
                      isActive
                        ? "bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                    )}
                  >
                    <item.icon className="w-5 h-5 shrink-0" />
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* User footer */}
      <div className="p-3 border-t border-[var(--border-default)]">
        {!isCollapsed ? (
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-sm text-white shrink-0"
              style={{ background: `${roleColor}30`, color: roleColor }}>
              {(currentUser?.username || 'U').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-semibold truncate">{currentUser?.username}</p>
              <p className="text-xs font-medium" style={{ color: roleColor }}>{roleLabel}</p>
            </div>
            <button onClick={onLogout} title="تسجيل الخروج"
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button onClick={onLogout} title="تسجيل الخروج"
            className="w-full flex justify-center p-2 text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        )}
      </div>
    </aside>
  );
}
