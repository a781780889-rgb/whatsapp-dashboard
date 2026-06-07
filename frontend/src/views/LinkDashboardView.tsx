import React, { useState } from 'react';
import { Smartphone, Link as LinkIcon, Shield, ShieldAlert, Star, Search, Filter, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/utils/cn';

export default function LinkDashboardView({ accountId }: { accountId: string | null }) {
  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط لعرض الروابط الملتقطة.</p>
        </div>
      </div>
    );
  }

  const mockLinks = [
    { id: 1, url: 'chat.whatsapp.com/AbcDeF', country: 'السعودية', keywords: 'تسويق، عقارات', rating: 4.5, safe: true },
    { id: 2, url: 'chat.whatsapp.com/Xyz123', country: 'مصر', keywords: 'وظائف، توظيف', rating: 5.0, safe: true },
    { id: 3, url: 'chat.whatsapp.com/Spam44', country: 'غير معروف', keywords: 'قروض، تمويل', rating: 1.2, safe: false },
    { id: 4, url: 'chat.whatsapp.com/Dev999', country: 'الإمارات', keywords: 'برمجة، تقنية', rating: 4.8, safe: true },
  ];

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مراقبة الروابط</h1>
          <p className="text-[var(--text-secondary)] mt-1">روابط دعوة المجموعات الملتقطة من رسائل الواتساب</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'إجمالي الروابط', value: '1,240', icon: LinkIcon, color: 'text-blue-500' },
          { label: 'روابط آمنة', value: '1,105', icon: Shield, color: 'text-green-500' },
          { label: 'مشبوهة (Spam)', value: '135', icon: ShieldAlert, color: 'text-red-500' },
          { label: 'متوسط التقييم', value: '4.2/5', icon: Star, color: 'text-yellow-500' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-[var(--text-secondary)]">{stat.label}</span>
                <div className="text-2xl font-bold text-[var(--text-primary)] mt-1">{stat.value}</div>
              </div>
              <div className={cn("p-3 rounded-xl bg-[var(--bg-elevated)]", stat.color)}>
                <stat.icon className="w-5 h-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="card flex-1 overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[var(--border-default)] bg-[var(--bg-app)] flex flex-wrap gap-3 items-center">
          <div className="relative w-64">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input className="input pr-9 h-9" placeholder="بحث في الروابط والكلمات..." />
          </div>
          <select className="input w-32 h-9">
            <option>كل الدول</option>
            <option>السعودية</option>
            <option>مصر</option>
            <option>الإمارات</option>
          </select>
          <select className="input w-40 h-9">
            <option>ترتيب: الأحدث</option>
            <option>ترتيب: الأعلى تقييماً</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer mr-4">
            <input type="checkbox" className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" defaultChecked />
            إخفاء المشبوه
          </label>
          
          <div className="mr-auto flex gap-2">
            <Button variant="outline" className="h-9">
              <Download className="w-4 h-4" /> تصدير CSV
            </Button>
            <Button className="h-9 bg-[var(--brand-secondary)] hover:bg-[var(--brand-secondary)] border-[var(--brand-secondary)]">
              انضمام تلقائي للمحدد
            </Button>
          </div>
        </div>
        
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader className="bg-[var(--bg-elevated)] sticky top-0 z-10 shadow-sm">
              <TableRow className="border-[var(--border-default)] hover:bg-transparent">
                <TableHead className="w-12 text-center py-4"><input type="checkbox" className="w-4 h-4 rounded" /></TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الرابط</TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الدولة</TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الكلمات المفتاحية</TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">التقييم</TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الحالة</TableHead>
                <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الإجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockLinks.map(link => (
                <TableRow key={link.id} className="border-[var(--border-default)]">
                  <TableCell className="text-center"><input type="checkbox" className="w-4 h-4 rounded" /></TableCell>
                  <TableCell className="font-mono text-sm dir-ltr text-left text-[var(--brand-secondary)]">{link.url}</TableCell>
                  <TableCell className="text-[var(--text-secondary)] text-sm">{link.country}</TableCell>
                  <TableCell className="text-[var(--text-secondary)] text-sm">{link.keywords}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 text-sm font-medium">
                      <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                      <span className="dir-ltr">{link.rating.toFixed(1)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      "border-0 font-medium",
                      link.safe ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                    )}>
                      {link.safe ? 'آمن' : 'مشبوه'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" className="h-8">انضمام الآن</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
