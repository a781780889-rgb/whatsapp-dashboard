import React from 'react';

interface State { hasError: boolean; error?: Error; }

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-3xl">⚠️</div>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>حدث خطأ غير متوقع</h2>
          <p style={{ color: 'var(--text-secondary)' }} className="max-w-md text-sm">{this.state.error?.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--brand-primary)', color: '#fff' }}
          >
            إعادة تحميل الصفحة
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
