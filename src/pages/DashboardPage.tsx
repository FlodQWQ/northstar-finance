import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  Clock3,
  Coins,
  RefreshCw,
  Scale,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "react-router-dom";
import { api } from "../api";
import { AssetIcon } from "../components/AssetIcon";
import { useResource } from "../hooks";
import {
  assetKindLabels,
  formatCompactMoney,
  formatDateTime,
  formatMoney,
  stringFromUnknown,
} from "../utils";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../components/ui";

export default function DashboardPage() {
  const { data, loading, error, reload } = useResource(api.dashboard);
  const allocationData = data?.allocation.map((item) => ({
    ...item,
    displayName: assetKindLabels[item.name] || item.name,
  })) || [];

  return (
    <div className="page">
      <PageHeader
        eyebrow="今日工作台"
        title="总览"
        description="实际资产、待跟进机会与定期事件的统一视图。"
        actions={
          <Button className="secondary" type="button" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={17} /> 更新数据
          </Button>
        }
      />

      {loading && !data ? <LoadingState label="正在汇总资产" /> : null}
      {error && !data ? <ErrorState message={error} retry={() => void reload()} /> : null}

      {data ? (
        <>
          <section className="metric-grid" aria-label="资产摘要">
            <article className="metric-card">
              <span className="metric-icon"><CircleDollarSign size={18} /></span>
              <div><small>实际净资产</small><strong>{formatMoney(data.netWorth, data.baseCurrency)}</strong></div>
              <span className="metric-note">{data.unconvertedAssetCount ? `另有 ${data.unconvertedAssetCount} 项其他币种未折算` : "仅包含直接持仓"}</span>
            </article>
            <article className="metric-card">
              <span className="metric-icon"><Scale size={18} /></span>
              <div><small>持仓成本</small><strong>{formatMoney(data.costBasis, data.baseCurrency)}</strong></div>
              <span className="metric-note">已记录成本口径</span>
            </article>
            <article className="metric-card">
              <span className="metric-icon"><TrendingUp size={18} /></span>
              <div><small>累计盈亏</small><strong className={Number(data.totalPnl) >= 0 ? "positive-text" : "danger-text"}>{formatMoney(data.totalPnl, data.baseCurrency)}</strong></div>
              <span className="metric-note">实际资产变动</span>
            </article>
            <article className="metric-card expected-metric">
              <span className="metric-icon"><Coins size={18} /></span>
              <div><small>预期价值区间</small><strong>{formatMoney(data.expectedLow, data.baseCurrency)} - {formatMoney(data.expectedHigh, data.baseCurrency)}</strong></div>
              <span className="metric-note">{data.unconvertedExpectedCount ? `另有 ${data.unconvertedExpectedCount} 项其他币种未折算` : "不计入实际净资产"}</span>
            </article>
          </section>

          <div className="dashboard-primary-grid">
            <section className="surface chart-surface" aria-labelledby="trend-title">
              <div className="section-heading">
                <div><h2 id="trend-title">净值趋势</h2><p>直接持仓的历史估值</p></div>
                <StatusBadge label={data.baseCurrency} tone="neutral" />
              </div>
              {data.trend.length ? (
                <div className="chart-wrap" role="img" aria-label={`净值趋势，共 ${data.trend.length} 个数据点`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.trend} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                      <CartesianGrid stroke="#edf0f3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#6b7280", fontSize: 12 }} minTickGap={28} />
                      <YAxis tickLine={false} axisLine={false} width={64} tick={{ fill: "#6b7280", fontSize: 12 }} tickFormatter={(value: number) => formatCompactMoney(value, data.baseCurrency)} />
                      <Tooltip formatter={(value) => formatMoney(Number(value), data.baseCurrency)} contentStyle={{ borderRadius: 6, borderColor: "#e4e4e7" }} />
                      <Area type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} fill="#dbeafe" fillOpacity={0.65} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyState title="暂无趋势数据" description="记录价格后，这里会显示实际净值变化。" />}
            </section>

            <section className="surface attention-surface" aria-labelledby="attention-title">
              <div className="section-heading">
                <div><h2 id="attention-title">待处理</h2><p>按数据风险排序</p></div>
                <AlertTriangle size={19} />
              </div>
              <div className="attention-list">
                <Link to="/holdings" className="attention-row">
                  <span className="attention-icon warning"><Clock3 size={17} /></span>
                  <span><strong>{data.staleAssetCount} 项价格待更新</strong><small>直接资产价格超过新鲜度阈值</small></span>
                  <ArrowRight size={17} />
                </Link>
                <Link to="/expected" className="attention-row">
                  <span className="attention-icon info"><Coins size={17} /></span>
                  <span><strong>{data.dueExpectedCount} 项预期资产待检查</strong><small>状态或新闻已到更新时间</small></span>
                  <ArrowRight size={17} />
                </Link>
                <Link to="/events" className="attention-row">
                  <span className="attention-icon neutral"><CalendarClock size={17} /></span>
                  <span><strong>{data.upcomingEventCount} 个事件即将执行</strong><small>查看计划与邮件投递配置</small></span>
                  <ArrowRight size={17} />
                </Link>
              </div>
            </section>
          </div>

          <div className="dashboard-secondary-grid">
            <section className="surface" aria-labelledby="allocation-title">
              <div className="section-heading">
                <div><h2 id="allocation-title">资产分布</h2><p>按直接资产类型统计</p></div>
              </div>
              {allocationData.length ? (
                <div className="allocation-layout">
                  <div className="allocation-chart" role="img" aria-label="直接资产类型分布">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={allocationData} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 4 }}>
                        <CartesianGrid stroke="#edf0f3" horizontal={false} />
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="displayName" tickLine={false} axisLine={false} width={62} tick={{ fill: "#52525b", fontSize: 12 }} />
                        <Tooltip formatter={(value) => formatMoney(Number(value), data.baseCurrency)} cursor={{ fill: "#f4f5f7" }} />
                        <Bar dataKey="value" fill="#2563eb" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="allocation-legend">
                    {allocationData.map((item) => (
                      <div key={item.name}><span style={{ backgroundColor: item.color || "#2563eb" }} /><strong>{item.displayName}</strong><small>{formatMoney(item.value, data.baseCurrency)}</small></div>
                    ))}
                  </div>
                </div>
              ) : <EmptyState title="暂无分布数据" description="新增直接资产后即可查看配置。" />}
            </section>

            <section className="surface" aria-labelledby="upcoming-title">
              <div className="section-heading">
                <div><h2 id="upcoming-title">即将运行</h2><p>下一批定期事件</p></div>
                <Link className="text-link" to="/events">查看全部 <ArrowRight size={15} /></Link>
              </div>
              {data.upcomingEvents.length ? (
                <div className="compact-list">
                  {data.upcomingEvents.slice(0, 5).map((event) => (
                    <div className="compact-row" key={event.id}>
                      <span className="row-symbol"><CalendarClock size={17} /></span>
                      <span><strong>{event.name}</strong><small>{event.scheduleLabel}</small></span>
                      <time>{formatDateTime(event.nextRunAt)}</time>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="暂无计划事件" description="创建一个定期跟踪任务，结果会汇总到这里。" />}
            </section>

            <section className="surface recent-surface" aria-labelledby="recent-title">
              <div className="section-heading">
                <div><h2 id="recent-title">近期资产操作</h2><p>持仓数量与成本的审计记录</p></div>
                <Link className="text-link" to="/holdings">管理持仓 <ArrowRight size={15} /></Link>
              </div>
              {data.recentOperations.length ? (
                <div className="compact-list">
                  {data.recentOperations.slice(0, 6).map((operation, index) => {
                    const title = stringFromUnknown(operation.assetName || operation.name, "资产操作");
                    const symbol = stringFromUnknown(operation.assetSymbol);
                    const type = stringFromUnknown(operation.type, "记录");
                    const happenedAt = stringFromUnknown(operation.occurredAt || operation.createdAt);
                    const quantity = stringFromUnknown(operation.quantity || operation.quantityDelta);
                    return (
                      <div className="compact-row" key={stringFromUnknown(operation.id, String(index))}>
                        <AssetIcon name={title} symbol={symbol} currency={stringFromUnknown(operation.currency)} size="compact" />
                        <span><strong>{title}</strong><small>{type}{quantity ? ` · ${quantity}` : ""}</small></span>
                        <time>{formatDateTime(happenedAt)}</time>
                      </div>
                    );
                  })}
                </div>
              ) : <EmptyState title="暂无操作流水" description="买入、卖出和调整记录会显示在这里。" />}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
