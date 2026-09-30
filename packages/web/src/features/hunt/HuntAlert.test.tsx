// @vitest-environment jsdom
/**
 * HuntAlert.test — 对话页「刷新了新的怪物」横幅的口径锁（2026-09-30）。
 *
 * 锁四条：
 *  ① 首次挂载只取基线，不弹（今天早些时候聊出来的怪不算"新"）；
 *  ② 一轮回答收口后重取地图：与基线的差集才是"新刷的"——用的是与大陆同一个 `topicMonsterIds`，不在前端另做匹配；
 *  ③ 「一键讨伐」把名单投进 `continent-hunt-store` 并切页；「×」只忽略，不投递；
 *  ④ 取数失败不弹横幅也不抛（附加提醒不该打断主流程）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { computeReviewState, localDayKey } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { resetHuntStore, takeHunt } from '../continent/continent-hunt-store';

const mapMock = vi.fn();
vi.mock('../../lib/api', () => ({ api: { terms: { map: mapMock } } }));

const { HuntAlert } = await import('./HuntAlert');

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = localDayKey(NOW);

function sqlite(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 一条今天入库的普通词条；`usedToday` ⇒ `last_used_at` 就是现在（话题怪候选） */
function termOf(id: string, usedToday: boolean): ContinentMapTerm {
  const createdAt = sqlite(new Date(NOW.getTime() - 5 * 86_400_000));
  return {
    id,
    term: `词条${id}`,
    definition: `释义${id}`,
    domain: 'js',
    importance: 0.5,
    usage_count: 1,
    created_at: createdAt,
    updated_at: createdAt,
    review_stage: 0,
    last_reviewed_at: null,
    review_in_scope: 0,
    last_used_at: usedToday ? sqlite(NOW) : null,
    review: computeReviewState({ stage: 0, createdAt, now: NOW }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  resetHuntStore();
  mapMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HuntAlert', () => {
  it('★ 首次挂载只取基线不弹；一轮收口后新冒出的话题怪才弹，点「一键讨伐」投递名单并切页', async () => {
    expect(DAY).toBe(localDayKey(new Date()));
    mapMock.mockResolvedValueOnce({ terms: [termOf('old', true), termOf('quiet', false)] });
    const go = vi.fn();
    const { rerender } = render(<HuntAlert active roundTick={0} onGoContinent={go} />);
    await waitFor(() => expect(mapMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).toBeNull();

    // 一轮回答收口：quiet 被提到了 ⇒ 今天多了一只话题怪；old 早就有 ⇒ 不算新
    mapMock.mockResolvedValueOnce({ terms: [termOf('old', true), termOf('quiet', true)] });
    rerender(<HuntAlert active roundTick={1} onGoContinent={go} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.getByText('刷新了新的怪物')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('「词条quiet」');
    expect(screen.getByRole('status').textContent).not.toContain('「词条old」');

    fireEvent.click(screen.getByRole('button', { name: '一键讨伐' }));
    expect(takeHunt()).toEqual(['quiet']);
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('没有新怪的一轮不弹；「×」只忽略不投递；不在对话页时不显示', async () => {
    mapMock.mockResolvedValue({ terms: [termOf('a', true)] });
    const { rerender } = render(<HuntAlert active roundTick={0} onGoContinent={vi.fn()} />);
    await waitFor(() => expect(mapMock).toHaveBeenCalledTimes(1));
    rerender(<HuntAlert active roundTick={1} onGoContinent={vi.fn()} />);
    await waitFor(() => expect(mapMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();

    mapMock.mockResolvedValueOnce({ terms: [termOf('a', true), termOf('b', true)] });
    rerender(<HuntAlert active roundTick={2} onGoContinent={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    rerender(<HuntAlert active={false} roundTick={2} onGoContinent={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<HuntAlert active roundTick={2} onGoContinent={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '忽略这次提醒' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(takeHunt()).toBeNull();
  });

  it('取地图失败：不弹、不抛，只 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mapMock.mockRejectedValueOnce(new Error('网络断了'));
    render(<HuntAlert active roundTick={1} onGoContinent={vi.fn()} />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    warn.mockRestore();
  });
});
