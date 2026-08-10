import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Filter,
  FileText,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { AssetKind, ExpectedAsset, ExpectedHealth, ExpectedStage } from "../../shared/types";
import { api, type ExpectedConversionInput, type ExpectedInput } from "../api";
import { AssetIcon } from "../components/AssetIcon";
import { MonitorRunTimeline } from "../components/MonitorRunTimeline";
import { useResource } from "../hooks";
import {
  expectedHealthLabels,
  expectedStageLabels,
  formatDate,
  formatDateTime,
  formatMoney,
  getTone,
  toLocalInputValue,
} from "../utils";
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

const confidenceLabels = { low: "低", medium: "中", high: "高" } as const;

function nextDayIso() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function CreateExpectedSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("空投");
  const [ecosystem, setEcosystem] = useState("");
  const [stage, setStage] = useState<ExpectedStage>("discovered");
  const [nextAction, setNextAction] = useState("");
  const [deadline, setDeadline] = useState("");
  const [estimatedLow, setEstimatedLow] = useState("0");
  const [estimatedHigh, setEstimatedHigh] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [investedCost, setInvestedCost] = useState("0");
  const [confidence, setConfidence] = useState<ExpectedAsset["confidence"]>("medium");
  const [sourceUrl, setSourceUrl] = useState("");
  const [keywords, setKeywords] = useState("");
  const [nextCheckAt, setNextCheckAt] = useState(toLocalInputValue(nextDayIso()));
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: ExpectedInput = {
      name,
      category,
      ecosystem,
      stage,
      health: "healthy",
      nextAction,
      deadline: deadline ? new Date(`${deadline}T23:59:59`).toISOString() : null,
      estimatedLow,
      estimatedHigh,
      currency,
      investedCost,
      confidence,
      sourceUrl,
      keywords: keywords.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      latestUpdate: "已创建，等待首次检查",
      nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : nextDayIso(),
      notes,
    };
    setSubmitting(true);
    try {
      await api.expected.create(input);
      notify("预期资产已加入跟踪队列");
      setName("");
      setNextAction("");
      setNotes("");
      onCreated();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "创建预期资产失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="创建预期资产" description="预期价值独立展示，不计入实际净资产。">
      <SheetForm submitLabel="开始跟踪" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>项目与阶段</h3>
          <div className="form-grid two-column">
            <FormField label="项目名称" required>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：项目空投第二季" required autoFocus />
            </FormField>
            <FormField label="类型" required>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option>空投</option><option>链上活动</option><option>返利</option><option>未解锁资产</option><option>认购</option><option>其他</option>
              </select>
            </FormField>
            <FormField label="项目 / 生态">
              <input value={ecosystem} onChange={(event) => setEcosystem(event.target.value)} placeholder="项目方或所在生态" />
            </FormField>
            <FormField label="当前阶段">
              <select value={stage} onChange={(event) => setStage(event.target.value as ExpectedStage)}>
                {Object.entries(expectedStageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </FormField>
          </div>
          <FormField label="下一步行动" required>
            <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="例如：完成第三周交互" required />
          </FormField>
        </div>

        <div className="form-section">
          <h3>时间与估值</h3>
          <div className="form-grid two-column">
            <FormField label="截止日期">
              <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            </FormField>
            <FormField label="下次检查" required>
              <input type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} required />
            </FormField>
            <FormField label="预估下限">
              <input type="number" inputMode="decimal" step="any" min="0" value={estimatedLow} onChange={(event) => setEstimatedLow(event.target.value)} />
            </FormField>
            <FormField label="预估上限">
              <input type="number" inputMode="decimal" step="any" min="0" value={estimatedHigh} onChange={(event) => setEstimatedHigh(event.target.value)} />
            </FormField>
            <FormField label="估值币种">
              <input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={8} />
            </FormField>
            <FormField label="信心等级">
              <select value={confidence} onChange={(event) => setConfidence(event.target.value as ExpectedAsset["confidence"])}>
                <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
              </select>
            </FormField>
            <FormField label="已投入成本">
              <input type="number" inputMode="decimal" step="any" min="0" value={investedCost} onChange={(event) => setInvestedCost(event.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="form-section">
          <h3>检查依据</h3>
          <FormField label="官方来源" hint="AI 检查将优先引用该地址">
            <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://" />
          </FormField>
          <FormField label="关键词" hint="使用逗号分隔">
            <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="claim, snapshot, season 2" />
          </FormField>
          <FormField label="备注">
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="资格条件、钱包或风险信息" />
          </FormField>
        </div>
      </SheetForm>
    </Sheet>
  );
}

function UpdateExpectedSheet({ item, onClose, onSaved }: { item: ExpectedAsset | null; onClose: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<ExpectedStage>(item?.stage || "watching");
  const [health, setHealth] = useState<ExpectedHealth>(item?.health || "healthy");
  const [nextAction, setNextAction] = useState(item?.nextAction || "");
  const [latestUpdate, setLatestUpdate] = useState(item?.latestUpdate || "");
  const [nextCheckAt, setNextCheckAt] = useState(toLocalInputValue(item?.nextCheckAt));
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item) return;
    setSubmitting(true);
    try {
      await api.expected.update(item.id, {
        stage,
        health,
        nextAction,
        latestUpdate,
        nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : item.nextCheckAt,
      });
      notify(`${item.name} 的状态已更新`);
      onSaved();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "更新状态失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={Boolean(item)} onClose={onClose} title="更新项目状态" description={item?.name}>
      <SheetForm submitLabel="保存状态" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>跟踪状态</h3>
          <div className="form-grid two-column">
            <FormField label="业务阶段" required>
              <select value={stage} onChange={(event) => setStage(event.target.value as ExpectedStage)}>
                {Object.entries(expectedStageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </FormField>
            <FormField label="更新健康度" required>
              <select value={health} onChange={(event) => setHealth(event.target.value as ExpectedHealth)}>
                {Object.entries(expectedHealthLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </FormField>
          </div>
          <FormField label="下一步行动" required>
            <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} required />
          </FormField>
          <FormField label="本次更新" required>
            <textarea value={latestUpdate} onChange={(event) => setLatestUpdate(event.target.value)} rows={4} placeholder="记录状态变化、新闻与依据" required />
          </FormField>
          <FormField label="下次检查" required>
            <input type="datetime-local" value={nextCheckAt} onChange={(event) => setNextCheckAt(event.target.value)} required />
          </FormField>
        </div>
      </SheetForm>
    </Sheet>
  );
}

function ConvertExpectedSheet({ item, onClose, onSaved }: { item: ExpectedAsset | null; onClose: () => void; onSaved: () => void }) {
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState<AssetKind>("crypto");
  const [account, setAccount] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("0");
  const [currentPrice, setCurrentPrice] = useState("0");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item) return;
    setSubmitting(true);
    try {
      const input: ExpectedConversionInput = {
        symbol,
        kind,
        account,
        currency: item.currency,
        quantity,
        unitCost,
        currentPrice,
        priceMode: "manual",
        priceSource: "预期资产到账",
        notes,
      };
      await api.expected.convert(item.id, input);
      notify(`${item.name} 已转入直接持仓`);
      onSaved();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "转入持仓失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={Boolean(item)} onClose={onClose} title="确认到账" description={item?.name}>
      <SheetForm submitLabel="转入直接持仓" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>到账资产</h3>
          <div className="form-grid two-column">
            <FormField label="资产代码" required>
              <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="TOKEN" autoFocus required />
            </FormField>
            <FormField label="资产类型" required>
              <select value={kind} onChange={(event) => setKind(event.target.value as AssetKind)}>
                <option value="crypto">虚拟货币</option><option value="stock">股票</option><option value="fund">基金</option><option value="wealth">理财产品</option><option value="cash">现金</option><option value="other">其他</option>
              </select>
            </FormField>
            <FormField label="账户 / 钱包" required>
              <input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="到账账户" required />
            </FormField>
            <FormField label="到账数量" required>
              <input type="number" inputMode="decimal" step="any" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
            </FormField>
            <FormField label="单位成本" hint="免费空投可填 0">
              <input type="number" inputMode="decimal" step="any" min="0" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} required />
            </FormField>
            <FormField label="当前价格">
              <input type="number" inputMode="decimal" step="any" min="0" value={currentPrice} onChange={(event) => setCurrentPrice(event.target.value)} required />
            </FormField>
          </div>
          <FormField label="备注">
            <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="领取交易哈希或到账说明" />
          </FormField>
        </div>
      </SheetForm>
    </Sheet>
  );
}

function ExpectedDetailDialog({
  item,
  onClose,
}: {
  item: ExpectedAsset | null;
  onClose: () => void;
}) {
  const title = item?.name ?? "预期资产详情";
  const description = item
    ? [item.category, item.ecosystem].filter(Boolean).join(" · ") || "查看机会信息与每次检查结果"
    : "查看机会信息与每次检查结果";

  return (
    <Dialog open={Boolean(item)} title={title} description={description} onClose={onClose}>
      {item ? (
        <div className="event-detail expected-detail">
          <div className="event-detail-intro">
            <div>
              <span className="event-detail-label">预期资产事件</span>
              <p>{item.latestUpdate || "等待首次检查结果"}</p>
            </div>
            <div className="expected-detail-badges">
              <StatusBadge label={expectedStageLabels[item.stage]} tone={getTone(item.stage)} />
              <StatusBadge label={expectedHealthLabels[item.health]} tone={getTone(item.health)} />
            </div>
          </div>

          <div className="event-detail-meta" aria-label="预期资产信息">
            <div>
              <span>类型 / 生态</span>
              <strong>{item.category || "未分类"}</strong>
              <small>{item.ecosystem || "未填写生态"}</small>
            </div>
            <div>
              <span>截止日期</span>
              <strong>{formatDate(item.deadline)}</strong>
              <small>{item.deadline ? "按项目截止时间" : "暂未设置"}</small>
            </div>
            <div>
              <span>检查计划</span>
              <strong>{formatDateTime(item.nextCheckAt)}</strong>
              <small>上次：{formatDateTime(item.lastCheckedAt)}</small>
            </div>
            <div>
              <span>潜在价值</span>
              <strong>{formatMoney(item.estimatedLow, item.currency)} - {formatMoney(item.estimatedHigh, item.currency)}</strong>
              <small>不计入实际净资产</small>
            </div>
            <div>
              <span>已投入成本</span>
              <strong>{formatMoney(item.investedCost, item.currency)}</strong>
              <small>{item.linkedAssetId ? "已关联直接持仓" : "尚未转入直接持仓"}</small>
            </div>
            <div>
              <span>信心等级</span>
              <strong>{confidenceLabels[item.confidence]}</strong>
              <small>{item.keywords.length ? `${item.keywords.length} 个检查关键词` : "未设置关键词"}</small>
            </div>
          </div>

          <section className="event-detail-section">
            <div className="event-detail-section-heading">
              <span className="event-detail-section-icon"><FileText size={16} /></span>
              <div>
                <h3>下一步行动</h3>
                <p>当前需要完成或继续观察的事项</p>
              </div>
            </div>
            <p className="event-instructions">{item.nextAction || "等待下一次检查后确定行动"}</p>
          </section>

          <section className="event-detail-section">
            <div className="event-detail-section-heading">
              <span className="event-detail-section-icon"><Tags size={16} /></span>
              <div>
                <h3>检查依据</h3>
                <p>官方来源、检索关键词与人工备注</p>
              </div>
            </div>
            <div className="expected-reference-list">
              <div>
                <span>官方来源</span>
                {item.sourceUrl ? (
                  <a className="expected-source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">
                    <span>{item.sourceUrl}</span>
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                ) : <p>未填写官方来源</p>}
              </div>
              <div>
                <span>关键词</span>
                {item.keywords.length ? (
                  <div className="expected-keywords">{item.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>
                ) : <p>未设置检查关键词</p>}
              </div>
              <div>
                <span>备注</span>
                <p>{item.notes || "暂无备注"}</p>
              </div>
            </div>
          </section>

          <MonitorRunTimeline
            targetId={item.id}
            loadRuns={api.expected.runs}
            title="检查时间线"
            recordLabel="检查记录"
            detailLabel="本次检查"
            emptyLabel="还没有检查记录"
            showEmailStatus={false}
          />
        </div>
      ) : null}
    </Dialog>
  );
}

export default function ExpectedPage() {
  const { data: items, loading, error, reload } = useResource(api.expected.list);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ExpectedAsset | null>(null);
  const [editing, setEditing] = useState<ExpectedAsset | null>(null);
  const [converting, setConverting] = useState<ExpectedAsset | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const { notify } = useToast();

  const filtered = useMemo(() => (items || []).filter((item) => {
    const matchesQuery = `${item.name} ${item.ecosystem} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (stage === "all" || item.stage === stage);
  }), [items, query, stage]);

  const counts = useMemo(() => ({
    active: (items || []).filter((item) => !["claimed", "missed", "expired", "rejected"].includes(item.stage)).length,
    due: (items || []).filter((item) => item.health === "due").length,
    claimable: (items || []).filter((item) => item.stage === "claimable").length,
    risk: (items || []).filter((item) => item.health === "risk" || item.health === "failed").length,
  }), [items]);

  const checkItem = async (item: ExpectedAsset) => {
    setCheckingId(item.id);
    try {
      await api.expected.check(item.id);
      notify(`${item.name} 已完成检查`);
      void reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "检查失败", "error");
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="机会与待到账"
        title="预期资产"
        description="独立跟踪资格、截止时间、新闻和潜在价值，不计入净资产。"
        actions={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 新建项目</Button>}
      />

      <div className="separation-banner"><Sparkles size={18} /><div><strong>预期价值与实际资产严格分开</strong><span>只有确认到账并转为直接持仓后，才会影响实际净资产。</span></div></div>

      <section className="metric-strip" aria-label="预期资产摘要">
        <div><small>跟踪中</small><strong>{counts.active} 项</strong></div>
        <div><small>今天待检查</small><strong>{counts.due} 项</strong></div>
        <div><small>可领取</small><strong>{counts.claimable} 项</strong></div>
        <div><small>异常 / 风险</small><strong>{counts.risk} 项</strong></div>
      </section>

      <section className="surface data-surface">
        <div className="toolbar">
          <div className="search-control"><Search size={17} /><input aria-label="搜索预期资产" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、生态或类型" /></div>
          <div className="toolbar-group">
            <label className="select-control"><Filter size={16} /><span className="sr-only">阶段</span><select value={stage} onChange={(event) => setStage(event.target.value)}><option value="all">全部阶段</option>{Object.entries(expectedStageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <Button className="icon-only secondary" type="button" aria-label="刷新预期资产" title="刷新" onClick={() => void reload()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={17} /></Button>
          </div>
        </div>

        {loading && !items ? <LoadingState label="正在读取预期资产" /> : null}
        {error && !items ? <ErrorState message={error} retry={() => void reload()} /> : null}
        {items && !items.length ? <EmptyState title="还没有预期资产" description="添加空投、活动或待到账机会，建立每日跟踪。" action={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 新建项目</Button>} /> : null}
        {items?.length && !filtered.length ? <EmptyState title="没有匹配的项目" description="调整关键词或阶段筛选。" /> : null}

        {filtered.length ? (
          <>
            <div className="table-wrap desktop-table">
              <table>
                <thead><tr><th>项目</th><th>阶段</th><th>下一步</th><th>截止 / 检查</th><th className="numeric">潜在价值</th><th>更新状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>{filtered.map((item) => (
                  <tr className="event-row" key={item.id} onClick={() => setSelectedItem(item)}>
                    <td>
                      <button className="event-open-button" type="button" onClick={() => setSelectedItem(item)} aria-label={`查看预期资产 ${item.name}`}>
                        <span className="asset-cell"><AssetIcon className="expected-avatar" name={item.name} /><span><strong>{item.name}</strong><small>{item.ecosystem || item.category} · 信心{confidenceLabels[item.confidence]}</small></span></span>
                      </button>
                    </td>
                    <td><StatusBadge label={expectedStageLabels[item.stage]} tone={getTone(item.stage)} /></td>
                    <td className="wide-cell"><strong className="cell-primary">{item.nextAction || "等待更新"}</strong><small className="cell-secondary clamp-one">{item.latestUpdate}</small></td>
                    <td><strong className="cell-primary">{formatDate(item.deadline)}</strong><small className="cell-secondary">检查 {formatDateTime(item.nextCheckAt)}</small></td>
                    <td className="numeric"><strong>{formatMoney(item.estimatedLow, item.currency)} - {formatMoney(item.estimatedHigh, item.currency)}</strong><small className="cell-secondary">不计入净值</small></td>
                    <td><StatusBadge label={expectedHealthLabels[item.health]} tone={getTone(item.health)} /><small className="cell-secondary">{formatDateTime(item.lastCheckedAt)}</small></td>
                    <td><div className="row-actions"><button className="icon-button" type="button" title="更新状态" aria-label={`更新 ${item.name} 状态`} onClick={(clickEvent) => { clickEvent.stopPropagation(); setEditing(item); }}><PencilLine size={17} /></button>{["claimable", "claimed"].includes(item.stage) && !item.linkedAssetId ? <button className="icon-button" type="button" title="确认到账" aria-label={`将 ${item.name} 转入持仓`} onClick={(clickEvent) => { clickEvent.stopPropagation(); setConverting(item); }}><ArrowRightLeft size={17} /></button> : <button className="icon-button" type="button" title="立即检查" aria-label={`立即检查 ${item.name}`} onClick={(clickEvent) => { clickEvent.stopPropagation(); void checkItem(item); }} disabled={checkingId === item.id}>{checkingId === item.id ? <RefreshCw className="spin" size={17} /> : <Bot size={17} />}</button>}</div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>

            <div className="mobile-data-list">
              {filtered.map((item) => (
                <article className="mobile-data-item event-card" key={item.id} onClick={() => setSelectedItem(item)}>
                  <header><button className="event-open-button event-mobile-trigger" type="button" onClick={() => setSelectedItem(item)} aria-label={`查看预期资产 ${item.name}`}><span className="asset-cell"><AssetIcon className="expected-avatar" name={item.name} /><span><strong>{item.name}</strong><small>{item.ecosystem || item.category}</small></span></span></button><StatusBadge label={expectedHealthLabels[item.health]} tone={getTone(item.health)} /></header>
                  <div className="mobile-value-row"><div><small>阶段</small><strong>{expectedStageLabels[item.stage]}</strong></div><div><small>价值区间</small><strong>{formatMoney(item.estimatedLow, item.currency)} - {formatMoney(item.estimatedHigh, item.currency)}</strong></div></div>
                  <div className="next-action"><small>下一步</small><strong>{item.nextAction || "等待更新"}</strong><span><CalendarDays size={15} /> {formatDate(item.deadline)}</span></div>
                  <footer><Button className="secondary" type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); setEditing(item); }}><PencilLine size={16} /> 更新状态</Button>{["claimable", "claimed"].includes(item.stage) && !item.linkedAssetId ? <Button className="primary" type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); setConverting(item); }}><ArrowRightLeft size={16} /> 确认到账</Button> : <Button className="secondary" type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); void checkItem(item); }} disabled={checkingId === item.id}>{checkingId === item.id ? <RefreshCw className="spin" size={16} /> : <Bot size={16} />} 立即检查</Button>}</footer>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <div className="direction-note" role="note"><span><CheckCircle2 size={16} /> 状态变更保留更新时间</span><span><Bot size={16} /> AI 检查失败不会覆盖现有事实</span><span><AlertTriangle size={16} /> 风险与业务阶段分别记录</span></div>

      <CreateExpectedSheet open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />
      <ExpectedDetailDialog item={selectedItem} onClose={() => setSelectedItem(null)} />
      <UpdateExpectedSheet key={`update-${editing?.id || "none"}`} item={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
      <ConvertExpectedSheet key={`convert-${converting?.id || "none"}`} item={converting} onClose={() => setConverting(null)} onSaved={() => void reload()} />
    </div>
  );
}
