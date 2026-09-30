/**
 * version — 服务端对外报告的版本号，**运行时读 `packages/server/package.json`**，不再手抄。
 *
 * 全仓只有一个版本号（`docs/GITHUB-OPS-SPEC.md` R-3）：根 package.json = 三个 workspace 的 package.json
 * = git tag `vX.Y.Z` = CHANGELOG 顶部 `## vX.Y.Z` = `PUBLIC_RELEASES[0]` = README 徽章，由 `tools/check-version.mjs` 对账。
 * 此前这里硬编码 `'2.0.0-alpha.0'`（产品内部号），而线上发的是 `v0.2.x`（部署构建号）⇒ `/api/status` 报的号
 * 与 GitHub Release / 更新页对不上，README 只能写「判线上版本别看 /api/status」——两套号的代价就是这样落到用户头上的。
 *
 * 路径解析：`src/version.ts` 与打包产物 `dist/index.js` 都在 `packages/server/` 下一层 ⇒ `../package.json` 两种形态都成立
 * （esbuild `--format=esm` 保留 `import.meta.url`）。读不到时回落 `0.0.0-unknown` 而不是抛：版本号不该让服务起不来。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNKNOWN_VERSION = '0.0.0-unknown';

/** 从给定目录向上一层读 package.json 的 version（导出以便单测直接喂目录）。 */
export function readPackageVersion(fromDir: string): string {
  try {
    const raw = readFileSync(path.join(fromDir, '..', 'package.json'), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {
    /* 回落 */
  }
  return UNKNOWN_VERSION;
}

export const VERSION = readPackageVersion(path.dirname(fileURLToPath(import.meta.url)));
