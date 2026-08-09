import {
  Bot,
  CheckCircle2,
  Database,
  Globe2,
  LoaderCircle,
  Mail,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AppSettings } from "../../shared/types";
import { api, type AuthUser } from "../api";
import { useResource } from "../hooks";
import {
  Button,
  ErrorState,
  FormField,
  LoadingState,
  PageHeader,
  StatusBadge,
  useToast,
} from "../components/ui";

export default function SettingsPage({ user }: { user: AuthUser }) {
  const { data, loading, error, reload, setData } = useResource(api.settings.get);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"ai" | "price" | "email" | null>(null);
  const { notify } = useToast();

  useEffect(() => {
    if (!data) return;
    setForm(data);
  }, [data]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const payload: Partial<AppSettings> & Record<string, unknown> = {
        baseCurrency: form.baseCurrency,
        timezone: form.timezone,
        locale: form.locale,
        notificationEmail: form.notificationEmail,
        ...(user.role === "owner"
          ? {
              proxyUrl: form.proxyUrl,
            }
          : {}),
      };
      const saved = await api.settings.update(payload);
      setData(saved);
      setForm(saved);
      notify("设置已保存");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "保存设置失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (kind: "ai" | "price" | "email") => {
    setTesting(kind);
    try {
      await api.settings.test(kind);
      notify(kind === "email" ? "SMTP 连接测试成功" : kind === "ai" ? "AI 连接测试成功" : "价格数据源连接正常");
      void reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "连接测试失败", "error");
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="系统与连接"
        title="设置"
        description="管理本位币、联网代理、AI、价格来源和邮件投递。"
        actions={
          <Button className="primary" type="submit" form="settings-form" disabled={!form || saving}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} {saving ? "正在保存" : "保存设置"}
          </Button>
        }
      />

      {loading && !form ? <LoadingState label="正在读取设置" /> : null}
      {error && !form ? <ErrorState message={error} retry={() => void reload()} /> : null}

      {form ? (
        <form id="settings-form" className="settings-layout" onSubmit={save}>
          <nav className={`settings-nav${user.role === "owner" ? "" : " compact"}`} aria-label="设置分区">
            <a href="#general"><Settings2 size={16} /> 常规</a>
            {user.role === "owner" ? <a href="#network"><Globe2 size={16} /> 网络与价格</a> : null}
            {user.role === "owner" ? <a href="#ai"><Bot size={16} /> AI</a> : null}
            <a href="#email"><Mail size={16} /> 邮件</a>
            <a href="#security"><ShieldCheck size={16} /> 数据安全</a>
          </nav>

          <div className="settings-content">
            <section className="surface settings-section" id="general">
              <div className="settings-section-heading"><span><Settings2 size={19} /></span><div><h2>常规</h2><p>决定整个平台的显示与时间口径。</p></div></div>
              <div className="form-grid two-column">
                <FormField label="本位币" required>
                  <select value={form.baseCurrency} onChange={(event) => setForm({ ...form, baseCurrency: event.target.value })}>
                    <option value="CNY">CNY · 人民币</option><option value="USD">USD · 美元</option><option value="USDT">USDT · 泰达币</option><option value="HKD">HKD · 港币</option><option value="EUR">EUR · 欧元</option>
                  </select>
                </FormField>
                <FormField label="时区" required>
                  <select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>
                    <option value="Asia/Shanghai">Asia/Shanghai</option><option value="UTC">UTC</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option>
                  </select>
                </FormField>
                <FormField label="界面语言">
                  <select value={form.locale} onChange={(event) => setForm({ ...form, locale: event.target.value })}>
                    <option value="zh-CN">简体中文</option><option value="en-US">English</option>
                  </select>
                </FormField>
              </div>
            </section>

            {user.role === "owner" ? <section className="surface settings-section" id="network">
              <div className="settings-section-heading"><span><Globe2 size={19} /></span><div><h2>网络与价格数据</h2><p>所有联网查询均由服务端发起。</p></div></div>
              <FormField label="HTTP 代理" hint="容器访问宿主机代理时使用 http://host.docker.internal:7890">
                <input type="url" value={form.proxyUrl} onChange={(event) => setForm({ ...form, proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890" />
              </FormField>
              <div className="connection-row">
                <div><span className="connection-icon"><Database size={18} /></span><span><strong>价格数据源</strong><small>用于持仓页面的按需价格更新</small></span></div>
                <Button className="secondary" type="button" onClick={() => void testConnection("price")} disabled={testing !== null}>{testing === "price" ? <LoaderCircle className="spin" size={16} /> : <Wifi size={16} />} 测试连接</Button>
              </div>
            </section> : null}

            {user.role === "owner" ? <section className="surface settings-section" id="ai">
              <div className="settings-section-heading"><span><Bot size={19} /></span><div><h2>AI 服务</h2><p>由部署环境管理；连接测试会执行一次真实联网搜索。</p></div><StatusBadge label={form.aiConfigured ? "已配置" : "未配置"} tone={form.aiConfigured ? "positive" : "warning"} /></div>
              <div className="form-grid two-column">
                <FormField label="运行模式">
                  <select value={form.aiProvider} disabled>
                    <option value="auto">自动 · Codex 优先</option><option value="codex-sdk">Codex SDK</option><option value="opencode-agent-reach">OpenCode + Agent-Reach</option><option value="disabled">已停用</option>{form.aiProvider === "mock" ? <option value="mock">本地模拟</option> : null}
                  </select>
                </FormField>
                <FormField label="模型">
                  <input value={form.aiModel} disabled placeholder="由服务端选择" />
                </FormField>
              </div>
              <FormField label="API Base URL">
                <input type="url" value={form.aiBaseUrl} disabled placeholder="由服务端配置" />
              </FormField>
              <div className="section-actions"><Button className="secondary" type="button" onClick={() => void testConnection("ai")} disabled={testing !== null}>{testing === "ai" ? <LoaderCircle className="spin" size={16} /> : <Bot size={16} />} 测试 AI</Button></div>
            </section> : null}

            <section className="surface settings-section" id="email">
              <div className="settings-section-heading"><span><Mail size={19} /></span><div><h2>邮件通知</h2><p>SMTP 连接由服务器环境统一管理，账户只保存自己的默认收件地址。</p></div><StatusBadge label={form.smtpConfigured ? "服务可用" : "服务未配置"} tone={form.smtpConfigured ? "positive" : "warning"} /></div>
              <FormField label="默认收件邮箱">
                <input type="email" value={form.notificationEmail} onChange={(event) => setForm({ ...form, notificationEmail: event.target.value })} placeholder="you@example.com" />
              </FormField>
              {user.role === "owner" ? <div className="section-actions"><Button className="secondary" type="button" onClick={() => void testConnection("email")} disabled={testing !== null}>{testing === "email" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} 测试 SMTP</Button></div> : null}
            </section>

            <section className="surface settings-section" id="security">
              <div className="settings-section-heading"><span><ShieldCheck size={19} /></span><div><h2>数据与安全</h2><p>当前版本的数据保存在部署服务器的本地数据库。</p></div></div>
              <div className="security-list">
                <div><CheckCircle2 size={17} /><span><strong>凭证留在服务端</strong><small>AI 与 SMTP 敏感凭证由部署环境管理，不进入浏览器设置响应。</small></span></div>
                <div><CheckCircle2 size={17} /><span><strong>事件运行可审计</strong><small>摘要、来源、错误和邮件状态均保留记录。</small></span></div>
                <div><CheckCircle2 size={17} /><span><strong>预期价值隔离</strong><small>预期资产永远不会被总览计入实际净值。</small></span></div>
              </div>
            </section>

            <div className="mobile-save-bar"><Button className="primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} {saving ? "正在保存" : "保存设置"}</Button></div>
          </div>
        </form>
      ) : null}
    </div>
  );
}
