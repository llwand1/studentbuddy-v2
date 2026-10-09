/**
 * features/hunt/HuntAlert — 对话页的「刷新了新的怪物」横幅 + 「一键讨伐」（2026-09-30，
 * 契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「话题怪」）。
 *
 * 用户原话："用户在对话时刷新对应的怪物，刷新了就在对话页弹提醒，有一键讨伐按钮，点了跳转知识大陆答题讨伐。"
 *
 * ── 怎么知道"刷新了"（与大陆**同一份口径**）───────────────────────────────────
 * 回答收口（`onRoundDone`）时服务端已经按正文匹配把提到的词条写了 `last_used_at`（`term-usage.ts`，在 `done` 帧之前）。
 * 这里在每轮收口后重取一次地图（`GET /api/terms/review/map`，与大陆页同一个端点）并用同一个 `topicMonsterIds`
 * 算"今天的话题怪"，与**上一次**的集合做差 ⇒ 新冒出来的那几只。不在前端自己做一遍词条匹配：
 * 那会是第二份匹配口径（横幅说刷了、大陆上没有）。首次挂载先取一次当基线（今天早些时候聊出来的不算"新"）。
 *
 * ── 交接 ───────────────────────────────────────────────────────────────────
 * 「一键讨伐」⇒ `requestHunt(ids)`（模块级信箱）⇒ `onGoContinent()` 切页 ⇒ 大陆页英雄就位后取走名单，
 * 依次寻路、到了自动开打（`useContinentHunt`）。
 * ★ 取数失败不弹横幅、只 `console.warn`：这是附加提醒，不是主流程；主流程（回答本身）已经完成，不该为它再打一条错误横幅。
 * ★ 只在对话页显示（`active`）；横幅常驻到用户处理（讨伐 / 忽略）或下一轮刷出新的替换它。
 */
import { useEffect, useRef, useState } from 'react';
import { localDayKey, topicMonsterIds } from '@sb/shared';
import { api } from '../../lib/api';
import { requestHunt } from '../continent/continent-hunt-store';
import './hunt-alert.css';
import { useNarrow } from '../../lib/use-narrow';

interface Props {
  /** 是否在对话页（不在就不显示，但状态保留） */
  active: boolean;
  /** 每轮回答收口 +1（App 在 `onRoundDone` 里增）；0 = 还没有任何一轮 */
  roundTick: number;
  onGoContinent: () => void;
}

interface Fresh {
  ids: string[];
  names: string[];
}

export function HuntAlert({ active, roundTick, onGoContinent }: Props) {
  const narrow = useNarrow();
  const [fresh, setFresh] = useState<Fresh | null>(null);
  /** 上一次看到的话题怪集合；`null` = 基线还没取到 */
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const map = await api.terms.map();
        if (cancelled) return;
        const now = topicMonsterIds(map.terms, localDayKey(new Date()));
        const seen = seenRef.current;
        seenRef.current = now;
        if (seen === null || roundTick === 0) return; // 基线
        const ids = [...now].filter((id) => !seen.has(id));
        if (ids.length === 0) return;
        const byId = new Map(map.terms.map((t) => [t.id, t.term]));
        setFresh({ ids, names: ids.map((id) => byId.get(id) ?? id) });
      } catch (e) {
        console.warn('[hunt-alert] 取地图失败，这轮不提醒：', e instanceof Error ? e.message : e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roundTick]);

  if (!active || !fresh) return null;
  const listed = fresh.names.slice(0, 4).map((n) => `「${n}」`).join('');
  const more = fresh.names.length > 4 ? ` 等 ${fresh.names.length} 条` : '';
  return (
    <div className={`hunt-alert${narrow ? ' is-compact' : ''}`} role="status" aria-live="polite">
      {!narrow && <span className="hunt-alert-sigil" aria-hidden="true" />}
      {!narrow && <span className="hunt-alert-text">
        <b>刷新了新的怪物</b>
        刚聊到的{listed}
        {more}在知识大陆上冒出了话题怪——趁热打一场，答对就算复习一次。
      </span>}
      <button
        type="button"
        className="hunt-alert-go"
        title={`刚聊到的${listed}${more}可以复习`}
        onClick={() => {
          requestHunt(fresh.ids);
          setFresh(null);
          onGoContinent();
        }}
      >
        {narrow ? `新怪 ${fresh.ids.length}` : '一键讨伐'}
      </button>
      <button type="button" className="hunt-alert-x" aria-label="忽略这次提醒" onClick={() => setFresh(null)}>
        ×
      </button>
    </div>
  );
}
