/** guide-catalog: split domain module; compatible exports remain at guide.ts. */
import type { GuideGroup } from './guide-models.js';
import type { GuideText } from './guide-models.js';
import type { GuideKind } from './guide-models.js';
import type { GuideStage } from './guide-models.js';
import type { GuideLang } from './guide-models.js';

export interface GuideKindInfo {
  group: GuideGroup;
  label: GuideText;
  hint: GuideText;
  /** 此刻做不了时的一句「怎么解锁」（「全部功能」里灰着的那几行） */
  need: GuideText;
  /** 带文本动作的兜底文本（模型没给 / 给得不合格时用） */
  text?: GuideText;
}

export const GUIDE_CATALOG: Record<GuideKind, GuideKindInfo> = {
  'chat.topic': {
    group: 'chat',
    label: { zh: '随机聊个话题', en: 'Chat about something random' },
    hint: { zh: '让 AI 现想一个有意思的话题，点了直接开聊', en: 'AI picks a fun topic and starts talking right away' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'chat.ask': {
    group: 'chat',
    label: { zh: '追问一下', en: 'Ask a follow-up' },
    hint: { zh: '顺着刚才的内容再深挖一层', en: 'Dig one level deeper into what we just covered' },
    need: { zh: '先和 AI 聊一轮再来', en: 'Chat with AI for a round first' },
    text: { zh: '再用一个生活里的例子，把刚才的内容讲一遍', en: 'Explain what we just covered again with an everyday example' },
  },
  'chat.remember': {
    group: 'chat',
    label: { zh: '存入记忆', en: 'Save to memory' },
    hint: { zh: '把刚才的重要术语收进词条库，以后会来复习', en: 'Keep the key terms in your library for later review' },
    need: { zh: '先聊一轮再来', en: 'Chat for a round first' },
  },
  'chat.videos': {
    group: 'chat',
    label: { zh: '找讲解视频', en: 'Find videos' },
    hint: { zh: '去 B站 / 抖音搜这个知识点的讲解', en: 'Search Bilibili / Douyin for explainers on this' },
    need: { zh: '先让 AI 回答一次', en: 'Let AI answer once first' },
  },
  'session.new': {
    group: 'chat',
    label: { zh: '开一场新对话', en: 'Start a new chat' },
    hint: { zh: '换个话题，从头聊', en: 'New topic, clean slate' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'quiz.start': {
    group: 'quiz',
    label: { zh: '来一套题', en: 'Quiz me' },
    hint: { zh: '基于刚才的对话出题，当场判分', en: 'Questions from this chat, graded on the spot' },
    need: { zh: '先聊一轮，题才有得出', en: 'Chat for a round so there is something to quiz on' },
  },
  'quiz.scenario': {
    group: 'quiz',
    label: { zh: '出道情景题', en: 'Try a scenario task' },
    hint: { zh: '在可交互的小场景里动手做', en: 'Hands-on in an interactive mini-scenario' },
    need: { zh: '先聊一轮，题才有得出', en: 'Chat for a round so there is something to quiz on' },
  },
  'quiz.explain': {
    group: 'quiz',
    label: { zh: '一键解析', en: 'Explain my answers' },
    hint: { zh: '结合你的作答，图文讲清每道题', en: 'Illustrated walk-through based on your answers' },
    // ★ 灰着有三种原因：没做完 / 正在生成 / 已经生成（生成后这一项就撤销了，讲解留在那组题下方）。
    //   所以这句不能只写「先做完」——对做完了、也看过讲解的人是误导；两半都得说清：怎么解锁 + 之后去哪看。
    need: { zh: '做完一组题后可用；讲解生成后留在这组题下方', en: 'Available once a set is finished; the walkthrough then stays below that set' },
  },
  'quiz.retry': {
    group: 'quiz',
    label: { zh: '再练一遍', en: 'Practice again' },
    hint: { zh: '清空作答，重做这一组', en: 'Reset answers and redo this set' },
    need: { zh: '先把一组题做完', en: 'Finish a question set first' },
  },
  'nav.terms': {
    group: 'go',
    label: { zh: '翻翻词条库', en: 'Open your terms' },
    hint: { zh: 'AI 在对话里替你记下的术语都在这', en: 'Every term AI saved for you lives here' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.continent': {
    group: 'go',
    label: { zh: '去知识大陆', en: 'Visit the Continent' },
    hint: { zh: '到期的词条是怪物，复习就是收复', en: 'Due terms are monsters; reviewing wins the land back' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.pk': {
    group: 'go',
    label: { zh: '去对战', en: 'Battle arena' },
    hint: { zh: '和 AI 或朋友在答题擂台上 PK', en: 'Quiz duel against AI or a friend' },
    need: { zh: '随时可用', en: 'Always available' },
  },
  'nav.settings': {
    group: 'go',
    label: { zh: '去设置', en: 'Open settings' },
    hint: { zh: '绑定模型、调回答方式与出题偏好', en: 'Bind a model, tune answer style and quiz mix' },
    need: { zh: '随时可用', en: 'Always available' },
  },
};

/** 各阶段提灯开口那一句（弹层标题下那行；规则推荐用它，AI 推荐会自己写一句） */
export const GUIDE_HEADLINES: Record<GuideStage | 'nomodelHere', GuideText> = {
  nomodel: { zh: '还没有可用的模型，先去设置绑一个', en: 'No model yet — bind one in Settings first' },
  nomodelHere: { zh: '在这页绑一个模型（或点「一键默认设置」），我就能指路了', en: 'Bind a model on this page (or use one-click defaults) and I can help' },
  tour: { zh: '想换个地方逛逛，还是回去聊点什么？', en: 'Look around, or head back to chat?' },
  busy: { zh: 'AI 正在回答，答完我再给你指路', en: "AI is answering — I'll point the way once it's done" },
  quizzed: { zh: '这组做完了，把原理看明白吧', en: "Set finished — let's make sure it really clicks" },
  fresh: { zh: '不知道从哪开始？我帮你起个头', en: "Not sure where to start? I'll get you going" },
  chatted: { zh: '聊得差不多了，来检验一下？', en: 'Nice chat — want to test what stuck?' },
};

/** 亮灯时冒在图标下的短提示（宽屏才显示；很短，宽度只有提灯下方那一小块） */
export const GUIDE_TEASERS: Partial<Record<GuideStage, GuideText>> = {
  nomodel: { zh: '先绑个模型', en: 'Bind a model' },
  fresh: { zh: '不知聊啥？点我', en: 'Need a topic?' },
  chatted: { zh: '来套题检验下？', en: 'Quiz time?' },
  quizzed: { zh: '做完了，看解析', en: 'See the walkthrough' },
};

export function guideTeaser(stage: GuideStage, lang: GuideLang): string | null {
  return GUIDE_TEASERS[stage]?.[lang] ?? null;
}

/** 内置的随机话题（规则推荐用；AI 推荐时由模型现想一个）。每条本身就是一句能直接发出去的话 */
export const GUIDE_TOPICS: readonly GuideText[] = [
  { zh: '用一个生活里的例子，讲讲什么是「复利」', en: 'Use an everyday example to explain compound interest' },
  { zh: '为什么天空是蓝色的？用最直白的话讲给我听', en: 'Why is the sky blue? Explain it in plain words' },
  { zh: '教我一个五分钟就能学会的学习方法', en: 'Teach me a study technique I can learn in five minutes' },
  { zh: '讲一个你觉得最反直觉的科学事实，并解释为什么', en: "Tell me the most counter-intuitive science fact you know, and why it's true" },
  { zh: '什么是费曼学习法？怎么用它学一个新概念？', en: 'What is the Feynman technique, and how do I use it on a new concept?' },
  { zh: '随便挑一个计算机基础概念，用比喻讲给我听', en: 'Pick a basic computer-science idea and explain it with a metaphor' },
  { zh: '挑一个改变了世界的小发明，讲讲它的故事', en: 'Pick one small invention that changed the world and tell its story' },
  { zh: '为什么我们会遗忘？有什么办法记得更牢？', en: 'Why do we forget, and how can I remember better?' },
  { zh: '讲讲黑洞：从零开始，不用公式', en: 'Explain black holes from scratch, no formulas' },
  { zh: '帮我理解「概率」：抛硬币为什么不能预测下一次？', en: "Help me understand probability: why can't a coin flip be predicted?" },
  { zh: '挑一个有趣的心理学效应，讲讲它怎么影响日常决定', en: 'Pick an interesting psychology effect and show how it shapes daily choices' },
  { zh: '如果只能记住一条写作技巧，你会教我哪一条？', en: 'If I could remember only one writing tip, which would you teach me?' },
];
