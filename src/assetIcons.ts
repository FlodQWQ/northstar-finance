export interface AssetIconIdentity {
  symbol?: string | null;
  name?: string | null;
  currency?: string | null;
}

export interface AssetIconDefinition {
  key: string;
  label: string;
  path: string;
}

const ICONS: Record<string, AssetIconDefinition> = {
  BTC: { key: "BTC", label: "Bitcoin", path: "/assets/icons/btc.png" },
  ETH: { key: "ETH", label: "Ethereum", path: "/assets/icons/eth.png" },
  USDT: { key: "USDT", label: "Tether", path: "/assets/icons/usdt.png" },
  OKB: { key: "OKB", label: "OKB", path: "/assets/icons/okb.png" },
  CFX: { key: "CFX", label: "Conflux", path: "/assets/icons/cfx.png" },
  XPL: { key: "XPL", label: "Plasma", path: "/assets/icons/xpl.png" },
  SOL: { key: "SOL", label: "Solana", path: "/assets/icons/sol.png" },
  XAUT: { key: "XAUT", label: "Tether Gold", path: "/assets/icons/xaut.png" },
  U: { key: "U", label: "United Stables", path: "/assets/icons/u.jpg" },
  NVDAON: { key: "NVDAON", label: "NVIDIA (Ondo Tokenized Stock)", path: "/assets/icons/nvdaon.png" },
  QQQON: { key: "QQQON", label: "Invesco QQQ (Ondo Tokenized ETF)", path: "/assets/icons/qqqon.png" },
  IBMON: { key: "IBMON", label: "IBM (Ondo Tokenized Stock)", path: "/assets/icons/ibmon.png" },
  PREOPAI: { key: "PREOPAI", label: "OpenAI (Republic Pre-IPO)", path: "/assets/icons/preopai.png" },
  SPSEI: { key: "SPSEI", label: "Splashing Staked SEI", path: "/assets/icons/spsei.png" },
  USD1: { key: "USD1", label: "USD1", path: "/assets/icons/usd1.png" },
  RLUSD: { key: "RLUSD", label: "Ripple USD", path: "/assets/icons/rlusd.png" },
  SUSDAT: { key: "SUSDAT", label: "Saturn sUSDat", path: "/assets/icons/susdat.png" },
};

const SYMBOL_ALIASES: Record<string, string> = {
  USDTDEBT: "USDT",
};

const NAME_ALIASES: Record<string, string> = {
  BITCOIN: "BTC",
  ETHEREUM: "ETH",
  TETHER: "USDT",
  TETHERUSD: "USDT",
  TETHERGOLD: "XAUT",
  CONFLUX: "CFX",
  SOLANA: "SOL",
  PLASMA: "XPL",
  UNITEDSTABLES: "U",
  RIPPLEUSD: "RLUSD",
  NVIDIAONDOTOKENIZEDSTOCK: "NVDAON",
  INVESCOQQQONDOTOKENIZEDETF: "QQQON",
  IBMONDOTOKENIZEDSTOCK: "IBMON",
  OPENAIREPUBLICPREIPO: "PREOPAI",
  SPLASHINGSTAKEDSEI: "SPSEI",
  SATURNSUSDAT: "SUSDAT",
};

function normalizeIdentity(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

export function resolveAssetIcon(identity: AssetIconIdentity): AssetIconDefinition | null {
  const symbol = normalizeIdentity(identity.symbol);
  const symbolKey = SYMBOL_ALIASES[symbol] || symbol;
  if (ICONS[symbolKey]) return ICONS[symbolKey];

  const nameKey = NAME_ALIASES[normalizeIdentity(identity.name)];
  if (nameKey && ICONS[nameKey]) return ICONS[nameKey];

  if (!symbol && !identity.name?.trim() && normalizeIdentity(identity.currency) === "USDT") {
    return ICONS.USDT;
  }

  return null;
}

export function getAssetIconFallback(identity: AssetIconIdentity): string {
  const source = (identity.symbol || identity.name || "?").trim();
  return Array.from(source || "?").slice(0, 2).join("").toUpperCase();
}
