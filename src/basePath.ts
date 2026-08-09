const viteBasePath = import.meta.env.BASE_URL;

export const appBasePath = viteBasePath === "/" ? "" : viteBasePath.replace(/\/$/, "");

export function withAppBasePath(path: string): string {
  return `${appBasePath}${path.startsWith("/") ? path : `/${path}`}`;
}
