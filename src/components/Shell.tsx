import {
  Bell,
  CalendarClock,
  Compass,
  LayoutDashboard,
  Settings,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

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

export default function Shell() {
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
          <div>
            <span className="mobile-brand"><Compass size={18} /></span>
            <strong>{pageName}</strong>
          </div>
          <button className="icon-button" type="button" aria-label="通知">
            <Bell size={19} />
          </button>
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
