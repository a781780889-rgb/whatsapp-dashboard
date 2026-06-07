import React, { useState, useEffect, useCallback } from 'react';
import { Key, Plus, RefreshCw, Copy, Check, RotateCcw, Shield, ShieldOff, Loader2, X } from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

interface License { id:string; user_id:string; username:string; full_name:string; license_key:string; status:string; issued_at:string; note:string; }

function CopyBtn({ text }:{ text:string }) {
  const [done, setDone] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(()=>setDone(false), 2000);
  }
  return (
    <button onClick={copy} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors">
      {done ? <Check className="w-3.5 h-3.5 text-[var(--brand-primary)]"/> : <Copy className="w-3.5 h-3.5"/>}
    </button>
  );
}

function IssueModal({onClose, onSave}:{onClose:()=>void;onSave:()=>void}) {
  const [userId, setUserId] = useState('');
  const [note, setNote]     = useState('');
  const [users, setUsers]   = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    authFetch(`${API}/admin/users?limit=200`).then(r=>r.json()).then(d=>{ if(d.success) setUsers(d.users); });
  }, []);

  async function submit(e:React.FormEvent) {
    e.preventDefault(); setLoading(true);
    try {
      const res  = await authFetch(`${API}/admin/licenses`, { method:'POST', body: JSON.stringify({userId, note}) });
      const data = await res.json();
      if (data.success) {
        addToast({title:'✅ تم إصدار الترخيص', description: data.licenseKey, type:'success'});
        onSave();
      } else addToast({title:'خطأ', description: data.error, type:'error'});
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-[var(--shadow-elevated)] animate-scale-in" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h3 className="font-bold text-lg">إصدار ترخيص جديد</h3>
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
            <label className="text-sm font-medium text-[var(--text-secondary)]">ملاحظة</label>
            <input value={note} onChange={e=>setNote(e.target.value)} className="input" placeholder="اختياري..."/>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading}
              className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-60">
              {loading&&<Loader2 className="w-4 h-4 animate-spin"/>} إصدار الترخيص
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-all">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function LicensesView() {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [filterStatus, setFilter] = useState('');
  const [page, setPage]         = useState(1);
  const [showModal, setShow]    = useState(false);
  const { addToast } = useToast();
  const LIMIT = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ status: filterStatus, page: String(page), limit: String(LIMIT) });
      const res = await authFetch(`${API}/admin/licenses?${q}`);
      const d   = await res.json();
      if (d.success) { setLicenses(d.licenses); setTotal(d.total); }
    } finally { setLoading(false); }
  }, [filterStatus, page]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(id:string, status:string) {
    const res  = await authFetch(`${API}/admin/licenses/${id}/status`, { method:'PATCH', body: JSON.stringify({status}) });
    const data = await res.json();
    if (data.success) { addToast({title:'✅ تم',description:data.message,type:'success'}); load(); }
    else addToast({title:'خطأ',description:data.error,type:'error'});
  }

  async function reissue(id:string) {
    const res  = await authFetch(`${API}/admin/licenses/${id}/reissue`, { method:'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({title:'✅ مفتاح جديد',description: data.licenseKey, type:'success'});
      load();
    } else addToast({title:'خطأ',description:data.error,type:'error'});
  }

  const statusColor = (s:string) => ({active:'bg-green-500/15 text-green-400', suspended:'bg-yellow-500/15 text-yellow-400', revoked:'bg-red-500/15 text-red-400'}[s]||'bg-gray-500/15 text-gray-400');
  const statusLabel = (s:string) => ({active:'نشط', suspended:'موقوف', revoked:'ملغي'}[s]||s);
  const pages = Math.ceil(total/LIMIT);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إدارة التراخيص</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{total} ترخيص إجمالاً</p>
        </div>
        <button onClick={()=>setShow(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all shadow-[var(--shadow-glow)]">
          <Plus className="w-4 h-4"/> إصدار ترخيص
        </button>
      </div>

      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex gap-3">
        <select value={filterStatus} onChange={e=>{ setFilter(e.target.value); setPage(1); }} className="input w-48">
          <option value="">كل التراخيص</option>
          <option value="active">نشط</option>
          <option value="suspended">موقوف</option>
          <option value="revoked">ملغي</option>
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
                {['المستخدم','مفتاح الترخيص','الحالة','تاريخ الإصدار','إجراءات'].map(h=>(
                  <th key={h} className="px-4 py-3 text-right text-xs font-semibold text-[var(--text-muted)] uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length:5}).map((_,i)=>(
                <tr key={i} className="border-b border-[var(--border-default)]">
                  {Array.from({length:5}).map((_,j)=>(
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse"/></td>
                  ))}
                </tr>
              )) : licenses.length===0 ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  <Key className="w-10 h-10 mx-auto mb-2 opacity-30"/>لا توجد تراخيص
                </td></tr>
              ) : licenses.map(l=>(
                <tr key={l.id} className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/40 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-sm">{l.full_name||l.username}</p>
                    <p className="text-xs text-[var(--text-muted)] dir-ltr">@{l.username}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-mono bg-[var(--bg-elevated)] px-2.5 py-1.5 rounded-lg text-[var(--brand-primary)] dir-ltr tracking-wider">{l.license_key}</code>
                      <CopyBtn text={l.license_key}/>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColor(l.status)}`}>{statusLabel(l.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{new Date(l.issued_at).toLocaleDateString('ar')}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button title="إعادة الإصدار" onClick={()=>reissue(l.id)}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-blue-400 transition-colors">
                        <RotateCcw className="w-4 h-4"/>
                      </button>
                      {l.status==='active' && (
                        <button title="إيقاف" onClick={()=>setStatus(l.id,'suspended')}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-yellow-400 transition-colors">
                          <ShieldOff className="w-4 h-4"/>
                        </button>
                      )}
                      {l.status==='suspended' && (
                        <button title="تفعيل" onClick={()=>setStatus(l.id,'active')}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-green-400 transition-colors">
                          <Shield className="w-4 h-4"/>
                        </button>
                      )}
                      {l.status!=='revoked' && (
                        <button title="إلغاء" onClick={()=>setStatus(l.id,'revoked')}
                          className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-red-400 transition-colors">
                          <Key className="w-4 h-4"/>
                        </button>
                      )}
                    </div>
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
      {showModal && <IssueModal onClose={()=>setShow(false)} onSave={()=>{ setShow(false); load(); }}/>}
    </div>
  );
}
