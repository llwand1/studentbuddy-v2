/**
 * 应用壳：180px 浅色侧栏（会话+学习四环+系统）+ 主区。
 * 五环入口即需求闭环的导航面（学/练/忆/反馈），M1 起逐环填充。
 */
import { useState } from 'react';
import { ChatIcon, QuizIcon, CardsIcon, StatsIcon, SettingsIcon, PlusIcon } from '../components/icons';
import './app.css';

type View = 'chat' | 'quiz' | 'memorize' | 'summary' | 'settings';

const NAV: Array<{ key: View; label: string; icon: typeof ChatIcon }> = [
  { key: 'chat', label: '对话', icon: ChatIcon },
  { key: 'quiz', label: '题库', icon: QuizIcon },
  { key: 'memorize', label: '背背背', icon: CardsIcon },
  { key: 'summary', label: '今日总结', icon: StatsIcon },
];

export function App() {
  const [view, setView] = useState<View>('chat');
  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        <button className="sb-new-chat" onClick={() => setView('chat')}>
          <PlusIcon /> 新对话
        </button>
        <nav className="sb-nav">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={view === key ? 'sb-nav-item active' : 'sb-nav-item'}
              onClick={() => setView(key)}
            >
              <Icon /> {label}
            </button>
          ))}
        </nav>
        <div className="sb-nav sb-nav-bottom">
          <button
            className={view === 'settings' ? 'sb-nav-item active' : 'sb-nav-item'}
            onClick={() => setView('settings')}
          >
            <SettingsIcon /> 设置
          </button>
        </div>
      </aside>
      <main className="sb-main">
        <Placeholder view={view} />
      </main>
    </div>
  );
}

function Placeholder({ view }: { view: View }) {
  const labels: Record<View, string> = {
    chat: '对话（M1：流式/SSE 重连/上传附件）',
    quiz: '题库（M2：出题/三题型/统计/薄弱点）',
    memorize: '背背背（M3：翻卡/SRS 到期队列）',
    summary: '今日总结（M4：XP/连签/趋势）',
    settings: '设置（M1：服务商 + 角色模型绑定）',
  };
  return (
    <div className="sb-placeholder">
      <div className="sb-placeholder-card">
        <h2>studentbuddy v2</h2>
        <p>{labels[view]}</p>
        <p className="sb-placeholder-meta">M0 地基 · 学→练→析→忆→反馈</p>
      </div>
    </div>
  );
}
