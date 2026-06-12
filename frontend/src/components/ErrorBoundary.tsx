import React from 'react';

interface State { hasError: boolean; error?: Error; errorCount: number; }

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, errorCount: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log error for debugging
    console.error('[ErrorBoundary] Caught error:', error.message);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  handleReset = () => {
    // Try to recover without full page reload
    this.setState(prev => ({
      hasError: false,
      error: undefined,
      errorCount: prev.errorCount + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      const isHooksError = this.state.error?.message?.includes('310') ||
                           this.state.error?.message?.includes('Hooks') ||
                           this.state.error?.message?.includes('hooks');
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-3xl">⚠️</div>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>حدث خطأ غير متوقع</h2>
          {isHooksError ? (
            <p style={{ color: 'var(--text-secondary)' }} className="max-w-md text-sm">
              خطأ في تهيئة الصفحة. يرجى النقر على "إعادة المحاولة" أدناه.
            </p>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }} className="max-w-md text-sm">
              {this.state.error?.message || 'خطأ غير معروف'}
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--brand-primary)', color: '#fff' }}
            >
              إعادة المحاولة
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm font-medium border"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            >
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
