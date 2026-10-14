import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { checkQuizAnswer, type QuizQuestion, type QuizRoundResponse, type QuizFeedbackResult } from '@sb/shared';
import { QuizQuestionItem } from '../../packages/web/src/features/quiz/QuizQuestionItem';
import { LandingLangProvider } from '../../packages/web/src/app/landing-lang';
import '../../packages/web/src/styles/tokens.css';
import '../../packages/web/src/styles/pixel-ui.css';
import '../../packages/web/src/styles/grimoire-chat.css';
import '../../packages/web/src/features/chat/chat.css';
import '../../packages/web/src/features/quiz/quiz.css';
import '../../packages/web/src/features/quiz/quiz-effects.css';
const q:QuizQuestion={type:'single',question:'执行这段 JavaScript 后，第二次 counter() 返回什么？',material:'```javascript\nfunction makeCounter() {\n  let n = 0;\n  return () => ++n;\n}\nconst counter = makeCounter();\ncounter();\ncounter();\n```',options:['1：每次都从 0 开始','2：两次调用共享同一份 n','undefined：函数已返回','报错：n 已离开作用域'],answer:'1',explanation:'makeCounter 只调用了一次；返回的函数仍能访问同一份词法环境。'};
const draft={picked:[0],fills:[''],essay:''};
const response:QuizRoundResponse={index:0,revision:1,draft,thought:'我把返回的函数和重新调用 makeCounter 混在一起了。能不能先练「哪个步骤创建环境」？',result:checkQuizAnswer(q,draft),grade:null,status:'complete',generation:1,analysis:'### 对照你的思考\n你观察到了 n 从 0 初始化，但初始化发生在 makeCounter() 这一行，只执行一次。后面的 counter() 只是执行已保存的函数。\n\n### 下一步先练什么\n先辨认「创建环境」和「使用环境」，再比较两个独立计数器。这样能把错误定位到具体步骤，而不是只记住答案 2。',analysisReady:true,recorded:true,illustration:null,error:''};
const next:QuizQuestion={type:'single',question:'哪一行创建了计数器自己的 n，而不是只使用已经创建的 n？',material:'```javascript\nfunction makeCounter() {\n  let n = 0;\n  return () => ++n;\n}\n// A\nconst counter = makeCounter();\n// B\ncounter();\n```',options:['A：调用 makeCounter 创建环境','B：每次 counter 都创建新环境'],answer:'0',explanation:'先区分创建和使用，再去比较两个独立计数器。'};
const originalFetch=window.fetch;
window.fetch=async(input,init)=>{
  const path=String(input);
  if(!path.startsWith('/api/')) return originalFetch(input,init);
  await new Promise(resolve=>setTimeout(resolve,160));
  if(path==='/api/quiz/feedback/choices') return Response.json({options:[{id:'a',label:'先练环境创建',description:'先区分创建闭包和调用闭包，再增加难度'},{id:'b',label:'需要对比例子',description:'用两个计数器比较独立环境'}]});
  if(path==='/api/quiz/feedback/adapt') return Response.json({quizId:'demo-adapted',quiz:{title:'按反馈调整：先练环境创建',questions:[next],feedback:{comment:'先练环境创建；先区分创建闭包和调用闭包，再增加难度',adjustment:'减少一步推理，只辨认哪个调用创建环境；原题与思考保留。'}}});
  return Response.json({});
};
function Demo(){
  const [adapted,setAdapted]=useState<QuizFeedbackResult|null>(null);
  return <main className="evidence"><header><small>StudentBuddy · 编程入门 · 隔离演示数据</small><h1>把「答错原因」变成下一题的具体调整</h1><p>实际组件与交互；题目、评价选项和模型回复预置。不代表模型正确率或学习效果评测。</p></header><div className="quiz-card"><div className="quiz-head"><span className="quiz-eyebrow">知识试炼</span>编程入门 · JavaScript 闭包</div><QuizQuestionItem q={q} index={0} topic="JavaScript 闭包" roundResponse={response} onComplete={()=>{}} onAdapted={setAdapted} /></div>{adapted&&<div className="quiz-card"><div className="quiz-head">{adapted.quiz.title}</div><div className="quiz-adaptation"><p><b>你的评价：</b>{adapted.quiz.feedback?.comment}</p><p><b>本题调整：</b>{adapted.quiz.feedback?.adjustment}</p></div><QuizQuestionItem q={next} index={0} onComplete={()=>{}} /></div>}</main>;
}
createRoot(document.getElementById('root')!).render(<LandingLangProvider><Demo/></LandingLangProvider>);
