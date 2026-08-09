export type AssetKind = "crypto" | "stock" | "fund" | "wealth" | "cash" | "other";
export type PriceMode = "manual" | "provider";
export type OperationType =
  | "opening"
  | "buy"
  | "sell"
  | "transfer_in"
  | "transfer_out"
  | "dividend"
  | "interest"
  | "fee"
  | "adjustment"
  | "claim";

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  kind: AssetKind;
  account: string;
  currency: string;
  quantity: string;
  unitCost: string;
  currentPrice: string;
  marketValue: string;
  costBasis: string;
  pnl: string;
  pnlPercent: string;
  priceMode: PriceMode;
  priceSource: string;
  priceUpdatedAt: string;
  staleAfterHours: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type ExpectedStage =
  | "discovered"
  | "watching"
  | "eligible"
  | "claimable"
  | "claimed"
  | "missed"
  | "expired"
  | "rejected";
export type ExpectedHealth = "healthy" | "due" | "failed" | "risk";

export interface ExpectedAsset {
  id: string;
  name: string;
  category: string;
  ecosystem: string;
  stage: ExpectedStage;
  health: ExpectedHealth;
  nextAction: string;
  deadline: string | null;
  estimatedLow: string;
  estimatedHigh: string;
  currency: string;
  investedCost: string;
  confidence: "low" | "medium" | "high";
  sourceUrl: string;
  keywords: string[];
  latestUpdate: string;
  lastCheckedAt: string;
  nextCheckAt: string;
  notes: string;
  linkedAssetId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EventStatus = "active" | "paused" | "expired";
export type RunStatus = "queued" | "running" | "success" | "no_change" | "failed";

export interface TrackedEvent {
  id: string;
  name: string;
  topic: string;
  instructions: string;
  schedule: string;
  scheduleLabel: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: EventStatus;
  notifyOnChangeOnly: boolean;
  emailEnabled: boolean;
  emailTo: string;
  lastRunStatus: RunStatus | null;
  lastSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorRun {
  id: string;
  eventId: string;
  status: RunStatus;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string;
  changeSummary: string;
  sources: Array<{ title: string; url: string }>;
  searchEvidence?: {
    mode: "live";
    query: string;
    searchedAt: string;
    observedUrls: string[];
  };
  provider: string;
  emailStatus: "skipped" | "pending" | "sent" | "failed";
  error: string;
}

export interface DashboardData {
  baseCurrency: string;
  netWorth: string;
  costBasis: string;
  totalPnl: string;
  expectedLow: string;
  expectedHigh: string;
  staleAssetCount: number;
  dueExpectedCount: number;
  upcomingEventCount: number;
  unconvertedAssetCount: number;
  unconvertedExpectedCount: number;
  allocation: Array<{ name: string; value: number; color: string }>;
  trend: Array<{ date: string; value: number }>;
  recentOperations: Array<Record<string, unknown>>;
  upcomingEvents: TrackedEvent[];
}

export interface AppSettings {
  baseCurrency: string;
  timezone: string;
  locale: string;
  proxyUrl: string;
  aiProvider: string;
  aiBaseUrl: string;
  aiModel: string;
  aiConfigured: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpFrom: string;
  notificationEmail: string;
  smtpConfigured: boolean;
}

export interface ApiEnvelope<T> {
  data: T;
  message?: string;
}

export type AiCommandType =
  | "asset.create"
  | "asset.price.update"
  | "asset.operation.record"
  | "expected.create"
  | "expected.update"
  | "event.create"
  | "event.update";

export interface AtomicAiCommand {
  commandId?: string;
  type: AiCommandType;
  confirmed?: boolean;
  payload: Record<string, unknown>;
}

export interface AtomicAiCommandRequest {
  idempotencyKey: string;
  actor: string;
  dryRun?: boolean;
  expectedVersions?: Record<string, number>;
  commands: AtomicAiCommand[];
}

export interface AtomicAiCommandResult {
  batchId: string;
  idempotencyKey: string;
  actor: string;
  dryRun: boolean;
  status: "success" | "failed";
  replayed: boolean;
  results: Array<{
    index: number;
    commandId: string;
    type: AiCommandType;
    targetId: string | null;
    status: "applied" | "proposal" | "dry_run" | "failed";
    result: unknown;
  }>;
  error?: string;
  errorCode?: string;
}
