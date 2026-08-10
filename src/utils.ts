export const assetKindLabels: Record<string, string> = {
  crypto: "虚拟货币",
  stock: "股票",
  fund: "基金",
  wealth: "理财",
  cash: "现金",
  other: "其他",
};

export const expectedStageLabels: Record<string, string> = {
  discovered: "待评估",
  watching: "进行中",
  eligible: "等待结果",
  claimable: "可领取",
  claimed: "已到账",
  missed: "未达成",
  expired: "已过期",
  rejected: "已放弃",
};

export const expectedHealthLabels: Record<string, string> = {
  healthy: "正常",
  due: "待更新",
  failed: "更新失败",
  risk: "有风险",
};

export const eventStatusLabels: Record<string, string> = {
  active: "运行中",
  paused: "已暂停",
  expired: "已到期",
};

export const runStatusLabels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  success: "已完成",
  no_change: "无变化",
  failed: "失败",
};

export function formatMoney(value: string | number, currency = "CNY") {
  const numeric = typeof value === "number" ? value : Number(value || 0);
  if (!Number.isFinite(numeric)) return `-- ${currency}`;
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(numeric) >= 1000 ? 0 : 2,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString("zh-CN")} ${currency}`;
  }
}

export function formatCompactMoney(value: string | number, currency = "CNY") {
  const numeric = typeof value === "number" ? value : Number(value || 0);
  if (!Number.isFinite(numeric)) return `-- ${currency}`;
  const options: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: 1,
  };
  try {
    return new Intl.NumberFormat("zh-CN", {
      ...options,
      style: "currency",
      currency,
    }).format(numeric);
  } catch {
    return `${new Intl.NumberFormat("zh-CN", options).format(numeric)} ${currency}`;
  }
}

export function formatNumber(value: string | number, maximumFractionDigits = 6) {
  const numeric = typeof value === "number" ? value : Number(value || 0);
  if (!Number.isFinite(numeric)) return "--";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(numeric);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "尚无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function toLocalInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function getTone(value: string): "neutral" | "positive" | "warning" | "danger" | "info" {
  if (["success", "healthy", "active", "claimed", "sent"].includes(value)) return "positive";
  if (["due", "claimable", "eligible", "queued", "pending", "no_change"].includes(value)) return "warning";
  if (["failed", "risk", "missed", "expired"].includes(value)) return "danger";
  if (["running", "watching", "discovered"].includes(value)) return "info";
  return "neutral";
}

export function stringFromUnknown(value: unknown, fallback = "") {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return fallback;
}
