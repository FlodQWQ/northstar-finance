import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Shell from "./components/Shell";
import { LoadingState, ToastProvider } from "./components/ui";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const HoldingsPage = lazy(() => import("./pages/HoldingsPage"));
const ExpectedPage = lazy(() => import("./pages/ExpectedPage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function SuspendedPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page"><LoadingState label="正在打开页面" /></div>}>{children}</Suspense>;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<SuspendedPage><DashboardPage /></SuspendedPage>} />
          <Route path="holdings" element={<SuspendedPage><HoldingsPage /></SuspendedPage>} />
          <Route path="expected" element={<SuspendedPage><ExpectedPage /></SuspendedPage>} />
          <Route path="events" element={<SuspendedPage><EventsPage /></SuspendedPage>} />
          <Route path="settings" element={<SuspendedPage><SettingsPage /></SuspendedPage>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
