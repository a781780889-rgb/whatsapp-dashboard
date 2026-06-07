ممتاز! الملف جاهز والاسم صح. الحين **اضغط على المحرر الأبيض** والصق هذا المحتوى:

---

```markdown
<div dir="rtl">

# WhatsApp Enterprise Dashboard

لوحة تحكم متكاملة لإدارة بوت واتساب — تصميم احترافي بمستوى الشركات الكبرى.

## هيكل المشروع

```
whatsapp-bot-dashboard/
├── Dockerfile
├── backend/            ← Node.js + Express + SQLite (بدون تعديل)
│   ├── index.js
│   ├── package.json
│   └── src/
│       ├── api/
│       ├── bot/
│       ├── database/
│       └── scheduler/
└── frontend/           ← React + TypeScript + Tailwind v4 + shadcn/ui
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── App.tsx
        ├── index.css       ← Design tokens (Dark + Light)
        ├── components/
        │   ├── layout/     ← Sidebar, TopBar, AppLayout
        │   └── ui/         ← shadcn/ui components
        ├── views/          ← جميع الصفحات
        └── utils/
```

## أقسام لوحة التحكم

| المسار | القسم |
|--------|--------|
| `/` | الرئيسية — إحصائيات + رسوم بيانية |
| `/accounts` | إدارة الحسابات — إضافة / ربط QR / حذف |
| `/campaigns` | الحملات — معالج 5 خطوات |
| `/ad-library` | مكتبة الإعلانات |
| `/direct-publish` | النشر المباشر |
| `/schedules` | النشر المجدول |
| `/links` | مراقبة الروابط |

## تشغيل محلي

```bash
# Backend
cd backend && npm install && node index.js

# Frontend (منفذ آخر)
cd frontend && npm install && npm run dev
```

## Docker

```bash
docker build -t wa-dashboard .
docker run -p 8080:8080 wa-dashboard
```

**برمجة: المهندس / هيثم العقلاني**


## 🛠️ التقنيات المستخدمة

### الخلفية
- Node.js 20 + Express 5
- Socket.IO 4
- SQLite3
- Baileys (واجهة واتساب)
- JWT للمصادقة

### الواجهة الأمامية
- React + Vite
- Socket.IO Client

---

## 🚀 النشر على Railway

1. ارفع المشروع على GitHub
2. أنشئ مشروعاً جديداً على Railway واربطه بالمستودع
3. أضف المتغيرات البيئية:

| المتغير | الوصف |
|---------|-------|
| `JWT_SECRET` | مفتاح سري للتشفير |
| `ADMIN_USERNAME` | اسم مستخدم الإدارة |
| `ADMIN_PASSWORD` | كلمة مرور الإدارة |
| `PORT` | 8080 |

---

## 🔒 ملاحظات الأمان

- لا ترفع ملف `.env` على GitHub
- استخدم كلمة مرور قوية لحساب الإدارة

</div>
