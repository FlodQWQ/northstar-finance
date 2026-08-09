import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import {
  ApiError,
  api,
  setApiAuthSession,
  setApiUnauthorizedHandler,
  type AuthSessionData,
  type LoginInput,
  type RegisterInput,
} from "./api";
import AuthScreen, {
  AuthLoadingScreen,
  AuthUnavailableScreen,
  type AuthMode,
} from "./components/AuthScreen";
import Shell from "./components/Shell";
import { LoadingState, ToastProvider, useToast } from "./components/ui";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const HoldingsPage = lazy(() => import("./pages/HoldingsPage"));
const ExpectedPage = lazy(() => import("./pages/ExpectedPage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function SuspendedPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page"><LoadingState label="正在打开页面" /></div>}>{children}</Suspense>;
}

function AuthenticatedRoutes({
  session,
  loggingOut,
  onLogout,
}: {
  session: AuthSessionData;
  loggingOut: boolean;
  onLogout: () => void;
}) {
  return (
    <Routes>
      <Route element={<Shell user={session.user} loggingOut={loggingOut} onLogout={onLogout} />}>
        <Route index element={<SuspendedPage><DashboardPage /></SuspendedPage>} />
        <Route path="holdings" element={<SuspendedPage><HoldingsPage /></SuspendedPage>} />
        <Route path="expected" element={<SuspendedPage><ExpectedPage /></SuspendedPage>} />
        <Route path="events" element={<SuspendedPage><EventsPage /></SuspendedPage>} />
        <Route path="settings" element={<SuspendedPage><SettingsPage user={session.user} /></SuspendedPage>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

type AuthGateStatus = "checking" | "signed-out" | "signed-in" | "unavailable";

function AuthBoundary() {
  const [status, setStatus] = useState<AuthGateStatus>("checking");
  const [session, setSession] = useState<AuthSessionData | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const sessionRef = useRef<AuthSessionData | null>(null);
  const { notify } = useToast();

  const acceptSession = useCallback((nextSession: AuthSessionData) => {
    sessionRef.current = nextSession;
    setApiAuthSession(nextSession);
    setSession(nextSession);
    setSessionError("");
    setStatus("signed-in");
  }, []);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setApiAuthSession(null);
    setSession(null);
    setStatus("signed-out");
  }, []);

  const loadSession = useCallback(async (isRetry = false) => {
    if (isRetry) setRetrying(true);
    try {
      const nextSession = await api.auth.session();
      if (nextSession.authenticated) acceptSession(nextSession);
      else clearSession();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
      } else {
        setSessionError(error instanceof ApiError && error.status === 0
          ? "无法连接服务，请检查网络后重试"
          : "认证服务暂时不可用，请稍后重试");
        setStatus("unavailable");
      }
    } finally {
      if (isRetry) setRetrying(false);
    }
  }, [acceptSession, clearSession]);

  useEffect(() => {
    setApiAuthSession(null);
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    setApiUnauthorizedHandler(() => {
      const hadSession = sessionRef.current !== null;
      clearSession();
      if (hadSession) notify("登录状态已失效，请重新登录", "info");
    });
    return () => setApiUnauthorizedHandler(null);
  }, [clearSession, notify]);

  const handleAuthenticate = async (
    mode: AuthMode,
    input: LoginInput | RegisterInput,
  ) => {
    const nextSession = mode === "login"
      ? await api.auth.login(input as LoginInput)
      : await api.auth.register(input as RegisterInput);
    acceptSession(nextSession);
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api.auth.logout();
      clearSession();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession();
      } else {
        notify("退出失败，请检查网络后重试", "error");
      }
    } finally {
      setLoggingOut(false);
    }
  };

  if (status === "checking") return <AuthLoadingScreen />;
  if (status === "unavailable") {
    return (
      <AuthUnavailableScreen
        message={sessionError}
        retrying={retrying}
        onRetry={() => { void loadSession(true); }}
      />
    );
  }
  if (status === "signed-out" || !session) {
    return <AuthScreen onSubmit={handleAuthenticate} />;
  }
  return (
    <AuthenticatedRoutes
      session={session}
      loggingOut={loggingOut}
      onLogout={() => { void handleLogout(); }}
    />
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthBoundary />
    </ToastProvider>
  );
}
