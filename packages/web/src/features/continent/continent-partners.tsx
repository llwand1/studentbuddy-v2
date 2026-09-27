/**
 * features/continent/continent-partners — 学习伙伴（NPC）的**取数与呈现**（契约 `docs/NPC-PARTNER-SPEC.md` §7）。
 *
 * ★ 为什么从 `ContinentPage.tsx` 拆出来：① 那份文件要守 gates 的「.tsx ≤300 行」红线，
 *   伙伴这一族（取数 + 三条横幅 + 对话框接线）塞进去当场撞线；② 与 `continent-view.ts` /
 *   `continent-canvas.ts` 是同一刀法——**页面只管编排，一族功能一个文件**。
 *
 * ★★ **伙伴的一切派生量都读服务端**（数量/位置/遇险/今日余额）：它们是跨表的聚合，
 *   前端算不了，也不许算——自己算一遍就是「图上画着伙伴遇险、任务清单里没有那单」的开端。
 *   本文件唯一的"计算"是把服务端给的信物列表按卡数滤一遍（卡数本身也是服务端读数）。
 *
 * ★ `marks`（给 canvas 的最小形状）与 `distressed`（横幅要的那几位）都是**同一个 `partners` 的投影**，
 *   不是第二份结论；`NpcDialog` 打开的是 `id` 而不是对象，故地图刷新后名字/遇险状态永远是最新的。
 */
import { useCallback, useMemo, useState } from 'react';
import { NPC_TRADE_MIN_CARDS } from '@sb/shared';
import { api } from '../../lib/api';
import type { NpcState, NpcView } from '../../lib/api-npc';
import type { ContinentNpcMark } from './ContinentMap';
import { NpcDialog, type NpcToken } from './NpcDialog';

/**
 * 伙伴 + 信物的读口。**两个只读口并发**：`/api/npc`（伙伴）与 `/api/cards/state`（卡墙读数，
 * 只为滤出"够格当信物"的词条）。★ 不新增端点——卡数是两张流水的聚合，前端算不了，这一读省不掉。
 */
export function useContinentPartners() {
  const [partners, setPartners] = useState<NpcState | null>(null);
  const [tokens, setTokens] = useState<NpcToken[]>([]);

  const refresh = useCallback(async () => {
    const [cards, npc] = await Promise.all([api.cards.state(), api.npc.state()]);
    setPartners(npc);
    setTokens(
      cards.wall
        .filter((w) => w.card.cards >= NPC_TRADE_MIN_CARDS)
        .map((w) => ({ termId: w.termId, term: w.term, cards: w.card.cards })),
    );
  }, []);

  /** 给主伙伴改名（宣传点「创建你的 AI 学习伙伴」的唯一写口） */
  const rename = useCallback(
    async (name: string): Promise<string> => {
      const r = await api.npc.renamePartner(name);
      await refresh();
      return r.partnerName;
    },
    [refresh],
  );

  const marks: ContinentNpcMark[] = useMemo(
    () =>
      (partners?.npcs ?? []).map((n) => ({
        id: n.id,
        name: n.name,
        row: n.row,
        col: n.col,
        distressed: n.distressed,
      })),
    [partners],
  );
  const distressed = useMemo(() => (partners?.npcs ?? []).filter((n) => n.distressed), [partners]);

  return { partners, tokens, marks, distressed, refresh, rename };
}

interface Props {
  partners: NpcState | null;
  tokens: readonly NpcToken[];
  distressed: readonly NpcView[];
  /** 打开着的那位伙伴 **id**（不是对象：地图刷新后名字/遇险状态要跟着新数据走） */
  npcOpenId: string | null;
  /** 库里几条词条——只为分辨"空库"与"全是怪"两句不同的文案（§7.4） */
  total: number;
  onClose: () => void;
  /** 「去救他」：★ **不代打**，只把人送到能打的格（页面持有英雄控制器） */
  onRescue: (threatTermId: string) => void;
  onRename: (name: string) => Promise<string>;
  onLibraryChanged: () => void;
  onNotice: (text: string) => void;
}

/** 伙伴这一族的三条横幅 + 对话面板。★ 返回值是一个 Fragment，插在页面的横幅流里即可 */
export function ContinentPartners({
  partners,
  tokens,
  distressed,
  npcOpenId,
  total,
  onClose,
  onRescue,
  onRename,
  onLibraryChanged,
  onNotice,
}: Props) {
  const npcOpen = partners?.npcs.find((n) => n.id === npcOpenId) ?? null;
  const first = distressed[0];

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
      {/* ★ ⑦ 的激励说出来（数由服务端给：还差几条、现在几位、上限几位） */}
      {partners && partners.termsToNext !== null && partners.npcs.length > 0 && (
        <p className="continent-banner dim">
          再添 {partners.termsToNext} 条词条，大陆上就会多一位伙伴（现在 {partners.npcs.length} 位，最多{' '}
          {partners.max} 位）。
        </p>
      )}
      {/* ★ 空库例外（§2.1）：该有伙伴却没有落脚地——说清是"地上没位置"还是"库里还没词" */}
      {partners && partners.npcs.length === 0 && total > 0 && (
        <p className="continent-banner dim">
          这块地上暂时站不下伙伴——他得有块没冒怪的落脚地；把怪清掉，他就会露面。
        </p>
      )}

      {npcOpen && (
        <NpcDialog
          npc={npcOpen}
          tokens={tokens}
          tradesLeft={partners?.tradesLeft ?? 0}
          // ★ 只有第 0 位（主伙伴）能改名——用户"创建"的是那一位（§3）
          isPartner={partners?.npcs[0]?.id === npcOpen.id}
          onRename={async (next) => {
            onNotice(`他以后就叫「${await onRename(next)}」了。`);
          }}
          onClose={onClose}
          onRescue={onRescue}
          onLibraryChanged={onLibraryChanged}
        />
      )}
    </>
  );
}