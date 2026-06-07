import React, { useState, useEffect, useCallback } from 'react';
import { CreditCard, Plus, Search, XCircle, RefreshCw, Loader2, X, CheckCircle, Clock } from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

interface Sub { id:string; user_id:string; username:string; full_name:string; plan_type:string; planLabel:string; started_at:string; expires_at:string; status:string; daysRemaining:number; isExpired:boolean; note:string; }

const PLANS = [
  {id:'trial_24h',label:'تجربة 24 ساعة'},{id:'3d',label:'3 أيام'},{id:'7d',label:'7 أيام'},
  {id:'15d',label:'15 يوم'},{id:'30d',label:'30 يوم'},{id:'60d',label:'60 يوم'},
  {id:'90d',label:'90 يوم'},{id:'180d',label:'180 يوم'},{id:'365d',label:'365 يوم'},
  {id:'lifetime',label:'مدى الحياة ♾️'}
];

function StatusBadge({sub}:{sub:Sub}) {
  if (sub.plan_type==='lifetime') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]">♾️ مدى الحياة</span>;
  if (sub.isExpired || sub.status!=='active') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/15 text-red-400">منتهي</span>;
  if (sub.daysRemaining <= 3) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-500/15 text-yellow-400">{sub.daysRemaining} أيام</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-500/15 text-blue-400">{sub.daysRemaining} يوم</span>;
}

function NewSubModal({onClose, onSave}:{onClose:()=>void;onSave:()=>void}) {
  const [userId, setUserId]   = useState('');
  const [planType, setPlan]   = useState('30d');
  const [note, setNote]       = useState('');
  const [users, setUsers]     = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    authFetch(`${API}/admin/users?limit=200`).then(r=>r.json()).then(d=>{ if(d.success) setUsers(d.users); });
  }, []);

  async function submit(e:React.FormEvent) {
    e.preventDefault(); setLoading(true);
    try {
      const res  = await authFetch(`${API}/admin/subscriptions`, { method:'POST', body: JSON.stringify({userId, planType, note}) });
      const data = await res.json();
      if (data.success) { addToast({title:'✅ تم',description:'تم إنشاء الاشتراك',type:'success'}); onSave(); }
      else addToast({title:'خطأ',description:data.error,type:'error'});
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-[var(--shadow-elevated)] animate-scale-in" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h3 className="font-bold text-lg">إنشاء اشتراك جديد</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"><X className="w-4 h-4"/></button>
        </div>
        <form onSubmit={submit} className="p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">المستخدم</label>
            <select value={userId} onChange={e=>setUserId(e.target.value)} className="input" required>
              <option value="">اختر مستخدماً...</option>
              {users.map(u=><option key={u.id} value={u.id}>{u.full_name||u.username} (@{u.username})</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">الخطة</label>
            <select value={planType} onChange={e=>setPlan(e.target.value)} className="input">
              {PLANS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">ملاحظة</label>
            <input value={note} onChange={e=>setNote(e.target.value)} className="input" placeholder="اختياري..."/>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-60">
              {loading&&<Loader2 className="w-4 h-4 animate-spin"/>} إنشاء الاشتراك
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-all">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function SubscriptionsView() {
  const [subs, setSubs]       = useState<Sub[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilter] = useState('');
  const [page, setPage]       = useState(1);
  const [showModal, setShow]  = useState(false);
  const { addToast } = useToast();
  const LIMIT = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ status: filterStatus, page: String(page), limit: String(LIMIT) });
      const res = await authFetch(`${API}/admin/subscriptions?${q}`);
      const d   = await res.json();
      if (d.success) { setSubs(d.subscriptions); setTotal(d.total); }
    } finally { setLoading(false); }
  }, [filterStatus, page]);

  useEffect(()=>{ load(); }, [load]);

  async function cancelSub(id:string) {
    const res  = await authFetch(`${API}/admin/subscriptions/${id}`, { method:'DELETE' });
    const data = await res.json();
    if (data.success) { addToast({title:'✅ تم',description:'تم إلغاء الاشتراك',type:'success'}); load(); }
    else addToast({title:'خطأ',description:data.error,type:'error'});
  }

  const pages = Math.ceil(total/LIMIT);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة الاشتراكات</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{total} اشتراك إجمالاً</p>
        </div>
        <button onClick={()=>setShow(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all shadow-[var(--shadow-glow)]">
          <Plus className="w-4 h-4"/> اشتراك جديد
        </button>
      </div>

      {/* Filters */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex gap-3 items-center">
        <select value={filterStatus} onChange={e=>{ setFilter(e.target.value); setPage(1); }} className="input w-48">
          <option value="">كل الاشتراكات</option>
          <option value="active">نشط</option>
          <option value="cancelled">ملغي</option>
        </select>
        <button onClick={load} className="p-2.5 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading?'animate-spin':''}`}/>
        </button>
      </div>

      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                {['المستخدم','الخطة','بداية','انتهاء','المتبقي','الحالة','إجراء'].map(h=>(
                  <th key={h} className="px-4 py-3 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length:5}).map((_,i)=>(
                <tr key={i} className="border-b border-[var(--border-default)]">
                  {Array.from({length:7}).map((_,j)=>(
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse"/></td>
                  ))}
                </tr>
              )) : subs.length===0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  <CreditCard className="w-10 h-10 mx-auto mb-2 opacity-30"/> لا توجد اشتراكات
                </td></tr>
              ) : subs.map(s=>(
                <tr key={s.id} className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/40 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-sm">{s.full_name||s.username}</p>
                    <p className="text-xs text-[var(--text-muted)] dir-ltr">@{s.username}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)]">{s.planLabel}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{new Date(s.started_at).toLocaleDateString('ar')}</td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                    {s.expires_at ? new Date(s.expires_at).toLocaleDateString('ar') : '♾️'}
                  </td>
                  <td className="px-4 py-3"><StatusBadge sub={s}/></td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${s.status==='active'&&!s.isExpired?'bg-green-500/15 text-green-400':'bg-red-500/15 text-red-400'}`}>
                      {s.status==='active'&&!s.isExpired?'نشط':'منتهي/ملغي'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {s.status==='active' && (
                      <button onClick={()=>cancelSub(s.id)} title="إلغاء"
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition-colors">
                        <XCircle className="w-4 h-4"/>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages>1 && (
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
      {showModal && <NewSubModal onClose={()=>setShow(false)} onSave={()=>{ setShow(false); load(); }}/>}
    </div>
  );
}
