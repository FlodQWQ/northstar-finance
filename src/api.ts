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
  code: string;

  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  status: "pending" | "active" | "disabled";
  role: "owner" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionData {
  authenticated: true;
  user: AuthUser;
  csrfToken: string;
}

export interface SignedOutSessionData {
  authenticated: false;
}

export interface LoginInput {
  identifier: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
}

export interface RegistrationSubmission {
  approvalRequired: true;
  user: AuthUser;
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  handleUnauthorized?: boolean;
};
type ErrorPayload = { message?: string; error?: { code?: string; message?: string } };

let activeCsrfToken = "";
let unauthorizedHandler: (() => void) | null = null;

export function setApiAuthSession(session: AuthSessionData | null): void {
  activeCsrfToken = session?.csrfToken ?? "";
}

export function setApiUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    body,
    handleUnauthorized = true,
    ...requestOptions
  } = options;
  const headers = new Headers(options.headers);
  const method = (requestOptions.method ?? "GET").toUpperCase();
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (isMutation && activeCsrfToken) headers.set("X-CSRF-Token", activeCsrfToken);

  let response: Response;
  try {
    response = await fetch(withAppBasePath(path), {
      ...requestOptions,
      headers,
      credentials: requestOptions.credentials ?? "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const errorCode = payload && "error" in payload ? payload.error?.code : undefined;
    if (response.status === 401 && handleUnauthorized) {
      activeCsrfToken = "";
      unauthorizedHandler?.();
    }
    throw new ApiError(
      payload?.message || nestedMessage || `请求失败（${response.status}）`,
      response.status,
      errorCode,
    );
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
  auth: {
    session: () => request<AuthSessionData | SignedOutSessionData>("/api/auth/session", {
      handleUnauthorized: false,
    }),
    login: (input: LoginInput) =>
      request<AuthSessionData>("/api/auth/login", {
        method: "POST",
        body: input,
        handleUnauthorized: false,
      }),
    register: (input: RegisterInput) =>
      request<RegistrationSubmission>("/api/auth/register", {
        method: "POST",
        body: input,
        handleUnauthorized: false,
      }),
    logout: () => request<{ loggedOut: true }>("/api/auth/logout", { method: "POST" }),
  },
  admin: {
    registrations: {
      list: () => request<AuthUser[]>("/api/admin/registrations"),
      approve: (id: string) =>
        request<AuthUser>(`/api/admin/registrations/${encodeURIComponent(id)}/approve`, {
          method: "POST",
        }),
      reject: (id: string) =>
        request<AuthUser>(`/api/admin/registrations/${encodeURIComponent(id)}/reject`, {
          method: "POST",
        }),
    },
  },
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
