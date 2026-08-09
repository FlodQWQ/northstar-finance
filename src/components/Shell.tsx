import {
  Bell,
  CalendarClock,
  Compass,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Settings,
  Sparkles,
  UserRound,
  WalletCards,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { AuthUser } from "../api";

const navItems = [
  { to: "/", label: "总览", icon: LayoutDashboard, end: true },
  { to: "/holdings", label: "持仓", icon: WalletCards },
  { to: "/expected", label: "预期资产", shortLabel: "预期", icon: Sparkles },
  { to: "/events", label: "事件", icon: CalendarClock },
  { to: "/settings", label: "设置", icon: Settings },
];

const pageNames: Record<string, string> = {
  "/": "资产总览",
  "/holdings": "直接持仓",
  "/expected": "预期资产",
  "/events": "事件跟踪",
  "/settings": "系统设置",
};

export default function Shell({
  user,
  loggingOut,
  onLogout,
}: {
  user: AuthUser;
  loggingOut: boolean;
  onLogout: () => void;
}) {
  const location = useLocation();
  const pageName = pageNames[location.pathname] || "Northstar";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Compass size={19} /></span>
          <span><strong>Northstar</strong><small>个人资产工作台</small></span>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="connection-dot" />
          <span><strong>本地服务</strong><small>数据由你的服务管理</small></span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <span className="mobile-brand"><Compass size={18} /></span>
            <strong>{pageName}</strong>
          </div>
          <div className="topbar-actions">
            <button className="icon-button notification-button" type="button" aria-label="通知" title="通知">
              <Bell size={19} />
            </button>
            <div className="account-control" role="group" aria-label={`当前账户：${user.username}`}>
              <span className="account-avatar"><UserRound size={17} /></span>
              <span className="account-copy">
                <strong title={user.username}>{user.username}</strong>
                <small>{user.role === "owner" ? "所有者" : "成员"}</small>
              </span>
              <button
                className="icon-button account-logout"
                type="button"
                aria-label={`退出 ${user.username}`}
                title="退出登录"
                onClick={onLogout}
                disabled={loggingOut}
              >
                {loggingOut ? <LoaderCircle className="spin" size={18} /> : <LogOut size={18} />}
              </button>
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="移动端主导航">
        {navItems.map(({ to, label, shortLabel, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon size={20} />
            <span>{shortLabel || label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
