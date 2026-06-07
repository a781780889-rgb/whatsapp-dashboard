import React, { useState } from 'react';
import { Search, Plus, Smartphone, Trash2, Link as LinkIcon, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QRCodeSVG } from 'qrcode.react';
import { useToast } from '@/components/ui/ToastProvider';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { io } from 'socket.io-client';

const SOCKET_URL = API.replace('/api/v1', '');

interface AccountsViewProps {
  accounts: any[];
  loading: boolean;
  fetchAccounts: () => void;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
}

export default function AccountsView({ accounts, loading, fetchAccounts, selectedAccountId, setSelectedAccountId }: AccountsViewProps) {
  const [search, setSearch] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const { addToast } = useToast();

  const filteredAccounts = accounts.filter(a => a.name.toLowerCase().includes(search.toLowerCase()) || (a.phone && a.phone.includes(search)));

  const handleAddAccount = async () => {
    if (!newAccountName) return;
    try {
      const res = await authFetch(`${API}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ name: newAccountName })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        addToast({ title: 'نجاح', description: 'تم إنشاء الحساب، يرجى مسح رمز QR', type: 'success' });
        setIsAddOpen(false);
        setConnectingId(data.account.id);
        fetchAccounts();
        handleConnect(data.account.id);
      }
    } catch {
      addToast({ title: 'خطأ', description: 'فشل إنشاء الحساب', type: 'error' });
    }
  };

  const handleConnect = async (id: string) => {
    setConnectingId(id);
    setQrCode(null);
    setIsQrOpen(true);
    
    try {
      await authFetch(`${API}/accounts/${id}/connect`, { method: 'POST' });
      const socket = io(SOCKET_URL);
      socket.emit('join_account', id);
      
      socket.on('qr_code', ({ qr }: { qr: string }) => {
        setQrCode(qr);
      });
      
      socket.on('account_status', ({ status }: { status: string }) => {
        if (status === 'connected') {
          setIsQrOpen(false);
          addToast({ title: 'متصل', description: 'تم ربط الحساب بنجاح', type: 'success' });
          fetchAccounts();
          socket.disconnect();
        }
      });
    } catch {
      addToast({ title: 'خطأ', description: 'فشل طلب الاتصال', type: 'error' });
      setIsQrOpen(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا الحساب؟')) return;
    try {
      await authFetch(`${API}/accounts/${id}`, { method: 'DELETE' });
      addToast({ title: 'تم الحذف', description: 'تم حذف الحساب بنجاح', type: 'success' });
      fetchAccounts();
      if (selectedAccountId === id) setSelectedAccountId(null);
    } catch {
      addToast({ title: 'خطأ', description: 'فشل حذف الحساب', type: 'error' });
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in h-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">الحسابات</h1>
          <p className="text-[var(--text-secondary)] mt-1">إدارة حسابات واتساب المرتبطة بالنظام</p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input 
              className="input pr-9" 
              placeholder="بحث عن حساب..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button onClick={() => setIsAddOpen(true)} className="flex-shrink-0">
            <Plus className="w-4 h-4" />
            <span>إضافة حساب</span>
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-48 w-full rounded-xl" />)}
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-[var(--border-default)] rounded-2xl bg-[var(--bg-surface)] p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-muted)] mb-4">
            <Smartphone className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-[var(--text-primary)]">لا توجد حسابات</h3>
          <p className="text-[var(--text-secondary)] max-w-sm mt-2 mb-6">لم تقم بإضافة أي حسابات واتساب حتى الآن. أضف حساباً جديداً لتبدأ في النشر.</p>
          <Button onClick={() => setIsAddOpen(true)}>إضافة حساب أول</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children overflow-y-auto pb-8">
          {filteredAccounts.map(account => (
            <Card 
              key={account.id} 
              className={cn(
                "card relative overflow-hidden flex flex-col group",
                selectedAccountId === account.id && "card-glow"
              )}
            >
              <div className={cn(
                "absolute top-0 left-0 w-full h-1", 
                account.status === 'connected' ? "bg-green-500" : "bg-red-500"
              )} />
              <CardContent className="p-5 flex-1 flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center border border-[var(--border-strong)]">
                      <Smartphone className="w-5 h-5 text-[var(--text-primary)]" />
                    </div>
                    <div>
                      <h3 className="font-bold text-[var(--text-primary)]">{account.name}</h3>
                      <p className="text-xs text-[var(--text-muted)] dir-ltr text-right mt-0.5">{account.phone || 'لا يوجد رقم'}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className={cn(
                    "border-0",
                    account.status === 'connected' ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                  )}>
                    {account.status === 'connected' ? 'متصل' : 'مفصول'}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-6 bg-[var(--bg-app)] p-3 rounded-lg border border-[var(--border-default)] text-center text-sm">
                  <div>
                    <p className="text-[var(--text-muted)] text-xs mb-1">الرسائل</p>
                    <p className="font-bold text-[var(--text-primary)]">12.4K</p>
                  </div>
                  <div className="border-r border-[var(--border-default)]">
                    <p className="text-[var(--text-muted)] text-xs mb-1">الحملات</p>
                    <p className="font-bold text-[var(--text-primary)]">8</p>
                  </div>
                </div>

                <div className="mt-auto flex items-center gap-2">
                  <Button 
                    variant={selectedAccountId === account.id ? "default" : "outline"} 
                    className="flex-1"
                    onClick={() => setSelectedAccountId(account.id)}
                  >
                    {selectedAccountId === account.id ? 'مُحدد' : 'تحديد'}
                  </Button>
                  {account.status !== 'connected' && (
                    <Button variant="outline" className="px-3" onClick={() => handleConnect(account.id)} title="ربط">
                      <LinkIcon className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="outline" className="px-3 text-red-500 hover:bg-red-500/10 hover:text-red-500" onClick={() => handleDelete(account.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Account Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة حساب واتساب جديد</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الحساب</label>
              <input 
                className="input" 
                placeholder="مثال: خدمة العملاء" 
                value={newAccountName}
                onChange={e => setNewAccountName(e.target.value)}
              />
            </div>
            <Button onClick={handleAddAccount} disabled={!newAccountName} className="w-full mt-2">إنشاء ومتابعة</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* QR Code Modal */}
      <Dialog open={isQrOpen} onOpenChange={setIsQrOpen}>
        <DialogContent className="sm:max-w-sm text-center flex flex-col items-center p-8">
          <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">ربط واتساب</h2>
          <p className="text-[var(--text-secondary)] text-sm mb-6">افتح تطبيق واتساب على هاتفك، اذهب إلى الأجهزة المرتبطة، وامسح الرمز أدناه.</p>
          
          <div className="bg-white p-4 rounded-2xl shadow-xl w-64 h-64 flex items-center justify-center relative">
            {qrCode ? (
              <QRCodeSVG value={qrCode} size={224} />
            ) : (
              <div className="flex flex-col items-center text-[var(--text-muted)] gap-4">
                <div className="w-8 h-8 border-4 border-t-[var(--brand-primary)] border-r-[var(--brand-primary)] border-b-transparent border-l-transparent rounded-full animate-spin" />
                <span className="text-sm font-medium">جاري جلب الرمز...</span>
              </div>
            )}
          </div>
          
          <div className="mt-6 flex items-center gap-2 text-sm text-[var(--text-muted)] bg-[var(--bg-elevated)] px-4 py-2 rounded-lg border border-[var(--border-default)]">
            <AlertCircle className="w-4 h-4 text-yellow-500" />
            <span>الرمز يتغير تلقائياً، يرجى المسح بسرعة.</span>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
