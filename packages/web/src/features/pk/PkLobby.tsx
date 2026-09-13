/**
 * PkLobby — PK 大厅（契约 docs/PK-SPEC.md §5：昵称→登录→建房/输码入房）。
 *
 * 两态：未登录只给昵称表单；已登录给「建房」与「输码入房」。
 * 判定逻辑在 pk-view.ts（本文件只挂 UI）；错误统一走 PkApp 的 error 位（ADR-5 三态）。
 */
import { useCallback, useState } from 'react';
import type { PkIdentity } from '@sb/shared';
import { normalizeRoomCode } from './pk-view';

interface Props {
  identity: PkIdentity | null;
  error: string;
  busy: boolean;
  onLogin: (nickname: string) => void;
  /** P0-7：`topic` = 建房人自己的对战主题；入房的人进房后在等待房补选 */
  onCreate: (mode: 'pvp' | 'pve', aiTopic?: string, topic?: string) => void;
  onJoin: (roomCode: string) => void;
}

export function PkLobby({ identity, error, busy, onLogin, onCreate, onJoin }: Props) {
  const [nickname, setNickname] = useState(identity?.nickname ?? '');
  const [code, setCode] = useState('');
  const [localErr, setLocalErr] = useState('');
  /** 建房模式：pvp 双人 / pve 人机（AI 对手） */
  const [mode, setMode] = useState<'pvp' | 'pve'>('pvp');
  /** PVE 主题方向（可选，空 = AI 自选轮换） */
  const [aiTopic, setAiTopic] = useState('');
  /** P0-7：我的对战主题（建房时一起提交；开局前还能在等待房改） */
  const [topic, setTopic] = useState('');

  const submitLogin = useCallback(() => {
    const name = nickname.trim();
    if (!name || name.length > 20) {
      setLocalErr('昵称 1~20 字');
      return;
    }
    setLocalErr('');
    onLogin(name);
  }, [nickname, onLogin]);

  const submitJoin = useCallback(() => {
    const normalized = normalizeRoomCode(code);
    if (normalized.length !== 6) {
      setLocalErr('房号是 6 位数字');
      return;
    }
    setLocalErr('');
    onJoin(normalized);
  }, [code, onJoin]);

  if (!identity) {
    return (
      <section className="sb-pk-card">
        <h2 className="sb-pk-h2">先取个名字</h2>
        <p className="sb-pk-hint">昵称会显示在对战双方比分条上（1~20 字）</p>
        <form
          className="sb-pk-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitLogin();
          }}
        >
          <input
            className="sb-pk-input"
            placeholder="输入昵称（1~20 字）"
            value={nickname}
            maxLength={20}
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
          {(localErr || error) && <div className="sb-pk-error">{localErr || error}</div>}
          <button type="submit" className="sb-pk-btn primary" disabled={busy || !nickname.trim()}>
            登录
          </button>
        </form>
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
        {mode === 'pvp' && <p className="sb-pk-hint">建好后把 6 位房号念给对手，等 TA 输码进房</p>}
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
      {(localErr || error) && <div className="sb-pk-error">{localErr || error}</div>}
      <div className="sb-pk-me">
        当前身份：{identity.nickname}
        <span className="sb-pk-me-id">{identity.userId.slice(0, 8)}</span>
      </div>
    </>
  );
}
