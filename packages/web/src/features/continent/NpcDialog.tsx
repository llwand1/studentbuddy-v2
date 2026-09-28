/**
 * features/continent/NpcDialog — 学习伙伴对话面板（契约 `docs/NPC-PARTNER-SPEC.md` §7.3）。
 *
 * ★ 这个面板就是宣传点「创建你的 AI 学习伙伴」的落地：给它起名（落 `app_settings` KV）、
 *   跟它说话（`npc` 模型角色，无 key 时降级到本地台词）、用信物卡跟它换一条没见过的新词。
 *
 * ★★ **降级必须说真话**：`source === 'fallback'` 时把 `NPC_FALLBACK_NOTICE` 原样显示出来
 *   （"伙伴现在靠固定台词应答——到设置里给他绑一个模型"）。不说这句，用户会以为 AI 就是这么木
 *   ——那正好把"AI 含量少"的观感钉死，与立项理由相反。
 *
 * ★ **收下新卡复用 `RitualOverlay`**（与 `ContinentChest` 同一条判断标准）：开卡的仪式感、两枚钮
 *   （收下 / 收下并纳入复习）与"拒收也记录"的口径都定在 `TERM-CARDS-SPEC` §8，复制一份 =
 *   两处口径开始漂移。这里只负责"换"这个动作，收下走**既有** `POST /api/cards/chest/accept`。
 *
 * ★ 交换**不花钥匙、不扣卡**（卡是流水派生的读数，见 SPEC §6.3）：所以本面板呈现的代价是
 *   "今天还能换 N 次"+ 信物门槛（★1 以上），并把那句话原样说出来，不许写成"消耗一张卡"。
 */
import { NPC_JOB_LABEL, NPC_MOOD_LABEL } from '@sb/shared';
import { useState } from 'react';
import { NPC_FALLBACK_NOTICE, NPC_TRADE_COST_LINE } from '@sb/shared';
import { api } from '../../lib/api';
import { cardsApi } from '../../lib/api-cards';
import type { ChestDraw } from '../../lib/api-cards';
import type { NpcView } from '../../lib/api-npc';
import { RitualOverlay } from '../game/ChestPanel';

/** 可当信物的一条词条（★ 卡数由服务端给：它是两张流水的聚合，前端算不了） */
export interface NpcToken {
  termId: string;
  term: string;
  cards: number;
}

interface Props {
  npc: NpcView;
  tokens: readonly NpcToken[];
  tradesLeft: number;
  onRename: (name: string) => Promise<void>;
  /** 「让他回家」：把这位伙伴从名册里删掉（★ 真删——门票按名册序号算，留个隐身位就是免费刷位） */
  onRemove: () => Promise<void>;
  onClose: () => void;
  /** 「去救他」：把用户送到能打的格（★ **不代打**，只是走过去） */
  onRescue: (threatTermId: string) => void;
  /** 收下新词之后：地图/卡墙都可能变，让页面重取 */
  onLibraryChanged: () => void;
}

export function NpcDialog({
  npc,
  tokens,
  tradesLeft,
  onRename,
  onRemove,
  onClose,
  onRescue,
  onLibraryChanged,
}: Props) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [source, setSource] = useState<'ai' | 'fallback' | null>(null);
  const [name, setName] = useState(npc.name);
  const [tokenId, setTokenId] = useState('');
  const [trades, setTrades] = useState(tradesLeft);
  const [draw, setDraw] = useState<ChestDraw | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** 「让他回家」是否已上膛（两段式：一个不可撤销的动作不该一键就发生） */
  const [armed, setArmed] = useState(false);

  const threat = npc.threat;

  const ask = async (): Promise<void> => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await api.npc.talk(npc.id, said);
      setReply(r.reply);
      setSource(r.source);
      setText('');
    } catch (e) {
      setNote(e instanceof Error ? e.message : '这句话没送出去，再试一次');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      await onRename(name.trim());
    } catch (e) {
      setNote(e instanceof Error ? e.message : '改名没成功');
    } finally {
      setBusy(false);
    }
  };

  /** 让他回家：★ 失败也说真话（服务端会说"这位伙伴不在大陆上了"），不静默吞掉 */
  const leave = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      await onRemove();
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : '没送走，再试一次');
    } finally {
      setBusy(false);
    }
  };

  const trade = async (): Promise<void> => {
    if (!tokenId || trades <= 0 || busy) return;
    setBusy(true);
    setNote('');
    try {
      const r = await api.npc.trade(npc.id, tokenId);
      setDraw(r.draw);
      setTrades(r.tradesLeft);
      // ★ 领域里没得换就回落全池——如实说一句，别让用户以为"他给错东西了"
      if (!r.domainMatched) setNote('你那个领域暂时没新词了，他给你挑了别的领域的。');
    } catch (e) {
      setNote(e instanceof Error ? e.message : '这次没换成');
    } finally {
      setBusy(false);
    }
  };

  const accept = async (review: boolean): Promise<void> => {
    if (!draw) return;
    setBusy(true);
    try {
      await cardsApi.acceptDraw(draw.openId, review);
      setDraw(null);
      onLibraryChanged();
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : '收下没落库，请刷新重试');
    } finally {
      setBusy(false);
    }
  };

  /** 拒收：★ 与宝箱不同的是**没烧钥匙**，但今天那一次额度照扣、这条词也进了"已抽过" */
  const refuse = (): void => {
    setNote('这张卡先放着没收——今天的交换次数已经用掉了，而且这条词不会再被你换到第二次。');
    setDraw(null);
  };

  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label={`学习伙伴 ${npc.name}`}>
      <div className="continent-modal-card continent-npc-card">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            {npc.name}
            <small>
              {npc.job ? `${NPC_JOB_LABEL[npc.job]} · ` : ''}
              {npc.mood ? `${NPC_MOOD_LABEL[npc.mood]} · ` : ''}
              守「{npc.term}」· {npc.domain}
              {npc.bio ? ` · ${npc.bio}` : ''}
            </small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <p className={npc.distressed ? 'continent-hint-line warn' : 'continent-hint-line'}>
          {npc.distressed && threat
            ? `他正被「${threat.term}」的怪堵在领地上——答对那道题，怪就散了。`
            : '他这会儿安好，附近没有怪。'}
        </p>
        {npc.distressed && threat && (
          <button className="continent-btn primary" onClick={() => onRescue(threat.termId)}>
            去救他
          </button>
        )}

        {/* ★ 每位伙伴都能改名：名字存在名册里，"只有第 0 位能改"那条随自动派位一起退役 */}
        <div className="continent-npc-line">
          <input
            className="continent-input"
            value={name}
            maxLength={12}
            placeholder="给他起个名字"
            aria-label="伙伴名字"
            onChange={(e) => setName(e.target.value)}
          />
          <button className="continent-btn ghost" disabled={busy || !name.trim()} onClick={() => void rename()}>
            起名
          </button>
        </div>

        {/* ★ 「让他回家」两段式：第一下只是上膛（`armed`），第二下才真删 */}
        <div className="continent-npc-line">
          <button
            className={armed ? 'continent-btn' : 'continent-btn ghost'}
            disabled={busy}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              void leave();
            }}
          >
            {armed ? '确认送他回家' : '让他回家'}
          </button>
          {armed && <span className="continent-note">他走了位置与名额都空出来；他守的词条和卡一张不动。</span>}
        </div>

        <div className="continent-npc-say">
          <p>{reply || `说句话吧——他只聊「${npc.term}」和他守的这块地。`}</p>
          {source === 'fallback' && <p className="continent-note">{NPC_FALLBACK_NOTICE}</p>}
        </div>

        <div className="continent-npc-line">
          <input
            className="continent-input"
            value={text}
            placeholder={`跟「${npc.name}」说句话`}
            aria-label="对伙伴说的话"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ask();
            }}
          />
          <button className="continent-btn primary" disabled={busy || !text.trim()} onClick={() => void ask()}>
            发送
          </button>
        </div>

        <div className="continent-npc-trade">
          <p className="continent-hint-line">
            今天还能跟他换 <b>{trades}</b> 次。
          </p>
          <div className="continent-npc-line">
            <select
              className="continent-input"
              value={tokenId}
              aria-label="信物词条"
              disabled={tokens.length === 0}
              onChange={(e) => setTokenId(e.target.value)}
            >
              <option value="">挑一条信物…</option>
              {tokens.map((t) => (
                <option key={t.termId} value={t.termId}>
                  {t.term}（{t.cards} 张）
                </option>
              ))}
            </select>
            <button
              className="continent-btn primary"
              disabled={busy || !tokenId || trades <= 0 || tokens.length === 0}
              onClick={() => void trade()}
            >
              换一条新词
            </button>
          </div>
          {tokens.length === 0 && (
            <p className="continent-hint-line">
              你还没有能当信物的词条——要 ★1 以上（至少 2 张卡）：把某条词条复习一次、或者在对话里聊到它，
              卡就会涨。
            </p>
          )}
          <p className="continent-note">{NPC_TRADE_COST_LINE}</p>
          {note && <p className="continent-note">{note}</p>}
        </div>
      </div>

      {draw && (
        <RitualOverlay draw={draw} busy={busy} onAccept={(review) => void accept(review)} onRefuse={refuse} />
      )}
    </div>
  );
}