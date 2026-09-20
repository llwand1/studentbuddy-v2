/**
 * TermCard — 词条卡（契约 `docs/TERM-HIGHLIGHT-SPEC.md` §3 / §6）。
 *
 * 两态：
 *   · `mini`（悬停速览）：词名 / 领域 / 已用次数 / 释义——只看一眼，移开即走；
 *   · `full`（点击固定）：＋别名 ＋复习状态 ＋动作按钮——要深入、要操作时才出现。
 * ★ **为什么是两态而不是一个**（老板拍板 G 方案的落地）：需求里藏着两个强度不同的诉求
 *   ——「扫读时别打扰我」与「我要点进去看全甚至操作」。折叠态低打扰、展开态高承载，
 *   与 `COACH-SPEC`「一个组件两种状态」是同一手法。
 * ★ **只做真实存在的动作**：纳入/移出复习（`scopeTerm`）、打开词条库（App 的 `openTerms`）
 *   与朗读发音（`lib/speech`，v1.1）。
 *   demo 里那个「标记已掌握」没有对应接口，按契约 §6 砍掉——**不做假按钮**。
 *   同一条理由决定了发音按钮的渲染条件：**环境没有语音能力就不渲染**，
 *   而不是渲染一个点了才报错的按钮（契约 §3.1）。
 * ★ 数据一律**现取当前词条状态**（由调用方传最新 `item`），不做快照：用户在词条库改了
 *   释义或合并了别名，卡片要跟着变。
 */
import { useState } from 'react';
import { computeReviewState, reviewStateLabel } from '@sb/shared';
import { api, type TermItem } from '../../lib/api';
import { canSpeak, isEnglishWord, speakEnglish } from '../../lib/speech';

export function TermCard({
  item,
  variant,
  say,
  onOpenTerms,
  onClose,
  onChanged,
}: {
  item: TermItem;
  variant: 'mini' | 'full';
  /**
   * 正文里显示的那段文本（命中原文）——发音按钮的**判定与朗读共用输入**（契约 §3.1，v1.1）。
   * ★ 刻意不读 `item.term`：别名命中时正文显示 `closure`、`item.term` 是 `闭包`。
   * 未注入时不显示喇叭（不猜、不回落）。
   */
  say?: string;
  /** 打开词条库（未注入时该按钮不出现） */
  onOpenTerms?: (keyword: string) => void;
  /** 关闭（仅完整卡有 × ） */
  onClose?: () => void;
  /** 词条状态变更后的回调（刷新索引，让卡片与列表跟上） */
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sayBusy, setSayBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const inScope = item.review_in_scope === 1;
  const rs = computeReviewState({
    lastReviewedAt: item.last_reviewed_at,
    createdAt: item.created_at,
    stage: item.review_stage,
  });
  /** 三个条件全真才渲染喇叭：有发音文本 + 它是英语词 + 环境有语音能力（契约 §3.1） */
  const speakable = say !== undefined && isEnglishWord(say) && canSpeak();

  const toggleScope = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api.terms.scopeTerm(item.id, !inScope);
      // ★ 纳入会**清零进度**（老板拍板），文案必须把这件事说出来——进度不可撤销，
      //   静默清掉等于让用户莫名其妙从头背（与 TermsPage 的既有口径一致）。
      setMsg(inScope ? '已移出复习范围' : '已纳入复习范围（进度从第 1 天重新开始）');
      onChanged?.();
    } catch {
      setMsg('操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 朗读发音。三态（`AGENTS.md` 红线 5）：
   *   · 进行中 = 按钮禁用并换成占位符（连点也点不动，`speakEnglish` 里还有 `cancel` 兜底）；
   *   · 成功   = **由声音本身承担**，不刷文案——卡里刷一句「已朗读」只会让卡片抖动且零信息量；
   *   · 失败   = 必须说出来（系统没装英文语音时 `speak()` 会静默无声，不提示等于用户以为坏了）。
   */
  const sayIt = async (): Promise<void> => {
    if (sayBusy || say === undefined) return;
    setSayBusy(true);
    setMsg('');
    try {
      await speakEnglish(say);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '朗读失败');
    } finally {
      setSayBusy(false);
    }
  };

  return (
    <div className={variant === 'mini' ? 'term-card mini' : 'term-card'}>
      <div className="term-card-head">
        <b className="term-card-name">{item.term}</b>
        {/* 喇叭紧跟词名：发音是「这个词的属性」，跟着词走最直观；卡片右侧已被
            「已用 N 次」与 × 占用，再塞会挤（契约 §3.1） */}
        {speakable && (
          <button
            type="button"
            className="term-card-say"
            disabled={sayBusy}
            aria-label="朗读发音"
            title="朗读发音"
            onClick={() => void sayIt()}
          >
            {sayBusy ? '···' : '🔊'}
          </button>
        )}
        <span className="term-card-domain">{item.domain}</span>
        <span className="term-card-use">已用 {item.usage_count} 次</span>
        {variant === 'full' && (
          <button type="button" className="term-card-x" aria-label="关闭词条卡" onClick={onClose}>
            ×
          </button>
        )}
      </div>

      <div className="term-card-def">{item.definition}</div>

      {variant === 'full' && (
        <>
          {item.aliases.length > 0 && (
            <div className="term-card-alias">
              <span>别名</span>
              {item.aliases.map((a) => (
                <i key={a}>{a}</i>
              ))}
            </div>
          )}

          {/* 未纳入复习范围时不显示「N 天没复习」——徽标只能有一个含义，
              否则数字与复习队列对不上（同 TermsPage 的既有判据） */}
          <div className={inScope ? 'term-card-rv' : 'term-card-rv out'}>
            {inScope ? reviewStateLabel(rs) : '未纳入复习范围'}
          </div>

          <div className="term-card-acts">
            <button
              type="button"
              className="term-card-btn primary"
              disabled={busy}
              onClick={() => void toggleScope()}
            >
              {inScope ? '移出复习' : '纳入复习'}
            </button>
            {onOpenTerms && (
              <button type="button" className="term-card-btn" onClick={() => onOpenTerms(item.term)}>
                打开词条库
              </button>
            )}
          </div>
        </>
      )}

      {/* ★ 提示行放在两态之外：喇叭在 mini 卡也有，失败提示若只挂在完整卡上就看不见了 */}
      {msg && <div className="term-card-msg">{msg}</div>}
    </div>
  );
}
