import { useState } from "react";
import { getAssetIconFallback, resolveAssetIcon, type AssetIconIdentity } from "../assetIcons";
import { withAppBasePath } from "../basePath";

interface AssetIconProps extends AssetIconIdentity {
  className?: string;
  size?: "default" | "compact";
}

export function AssetIcon({ symbol, name, currency, className = "", size = "default" }: AssetIconProps) {
  const identity = { symbol, name, currency };
  const icon = resolveAssetIcon(identity);
  const source = icon ? withAppBasePath(icon.path) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showImage = Boolean(source && source !== failedSource);
  const classes = [
    "asset-avatar",
    "asset-icon",
    size === "compact" ? "asset-icon-compact" : "",
    showImage ? "asset-icon-resolved" : "asset-icon-fallback",
    className,
  ].filter(Boolean).join(" ");
  const displayName = name?.trim() || icon?.label || symbol?.trim() || "资产";

  return (
    <span className={classes}>
      {showImage ? (
        <img
          src={source || undefined}
          alt={`${displayName} 图标`}
          width={size === "compact" ? 30 : 34}
          height={size === "compact" ? 30 : 34}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <span aria-label={`${displayName} 图标不可用`} role="img">
          {getAssetIconFallback(identity)}
        </span>
      )}
    </span>
  );
}
