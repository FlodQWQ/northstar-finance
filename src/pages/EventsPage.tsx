import {
  Bot,
  CalendarClock,
  CirclePause,
  CirclePlay,
  Filter,
  FileText,
  Mail,
  Play,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { EventStatus, TrackedEvent } from "../../shared/types";
import { api, type EventInput } from "../api";
import { formatMonitorTime, MonitorRunTimeline } from "../components/MonitorRunTimeline";
import { useResource } from "../hooks";
import { eventStatusLabels, formatDateTime, getTone, runStatusLabels } from "../utils";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  PageHeader,
  Sheet,
  SheetForm,
  StatusBadge,
  useToast,
} from "../components/ui";

const schedulePresets = {
  daily: { cron: "0 9 * * *", label: "每天 09:00" },
  weekdays: { cron: "0 9 * * 1-5", label: "工作日 09:00" },
  weekly: { cron: "0 9 * * 1", label: "每周一 09:00" },
  custom: { cron: "0 9 * * *", label: "自定义计划" },
} as const;

function CreateEventSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [preset, setPreset] = useState<keyof typeof schedulePresets>("daily");
  const [schedule, setSchedule] = useState<string>(schedulePresets.daily.cron);
  const [scheduleLabel, setScheduleLabel] = useState<string>(schedulePresets.daily.label);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailTo, setEmailTo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const changePreset = (value: keyof typeof schedulePresets) => {
    setPreset(value);
    setSchedule(schedulePresets[value].cron);
    setScheduleLabel(schedulePresets[value].label);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: EventInput = {
      name,
      topic,
      instructions,
      schedule,
      scheduleLabel,
      timezone,
      status: "active",
      notifyOnChangeOnly,
      emailEnabled,
      emailTo,
    };
    setSubmitting(true);
    try {
      await api.events.create(input);
      notify("事件已创建并加入调度队列");
      setName("");
      setTopic("");
      setInstructions("");
      onCreated();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "创建事件失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="创建跟踪事件" description="按计划联网检查，并在平台保留每次结果。">
      <SheetForm submitLabel="创建事件" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>跟踪目标</h3>
          <FormField label="事件名称" required>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每周跟踪美国利率决议" required autoFocus />
          </FormField>
          <FormField label="主题" required>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="说明要持续关注的对象" required />
          </FormField>
          <FormField label="执行指令" hint="写清楚需要比较什么、引用哪些信息以及输出格式" required>
            <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={6} placeholder="搜索权威来源，与上次结果比较，只报告关键变化并附链接。" required />
          </FormField>
        </div>

        <div className="form-section">
          <h3>运行计划</h3>
          <div className="form-grid two-column">
            <FormField label="频率">
              <select value={preset} onChange={(event) => changePreset(event.target.value as keyof typeof schedulePresets)}>
                <option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="custom">自定义</option>
              </select>
            </FormField>
            <FormField label="时区">
              <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                <option value="Asia/Shanghai">Asia/Shanghai</option><option value="UTC">UTC</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option>
              </select>
            </FormField>
          </div>
          {preset === "custom" ? (
            <div className="form-grid two-column">
              <FormField label="Cron 表达式" hint="分钟 小时 日 月 星期" required>
                <input value={schedule} onChange={(event) => setSchedule(event.target.value)} required />
              </FormField>
              <FormField label="计划说明" required>
                <input value={scheduleLabel} onChange={(event) => setScheduleLabel(event.target.value)} placeholder="例如：每月 1 日 09:00" required />
              </FormField>
            </div>
          ) : <div className="form-preview"><span>下发计划</span><strong>{schedulePresets[preset].label}</strong></div>}
        </div>

        <div className="form-section">
          <h3>通知</h3>
          <label className="toggle-row"><span><strong>仅在有变化时通知</strong><small>无变化仍会留下运行记录</small></span><input type="checkbox" checked={notifyOnChangeOnly} onChange={(event) => setNotifyOnChangeOnly(event.target.checked)} /></label>
          <label className="toggle-row"><span><strong>发送邮件</strong><small>需先在设置中配置 SMTP</small></span><input type="checkbox" checked={emailEnabled} onChange={(event) => setEmailEnabled(event.target.checked)} /></label>
          {emailEnabled ? <FormField label="收件邮箱" required><input type="email" value={emailTo} onChange={(event) => setEmailTo(event.target.value)} placeholder="you@example.com" required /></FormField> : null}
        </div>
      </SheetForm>
    </Sheet>
  );
}

function EventDetailDialog({
  event,
  onClose,
}: {
  event: TrackedEvent | null;
  onClose: () => void;
}) {
  const title = event?.name ?? "事件详情";
  const description = event?.topic || "查看事件配置与每次运行结果";

  return (
    <Dialog open={Boolean(event)} title={title} description={description} onClose={onClose}>
      {event ? (
        <div className="event-detail">
          <div className="event-detail-intro">
            <div>
              <span className="event-detail-label">跟踪事件</span>
              <p>{event.topic}</p>
            </div>
            <StatusBadge label={eventStatusLabels[event.status]} tone={getTone(event.status)} />
          </div>

          <div className="event-detail-meta" aria-label="事件信息">
            <div>
              <span>运行计划</span>
              <strong>{event.scheduleLabel}</strong>
              <small>{event.schedule}</small>
            </div>
            <div>
              <span>时区</span>
              <strong>{event.timezone}</strong>
              <small>按任务时区计算</small>
            </div>
            <div>
              <span>下次运行</span>
              <strong>{formatMonitorTime(event.nextRunAt, event.timezone)}</strong>
              <small>上次：{formatMonitorTime(event.lastRunAt, event.timezone)}</small>
            </div>
            <div>
              <span>通知策略</span>
              <strong>{event.emailEnabled ? "邮件已开启" : "仅平台记录"}</strong>
              <small>{event.notifyOnChangeOnly ? "仅有变化时发送" : "每次运行发送"}</small>
            </div>
            <div>
              <span>收件邮箱</span>
              <strong>{event.emailEnabled ? event.emailTo || "未配置" : "未启用"}</strong>
              <small>{event.emailEnabled ? "SMTP 投递目标" : "打开邮件后可配置"}</small>
            </div>
            <div>
              <span>最近结果</span>
              <strong>{event.lastRunStatus ? runStatusLabels[event.lastRunStatus] : "尚未运行"}</strong>
              <small>{event.lastSummary || "等待首次结果"}</small>
            </div>
          </div>

          <section className="event-detail-section">
            <div className="event-detail-section-heading">
              <span className="event-detail-section-icon"><FileText size={16} /></span>
              <div>
                <h3>执行指令</h3>
                <p>每次运行交给联网 AI 的任务说明</p>
              </div>
            </div>
            <p className="event-instructions">{event.instructions || "未填写执行指令"}</p>
          </section>

          <MonitorRunTimeline
            targetId={event.id}
            loadRuns={api.events.runs}
            timezone={event.timezone}
          />
        </div>
      ) : null}
    </Dialog>
  );
}

export default function EventsPage() {
  const { data: events, loading, error, reload } = useResource(api.events.list);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<TrackedEvent | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const { notify } = useToast();

  const filtered = useMemo(() => (events || []).filter((event) => {
    const matchesQuery = `${event.name} ${event.topic}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (status === "all" || event.status === status);
  }), [events, query, status]);

  const counts = useMemo(() => ({
    active: (events || []).filter((event) => event.status === "active").length,
    today: (events || []).filter((event) => event.nextRunAt && new Date(event.nextRunAt).toDateString() === new Date().toDateString()).length,
    failed: (events || []).filter((event) => event.lastRunStatus === "failed").length,
    paused: (events || []).filter((event) => event.status === "paused").length,
  }), [events]);

  const runNow = async (event: TrackedEvent) => {
    setRunningId(event.id);
    try {
      await api.events.run(event.id);
      notify(`${event.name} 已加入运行队列`);
      void reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "启动事件失败", "error");
    } finally {
      setRunningId(null);
    }
  };

  const toggleStatus = async (event: TrackedEvent) => {
    const nextStatus: EventStatus = event.status === "active" ? "paused" : "active";
    setUpdatingId(event.id);
    try {
      await api.events.update(event.id, { status: nextStatus });
      notify(nextStatus === "active" ? "事件已恢复" : "事件已暂停");
      void reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "更新事件失败", "error");
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="定期监控"
        title="事件"
        description="按计划联网查询关注事项，并保留变化与邮件投递记录。"
        actions={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 创建事件</Button>}
      />

      <section className="metric-strip" aria-label="事件摘要">
        <div><small>运行中</small><strong>{counts.active} 个</strong></div>
        <div><small>今日运行</small><strong>{counts.today} 个</strong></div>
        <div><small>上次失败</small><strong>{counts.failed} 个</strong></div>
        <div><small>已暂停</small><strong>{counts.paused} 个</strong></div>
      </section>

      <section className="surface data-surface">
        <div className="toolbar">
          <div className="search-control"><Search size={17} /><input aria-label="搜索事件" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件或主题" /></div>
          <div className="toolbar-group">
            <label className="select-control"><Filter size={16} /><span className="sr-only">事件状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(eventStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <Button className="icon-only secondary" type="button" aria-label="刷新事件" title="刷新" onClick={() => void reload()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={17} /></Button>
          </div>
        </div>

        {loading && !events ? <LoadingState label="正在读取事件计划" /> : null}
        {error && !events ? <ErrorState message={error} retry={() => void reload()} /> : null}
        {events && !events.length ? <EmptyState title="还没有跟踪事件" description="创建一个定期任务，自动汇总变化并发送邮件。" action={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 创建事件</Button>} /> : null}
        {events?.length && !filtered.length ? <EmptyState title="没有匹配的事件" description="调整搜索词或状态筛选。" /> : null}

        {filtered.length ? (
          <>
            <div className="table-wrap desktop-table">
              <table>
                <thead><tr><th>事件</th><th>计划</th><th>下次运行</th><th>上次结果</th><th>邮件</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>{filtered.map((event) => (
                  <tr className="event-row" key={event.id} onClick={() => setSelectedEvent(event)}>
                    <td>
                      <button className="event-open-button" type="button" onClick={() => setSelectedEvent(event)} aria-label={`查看事件 ${event.name}`}>
                        <span className="asset-cell"><span className="asset-avatar event-avatar"><CalendarClock size={17} /></span><span><strong>{event.name}</strong><small className="clamp-one">{event.topic}</small></span></span>
                      </button>
                    </td>
                    <td><strong className="cell-primary">{event.scheduleLabel}</strong><small className="cell-secondary">{event.timezone}</small></td>
                    <td><strong className="cell-primary">{formatDateTime(event.nextRunAt)}</strong></td>
                    <td className="wide-cell">{event.lastRunStatus ? <StatusBadge label={runStatusLabels[event.lastRunStatus]} tone={getTone(event.lastRunStatus)} /> : <StatusBadge label="尚未运行" />}<small className="cell-secondary clamp-one">{event.lastSummary || "等待首次结果"}</small></td>
                    <td>{event.emailEnabled ? <span className="inline-icon-text"><Mail size={15} /> 已开启</span> : <span className="muted-text">未开启</span>}</td>
                    <td><StatusBadge label={eventStatusLabels[event.status]} tone={getTone(event.status)} /></td>
                     <td><div className="row-actions"><button className="icon-button" type="button" title="立即运行" aria-label={`立即运行 ${event.name}`} onClick={(clickEvent) => { clickEvent.stopPropagation(); void runNow(event); }} disabled={runningId === event.id || event.status !== "active"}>{runningId === event.id ? <RefreshCw className="spin" size={17} /> : <Play size={17} />}</button><button className="icon-button" type="button" title={event.status === "active" ? "暂停" : "恢复"} aria-label={`${event.status === "active" ? "暂停" : "恢复"} ${event.name}`} onClick={(clickEvent) => { clickEvent.stopPropagation(); void toggleStatus(event); }} disabled={updatingId === event.id || event.status === "expired"}>{updatingId === event.id ? <RefreshCw className="spin" size={17} /> : event.status === "active" ? <CirclePause size={17} /> : <CirclePlay size={17} />}</button></div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>

            <div className="mobile-data-list">
              {filtered.map((event) => (
                <article className="mobile-data-item event-card" key={event.id} onClick={() => setSelectedEvent(event)}>
                  <header>
                    <button className="event-open-button event-mobile-trigger" type="button" onClick={() => setSelectedEvent(event)} aria-label={`查看事件 ${event.name}`}>
                      <span className="asset-cell"><span className="asset-avatar event-avatar"><CalendarClock size={17} /></span><span><strong>{event.name}</strong><small>{event.scheduleLabel}</small></span></span>
                    </button>
                    <StatusBadge label={eventStatusLabels[event.status]} tone={getTone(event.status)} />
                  </header>
                  <div className="event-mobile-result"><small>上次结果</small><div>{event.lastRunStatus ? <StatusBadge label={runStatusLabels[event.lastRunStatus]} tone={getTone(event.lastRunStatus)} /> : <StatusBadge label="尚未运行" />}</div><p>{event.lastSummary || "等待首次执行"}</p></div>
                  <div className="mobile-meta"><span>下次 {formatDateTime(event.nextRunAt)}</span><span>{event.emailEnabled ? "邮件已开启" : "仅平台记录"}</span></div>
                   <footer><Button className="secondary" type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); void toggleStatus(event); }} disabled={updatingId === event.id || event.status === "expired"}>{event.status === "active" ? <CirclePause size={16} /> : <CirclePlay size={16} />}{event.status === "active" ? "暂停" : "恢复"}</Button><Button className="primary" type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); void runNow(event); }} disabled={runningId === event.id || event.status !== "active"}>{runningId === event.id ? <RefreshCw className="spin" size={16} /> : <Play size={16} />} 立即运行</Button></footer>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <div className="direction-note" role="note"><span><Bot size={16} /> 每次运行保留来源与变化</span><span><Mail size={16} /> 邮件失败不影响平台记录</span><span><CalendarClock size={16} /> 所有时间按任务时区执行</span></div>
      <CreateEventSheet open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />
      <EventDetailDialog event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}
