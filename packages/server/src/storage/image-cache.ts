/**
 * storage/image-cache —— 网页图片的本地缓存（`fetch_image` 落盘 / `/api/images` 出图共用）。
 *
 * 为什么落盘（而 ```html 预览是内存暂存，见 `routes/preview.ts`）：
 *   图片地址会被写进**落库的消息正文**，历史回放、重新生成、跨重启都要能照样渲染；
 *   预览 HTML 是「点开时才生成」的一次性产物，丢了重生成即可 —— 图片丢了没法重生成
 *   （源站可能已改图或换图，再取一次拿到的未必是同一张）。
 *
 * 为什么不违反「AI 零写盘」（AGENTS.md 工程红线）：
 *   那条红线管的是**模型指定的路径**（`read_file`/`write_file` 那类本地磁盘工具，走申请式确认卡）。
 *   这里的路径由服务端按**内容 sha256** 生成，模型只能给 URL、给不了路径，也读不到任何别的文件；
 *   落盘位置固定在 `DATA_DIR/images/`，与库同目录、一起备份一起迁移。
 *   ⇒ 这是「服务端自己的受控缓存」，不是「AI 写盘」。
 *
 * 命名 = 内容 hash（`<sha256 前 32 位>.<ext>`）三个收益：
 *   ① 同图重放落到同一文件 ⇒ 天然去重；
 *   ② 天然幂等 ⇒ 支撑 `fetch_image` 的 `idempotent` 声明（network 档「同参重放无副作用」）；
 *   ③ 名字里不带 URL / 归属 / 时间 ⇒ 不泄漏来源，也不给枚举留线索。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './db.js';

/**
 * 单张图片字节上限。4MB 覆盖常见截图 / 插图 / 公式图 / 相机直出小图；
 * 再大的基本是原图或扫描件，塞进对话既没必要（学习者看的是讲解，不是像素）也拖慢回放。
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 字节前若干位是否等于给定签名（长度不足一律 false）。 */
function startsWith(h: Uint8Array, ...sig: number[]): boolean {
  if (h.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (h[i] !== sig[i]) return false;
  return true;
}

/** 从偏移处比对签名（用于 RIFF/ftyp 这类「尾巴才是格式」的容器）。 */
function at(h: Uint8Array, off: number, ...sig: number[]): boolean {
  if (h.length < off + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (h[off + i] !== sig[i]) return false;
  return true;
}

/**
 * 可缓存的图片格式：**字节魔数 → 扩展名 + MIME**。
 *
 * ★ 判据在**原始字节**上，不看 `content-type`：后者是服务端自述，会谎报、会缺失、会写成
 *   `application/octet-stream`。这与 `chat/tools/fetch-page.ts` 的 `looksBinary` 是同一条教训
 *   ——**判据是关于字节的，就该在字节上判**（那里实测过「按声明类型判」放行过二进制）。
 * ★★ **刻意不收 SVG**：`.svg` 是**文本**、可内嵌 `<script>`，而本路由与页面**同源** ⇒
 *   谁把 `/api/images/x.svg` 直接打开（模型或用户，新标签页也算）就等于在应用源上执行了
 *   源站的脚本，是实打实的 XSS 面。排除后 `image/svg+xml` 会落到「不是图片」分支如实拒绝，
 *   工具的失败文案里单独为它留了一句人话（否则用户只会觉得「这张图为什么搬不了」）。
 * ★ 也不收 TIFF/ICO：浏览器对 TIFF 普遍不渲染（收进来只会得到一张裂图），ICO 是图标不是插图。
 */
const IMAGE_SIGS: Array<{ ext: string; mime: string; test: (h: Uint8Array) => boolean }> = [
  { ext: 'png', mime: 'image/png', test: (h) => startsWith(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { ext: 'jpg', mime: 'image/jpeg', test: (h) => startsWith(h, 0xff, 0xd8, 0xff) },
  { ext: 'gif', mime: 'image/gif', test: (h) => startsWith(h, 0x47, 0x49, 0x46, 0x38) }, // GIF8
  { ext: 'webp', mime: 'image/webp', test: (h) => startsWith(h, 0x52, 0x49, 0x46, 0x46) && at(h, 8, 0x57, 0x45, 0x42, 0x50) },
  { ext: 'bmp', mime: 'image/bmp', test: (h) => startsWith(h, 0x42, 0x4d) }, // BM
  { ext: 'avif', mime: 'image/avif', test: (h) => at(h, 4, 0x66, 0x74, 0x79, 0x70) && at(h, 8, 0x61, 0x76, 0x69, 0x66) },
];

/**
 * 文件名闸门（**路径穿越的唯一防线就在这里**，出图路由与写盘都经它）。
 *
 * 只认 `<32 位小写 hex>.<ext>`：`..`、`/`、`\`、绝对路径、`%2e%2e`（express 已解码）、
 * 其他扩展名（尤其 `.svg`）一律不匹配。`ext` 部分由 IMAGE_SIGS 派生，不手写第二份清单。
 */
const NAME_RE = new RegExp(`^[a-f0-9]{32}\\.(?:${IMAGE_SIGS.map((s) => s.ext).join('|')})$`);

/** 图片缓存目录（`DATA_DIR/images`）。惰性求值：`resolveDataDir()` 实时读 env ⇒ 隔离实例/测试可改。 */
export function imagesDir(): string {
  return path.join(resolveDataDir(), 'images');
}

export function isImageName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 名字 → 绝对路径；名字不合法一律 `null`（调用方据此回 404，不要自己拼路径）。 */
export function imagePath(name: string): string | null {
  if (!isImageName(name)) return null;
  return path.join(imagesDir(), name);
}

/** 名字 → MIME（从嗅探表反查，不另立一份映射；未知扩展名回 `application/octet-stream`）。 */
export function mimeOfName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return IMAGE_SIGS.find((s) => s.ext === ext)?.mime ?? 'application/octet-stream';
}

/** 内容 hash → 文件名：sha256 前 32 位十六进制（128 bit，碰撞概率可忽略）。 */
export function imageNameFor(bytes: Uint8Array, ext: string): string {
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
}

/** 字节 → 图片类型；不在白名单内（含 SVG、纯文本、二进制、残缺头）回 `null`。 */
export function sniffImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length === 0) return null;
  const hit = IMAGE_SIGS.find((s) => s.test(bytes));
  return hit ? { ext: hit.ext, mime: hit.mime } : null;
}

/**
 * 落盘（同名已存在则直接复用 ⇒ 去重 + 幂等）。
 *
 * ★ 先写临时文件再 `rename`（同目录内 rename 是原子的）：避免出图路由读到**半截文件**
 *   （边写边被 `GET /api/images/:name` 读到的表征是「图偶尔只显示一半」，且复现不了）。
 * ★ `rename` 目标已存在时 Windows 会抛 `EEXIST`：并发下两个同 URL 的取图会算出一模一样的
 *   名字，此时删掉自己的临时文件收场即可 —— 内容按定义相同，谁赢都一样。
 */
export function saveImage(bytes: Uint8Array, ext: string): { name: string; created: boolean } {
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = imageNameFor(bytes, ext);
  const full = path.join(dir, name);
  if (fs.existsSync(full)) return { name, created: false };
  const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, full);
  } catch {
    fs.rmSync(tmp, { force: true });
    return { name, created: false };
  }
  return { name, created: true };
}

/**
 * 出图地址：**站内相对路径**，不是绝对 URL。
 *
 * 为什么不拼 `http://localhost:18791/...`：那样开发期（前端 5174 经 vite 代理）能显示，
 * 一上线上域名就全成裂图。相对路径天然跟随「用户当前访问的那个源」——
 * 开发时被 `vite.config.ts` 的 `'/api'` 代理转到 18791，生产时同源直连，两处都不用改。
 */
export function imageUrlOf(name: string): string {
  return `/api/images/${name}`;
}
