import {
  ChevronDown,
  Clock3,
  ExternalLink,
  History,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MonitorRun } from "../../shared/types";
import { formatDateTime, getTone, runStatusLabels } from "../utils";
import { Button, StatusBadge } from "./ui";

const emailStatusLabels: Record<string, string> = {
  skipped: "未发送",
  pending: "待投递",
  sent: "已发送",
  failed: "发送失败",
};

export function formatMonitorTime(value: string | null | undefined, timezone?: string) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (!timezone) return formatDateTime(value);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(date);
  } catch {
    return formatDateTime(value);
  }
}

function getRunOverview(run: MonitorRun) {
  const change = run.changeSummary.trim();
  const summary = run.summary.trim();
  if (change && !/^no material change\.?$/i.test(change)) return change;
  if (summary) return summary;
  if (change) return change;
  return `${runStatusLabels[run.status] ?? "运行结果"}已记录`;
}

function MonitorRunDetails({
  run,
  timezone,
  detailLabel,
  showEmailStatus,
}: {
  run: MonitorRun;
  timezone?: string;
  detailLabel: string;
  showEmailStatus: boolean;
}) {
  return (
    <article className="event-run-detail" aria-label={detailLabel}>
      <header className="event-run-detail-heading">
        <div>
          <span>{detailLabel}</span>
          <strong>{formatMonitorTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, timezone)}</strong>
        </div>
        <StatusBadge label={runStatusLabels[run.status] ?? run.status} tone={getTone(run.status)} />
      </header>

      <dl className="event-run-facts">
        <div>
          <dt>计划时间</dt>
          <dd>{formatMonitorTime(run.scheduledFor, timezone)}</dd>
        </div>
        <div>
          <dt>开始时间</dt>
          <dd>{formatMonitorTime(run.startedAt, timezone)}</dd>
        </div>
        <div>
          <dt>完成时间</dt>
          <dd>{formatMonitorTime(run.finishedAt, timezone)}</dd>
        </div>
        <div>
          <dt>AI 提供方</dt>
          <dd>{run.provider || "未记录"}</dd>
        </div>
        {showEmailStatus ? (
          <div>
            <dt>邮件投递</dt>
            <dd>{(emailStatusLabels[run.emailStatus] ?? run.emailStatus) || "未记录"}</dd>
          </div>
        ) : null}
        <div>
          <dt>运行编号</dt>
          <dd className="event-run-id">{run.id}</dd>
        </div>
      </dl>

      <div className="event-run-copy">
        <span>运行摘要</span>
        <p>{run.summary || "暂无摘要"}</p>
      </div>
      <div className="event-run-copy">
        <span>变化摘要</span>
        <p>{run.changeSummary || "暂无变化摘要"}</p>
      </div>

      {run.error ? (
        <div className="event-run-error" role="alert">
          <strong>运行错误</strong>
          <p>{run.error}</p>
        </div>
      ) : null}

      <div className="event-run-sources">
        <div className="event-run-copy-heading">
          <span>来源</span>
          <small>{run.sources.length ? `${run.sources.length} 条` : "暂无来源链接"}</small>
        </div>
        {run.sources.length ? (
          <ul className="event-source-list">
            {run.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  <span>{source.title || source.url}</span>
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

export function MonitorRunTimeline({
  targetId,
  loadRuns,
  timezone,
  title = "运行时间线",
  recordLabel = "运行记录",
  detailLabel = "本次运行",
  emptyLabel = "还没有运行记录",
  showEmailStatus = true,
}: {
  targetId: string;
  loadRuns: (id: string) => Promise<MonitorRun[]>;
  timezone?: string;
  title?: string;
  recordLabel?: string;
  detailLabel?: string;
  emptyLabel?: string;
  showEmailStatus?: boolean;
}) {
  const [runs, setRuns] = useState<MonitorRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selectedDetailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setError("");
    setLoading(true);
    setSelectedRunId(null);
    void loadRuns(targetId)
      .then((result) => {
        if (!cancelled) setRuns(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : `读取${recordLabel}失败`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRuns, recordLabel, reloadKey, targetId]);

  useEffect(() => {
    if (!selectedRunId || !runs?.some((run) => run.id === selectedRunId)) return;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      selectedDetailRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [runs, selectedRunId]);

  const selectedRun = runs?.find((run) => run.id === selectedRunId) ?? null;

  return (
    <section className="event-detail-section">
      <div className="event-detail-section-heading event-timeline-heading">
        <span className="event-detail-section-icon"><History size={16} /></span>
        <div>
          <h3>{title}</h3>
          <p>{runs ? `${runs.length} 次${recordLabel}` : `正在读取${recordLabel}`}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          title={`刷新${recordLabel}`}
          aria-label={`刷新${recordLabel}`}
          onClick={() => setReloadKey((current) => current + 1)}
          disabled={loading}
        >
          <RefreshCw className={loading ? "spin" : ""} size={16} />
        </button>
      </div>

      {loading ? (
        <div className="event-inline-state" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>正在读取{recordLabel}</span>
        </div>
      ) : error ? (
        <div className="event-inline-state event-inline-error" role="alert">
          <span>{error}</span>
          <Button className="secondary" type="button" onClick={() => setReloadKey((current) => current + 1)}>
            <RefreshCw size={15} /> 重试
          </Button>
        </div>
      ) : runs?.length ? (
        <>
          <div className="event-timeline" aria-label={recordLabel}>
            {runs.map((run, index) => {
              const selected = run.id === selectedRunId;
              const side = index % 2 === 0 ? "left" : "right";
              const detailId = `monitor-run-detail-${run.id}`;
              return (
                <div className={`event-timeline-entry ${side}`} key={run.id}>
                  <span className={`event-timeline-node status-${getTone(run.status)}${selected ? " selected" : ""}`} aria-hidden="true" />
                  <button
                    className={`event-run-item${selected ? " selected" : ""}`}
                    type="button"
                    onClick={() => setSelectedRunId(selected ? null : run.id)}
                    aria-expanded={selected}
                    aria-controls={detailId}
                  >
                    <span className="event-run-item-main">
                      <span className="event-run-item-top">
                        <strong>{formatMonitorTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, timezone)}</strong>
                        <StatusBadge label={runStatusLabels[run.status] ?? run.status} tone={getTone(run.status)} />
                      </span>
                      <span className="event-run-item-summary">{getRunOverview(run)}</span>
                    </span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {selectedRun ? (
            <div className="event-timeline-detail" id={`monitor-run-detail-${selectedRun.id}`} ref={selectedDetailRef}>
              <MonitorRunDetails
                run={selectedRun}
                timezone={timezone}
                detailLabel={detailLabel}
                showEmailStatus={showEmailStatus}
              />
            </div>
          ) : null}
        </>
      ) : (
        <div className="event-inline-state">
          <Clock3 size={18} />
          <span>{emptyLabel}</span>
        </div>
      )}
    </section>
  );
}
