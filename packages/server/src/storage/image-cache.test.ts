/**
 * storage/image-cache —— 图片缓存的判定、命名与落盘（2026-09-20 新建）。
 *
 * 只锁四类「写错不会报错」的事：
 * ① **类型判定判在字节上**，且 **SVG 必须被拒** —— 它被放进来不会有任何报错，
 *    只会让 `/api/images/x.svg` 成为一条同源脚本执行通道（本文件最要紧的一条）；
 * ② **路径闸门**（`..` / 绝对路径 / 别的扩展名全挡）—— 漏一个就是路径穿越，
 *    而症状只是「某个 URL 取到了不该取的文件」；
 * ③ **去重与幂等**（同内容两次落盘必须同一个文件）—— `fetch_image` 的 `idempotent`
 *    声明靠它，声明与实现不符时没有任何运行时报错，只会让重试白占磁盘；
 * ④ **出图地址是相对路径** —— 拼成绝对 URL 本地开发照样能显示，上线才全成裂图。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-imgcache-test-'));

const {
  MAX_IMAGE_BYTES,
  imageNameFor,
  imagePath,
  imageUrlOf,
  imagesDir,
  isImageName,
  mimeOfName,
  saveImage,
  sniffImage,
} = await import('./image-cache.js');

/** 各格式的真实文件头（嗅探只看头，故够用；尺寸不参与判定）。 */
const FIXTURES: Array<[string, Uint8Array]> = [
  ['png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
  ['jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])],
  ['gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])],
  ['webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
  ['bmp', new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00])],
  ['avif', new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
];

/** 落盘产物一律清掉：用例之间不共用文件，也免得污染真实 DATA_DIR。 */
beforeEach(() => {
  fs.rmSync(imagesDir(), { recursive: true, force: true });
});

describe('sniffImage —— 类型判定（判在字节上）', () => {
  it('六种白名单格式逐个命中，且扩展名与 MIME 对得上', () => {
    for (const [ext, bytes] of FIXTURES) {
      const hit = sniffImage(bytes);
      expect(hit?.ext, `${ext} 未被识别`).toBe(ext);
      expect(hit?.mime).toBe(mimeOfName(`x.${ext}`));
    }
  });

  it('★ SVG 必须被拒 —— 同源直接打开会执行源站脚本（本文件最要紧的一条）', () => {
    // 不给 `image/svg+xml` 任何入口：嗅探表里根本没有它，且它是文本、无魔数
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBeNull();
    // 连名字也进不来：NAME_RE 由嗅探表派生 ⇒ `.svg` 不在白名单
    expect(isImageName(`${'a'.repeat(32)}.svg`)).toBe(false);
  });

  it('HTML / 纯文本 / 空字节一律不算图片', () => {
    expect(sniffImage(new TextEncoder().encode('<html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('just text'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });

  it('残缺头不算命中（PNG 只给前 4 字节）', () => {
    // 签名是 8 字节全判：只对一半就当命中，等于给任意以 89 50 4e 47 开头的垃圾开门
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('RIFF 容器必须同时具有 WEBP 尾标（避免把 .wav/.avi 当图收下）', () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffImage(wav)).toBeNull();
  });
});

describe('命名与路径闸门（路径穿越的唯一防线）', () => {
  it('自产的名字一律合法，且 path 落在 images 目录内', () => {
    const name = imageNameFor(FIXTURES[0]?.[1] ?? new Uint8Array(), 'png');
    expect(isImageName(name)).toBe(true);
    expect(imagePath(name)).toBe(path.join(imagesDir(), name));
  });

  it('★ 穿越、绝对路径、错扩展名、大小写不符一律 null', () => {
    const bad = [
      '../studentbuddy.db',
      '..%2Fstudentbuddy.db',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      `${'a'.repeat(32)}.svg`, // 白名单外扩展名
      `${'a'.repeat(32)}.png.exe`,
      `${'A'.repeat(32)}.png`, // 大写的 hex：我们只会产出小写，不给自己留第二套写法
      `${'a'.repeat(31)}.png`, // 长度不符
      `${'a'.repeat(33)}.png`,
      'a'.repeat(32),
      '',
    ];
    for (const n of bad) {
      expect(isImageName(n), `应被拒：${n}`).toBe(false);
      expect(imagePath(n), `应被拒：${n}`).toBeNull();
    }
  });
});

describe('去重与幂等（fetch_image 的 idempotent 声明靠它）', () => {
  it('同内容两次落盘 = 同一个文件，第二次标 created=false，目录里只有一个文件', () => {
    const bytes = FIXTURES[1]?.[1] ?? new Uint8Array();
    const first = saveImage(bytes, 'jpg');
    const second = saveImage(bytes, 'jpg');
    expect(first.name).toBe(second.name);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(fs.readdirSync(imagesDir())).toEqual([first.name]);
  });

  it('内容不同 → 名字不同（不是按 URL 或时间命名）', () => {
    const a = saveImage(new Uint8Array([...FIXTURES[0]![1]!, 0x01]), 'png');
    const b = saveImage(new Uint8Array([...FIXTURES[0]![1]!, 0x02]), 'png');
    expect(a.name).not.toBe(b.name);
    expect(fs.readdirSync(imagesDir()).sort()).toEqual([a.name, b.name].sort());
  });

  it('落盘内容与入参逐字节一致（且不残留 .tmp）', () => {
    const bytes = new Uint8Array([...FIXTURES[0]![1]!, 0xaa, 0xbb, 0xcc]);
    const { name } = saveImage(bytes, 'png');
    expect(new Uint8Array(fs.readFileSync(path.join(imagesDir(), name)))).toEqual(bytes);
    expect(fs.readdirSync(imagesDir()).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('上限常量是 4MB 且唯一（工具与文案都读它，别处不许再写一个数）', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('出图地址', () => {
  it('★ 相对路径（绝对 URL 本地能显示、上线全裂）', () => {
    const name = `${'b'.repeat(32)}.png`;
    expect(imageUrlOf(name)).toBe(`/api/images/${name}`);
    // 关键：不能带 host —— 带 host 就等于把「当前部署在哪个域名」写死进了**要落库的正文**
    expect(imageUrlOf(name).startsWith('/')).toBe(true);
  });
});
