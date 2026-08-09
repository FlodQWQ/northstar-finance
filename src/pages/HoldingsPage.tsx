import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Filter,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  WalletCards,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { Asset, AssetKind, OperationType, PriceMode } from "../../shared/types";
import { api, type AssetInput } from "../api";
import { useResource } from "../hooks";
import { assetKindLabels, formatDateTime, formatMoney, formatNumber, toLocalInputValue } from "../utils";
import {
  Button,
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

const emptyAsset: AssetInput = {
  name: "",
  symbol: "",
  kind: "crypto",
  account: "",
  currency: "USD",
  quantity: "0",
  unitCost: "0",
  currentPrice: "0",
  priceMode: "manual",
  priceSource: "手动录入",
  staleAfterHours: 24,
  notes: "",
};

const operationLabels: Record<OperationType, string> = {
  opening: "期初持仓",
  buy: "买入",
  sell: "卖出",
  transfer_in: "转入",
  transfer_out: "转出",
  dividend: "分红",
  interest: "利息",
  fee: "手续费",
  adjustment: "数量调整",
  claim: "领取到账",
};

function isAssetStale(asset: Asset) {
  const timestamp = new Date(asset.priceUpdatedAt).getTime();
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp > asset.staleAfterHours * 60 * 60 * 1000;
}

function CreateAssetSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<AssetInput>(emptyAsset);
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api.assets.create(form);
      notify("资产已创建，并生成期初持仓记录");
      setForm(emptyAsset);
      onCreated();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "创建资产失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="新增直接资产" description="实际余额和估值会计入净资产。">
      <SheetForm submitLabel="创建资产" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>资产信息</h3>
          <div className="form-grid two-column">
            <FormField label="资产类型" required>
              <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as AssetKind })}>
                {Object.entries(assetKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </FormField>
            <FormField label="资产名称" required>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：比特币" required autoFocus />
            </FormField>
            <FormField label="代码 / 简称" required>
              <input value={form.symbol} onChange={(event) => setForm({ ...form, symbol: event.target.value.toUpperCase() })} placeholder="BTC" required />
            </FormField>
            <FormField label="账户 / 钱包" required>
              <input value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })} placeholder="例如：主钱包" required />
            </FormField>
          </div>
        </div>
        <div className="form-section">
          <h3>期初持仓</h3>
          <div className="form-grid two-column">
            <FormField label="数量" required>
              <input type="number" inputMode="decimal" step="any" min="0" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required />
            </FormField>
            <FormField label="计价币种" required>
              <input value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} maxLength={8} required />
            </FormField>
            <FormField label="单位成本" hint="未知成本可填 0">
              <input type="number" inputMode="decimal" step="any" min="0" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} />
            </FormField>
            <FormField label="当前价格" required>
              <input type="number" inputMode="decimal" step="any" min="0" value={form.currentPrice} onChange={(event) => setForm({ ...form, currentPrice: event.target.value })} required />
            </FormField>
          </div>
        </div>
        <div className="form-section">
          <h3>价格更新</h3>
          <div className="form-grid two-column">
            <FormField label="价格模式">
              <select value={form.priceMode} onChange={(event) => setForm({ ...form, priceMode: event.target.value as PriceMode })}>
                <option value="manual">手动更新</option>
                <option value="provider">数据源查询</option>
              </select>
            </FormField>
            <FormField label="价格来源">
              <input value={form.priceSource} onChange={(event) => setForm({ ...form, priceSource: event.target.value })} placeholder="手动录入 / 数据源名称" />
            </FormField>
            <FormField label="过期阈值（小时）" hint="超过该时间会进入待处理">
              <input type="number" inputMode="numeric" min="1" value={form.staleAfterHours} onChange={(event) => setForm({ ...form, staleAfterHours: Number(event.target.value) || 1 })} />
            </FormField>
          </div>
          <FormField label="备注">
            <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="合约地址、产品到期日或其他说明" rows={3} />
          </FormField>
        </div>
      </SheetForm>
    </Sheet>
  );
}

function OperationSheet({ asset, onClose, onSaved }: { asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<OperationType>("buy");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [fee, setFee] = useState("0");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(toLocalInputValue(new Date().toISOString()));
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!asset) return;
    setSubmitting(true);
    try {
      await api.assets.createOperation(asset.id, {
        type,
        quantity,
        unitPrice: unitPrice || undefined,
        fee: fee || undefined,
        currency: asset.currency,
        note: note || undefined,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined,
      });
      notify(`${asset.name} 的操作已记录`);
      onSaved();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "记录操作失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={Boolean(asset)} onClose={onClose} title="记录资产操作" description={asset ? `${asset.name} · 当前 ${formatNumber(asset.quantity)} ${asset.symbol}` : ""}>
      <SheetForm submitLabel="保存操作" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>流水内容</h3>
          <div className="form-grid two-column">
            <FormField label="操作类型" required>
              <select value={type} onChange={(event) => setType(event.target.value as OperationType)}>
                {(Object.entries(operationLabels) as Array<[OperationType, string]>).filter(([value]) => value !== "opening").map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </FormField>
            <FormField label="发生时间" required>
              <input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required />
            </FormField>
            <FormField label="数量" required>
              <input type="number" inputMode="decimal" step="any" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" required />
            </FormField>
            <FormField label="成交单价">
              <input type="number" inputMode="decimal" step="any" min="0" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder={asset?.currentPrice || "0"} />
            </FormField>
            <FormField label="手续费">
              <input type="number" inputMode="decimal" step="any" min="0" value={fee} onChange={(event) => setFee(event.target.value)} />
            </FormField>
            <FormField label="币种">
              <input value={asset?.currency || ""} readOnly aria-readonly="true" />
            </FormField>
          </div>
          <FormField label="备注">
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="交易所、交易哈希或调整原因" />
          </FormField>
        </div>
      </SheetForm>
    </Sheet>
  );
}

function PriceSheet({ asset, onClose, onSaved }: { asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const [price, setPrice] = useState(asset?.currentPrice || "");
  const [source, setSource] = useState(asset?.priceSource || "手动录入");
  const [asOf, setAsOf] = useState(toLocalInputValue(new Date().toISOString()));
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!asset) return;
    setSubmitting(true);
    try {
      await api.assets.updatePrice(asset.id, {
        price,
        currency: asset.currency,
        source,
        asOf: asOf ? new Date(asOf).toISOString() : undefined,
      });
      notify(`${asset.name} 的价格已更新`);
      onSaved();
      onClose();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "更新价格失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const projected = asset && Number.isFinite(Number(price)) ? Number(asset.quantity) * Number(price) : 0;
  return (
    <Sheet open={Boolean(asset)} onClose={onClose} title="更新资产价格" description={asset ? `${asset.name} · ${asset.symbol}` : ""}>
      <SheetForm submitLabel="确认更新" submitting={submitting} onSubmit={submit} onCancel={onClose}>
        <div className="form-section">
          <h3>价格快照</h3>
          <div className="form-grid two-column">
            <FormField label="当前价格" required>
              <input type="number" inputMode="decimal" step="any" min="0" value={price} onChange={(event) => setPrice(event.target.value)} autoFocus required />
            </FormField>
            <FormField label="币种">
              <input value={asset?.currency || ""} readOnly aria-readonly="true" />
            </FormField>
            <FormField label="数据来源" required>
              <input value={source} onChange={(event) => setSource(event.target.value)} required />
            </FormField>
            <FormField label="价格时间" required>
              <input type="datetime-local" value={asOf} onChange={(event) => setAsOf(event.target.value)} required />
            </FormField>
          </div>
          <div className="form-preview">
            <span>更新后持仓估值</span>
            <strong>{formatMoney(projected, asset?.currency || "CNY")}</strong>
          </div>
        </div>
      </SheetForm>
    </Sheet>
  );
}

export default function HoldingsPage() {
  const { data: assets, loading, error, reload } = useResource(api.assets.list);
  const [createOpen, setCreateOpen] = useState(false);
  const [operationAsset, setOperationAsset] = useState<Asset | null>(null);
  const [priceAsset, setPriceAsset] = useState<Asset | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");

  const filtered = useMemo(() => (assets || []).filter((asset) => {
    const matchesQuery = `${asset.name} ${asset.symbol} ${asset.account}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (kind === "all" || asset.kind === kind);
  }), [assets, kind, query]);

  const summary = useMemo(() => (assets || []).reduce((result, asset) => ({
    value: result.value + Number(asset.marketValue || 0),
    cost: result.cost + Number(asset.costBasis || 0),
    pnl: result.pnl + Number(asset.pnl || 0),
    stale: result.stale + (isAssetStale(asset) ? 1 : 0),
  }), { value: 0, cost: 0, pnl: 0, stale: 0 }), [assets]);

  const currencies = new Set((assets || []).map((asset) => asset.currency));
  const mixedCurrencies = currencies.size > 1;
  const baseCurrency = assets?.[0]?.currency || "USD";
  const summaryValue = (value: number) => mixedCurrencies ? "未折算" : formatMoney(value, baseCurrency);
  return (
    <div className="page">
      <PageHeader
        eyebrow="直接资产"
        title="持仓"
        description="记录真实余额、成本、价格快照和每一笔操作。"
        actions={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 新增资产</Button>}
      />

      <section className="metric-strip" aria-label="持仓摘要">
        <div><small>当前市值</small><strong>{summaryValue(summary.value)}</strong></div>
        <div><small>持仓成本</small><strong>{summaryValue(summary.cost)}</strong></div>
        <div><small>累计盈亏</small><strong className={!mixedCurrencies && summary.pnl >= 0 ? "positive-text" : !mixedCurrencies ? "danger-text" : ""}>{summaryValue(summary.pnl)}</strong></div>
        <div><small>价格待更新</small><strong>{summary.stale} 项</strong></div>
      </section>

      <section className="surface data-surface">
        <div className="toolbar">
          <div className="search-control">
            <Search size={17} />
            <input aria-label="搜索持仓" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资产、代码或账户" />
          </div>
          <div className="toolbar-group">
            <label className="select-control"><Filter size={16} /><span className="sr-only">资产类型</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="all">全部类型</option>
                {Object.entries(assetKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <Button className="icon-only secondary" type="button" aria-label="刷新持仓" title="刷新持仓" onClick={() => void reload()} disabled={loading}>
              <RefreshCw className={loading ? "spin" : ""} size={17} />
            </Button>
          </div>
        </div>

        {loading && !assets ? <LoadingState label="正在读取持仓" /> : null}
        {error && !assets ? <ErrorState message={error} retry={() => void reload()} /> : null}
        {assets && !assets.length ? <EmptyState title="还没有直接资产" description="新增第一项真实持仓，开始记录价格与操作。" action={<Button className="primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> 新增资产</Button>} /> : null}
        {assets?.length && !filtered.length ? <EmptyState title="没有匹配的资产" description="调整关键词或筛选条件后重试。" /> : null}

        {filtered.length ? (
          <>
            <div className="table-wrap desktop-table">
              <table>
                <thead><tr><th>资产</th><th>账户</th><th className="numeric">数量</th><th className="numeric">现价</th><th className="numeric">市值</th><th className="numeric">盈亏</th><th>价格状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {filtered.map((asset) => {
                    const stale = isAssetStale(asset);
                    return (
                      <tr key={asset.id}>
                        <td><div className="asset-cell"><span className="asset-avatar">{asset.symbol.slice(0, 2)}</span><span><strong>{asset.name}</strong><small>{asset.symbol} · {assetKindLabels[asset.kind]}</small></span></div></td>
                        <td><strong className="cell-primary">{asset.account}</strong><small className="cell-secondary">{asset.currency}</small></td>
                        <td className="numeric"><strong>{formatNumber(asset.quantity)}</strong></td>
                        <td className="numeric"><strong>{formatMoney(asset.currentPrice, asset.currency)}</strong></td>
                        <td className="numeric"><strong>{formatMoney(asset.marketValue, asset.currency)}</strong><small className="cell-secondary">成本 {formatMoney(asset.costBasis, asset.currency)}</small></td>
                        <td className="numeric"><strong className={Number(asset.pnl) >= 0 ? "positive-text" : "danger-text"}>{formatMoney(asset.pnl, asset.currency)}</strong><small className={Number(asset.pnlPercent) >= 0 ? "positive-text" : "danger-text"}>{Number(asset.pnlPercent) >= 0 ? "+" : ""}{formatNumber(asset.pnlPercent, 2)}%</small></td>
                        <td><StatusBadge label={stale ? "待更新" : "最新"} tone={stale ? "warning" : "positive"} /><small className="cell-secondary">{formatDateTime(asset.priceUpdatedAt)}</small></td>
                        <td><div className="row-actions">
                          <button className="icon-button" type="button" title="记录操作" aria-label={`记录 ${asset.name} 的操作`} onClick={() => setOperationAsset(asset)}><PencilLine size={17} /></button>
                          <button className="icon-button" type="button" title="更新价格" aria-label={`更新 ${asset.name} 的价格`} onClick={() => setPriceAsset(asset)}><RefreshCw size={17} /></button>
                        </div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mobile-data-list">
              {filtered.map((asset) => {
                const stale = isAssetStale(asset);
                return (
                  <article className="mobile-data-item" key={asset.id}>
                    <header><div className="asset-cell"><span className="asset-avatar">{asset.symbol.slice(0, 2)}</span><span><strong>{asset.name}</strong><small>{asset.account} · {assetKindLabels[asset.kind]}</small></span></div><StatusBadge label={stale ? "待更新" : "最新"} tone={stale ? "warning" : "positive"} /></header>
                    <div className="mobile-value-row"><div><small>市值</small><strong>{formatMoney(asset.marketValue, asset.currency)}</strong></div><div><small>盈亏</small><strong className={Number(asset.pnl) >= 0 ? "positive-text" : "danger-text"}>{Number(asset.pnl) >= 0 ? "+" : ""}{formatMoney(asset.pnl, asset.currency)}</strong></div></div>
                    <div className="mobile-meta"><span>{formatNumber(asset.quantity)} {asset.symbol}</span><span>价格 {formatDateTime(asset.priceUpdatedAt)}</span></div>
                    <footer><Button className="secondary" type="button" onClick={() => setOperationAsset(asset)}><PencilLine size={16} /> 记操作</Button><Button className="secondary" type="button" onClick={() => setPriceAsset(asset)}><RefreshCw size={16} /> 改价格</Button></footer>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <div className="direction-note" role="note">
        <span><ArrowDownToLine size={16} /> 买入和转入增加数量</span>
        <span><ArrowUpFromLine size={16} /> 卖出和转出减少数量</span>
        <span><Banknote size={16} /> 所有变更保留操作流水</span>
      </div>

      <CreateAssetSheet open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => void reload()} />
      <OperationSheet key={`operation-${operationAsset?.id || "none"}`} asset={operationAsset} onClose={() => setOperationAsset(null)} onSaved={() => void reload()} />
      <PriceSheet key={`price-${priceAsset?.id || "none"}`} asset={priceAsset} onClose={() => setPriceAsset(null)} onSaved={() => void reload()} />
    </div>
  );
}
