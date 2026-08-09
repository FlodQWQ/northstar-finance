import type {
  ApiEnvelope,
  AppSettings,
  Asset,
  DashboardData,
  ExpectedAsset,
  MonitorRun,
  TrackedEvent,
} from "../shared/types";
import { withAppBasePath } from "./basePath";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };
type ErrorPayload = { message?: string; error?: { message?: string } };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(withAppBasePath(path), {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("无法连接服务，请检查 API 是否已启动", 0);
  }

  let payload: ApiEnvelope<T> | ErrorPayload | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T> | ErrorPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const nestedMessage = payload && "error" in payload ? payload.error?.message : undefined;
    throw new ApiError(payload?.message || nestedMessage || `请求失败（${response.status}）`, response.status);
  }
  if (!payload || !("data" in payload)) {
    throw new ApiError("服务返回了无法识别的数据", response.status);
  }
  return payload.data;
}

export type AssetInput = Pick<
  Asset,
  | "name"
  | "symbol"
  | "kind"
  | "account"
  | "currency"
  | "quantity"
  | "unitCost"
  | "currentPrice"
  | "priceMode"
  | "priceSource"
  | "staleAfterHours"
  | "notes"
>;

export type OperationInput = {
  type: string;
  quantity?: string;
  quantityDelta?: string;
  unitPrice?: string;
  fee?: string;
  currency?: string;
  note?: string;
  occurredAt?: string;
  idempotencyKey?: string;
};

export type PriceInput = {
  price?: string;
  currency?: string;
  source?: string;
  asOf?: string;
};

export type ExpectedInput = Omit<
  ExpectedAsset,
  "id" | "createdAt" | "updatedAt" | "lastCheckedAt"
> & { lastCheckedAt?: string };

export type ExpectedConversionInput = {
  name?: string;
  symbol: string;
  kind: Asset["kind"];
  account: string;
  currency?: string;
  quantity: string;
  unitCost: string;
  currentPrice: string;
  priceMode: Asset["priceMode"];
  priceSource: string;
  notes: string;
};

export type EventInput = Omit<
  TrackedEvent,
  "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt" | "lastRunStatus" | "lastSummary"
>;

export const api = {
  dashboard: () => request<DashboardData>("/api/dashboard"),
  assets: {
    list: () => request<Asset[]>("/api/assets"),
    create: (input: AssetInput) => request<Asset>("/api/assets", { method: "POST", body: input }),
    updatePrice: (id: string, input: PriceInput) =>
      request<Asset>(`/api/assets/${id}/price`, { method: "POST", body: input }),
    createOperation: (id: string, input: OperationInput) =>
      request<unknown>(`/api/assets/${id}/operations`, { method: "POST", body: input }),
  },
  expected: {
    list: () => request<ExpectedAsset[]>("/api/expected"),
    create: (input: ExpectedInput) =>
      request<ExpectedAsset>("/api/expected", { method: "POST", body: input }),
    update: (id: string, input: Partial<ExpectedAsset>) =>
      request<ExpectedAsset>(`/api/expected/${id}`, { method: "PATCH", body: input }),
    check: (id: string) =>
      request<{ expected: ExpectedAsset; run: MonitorRun }>(`/api/expected/${id}/check`, { method: "POST" }),
    runs: (id: string) => request<MonitorRun[]>(`/api/expected/${id}/runs`),
    convert: (id: string, input: ExpectedConversionInput) =>
      request<{ asset: Asset; expected: ExpectedAsset }>(`/api/expected/${id}/convert`, {
        method: "POST",
        body: input,
      }),
  },
  events: {
    list: () => request<TrackedEvent[]>("/api/events"),
    create: (input: EventInput) =>
      request<TrackedEvent>("/api/events", { method: "POST", body: input }),
    update: (id: string, input: Partial<TrackedEvent>) =>
      request<TrackedEvent>(`/api/events/${id}`, { method: "PATCH", body: input }),
    run: (id: string) =>
      request<MonitorRun>(`/api/events/${id}/run`, { method: "POST" }),
    runs: (id: string) => request<MonitorRun[]>(`/api/events/${id}/runs`),
  },
  settings: {
    get: () => request<AppSettings>("/api/settings"),
    update: (input: Partial<AppSettings> & Record<string, unknown>) =>
      request<AppSettings>("/api/settings", { method: "PATCH", body: input }),
    test: (kind: "ai" | "price" | "email") =>
      request<Record<string, unknown>>(`/api/settings/test-${kind}`, { method: "POST" }),
  },
};
