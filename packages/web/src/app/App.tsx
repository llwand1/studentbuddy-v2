/**
 * 应用壳：180px 浅色侧栏（会话列表 + 学习四环导航 + 设置）+ 主区视图路由 + 右侧内置浏览器面板。
 * 五环入口即需求闭环的导航面（学/练/忆/反馈），M2-M4 逐环填充。
 * 面板（PreviewPanel）自己无预览时返回 null，故壳层不需要为它持状态。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { ChatIcon, QuizIcon, CardsIcon, StatsIcon, SettingsIcon, PlusIcon, PinIcon } from '../components/icons';
import { api } from '../lib/api';
import { ChatView } from '../features/chat/ChatView';
import { SettingsView } from '../features/settings/SettingsView';
import { QuizBankPage } from '../features/quiz/QuizBankPage';
import { TermsPage } from '../features/terms/TermsPage';
import { DailySummaryPage } from '../features/summary/DailySummaryPage';
import { PreviewPanel } from '../features/preview/PreviewPanel';
import './app.css';

type View = 'chat' | 'quiz' | 'terms' | 'summary' | 'settings';

const NAV: Array<{ key: View; label: string; icon: typeof ChatIcon }> = [
  { key: 'chat', label: '对话', icon: ChatIcon },
  { key: 'quiz', label: '题库', icon: QuizIcon },
  { key: 'terms', label: '词条库', icon: CardsIcon },
  { key: 'summary', label: '今日总结', icon: StatsIcon },
];

export function App() {
  const [view, setView] = useState<View>('chat');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** 会话标题过滤（纯前端，服务端列表本就 ≤ 单机量级）；空串 = 不过滤 */
  const [query, setQuery] = useState('');
  /** 正在生成回复的会话 id：侧栏在该会话项上显示「回复中」提示（busy 上报自 ChatView） */
  const [busySid, setBusySid] = useState<string | null>(null);

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

  /** 稳定引用：ChatView 的 useEffect 以它为依赖，箭头函数每次新建会导致 effect 反复触发 */
  const handleBusyChange = useCallback((busy: boolean, sid: string | null) => {
    setBusySid(busy ? sid : null);
  }, []);

  const togglePin = async (s: Session) => {
    await api.sessions.pin(s.id, !s.pinned).catch(() => undefined);
    await reloadSessions();
  };

  const q = query.trim().toLowerCase();
  const visible = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;

  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        <button className="sb-new-chat" onClick={() => void newSession()}>
          <PlusIcon /> 新对话
        </button>
        <input
          className="sb-session-search"
          placeholder="搜索会话"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sb-session-list">
          {visible.map((s) => (
            <div
              key={s.id}
              className={currentId === s.id && view === 'chat' ? 'sb-session active' : 'sb-session'}
              onClick={() => openSession(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && openSession(s.id)}
            >
              <span className="sb-session-title">{s.title || '新对话'}</span>
              {busySid === s.id && (
                <span className="sb-session-busy" role="status">
                  <span className="sb-session-busy-dot" />
                  回复中
                </span>
              )}
              <button
                className={s.pinned ? 'sb-session-pin pinned' : 'sb-session-pin'}
                title={s.pinned ? '取消置顶' : '置顶'}
                onClick={(e) => {
                  e.stopPropagation();
                  void togglePin(s);
                }}
              >
                <PinIcon size={13} />
              </button>
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
          {visible.length === 0 && q && <div className="sb-session-empty">没有匹配的会话</div>}
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
          <ChatView
            sessionId={currentId}
            sessionTitle={sessions.find((s) => s.id === currentId)?.title}
            onNewSession={() => void newSession()}
            onRoundDone={() => void reloadSessions()}
            onBusyChange={handleBusyChange}
          />
        )}
        {view === 'quiz' && <QuizBankPage />}
        {view === 'terms' && <TermsPage />}
        {view === 'summary' && <DailySummaryPage />}
        {view === 'settings' && <SettingsView />}
      </main>
      <PreviewPanel />
    </div>
  );
}
