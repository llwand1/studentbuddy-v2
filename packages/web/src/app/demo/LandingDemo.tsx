/**
 * LandingDemo — 演示窗外壳（窗口 chrome + 重播 + 阶段进度 + 多演示切换位）。
 *
 * ★ 外壳与演示**解耦**：它只从 `LANDING_DEMOS` 拿定义、把 `stage` 交给 `View`，
 *   自身不含任何词条知识。所以老板预告的「知识图演示」落地时，本文件一行都不用改。
 *
 * ★ 多演示切换位：`LANDING_DEMOS.length > 1` 时才画 Tab —— 现在只有词条一个，
 *   画出来就是一个点无可点的装饰控件（与「未配 GitHub 凭据就不画登录按钮」同一条纪律：
 *   宁少一个入口，不给用户一个点了没反应的按钮）。点单的演示顺序即数组顺序。
 */
import { useState } from 'react';
import { EMPTY_DEMO, LANDING_DEMOS } from './registry';
import { useDemoPlayer } from './useDemoPlayer';
import './demo.css';

export function LandingDemo() {
  const [pick, setPick] = useState(0);
  const demo = LANDING_DEMOS[pick] ?? LANDING_DEMOS[0] ?? EMPTY_DEMO;
  const { stage, replay, still } = useDemoPlayer(demo.stages);
  const View = demo.View;
  const cur = demo.stages[stage];
  const many = LANDING_DEMOS.length > 1;

  return (
    <div className="ld-window">
      <div className="ld-bar">
        <span className="ld-dot" />
        <span className="ld-dot" />
        <span className="ld-dot" />
        <span className="ld-bar-title">{demo.title}</span>
        {!still && (
          <button type="button" className="ld-replay" onClick={replay}>
            重播
          </button>
        )}
      </div>

      {many && (
        <div className="ld-tabs">
          {LANDING_DEMOS.map((d, i) => (
            <button
              key={d.key}
              type="button"
              className={i === pick ? 'ld-tab ld-tab-on' : 'ld-tab'}
              onClick={() => setPick(i)}
            >
              {d.title}
            </button>
          ))}
        </div>
      )}

      <div className="ld-stage">
        <View stage={stage} />
      </div>

      <div className="ld-foot">
        <span className="ld-progress" aria-hidden="true">
          {demo.stages.map((s, i) => (
            <i key={s.caption} className={i === stage ? 'ld-pip ld-pip-on' : 'ld-pip'} />
          ))}
        </span>
        <span className="ld-caption">{cur ? cur.caption : ''}</span>
      </div>
    </div>
  );
}
