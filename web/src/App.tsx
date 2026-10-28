import { lazy, Suspense, Component, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './lib/auth';
import { AppLayout } from './components/Layout';
import Landing from './pages/Landing';
import { Login, Register } from './pages/Auth';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Twins = lazy(() => import('./pages/Twins'));
const TwinDetail = lazy(() => import('./pages/TwinDetail'));
const Simulator = lazy(() => import('./pages/Simulator'));
const Interactions = lazy(() => import('./pages/Interactions'));
const TDM = lazy(() => import('./pages/TDM'));
const Trials = lazy(() => import('./pages/Trials'));
const Anesthesia = lazy(() => import('./pages/Anesthesia'));
const Discovery = lazy(() => import('./pages/Discovery'));
const Training = lazy(() => import('./pages/Training'));
const Library = lazy(() => import('./pages/Library'));
const Methods = lazy(() => import('./pages/Methods'));
const Experiments = lazy(() => import('./pages/Experiments'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const BodyTwin = lazy(() => import('./pages/BodyTwin'));
const Learning = lazy(() => import('./pages/Learning'));
const Regulatory = lazy(() => import('./pages/Regulatory'));
const Signals = lazy(() => import('./pages/Signals'));
const ADR = lazy(() => import('./pages/ADR'));

function Spinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted" role="status">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="mx-auto mt-16 max-w-lg rounded-2xl border border-line bg-surface p-6 text-center">
          <p className="text-lg font-semibold">Something went wrong</p>
          <p className="mt-2 text-sm text-muted">This view hit an unexpected error. Your saved data is safe.</p>
          <button className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg" onClick={() => location.reload()}>
            Reload page
          </button>
        </div>
      );
    return this.props.children;
  }
}

function RequireAuth({ children, role }: { children: ReactNode; role?: string }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (role && user.role !== role) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="body" element={<BodyTwin />} />
            <Route path="learning" element={<Learning />} />
            <Route path="regulatory" element={<Regulatory />} />
            <Route path="signals" element={<Signals />} />
            <Route path="adr" element={<ADR />} />
            <Route path="twins" element={<Twins />} />
            <Route path="twins/:id" element={<TwinDetail />} />
            <Route path="simulate" element={<Simulator />} />
            <Route path="interactions" element={<Interactions />} />
            <Route path="tdm" element={<TDM />} />
            <Route path="trials" element={<Trials />} />
            <Route path="anesthesia" element={<Anesthesia />} />
            <Route path="discovery" element={<Discovery />} />
            <Route path="training" element={<Training />} />
            <Route path="library" element={<Library />} />
            <Route path="methods" element={<Methods />} />
            <Route path="experiments" element={<Experiments />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<RequireAuth role="admin"><Admin /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
