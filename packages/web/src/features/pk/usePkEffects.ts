/**
 * PK 关键事件的本机音效与反馈层。
 * 房间快照仍是唯一状态源：用题目状态的前后差识别新题、超时与对手判分，不增加服务端状态或计分分支。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PkRoomState } from '@sb/shared';
import { PkAudio, loadPkSound, savePkSound, type PkSfx } from './pk-audio';
import type { PkBattleFxKind, PkBattleFxState } from './PkBattleFx';

export interface PkScoreFx {
  userId: string;
  delta: number;
  key: number;
}

const FX_MS = 950;

export function usePkEffects(state: PkRoomState, userId: string) {
  const [sound, setSound] = useState(loadPkSound);
  const [fx, setFx] = useState<PkBattleFxState | null>(null);
  const [scoreFx, setScoreFx] = useState<PkScoreFx | null>(null);
  const audio = useRef<PkAudio | null>(null);
  const sequence = useRef(0);
  const combo = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previous = useRef<PkRoomState | null>(null);

  useEffect(() => {
    audio.current = new PkAudio(undefined, true);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      audio.current?.dispose();
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    audio.current?.setMuted(!sound);
    savePkSound(sound);
  }, [sound]);

  const trigger = useCallback((kind: PkBattleFxKind, sfx: PkSfx, count?: number) => {
    sequence.current += 1;
    setFx({ kind, key: sequence.current, ...(count === undefined ? {} : { combo: count }) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFx(null), FX_MS);
    audio.current?.play(sfx);
  }, []);

  const answerResult = useCallback((correct: boolean) => {
    combo.current = correct ? combo.current + 1 : 0;
    if (correct && combo.current >= 3 && combo.current % 3 === 0) {
      trigger('combo', 'combo', combo.current);
    } else {
      trigger(correct ? 'correct' : 'wrong', correct ? 'correct' : 'wrong');
    }
  }, [trigger]);

  useEffect(() => {
    const before = previous.current;
    if (!before || before.roomId !== state.roomId) {
      previous.current = state;
      return;
    }
    for (const q of state.questions) {
      const old = before.questions.find((item) => item.id === q.id);
      if (!old && q.toUserId === userId && q.fromUserId !== userId) {
        trigger('question', 'question');
        continue;
      }
      if (!old || old.status !== 'pending' || q.status === 'pending') continue;
      if (q.toUserId === userId && q.status === 'timeout') {
        combo.current = 0;
        trigger('timeout', 'timeout');
        continue;
      }
      if (q.toUserId === userId) continue; // 自己提交的答案由 REST 回执即时反馈，避免 SSE 重播。
      const oldScore = before.players.find((player) => player.userId === q.toUserId)?.score ?? 0;
      const newScore = state.players.find((player) => player.userId === q.toUserId)?.score ?? oldScore;
      const delta = newScore - oldScore;
      if (delta === 0) continue;
      setScoreFx({ userId: q.toUserId, delta, key: ++sequence.current });
      const kind = q.status === 'timeout' ? 'timeout' : delta > 0 ? 'correct' : 'wrong';
      trigger(kind, kind);
    }
    previous.current = state;
  }, [state, trigger, userId]);

  const toggleSound = useCallback(() => setSound((value) => !value), []);

  return { sound, toggleSound, fx, scoreFx, answerResult };
}
