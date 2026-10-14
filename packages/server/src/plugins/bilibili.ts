import { cleanVideoQuery, objectValue, type BilibiliRecommendation, type BilibiliVideoQuiz, type PluginTool } from '@sb/shared';
import type { ToolContext } from '../chat/tools/registry.js';
import { searchVideoRoute } from '../sources/video-route.js';
import { searchWeb } from '../search/index.js';
import { loadExamContext } from '../learning/exam-mode.js';
import { generateCampfireOpener } from '../learning/campfire-opener.js';
import { announceQuizToSession } from '../learning/quiz-announce.js';
import { canAccessSession, sessionExists } from '../auth/ownership.js';
import { beginVideoSearch, finishVideoSearch } from '../sources/learning-videos.js';
import { bilibiliMaterial, learningDirection, loadBilibiliVideo, readBilibiliVideo, saveBilibiliVideo, videoAddress } from './bilibili-material.js';

export const BILIBILI_TOOLS: PluginTool[] = [
  { name: 'recommend_videos', description: '按指定或有证据的学习方向推荐真实 B站视频及相关网页资料。可留空 query；无方向时明确请求关键词。不会播放或访问账号历史。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 }, relatedToSelected:{type:'boolean',description:'明确找已选视频的相关视频与资料；此时依照已选视频标题，不推断观看历史。'} }, additionalProperties: false } },
  { name: 'select_video', description: '选择一个 HTTPS B站 BV 视频并读取真实标题与简介。切换视频清除旧笔记；Agent 不得编写字幕/笔记，用户只能通过学习卡明确提交材料。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 1000 } }, required: ['url'], additionalProperties: false } },
  { name: 'quiz_from_video', description: '从已选视频的真实简介、同视频共读划选或用户笔记生成一道可作答题。材料不足拒绝，不声称已看完视频。有学习会话时直接交付题卡并保存。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
/** Built-in adapter: no remote MCP endpoint, account secrets, or untrusted discovery schemas. */
export async function invokeBilibili(tool: string, raw: unknown, ctx: ToolContext, checkCurrent: () => void): Promise<unknown> {
  const args = objectValue(raw), owner = ctx.ownerId;
  if (ctx.sessionId && (!sessionExists(ctx.sessionId) || !canAccessSession(ctx.sessionId, owner))) throw new Error('学习会话不存在');
  const check = () => { ctx.signal?.throwIfAborted(); checkCurrent();
    if (ctx.sessionId && (!sessionExists(ctx.sessionId) || !canAccessSession(ctx.sessionId, owner))) throw new Error('学习会话已结束'); };
  check(); ctx.onStep('plugin_call', 'running', 'B站学习 · ' + tool);
  if (tool === 'recommend_videos') {
    const current = loadBilibiliVideo(owner);
    if(args.relatedToSelected===true&&!current)throw new Error('请先选择学习视频，再找相关视频');
    const direction = args.relatedToSelected===true&&current
      ? {query:cleanVideoQuery(current.title),source:'video' as const,reason:'你已选择的视频主题（依据标题，未声称看完整段讲解）'}
      : learningDirection(owner, args.query), exam = loadExamContext(owner);
    const query = direction.query;
    const ticket = ctx.sessionId ? beginVideoSearch(owner, ctx.sessionId) : null;
    const [videos, materials] = await Promise.all([
      searchVideoRoute('bilibili', query, owner, ctx.signal),
      searchWeb(query + ' 学习 教程', owner, { signal: ctx.signal, ...(exam.on ? { allowHosts: exam.hosts } : {}) })
        .then(r => r.results.slice(0, 5)).catch(() => []),
    ]);
    check();
    if (ctx.sessionId && ticket !== null) finishVideoSearch(owner, ctx.sessionId, ticket, videos, false);
    return { direction, videos: args.relatedToSelected===true?videos.hits.filter(hit=>hit.url!==current?.url):videos.hits, materials, siteSearchUrl: videos.siteSearchUrl,
      note: videos.note ?? '按学习方向检索的真实候选；匹配依据是检索文本，不代表已审核整段视频' } satisfies BilibiliRecommendation;
  }
  if (tool === 'select_video') {
    const { bvid } = videoAddress(args.url, owner), old = loadBilibiliVideo(owner);
    const video = old?.bvid === bvid ? { ...old } : await readBilibiliVideo(args.url, owner, ctx.signal);
    check();
    if (JSON.stringify(loadBilibiliVideo(owner)) !== JSON.stringify(old)) throw new Error('视频选择已更新，旧请求未覆盖');
    saveBilibiliVideo(owner, video);
    return ctx.sessionId ? {url:video.url,bvid:video.bvid,title:video.title,author:video.author,informationSource:video.informationSource,
      descriptionExcerpt:video.description.slice(0,3500),savedNotesChars:video.notes.length,
      notice:'这里只返回简介片段和材料状态；字幕/笔记由出题工具读取，不代表看完整段视频'} : video;
  }
  if (tool !== 'quiz_from_video') throw new Error('未知 B站学习工具');
  const video = loadBilibiliVideo(owner);
  if (!video) throw new Error('请先选择学习视频');
  videoAddress(video.url, owner);
  const material = bilibiliMaterial(owner, video, ctx.sessionId);
  const result = await generateCampfireOpener(owner, [], ctx.signal ?? new AbortController().signal, material.text);
  check();
  const current=loadBilibiliVideo(owner);
  if (current?.bvid !== video.bvid || current.selectedAt !== video.selectedAt || current.notes !== video.notes) throw new Error('视频或笔记已变化，旧题未交付');
  if (!result.ok) throw new Error(result.error);
  const opener = { ...result.value, scope: `${video.title} · ${material.basisLabel}` };
  if (ctx.sessionId) {
    announceQuizToSession(ctx.sessionId, { title: opener.question.topic, questions: [{
    type: 'single', question: opener.question.question, options: opener.question.options, answer: [opener.question.answer],
    explanation: opener.question.explanation, material: material.text,
    }] }, 'bilibili-' + opener.id);
    return {delivered:true,quizId:'bilibili-'+opener.id,source:{url:video.url,title:video.title},basis:material.basis,basisLabel:material.basisLabel,question:opener.question};
  }
  return { video, basis: material.basis, basisLabel: material.basisLabel, opener } satisfies BilibiliVideoQuiz;
}
