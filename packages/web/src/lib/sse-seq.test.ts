import { describe, it, expect } from 'vitest';
import { acceptSeq } from './sse-seq';

describe('lib/sse-seq — SSE seq 去重判定', () => {
  it('同一轮内：seq 递增，逐个接受并把 since 前移', () => {
    expect(acceptSeq(0, 1)).toBe(1);
    expect(acceptSeq(1, 2)).toBe(2);
    expect(acceptSeq(2, 3)).toBe(3);
  });

  it('同一轮内：≤since 的重复帧被丢弃（重连回放与 /live 快照会重叠）', () => {
    // 这条是 v13 的老防线：不拦则 token 帧进两次回调、文字翻倍
    expect(acceptSeq(56, 56)).toBeNull();
    expect(acceptSeq(56, 30)).toBeNull();
    expect(acceptSeq(56, 1 + 2)).toBeNull();
  });

  it('★ 跨轮：新一轮从 seq=1 起始时，本地计数必须归零（否则整轮被吃掉）', () => {
    // 上一轮收到 56，新一轮第一帧是 1 —— 它**不是重复帧**，是这个人的下一句话
    expect(acceptSeq(56, 1)).toBe(1);
  });

  it('★ 复现 B-007：新一轮短于上一轮时，整轮（含 done）都收得到', () => {
    // 上一轮 seq 到 101；新一轮只产 3 帧就 done（比上一轮短）
    let since = 101;
    const round2 = [1, 2, 3];
    const accepted: number[] = [];
    for (const seq of round2) {
      const next = acceptSeq(since, seq);
      if (next !== null) {
        accepted.push(seq);
        since = next;
      }
    }
    // 修复前：三个都 ≤ 101 且非 1 ⇒ 全被丢 ⇒ 正文永不显示、busy 永久卡住
    expect(accepted).toEqual([1, 2, 3]);
    expect(since).toBe(3);
  });

  it('★ 新一轮首帧与本地计数同值（since=1）时按「新轮」接受：宁可多一帧，不可丢整轮', () => {
    // 代价：重连回放可能把 seq=1 那帧重放一次（多几个字）；收益：不会整轮静默丢失。
    // 这个取舍是刻意的——丢整轮的后果是「永久卡在生成中」，重复一帧的后果只是多几个字。
    expect(acceptSeq(1, 1)).toBe(1);
  });

  it('误放宽防线：非 1 的乱序小值仍必须拦（不能因为跨轮就放开去重）', () => {
    expect(acceptSeq(56, 2)).toBeNull();
    expect(acceptSeq(56, 55)).toBeNull();
  });

  it('边界：since=0 时首帧接受', () => {
    expect(acceptSeq(0, 1)).toBe(1);
  });

  it('边界：seq=0 是非法值（服务端不为 0），按重复帧拦掉', () => {
    expect(acceptSeq(5, 0)).toBeNull();
  });
});
