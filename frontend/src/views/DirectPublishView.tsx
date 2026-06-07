import React, { useState } from 'react';
import { Smartphone, Send, Search, Users, ChevronDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';

export default function DirectPublishView({ accountId, accounts }: { accountId: string | null, accounts: any[] }) {
  const [message, setMessage] = useState('');
  
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
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">النشر المباشر</h1>
          <p className="text-[var(--text-secondary)] mt-1">إرسال رسالة فورية للمجموعات المحددة عبر {selectedAccount?.name}</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
        
        {/* Left Column: Groups List */}
        <Card className="card w-full lg:w-1/3 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[var(--border-default)] bg-[var(--bg-app)]">
            <h3 className="font-bold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Users className="w-4 h-4 text-[var(--text-muted)]" /> المجموعات
            </h3>
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input className="input pr-9 bg-[var(--bg-surface)]" placeholder="بحث في المجموعات..." />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            <label className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
              <span className="font-bold text-[var(--brand-primary)]">تحديد الكل (15)</span>
            </label>
            <div className="w-full h-px bg-[var(--border-default)] my-1" />
            {[1,2,3,4,5,6,7,8].map(i => (
              <label key={i} className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer transition-colors">
                <input type="checkbox" className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
                <div className="flex-1">
                  <p className="font-medium text-[var(--text-primary)] text-sm truncate">مجموعة العملاء النشطين {i}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">240 عضو</p>
                </div>
              </label>
            ))}
          </div>
        </Card>

        {/* Right Column: Message & Publish */}
        <Card className="card w-full lg:w-2/3 flex flex-col overflow-hidden">
          <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-6">
            
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-[var(--text-primary)]">محتوى الرسالة</label>
                <Button variant="outline" size="sm" className="h-8">استيراد من المكتبة</Button>
              </div>
              <textarea 
                className="input min-h-[160px] font-mono text-sm leading-relaxed" 
                placeholder="اكتب رسالتك هنا..."
                value={message}
                onChange={e => setMessage(e.target.value)}
              />
            </div>

            {/* Live Preview (WhatsApp Style Bubble) */}
            {message && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-[var(--text-primary)]">معاينة</label>
                <div className="bg-[#efeae2] p-4 rounded-xl relative overflow-hidden">
                  <div className="absolute inset-0 bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_04fcacde539c58cca6745483d4858c52.png')] bg-repeat opacity-50 pointer-events-none" />
                  <div className="bg-white p-3 rounded-2xl rounded-tr-none shadow-sm max-w-[85%] relative z-10 mr-auto">
                    <p className="text-[#111b21] text-[15px] leading-relaxed whitespace-pre-wrap dir-rtl">{message}</p>
                    <span className="text-[11px] text-gray-400 float-left mt-2 ml-1">الآن</span>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-auto pt-6">
              <Button className="w-full h-14 text-lg font-bold shadow-[var(--shadow-glow)] bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e]">
                <Send className="w-5 h-5 ml-2" /> إرسال الآن (0 مجموعة محددة)
              </Button>
            </div>
            
          </div>
          
          {/* Publish Log Strip */}
          <div className="border-t border-[var(--border-default)] bg-[var(--bg-app)] p-3 px-6 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-elevated)] transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium text-[var(--text-secondary)]">سجل الإرسال جاهز...</span>
            </div>
            <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
        </Card>

      </div>
    </div>
  );
}
