/**
 * AnswerStyleCard — 回答方式偏好设置卡（契约 docs/ANSWER-STYLE-SPEC.md §1/§2）。
 * 点选即存（同 QuizImageCard：四维都是短值，多一步保存只会增加「改了没存」的困惑）。
 * 「恢复默认」＝删键，回到「没配过」态：出题前的选项卡会重新问一次（契约 §2 的 configured 语义）。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_ANSWER_STYLE, styleSummary } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';
import { api } from '../../lib/api';
import { StyleChips } from '../../components/StyleChips';
import './settings.css';

export function AnswerStyleCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [style, setStyle] = useState<AnswerStyle>(DEFAULT_ANSWER_STYLE);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings
      .answerStyle()
      .then((r) => {
        setStyle(r.style);
        setConfigured(r.configured);
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  /** 保存并回读：屏上显示的必须是服务端归一后的值（非法值逐字段回落，不能屏上选 A 库里存 B） */
  const save = async (next: AnswerStyle, text: string) => {
    setBusy(true);
    setStyle(next); // 先乐观上屏，失败再用库内真值盖回来
    try {
      const r = await api.settings.saveAnswerStyle(next);
      setStyle(r.style);
      setConfigured(true);
      flash(true, `${text}：${styleSummary(r.style)}`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
      api.settings
        .answerStyle()
        .then((r) => setStyle(r.style))
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const r = await api.settings.resetAnswerStyle();
      setStyle(r.style);
      setConfigured(r.configured);
      flash(true, '已恢复默认（没配过状态）：下次点出题会再问你一次');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const state = loading ? '读取中…' : busy ? '保存中…' : `当前：${styleSummary(style)}`;

  return (
    <section className="settings-sec">
      <h3>回答方式偏好</h3>
      <p className="settings-hint">
        决定 AI 讲解与出题解析<b>怎么说、说多少</b>——只影响表达，不改题目内容、不改配图开关。
        四维默认值就是本功能之前的行为：不设置，AI 口吻不变。没配过时，点「出题」会先弹一张同样的选项卡问你一次。
      </p>

      <StyleChips value={style} onChange={(next) => void save(next, '已保存')} disabled={loading || busy} />

      <div className="settings-actions">
        <span className={configured ? 'settings-state on' : 'settings-state'}>
          {state}
          {configured ? '' : '（未保存过，出题前会先问你）'}
        </span>
        <button className="settings-test" disabled={loading || busy} onClick={() => void reset()}>
          恢复默认
        </button>
      </div>
    </section>
  );
}
