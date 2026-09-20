/**
 * PkLobby — PK 大厅（契约 docs/PK-SPEC.md §5 / §14.1）。
 *
 * ★ B1（§14.1）改版：**不再有 PK 自己的登录表单**——昵称模拟登录已随 `pk_users` 一起废弃，
 *   身份由统一账号会话裁定。未登录只给「去登录」引导（跳主壳登录，登录后按 returnTo 跳回）；
 *   已登录给「建房」与「输码入房」。判定逻辑在 pk-view.ts（本文件只挂 UI）；
 *   错误统一走 PkApp 的 error 位（ADR-5 三态）。
 */
import { useState } from 'react';
import type { PkIdentity } from '@sb/shared';
import { normalizeRoomCode } from './pk-view';

interface Props {
  identity: PkIdentity | null;
  error: string;
  busy: boolean;
  /** §14.1：去主壳登录（PkApp 会把当前 hash 存进 returnTo，登录后跳回） */
  onGoLogin: () => void;
  /** P0-7：`topic` = 建房人自己的对战主题；入房的人进房后在等待房补选 */
  onCreate: (mode: 'pvp' | 'pve', aiTopic?: string, topic?: string) => void;
  onJoin: (roomCode: string) => void;
  /** P0-8：打开对战历史（已打完的局，含认输的） */
  onHistory: () => void;
}

export function PkLobby({ identity, error, busy, onGoLogin, onCreate, onJoin, onHistory }: Props) {
  const [code, setCode] = useState('');
  const [localErr, setLocalErr] = useState('');
  /** 建房模式：pvp 双人 / pve 人机（AI 对手） */
  const [mode, setMode] = useState<'pvp' | 'pve'>('pvp');
  /** PVE 主题方向（可选，空 = AI 自选轮换） */
  const [aiTopic, setAiTopic] = useState('');
  /** P0-7：我的对战主题（建房时一起提交；开局前还能在等待房改） */
  const [topic, setTopic] = useState('');

  const submitJoin = () => {
    const normalized = normalizeRoomCode(code);
    if (normalized.length !== 6) {
      setLocalErr('房号是 6 位数字');
      return;
    }
    setLocalErr('');
    onJoin(normalized);
  };

  if (!identity) {
    return (
      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">先登录再开战</h2>
        <p className="sb-pk-hint">
          对战身份已并入学习助手账号（邮箱登录），昵称取自账号资料——先去主壳登录，成功后自动回到本页
        </p>
        {error && <div className="sb-pk-error">{error}</div>}
        <button type="button" className="sb-pk-btn primary" onClick={onGoLogin}>
          去登录
        </button>
      </section>
    );
  }

  return (
    <>
      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">建房开战</h2>
        <div className="sb-pk-modes">
          <button
            type="button"
            className={mode === 'pvp' ? 'sb-pk-mode active' : 'sb-pk-mode'}
            onClick={() => setMode('pvp')}
          >
            双人对战
            <small>同一 WiFi 输房号入座</small>
          </button>
          <button
            type="button"
            className={mode === 'pve' ? 'sb-pk-mode active' : 'sb-pk-mode'}
            onClick={() => setMode('pve')}
          >
            AI 对战
            <small>与 AI 互出题互答题</small>
          </button>
        </div>
        {mode === 'pvp' && (
          <p className="sb-pk-hint">建好后把 6 位房号或邀请链接发给对手，TA 进房即可坐下</p>
        )}
        {mode === 'pve' && (
          <p className="sb-pk-hint">
            AI 与你同规则：互出题（+1）、答题（±2/−1）、45 秒时限、8 分钟结算。AI 用「设置 → 模型」里你配的服务商答题。
          </p>
        )}
        {mode === 'pve' && (
          <input
            className="sb-pk-input"
            placeholder="主题方向（可选，如：世界历史）"
            maxLength={50}
            value={aiTopic}
            onChange={(e) => setAiTopic(e.target.value)}
          />
        )}
        <input
          className="sb-pk-input"
          placeholder="你的对战主题（如：二次函数、三国历史）"
          maxLength={20}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
        <p className="sb-pk-hint">
          双方各选一个主题，出题轮次在两个主题之间交替——谁出题都要贴合当前主题，跑题会被裁判判失败
        </p>
        <button
          type="button"
          className="sb-pk-btn primary"
          disabled={busy || !topic.trim()}
          onClick={() => onCreate(mode, mode === 'pve' ? aiTopic.trim() || undefined : undefined, topic.trim())}
        >
          建房
        </button>
      </section>
      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">输码入房</h2>
        <form
          className="sb-pk-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitJoin();
          }}
        >
          <input
            className="sb-pk-input code"
            placeholder="6 位房号"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
          />
          <button type="submit" className="sb-pk-btn primary" disabled={busy || code.length !== 6}>
            进房
          </button>
        </form>
      </section>
      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">战绩</h2>
        <p className="sb-pk-hint">打完的对局都记在这里（含认输的），点开能回看题目</p>
        <button type="button" className="sb-pk-btn" disabled={busy} onClick={onHistory}>
          对战历史
        </button>
      </section>
      {(localErr || error) && <div className="sb-pk-error">{localErr || error}</div>}
      <div className="sb-pk-me">当前身份：{identity.nickname}</div>
    </>
  );
}
