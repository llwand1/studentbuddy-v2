/**
 * features/continent/continent-partners — 学习伙伴（NPC）的**取数与呈现**（契约 `docs/NPC-PARTNER-SPEC.md` §7）。
 *
 * ★ 为什么从 `ContinentPage.tsx` 拆出来：① 那份文件要守 gates 的「.tsx ≤300 行」红线，
 *   伙伴这一族（取数 + 横幅 + 对话框接线）塞进去当场撞线；② 与 `continent-view.ts` /
 *   `continent-canvas.ts` 是同一刀法——**页面只管编排，一族功能一个文件**。
 *
 * ★★ **伙伴的一切派生量都读服务端**（位置/处境/名额门票/可落位格/今日余额）：它们是跨表的聚合，
 *   前端算不了，也不许算——自己算一遍就是「图上画着伙伴遇险、任务清单里没有那单」的开端。
 *   本文件唯一的"计算"是把服务端给的信物列表按卡数滤一遍（卡数本身也是服务端读数）。
 *
 * ★★ 2026-09-27（玩家创建制）：**创建/改名/解散三个写口都在这里**，且三者的响应都是
 *   **整份 `NpcState`** ——创建会改变名额与可落位格、解散会空出一格，只回"成功"会让地图立刻过期。
 * ★ **「选位态」也住在这里**（`placing` + `startCreate`/`cancelCreate`/`placeAt`）：它是"伙伴这一族"
 *   的界面状态，而不是页面的编排状态。放在这里，页面只需在 `pick` 里让位一行：
 *   `if (partners.placing) return void partners.placeAt(row, col);`
 *   ——页面因此守住行数红线，而"点哪一格"的交互仍然只有一处（地图点击 → 页面分流）。
 * ★ 提示语由 `onNotice` 回给页面（页面统一渲染横幅）：本文件不自己造第二条横幅通道。
 *
 * ★ `marks`（给 canvas 的最小形状）与 `distressed`（横幅要的那几位）都是**同一个 `partners` 的投影**，
 *   不是第二份结论；`NpcDialog` 打开的是 `id` 而不是对象，故地图刷新后名字/处境永远是最新的。
 */
import { useCallback, useMemo, useState } from 'react';
import { NPC_JOBS, NPC_JOB_LABEL, NPC_MOODS, NPC_MOOD_LABEL, NPC_TRADE_MIN_CARDS, type NpcJob, type NpcMood } from '@sb/shared';
import { api } from '../../lib/api';
import type { NpcState, NpcView } from '../../lib/api-npc';
import type { ContinentNpcMark } from './ContinentMap';
import { NpcDialog, type NpcToken } from './NpcDialog';

/** 创建成功要回给页面的一句"他来了"（名字/人设/是否 AI 起的） */
export interface NpcCreated {
  name: string;
  bio: string;
  source: 'ai' | 'fallback';
}

/**
 * 伙伴 + 信物的读口。**两个只读口并发**：`/api/npc`（伙伴）与 `/api/cards/state`（卡墙读数，
 * 只为滤出"够格当信物"的词条）。★ 不新增端点——卡数是两张流水的聚合，前端算不了，这一读省不掉。
 *
 * `onNotice` 由页面注入（横幅的唯一通道）：创建成功/失败、名额不够都从这里说出去，**禁静默**。
 */
export function useContinentPartners(onNotice: (text: string) => void) {
  const [partners, setPartners] = useState<NpcState | null>(null);
  const [tokens, setTokens] = useState<NpcToken[]>([]);
  const [placing, setPlacing] = useState(false);
  /** 招募面板里选好的职业与性格（选位态期间有效；守护词条 = 玩家点的那一格） */
  const [pick, setPick] = useState<{ job: NpcJob; mood: NpcMood }>({ job: 'mage', mood: 'warm' });

  const refresh = useCallback(async () => {
    const [cards, npc] = await Promise.all([api.cards.state(), api.npc.state()]);
    setPartners(npc);
    setTokens(
      cards.wall
        .filter((w) => w.card.cards >= NPC_TRADE_MIN_CARDS)
        .map((w) => ({ termId: w.termId, term: w.term, cards: w.card.cards })),
    );
  }, []);

  /** 创建一位伙伴（位置 = 玩家点的那一格）。★ 服务端回整份新状态，直接换上，不重取 */
  const create = useCallback(async (row: number, col: number): Promise<NpcCreated> => {
    const r = await api.npc.create(row, col, pick);
    setPartners(r.state);
    const m = r.state.npcs.find((n) => n.id === r.memberId);
    return { name: m?.name ?? '伙伴', bio: m?.bio ?? '', source: r.source };
  }, [pick]);

  /** 改名：服务端回整份新状态（名字也出现在横幅与任务清单里） */
  const rename = useCallback(async (id: string, name: string): Promise<string> => {
    const r = await api.npc.rename(id, name);
    setPartners(r.state);
    return r.state.npcs.find((n) => n.id === id)?.name ?? name;
  }, []);

  /** 「让他回家」：删掉他就空出一个名额与一格 */
  const remove = useCallback(async (id: string): Promise<void> => {
    const r = await api.npc.remove(id);
    setPartners(r.state);
  }, []);

  /** 进选位态。★ 不能创建时**必须说清为什么**（`blockedBy` 是服务端算好的那句话，UI 不自己编） */
  const startCreate = useCallback(() => {
    const q = partners?.quota;
    if (!q) return;
    if (!q.canCreate) {
      onNotice(q.blockedBy);
      return;
    }
    setPlacing(true);
    onNotice('选好职业与性格，再点地图上一格——他会守那一格上的词条。');
  }, [partners, onNotice]);

  const cancelCreate = useCallback(() => setPlacing(false), []);

  /**
   * 把伙伴安置在 (row, col)。★ **失败留在选位态**（换一格再点就好），并把服务端那句话原样说出来：
   * 它是逐格判定（那格被怪占着／已经有伙伴守着／这条词条你还不熟），比"安置失败"有用得多。
   * ★ 成功时说真话：`fallback` 时补一句"名字是本地起的"（降级可以，假装没降级不行）。
   */
  const placeAt = useCallback(
    async (row: number, col: number): Promise<void> => {
      try {
        const made = await create(row, col);
        setPlacing(false);
        onNotice(
          made.source === 'ai'
            ? `「${made.name}」来了——${made.bio}`
            : `「${made.name}」来了——${made.bio}（名字是本地起的；到设置里绑个模型，他会自己取）`,
        );
      } catch (e) {
        onNotice(e instanceof Error && e.message ? e.message : '这一格安置不了，换一格再点试试');
      }
    },
    [create, onNotice],
  );

  /**
   * 选位态要在地图上标出来的**可落位格**；`undefined` = 不在选位态。
   * ★ 地图靠"给没给"判断选位态（省一个布尔 prop，也就不会出现两个状态打架）；
   * ★ 引用必须**稳定**（不在选位态时恒为 `undefined`，在选位态时是 state 里那个数组），
   *   否则 `ContinentMap` 的绘制 effect 每帧重跑。
   */
  const placeSpots = placing ? partners?.spots : undefined;

  const marks: ContinentNpcMark[] = useMemo(
    () =>
      (partners?.npcs ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        row: n.row,
        col: n.col,
        distressed: n.distressed,
        job: n.job,
      })),
    [partners],
  );
  const distressed = useMemo(() => (partners?.npcs ?? []).filter((n) => n.distressed), [partners]);

  return {
    partners,
    tokens,
    marks,
    distressed,
    placing,
    pick,
    setPick,
    placeSpots,
    refresh,
    create,
    rename,
    remove,
    startCreate,
    cancelCreate,
    placeAt,
  };
}

interface Props {
  partners: NpcState | null;
  tokens: readonly NpcToken[];
  distressed: readonly NpcView[];
  /** 打开着的那位伙伴 **id**（不是对象：地图刷新后名字/处境要跟着新数据走） */
  npcOpenId: string | null;
  /** 正在选位（状态在 `useContinentPartners` 里，页面只把它透传下来） */
  placing: boolean;
  /** 招募面板的选择（职业 / 性格）与改写口 */
  pick: { job: NpcJob; mood: NpcMood };
  onPick: (next: { job: NpcJob; mood: NpcMood }) => void;
  onClose: () => void;
  /** 「去救他」：★ **不代打**，只把人送到能打的格（页面持有英雄控制器） */
  onRescue: (threatTermId: string) => void;
  onRename: (id: string, name: string) => Promise<string>;
  onRemove: (id: string) => Promise<void>;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onLibraryChanged: () => void;
  onNotice: (text: string) => void;
}

/** 伙伴这一族的横幅 + 对话面板。★ 返回值是一个 Fragment，插在页面的横幅流里即可 */
export function ContinentPartners({
  partners,
  tokens,
  distressed,
  npcOpenId,
  placing,
  pick,
  onPick,
  onClose,
  onRescue,
  onRename,
  onRemove,
  onStartCreate,
  onCancelCreate,
  onLibraryChanged,
  onNotice,
}: Props) {
  const npcOpen = partners?.npcs.find((n) => n.id === npcOpenId) ?? null;
  const first = distressed[0];
  const quota = partners?.quota;

  return (
    <>
      {/* ★ ④ 与任务清单联动的**用户可见面**：他在喊、怪在哪、怎么救（同一件事清单里也有一单） */}
      {first && (
        <p className="continent-banner warn">
          伙伴在求救：「{first.name}」被「{first.threat?.term ?? '一只怪'}」堵住了
          {distressed.length > 1 ? `（还有 ${distressed.length - 1} 位也在喊）` : ''}
          ——走到那只怪旁边答对那道题，怪就散了。任务清单里也挂了这一单。
        </p>
      )}

      {/* ★ ③ 宣传点「创建你的 AI 学习伙伴」的入口 + 名额门票的**进度说在明面上** */}
      {placing ? (
        <div className="continent-banner continent-recruit" role="group" aria-label="招募伙伴">
          <div className="continent-recruit-row">
            <span className="continent-recruit-label">职业</span>
            {NPC_JOBS.map((j) => (
              <button key={j} type="button" aria-pressed={pick.job === j}
                className={pick.job === j ? 'continent-btn continent-recruit-on' : 'continent-btn'}
                onClick={() => onPick({ ...pick, job: j })}>
                {NPC_JOB_LABEL[j]}
              </button>
            ))}
          </div>
          <div className="continent-recruit-row">
            <span className="continent-recruit-label">性格</span>
            {NPC_MOODS.map((m) => (
              <button key={m} type="button" aria-pressed={pick.mood === m}
                className={pick.mood === m ? 'continent-btn continent-recruit-on' : 'continent-btn'}
                onClick={() => onPick({ ...pick, mood: m })}>
                {NPC_MOOD_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="continent-recruit-hint">
            守护词条：点地图上一格（得是「有词条、没冒怪」的地），他就守那一格上的词条；名字与人设由 AI 按你选的职业和性格来写。
            <button type="button" className="continent-btn ghost" onClick={onCancelCreate}>
              取消招募
            </button>
          </p>
        </div>
      ) : (
        quota && (
          <p className={quota.canCreate ? 'continent-banner' : 'continent-banner dim'}>
            {quota.count === 0
              ? '大陆上还没有伙伴。'
              : `已有 ${quota.count} 位伙伴（这块大陆最多 ${quota.max} 位）· 已完成 ${quota.doneTasks} 单任务。`}
            {quota.canCreate
              ? ' 招募你的 AI 学习伙伴——选职业与性格、挑一块地让他守，名字与人设由 AI 来写。'
              : ` ${quota.blockedBy}`}
            {quota.canCreate && (
              <button type="button" className="continent-btn" onClick={onStartCreate}>
                招募伙伴
              </button>
            )}
          </p>
        )
      )}

      {npcOpen && (
        <NpcDialog
          npc={npcOpen}
          tokens={tokens}
          tradesLeft={partners?.tradesLeft ?? 0}
          onRename={async (next) => {
            onNotice(`他以后就叫「${await onRename(npcOpen.id, next)}」了。`);
          }}
          onRemove={async () => {
            const gone = npcOpen.name;
            await onRemove(npcOpen.id);
            onNotice(`「${gone}」回家去了——位置和名额都空出来了。`);
          }}
          onClose={onClose}
          onRescue={onRescue}
          onLibraryChanged={onLibraryChanged}
        />
      )}
    </>
  );
}