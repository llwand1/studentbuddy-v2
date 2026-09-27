/**
 * world/ChapterNpc — 冒险录「招募你的 AI 学习伙伴」：职业 / 性格 / 守护词条三选，右侧立绘与对话框即时变化。
 *
 * ★ 事实口径见 world-copy 头注：伙伴由玩家在地图上点格创建、AI 起名与人设；三个动作对应产品的
 *   对话（就守护词条提问/给线索）、求救单（遇怪派任务）、交换（拿卡换同领域新词条）。
 *   这里的名字与台词是示意模板，不调用模型。
 * ★ 对话框逐字显示（歧路旅人式），减少动态效果时整句直接出现。
 */
import { useEffect, useState } from 'react';
import { useLandingLang } from '../landing-lang';
import { CH_NPC as N, DEMO_TERMS, NPC_LINES } from './world-copy';
import { NPC_ART } from './npc-art';
import { PixelSprite } from './PixelSprite';
import { Chapter } from './Chapter';

const TERM_PICKS = [0, 2, 4, 5];

export function ChapterNpc() {
  const { lang } = useLandingLang();
  const [job, setJob] = useState('mage');
  const [mood, setMood] = useState('warm');
  const [term, setTerm] = useState(0);
  const [act, setAct] = useState('talk');
  const [shown, setShown] = useState(0);
  const termName = DEMO_TERMS[term]!.name[lang];
  const line = NPC_LINES[act]![mood]![lang].replace('{t}', termName);
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => { setShown(calm ? Number.MAX_SAFE_INTEGER : 0); }, [line, calm]);
  useEffect(() => {
    if (shown >= line.length) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), lang === 'zh' ? 45 : 18);
    return () => window.clearTimeout(id);
  }, [shown, line, lang]);

  const art = NPC_ART[job]!;
  const jobName = N.jobs.find((j) => j.id === job)!.name[lang];
  const moodName = N.moods.find((m) => m.id === mood)!.name[lang];

  return (
    <Chapter id="npc" title={N.title[lang]} accent={N.accent[lang]} lead={N.lead[lang]}>
      <div className="wn-grid" role="group" aria-label={N.aria[lang]}>
        <div className="wn-pick">
          <fieldset className="wn-set">
            <legend>{N.jobLabel[lang]}</legend>
            <div className="wn-jobs">
              {N.jobs.map((j) => (
                <button key={j.id} type="button" className={j.id === job ? 'wn-job wn-on' : 'wn-job'} aria-pressed={j.id === job} onClick={() => setJob(j.id)}>
                  <PixelSprite map={NPC_ART[j.id]!.map} pal={NPC_ART[j.id]!.pal} className="wn-job-art" />
                  <span>{j.name[lang]}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="wn-set">
            <legend>{N.moodLabel[lang]}</legend>
            <div className="wn-chips">
              {N.moods.map((m) => (
                <button key={m.id} type="button" className={m.id === mood ? 'wn-chip wn-on' : 'wn-chip'} aria-pressed={m.id === mood} onClick={() => setMood(m.id)}>{m.name[lang]}</button>
              ))}
            </div>
          </fieldset>
          <fieldset className="wn-set">
            <legend>{N.termLabel[lang]}</legend>
            <div className="wn-chips">
              {TERM_PICKS.map((i) => (
                <button key={i} type="button" className={i === term ? 'wn-chip wn-on' : 'wn-chip'} aria-pressed={i === term} onClick={() => setTerm(i)}>{DEMO_TERMS[i]!.name[lang]}</button>
              ))}
            </div>
          </fieldset>
          <p className="wn-cap">{N.cap[lang]}</p>
        </div>

        <div className="wf-frame wn-stage">
          <div className="wn-shaft" aria-hidden="true" />
          <div className="wn-hero" key={job}>
            <PixelSprite map={art.map} pal={art.pal} className="wn-art" />
            <i className="wn-plinth" aria-hidden="true" />
          </div>
          <div className="wn-plate">
            <strong>{N.names[job]![lang]}</strong>
            <span>{jobName} · {moodName}</span>
            <span className="wn-guard">{N.termLabel[lang]} · {termName}</span>
          </div>
          <div className="wn-dialog">
            <span className="wn-dialog-name">{N.names[job]![lang]}</span>
            <p aria-live="polite">{line.slice(0, shown)}<i className="wn-next" aria-hidden="true" /></p>
          </div>
          <div className="wn-acts">
            {N.actions.map((a) => (
              <button key={a.id} type="button" className={a.id === act ? 'wf-btn wn-act wn-on' : 'wf-btn wn-act'} aria-pressed={a.id === act} onClick={() => setAct(a.id)}>{a.name[lang]}</button>
            ))}
          </div>
        </div>
      </div>
    </Chapter>
  );
}
