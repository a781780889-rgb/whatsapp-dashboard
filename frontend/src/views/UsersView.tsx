import React, { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, Search, Edit2, Trash2, Ban, CheckCircle,
  RefreshCw, Eye, EyeOff, X, Crown, Shield, User, Lock,
  Calendar, Key, ChevronDown, Loader2
} from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

/* ─── types ─────────────────────────────────────────── */
interface AppUser {
  id:string; username:string; full_name:string; email:string;
  role:string; status:string; last_login:string; created_at:string;
  plan_type:string; expires_at:string; sub_status:string;
  license_key:string; daysRemaining:number;
}
interface NewUserForm {
  username:string; password:string; fullName:string; email:string;
  role:string; planType:string;
}

const ROLES = [
  { id:'super_admin', label:'Super Admin', color:'#f59e0b', icon: Crown },
  { id:'admin',       label:'Admin',       color:'#8b5cf6', icon: Shield },
  { id:'moderator',   label:'Moderator',   color:'#3b82f6', icon: Shield },
  { id:'user',        label:'User',        color:'#6b7280', icon: User },
];
const PLANS = [
  { id:'trial_24h', label:'تجربة 24 ساعة' }, { id:'3d', label:'3 أيام' },
  { id:'7d', label:'7 أيام' },  { id:'15d', label:'15 يوم' },
  { id:'30d', label:'30 يوم' }, { id:'60d', label:'60 يوم' },
  { id:'90d', label:'90 يوم' }, { id:'180d', label:'180 يوم' },
  { id:'365d', label:'365 يوم' },{ id:'lifetime', label:'مدى الحياة ♾️' },
];

function roleInfo(r:string) { return ROLES.find(x=>x.id===r) || ROLES[3]; }

function SubBadge({ user }: { user: AppUser }) {
  const isLifetime = user.plan_type==='lifetime';
  const isExpired  = !isLifetime && user.daysRemaining===0;
  const isTrial    = user.plan_type==='trial_24h';
  const color = isLifetime ? '#00A884' : isExpired ? '#ef4444' : isTrial ? '#f59e0b' : '#3b82f6';
  const label = isLifetime ? '♾️ مدى الحياة'
    : isExpired ? 'منتهي' : `${user.daysRemaining}ي`;
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-bold"
      style={{ background:`${color}18`, color }}>
      {label}
    </span>
  );
}

/* ─── Create / Edit Modal ────────────────────────────── */
function UserModal({ mode, user, onClose, onSave }:
  { mode:'create'|'edit'; user?:AppUser; onClose:()=>void; onSave:()=>void }) {

  const [form, setForm] = useState<NewUserForm>({
    username: user?.username||'', password:'', fullName: user?.full_name||'',
    email: user?.email||'', role: user?.role||'user', planType:'30d'
  });
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  const f = (k:keyof NewUserForm) => (e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>) =>
    setForm(p=>({ ...p, [k]: e.target.value }));

  async function submit(e:React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const url = mode==='create' ? `${API}/admin/users` : `${API}/admin/users/${user!.id}`;
      const method = mode==='create' ? 'POST' : 'PUT';
      const body = mode==='create'
        ? { username:form.username, password:form.password, fullName:form.fullName, email:form.email, role:form.role, planType:form.planType }
        : { fullName:form.fullName, email:form.email, role:form.role, newPassword: form.password||undefined };

      const res = await authFetch(url, { method, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        addToast({ title:'✅ تم', description: mode==='create'?'تم إنشاء المستخدم بنجاح':'تم تحديث المستخدم', type:'success' });
        if (mode==='create' && data.licenseKey) {
          addToast({ title:'مفتاح الترخيص', description: data.licenseKey, type:'info' });
        }
        onSave();
      } else {
        addToast({ title:'خطأ', description: data.error||'فشلت العملية', type:'error' });
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-[var(--shadow-elevated)] animate-scale-in"
        onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h3 className="font-bold text-lg">{mode==='create'?'إضافة مستخدم جديد':'تعديل المستخدم'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"><X className="w-4 h-4"/></button>
        </div>
        <form onSubmit={submit} className="p-6 flex flex-col gap-4">
          {/* Username */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">اسم المستخدم</label>
            <input value={form.username} onChange={f('username')} disabled={mode==='edit'}
              className="input dir-ltr" placeholder="john_doe" required={mode==='create'}/>
          </div>
          {/* Full name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">الاسم الكامل</label>
            <input value={form.fullName} onChange={f('fullName')} className="input" placeholder="أحمد محمد"/>
          </div>
          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">البريد الإلكتروني</label>
            <input value={form.email} onChange={f('email')} type="email" className="input dir-ltr" placeholder="user@example.com"/>
          </div>
          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">{mode==='edit'?'كلمة مرور جديدة (اتركها فارغة للإبقاء)':'كلمة المرور'}</label>
            <div className="relative">
              <input type={showPwd?'text':'password'} value={form.password} onChange={f('password')}
                className="input dir-ltr pr-10" placeholder="••••••••" required={mode==='create'}/>
              <button type="button" onClick={()=>setShowPwd(!showPwd)}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                {showPwd?<EyeOff className="w-4 h-4"/>:<Eye className="w-4 h-4"/>}
              </button>
            </div>
          </div>
          {/* Role */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[var(--text-secondary)]">الدور</label>
              <select value={form.role} onChange={f('role')} className="input">
                {ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            {mode==='create' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-[var(--text-secondary)]">خطة الاشتراك</label>
                <select value={form.planType} onChange={f('planType')} className="input">
                  {PLANS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-60">
              {loading?<Loader2 className="w-4 h-4 animate-spin"/>:null}
              {mode==='create'?'إنشاء المستخدم':'حفظ التعديلات'}
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-all">
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Renew Subscription Modal ────────────────────────── */
function RenewModal({ user, onClose, onSave }:{ user:AppUser; onClose:()=>void; onSave:()=>void }) {
  const [planType, setPlanType] = useState('30d');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  async function submit(e:React.FormEvent) {
    e.preventDefault(); setLoading(true);
    try {
      const res = await authFetch(`${API}/admin/subscriptions`, {
        method:'POST', body: JSON.stringify({ userId: user.id, planType, note })
      });
      const data = await res.json();
      if (data.success) {
        addToast({ title:'✅ تم التجديد', description:`اشتراك ${user.username} تم تجديده`, type:'success' });
        onSave();
      } else {
        addToast({ title:'خطأ', description: data.error, type:'error' });
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-[var(--shadow-elevated)] animate-scale-in"
        onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h3 className="font-bold text-lg">تجديد اشتراك <span className="text-[var(--brand-primary)]">{user.username}</span></h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"><X className="w-4 h-4"/></button>
        </div>
        <form onSubmit={submit} className="p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">خطة الاشتراك</label>
            <select value={planType} onChange={e=>setPlanType(e.target.value)} className="input">
              {PLANS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">ملاحظة (اختياري)</label>
            <input value={note} onChange={e=>setNote(e.target.value)} className="input" placeholder="تجديد..."/>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-60">
              {loading && <Loader2 className="w-4 h-4 animate-spin"/>} تجديد الاشتراك
            </button>
            <button type="button" onClick={onClose}
              className="h-11 px-5 rounded-xl border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-all">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────── */
export default function UsersView() {
  const [users, setUsers]     = useState<AppUser[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [filterRole, setFilterRole]     = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage]       = useState(1);

  const [modal, setModal]     = useState<null|'create'|'edit'|'renew'>(null);
  const [selected, setSelected] = useState<AppUser|null>(null);
  const [deleteId, setDeleteId] = useState<string|null>(null);

  const { addToast } = useToast();
  const LIMIT = 15;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ search, role:filterRole, status:filterStatus, page:String(page), limit:String(LIMIT) });
      const res  = await authFetch(`${API}/admin/users?${q}`);
      const data = await res.json();
      if (data.success) { setUsers(data.users); setTotal(data.total); }
    } finally { setLoading(false); }
  }, [search, filterRole, filterStatus, page]);

  useEffect(() => { load(); }, [load]);

  async function toggleStatus(u:AppUser) {
    const newStatus = u.status==='active' ? 'suspended' : 'active';
    const res  = await authFetch(`${API}/admin/users/${u.id}/status`, { method:'PATCH', body: JSON.stringify({ status: newStatus }) });
    const data = await res.json();
    if (data.success) { addToast({ title:'✅ تم', description: data.message, type:'success' }); load(); }
    else addToast({ title:'خطأ', description: data.error, type:'error' });
  }

  async function deleteUser() {
    if (!deleteId) return;
    const res  = await authFetch(`${API}/admin/users/${deleteId}`, { method:'DELETE' });
    const data = await res.json();
    if (data.success) { addToast({ title:'✅ تم الحذف', description: data.message, type:'success' }); setDeleteId(null); load(); }
    else addToast({ title:'خطأ', description: data.error, type:'error' });
  }

  const pages = Math.ceil(total/LIMIT);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة المستخدمين</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{total} مستخدم إجمالاً</p>
        </div>
        <button onClick={()=>{ setSelected(null); setModal('create'); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 active:scale-[0.98] transition-all shadow-[var(--shadow-glow)]">
          <Plus className="w-4 h-4"/> إضافة مستخدم
        </button>
      </div>

      {/* Filters */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"/>
          <input value={search} onChange={e=>{ setSearch(e.target.value); setPage(1); }}
            className="input pr-9 w-full" placeholder="بحث بالاسم أو البريد..."/>
        </div>
        <select value={filterRole} onChange={e=>{ setFilterRole(e.target.value); setPage(1); }} className="input w-40">
          <option value="">كل الأدوار</option>
          {ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e=>{ setFilterStatus(e.target.value); setPage(1); }} className="input w-40">
          <option value="">كل الحالات</option>
          <option value="active">نشط</option>
          <option value="suspended">موقوف</option>
        </select>
        <button onClick={load} className="p-2.5 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading?'animate-spin':''}`}/>
        </button>
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                {['المستخدم','الدور','الاشتراك','الترخيص','آخر دخول','الحالة','إجراءات'].map(h=>(
                  <th key={h} className="px-4 py-3 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({length:5}).map((_,i)=>(
                  <tr key={i} className="border-b border-[var(--border-default)]">
                    {Array.from({length:7}).map((_,j)=>(
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse"/></td>
                    ))}
                  </tr>
                ))
              ) : users.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  <Users className="w-10 h-10 mx-auto mb-2 opacity-30"/>
                  لا يوجد مستخدمون
                </td></tr>
              ) : users.map(u => {
                const ri = roleInfo(u.role);
                const RoleIcon = ri.icon;
                return (
                  <tr key={u.id} className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm text-white"
                          style={{ background:`${ri.color}20`, color: ri.color }}>
                          {(u.full_name||u.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{u.full_name||u.username}</p>
                          <p className="text-xs text-[var(--text-muted)] dir-ltr">@{u.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full w-fit"
                        style={{ background:`${ri.color}15`, color: ri.color }}>
                        <RoleIcon className="w-3 h-3"/>{ri.label}
                      </span>
                    </td>
                    <td className="px-4 py-3"><SubBadge user={u}/></td>
                    <td className="px-4 py-3">
                      {u.license_key
                        ? <span className="text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-elevated)] px-2 py-0.5 rounded">
                            {u.license_key.slice(0,10)}…
                          </span>
                        : <span className="text-xs text-[var(--text-muted)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)] whitespace-nowrap">
                      {u.last_login ? new Date(u.last_login).toLocaleDateString('ar') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${u.status==='active'?'bg-green-500/15 text-green-400':'bg-red-500/15 text-red-400'}`}>
                        {u.status==='active'?'نشط':'موقوف'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button title="تعديل" onClick={()=>{ setSelected(u); setModal('edit'); }}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                          <Edit2 className="w-4 h-4"/>
                        </button>
                        <button title="تجديد الاشتراك" onClick={()=>{ setSelected(u); setModal('renew'); }}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-blue-400 transition-colors">
                          <RefreshCw className="w-4 h-4"/>
                        </button>
                        <button title={u.status==='active'?'إيقاف':'تفعيل'} onClick={()=>toggleStatus(u)}
                          className={`p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors ${u.status==='active'?'text-[var(--text-muted)] hover:text-yellow-400':'text-[var(--text-muted)] hover:text-green-400'}`}>
                          {u.status==='active'?<Ban className="w-4 h-4"/>:<CheckCircle className="w-4 h-4"/>}
                        </button>
                        <button title="حذف" onClick={()=>setDeleteId(u.id)}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-red-400 transition-colors">
                          <Trash2 className="w-4 h-4"/>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-default)]">
            <p className="text-sm text-[var(--text-muted)]">صفحة {page} من {pages}</p>
            <div className="flex gap-2">
              <button disabled={page<=1} onClick={()=>setPage(p=>p-1)}
                className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border-strong)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">السابق</button>
              <button disabled={page>=pages} onClick={()=>setPage(p=>p+1)}
                className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border-strong)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">التالي</button>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {modal==='create' && <UserModal mode="create" onClose={()=>setModal(null)} onSave={()=>{ setModal(null); load(); }}/>}
      {modal==='edit' && selected && <UserModal mode="edit" user={selected} onClose={()=>setModal(null)} onSave={()=>{ setModal(null); load(); }}/>}
      {modal==='renew' && selected && <RenewModal user={selected} onClose={()=>setModal(null)} onSave={()=>{ setModal(null); load(); }}/>}

      {/* Delete Confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl p-6 animate-scale-in text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-7 h-7 text-red-400"/>
            </div>
            <h3 className="font-bold text-lg mb-2">تأكيد الحذف</h3>
            <p className="text-sm text-[var(--text-muted)] mb-6">سيتم حذف المستخدم وجميع بياناته نهائياً. لا يمكن التراجع.</p>
            <div className="flex gap-3">
              <button onClick={deleteUser}
                className="flex-1 h-11 rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 transition-colors">حذف نهائي</button>
              <button onClick={()=>setDeleteId(null)}
                className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
