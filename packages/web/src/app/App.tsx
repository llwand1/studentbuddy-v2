/**
 * 应用壳：180px 浅色侧栏（会话列表 + 学习四环导航 + 设置）+ 主区视图路由。
 * 五环入口即需求闭环的导航面（学/练/忆/反馈），M2-M4 逐环填充。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { ChatIcon, QuizIcon, CardsIcon, StatsIcon, SettingsIcon, PlusIcon } from '../components/icons';
import { api } from '../lib/api';
import { ChatView } from '../features/chat/ChatView';
import { SettingsView } from '../features/settings/SettingsView';
import { QuizBankPage } from '../features/quiz/QuizBankPage';
import { MemorizePage } from '../features/memorize/MemorizePage';
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions.list());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void reloadSessions();
  }, [reloadSessions]);

  // 会话标题在首轮对话后由服务端更新：切回会话列表时刷新
  useEffect(() => {
    if (view === 'chat') void reloadSessions();
  }, [view, currentId, reloadSessions]);

  const newSession = useCallback(async () => {
    const s = await api.sessions.create();
    setView('chat');
    setCurrentId(s.id);
    await reloadSessions();
  }, [reloadSessions]);

  const openSession = (id: string) => {
    setView('chat');
    setCurrentId(id);
  };

  const removeSession = async (id: string) => {
    await api.sessions.remove(id).catch(() => undefined);
    if (currentId === id) setCurrentId(null);
    await reloadSessions();
  };

  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        <button className="sb-new-chat" onClick={() => void newSession()}>
          <PlusIcon /> 新对话
        </button>
        <div className="sb-session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={currentId === s.id && view === 'chat' ? 'sb-session active' : 'sb-session'}
              onClick={() => openSession(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && openSession(s.id)}
            >
              <span className="sb-session-title">{s.title || '新对话'}</span>
              <button
                className="sb-session-del"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <nav className="sb-nav sb-nav-bottom">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={view === key ? 'sb-nav-item active' : 'sb-nav-item'}
              onClick={() => setView(key)}
            >
              <Icon /> {label}
            </button>
          ))}
          <button
            className={view === 'settings' ? 'sb-nav-item active' : 'sb-nav-item'}
            onClick={() => setView('settings')}
          >
            <SettingsIcon /> 设置
          </button>
        </nav>
      </aside>
      <main className="sb-main">
        {view === 'chat' && (
          <ChatView sessionId={currentId} onNewSession={() => void newSession()} onRoundDone={() => void reloadSessions()} />
        )}
        {view === 'quiz' && <QuizBankPage />}
        {view === 'memorize' && <MemorizePage />}
        {view === 'settings' && <SettingsView />}
        {(view === 'chat' || view === 'settings' || view === 'quiz' || view === 'memorize') ? null : <Placeholder view={view} />}
      </main>
    </div>
  );
}

function Placeholder({ view }: { view: View }) {
  const labels: Record<View, string> = {
    chat: '',
    quiz: '题库（M2：出题/三题型/统计/薄弱点）',
    memorize: '背背背（M3：翻卡/SRS 到期队列）',
    summary: '今日总结（M4：XP/连签/趋势）',
    settings: '',
  };
  return (
    <div className="sb-placeholder">
      <div className="sb-placeholder-card">
        <h2>studentbuddy v2</h2>
        <p>{labels[view]}</p>
      </div>
    </div>
  );
}
