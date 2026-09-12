/**
 * 应用壳：侧栏（吉祥物 logo + 新对话 + 功能列表 + 可折叠历史对话 + 用户占位）
 * + 主区视图路由 + 右侧内置浏览器面板。
 * 2026-09-09 侧栏改版（老板口述定稿）：功能列表从上到下、历史列表可展开收起、
 * 底部用户框为 PK 昵称登录入口（P0 模拟登录；真微信授权 P1 接入）；「对话」不再占导航项——logo 与新对话即入口。
 * 会话搜索框保留（批次 3 交付项），收进历史对话区内。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@sb/shared';
import { UserAuthBox } from '../components/UserAuthBox';
import {
  QuizIcon,
  CardsIcon,
  StatsIcon,
  SettingsIcon,
  PlusIcon,
  PinIcon,
  ChevronDownIcon,
  ClockIcon,
} from '../components/icons';
import { api } from '../lib/api';
import { ChatView } from '../features/chat/ChatView';
import { Mascot } from '../features/chat/Mascot';
import { SettingsView } from '../features/settings/SettingsView';
import { QuizBankPage } from '../features/quiz/QuizBankPage';
import { TermsPage } from '../features/terms/TermsPage';
import { DailySummaryPage } from '../features/summary/DailySummaryPage';
import { PreviewPanel } from '../features/preview/PreviewPanel';
import './app.css';

type View = 'chat' | 'quiz' | 'terms' | 'summary' | 'settings';

const NAV: Array<{ key: View; label: string; icon: typeof QuizIcon }> = [
  { key: 'quiz', label: '题库', icon: QuizIcon },
  { key: 'terms', label: '词条', icon: CardsIcon },
  { key: 'summary', label: '今日总结', icon: StatsIcon },
  { key: 'settings', label: '设置', icon: SettingsIcon },
];

export function App() {
  const [view, setView] = useState<View>('chat');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** 会话标题过滤（纯前端，服务端列表本就 ≤ 单机量级）；空串 = 不过滤 */
  const [query, setQuery] = useState('');
  /** 正在生成回复的会话 id：侧栏在该会话项上显示「回复中」提示（busy 上报自 ChatView） */
  const [busySid, setBusySid] = useState<string | null>(null);
  /** 历史对话列表展开/收起（默认展开） */
  const [historyOpen, setHistoryOpen] = useState(true);

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

  const togglePin = async (s: Session) => {
    await api.sessions.pin(s.id, !s.pinned).catch(() => undefined);
    await reloadSessions();
  };

  /** 稳定引用：ChatView 的 useEffect 以它为依赖，箭头函数每次新建会导致 effect 反复触发 */
  const handleBusyChange = useCallback((busy: boolean, sid: string | null) => {
    setBusySid(busy ? sid : null);
  }, []);

  const q = query.trim().toLowerCase();
  const visible = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;

  return (
    <div className="sb-shell">
      <aside className="sb-sidebar">
        {/* 品牌 logo：吉祥物团子即入口（点击回对话主界面，对话不再占导航项） */}
        <button className="sb-logo" title="studentbuddy" onClick={() => setView('chat')}>
          <Mascot />
          <span className="sb-logo-name">
            studentbuddy<small>你的专属学习助手</small>
          </span>
        </button>

        <button className="sb-new-chat" onClick={() => void newSession()}>
          <PlusIcon /> 新对话
        </button>

        {/* 功能列表（从上到下） */}
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

        <hr className="sb-nav-divider" />

        {/* 历史对话（可展开/收起） */}
        <button
          className={historyOpen ? 'sb-history-head' : 'sb-history-head collapsed'}
          onClick={() => setHistoryOpen(!historyOpen)}
          aria-expanded={historyOpen}
        >
          <ClockIcon size={13} /> 历史对话
          <span className="sb-history-count">{visible.length}</span>
          <ChevronDownIcon size={13} className="sb-history-chev" />
        </button>
        {historyOpen && (
          <input
            className="sb-session-search"
            placeholder="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <div className={historyOpen ? 'sb-session-list' : 'sb-session-list collapsed'}>
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
          {visible.length === 0 && query && <div className="sb-session-empty">没有匹配的会话</div>}
        </div>

        {/* 底部用户区：PK 登录（P0-1），组件自持登录态，见 components/UserAuthBox */}
        <UserAuthBox />
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
