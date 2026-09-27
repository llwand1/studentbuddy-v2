import { useLandingLang } from './landing-lang';
import './landing-continent.css';

const COPY = {
  title: { zh: '知识大陆', en: 'Knowledge continent' },
  note: { zh: '玩法示意 · 你的地图由自己的词条构成', en: 'Illustrated view · your own terms shape your map' },
  labels: {
    light: { zh: '光合作用', en: 'Photosynthesis' },
    cell: { zh: '细胞', en: 'Cells' },
    energy: { zh: '能量', en: 'Energy' },
    player: { zh: '从这里出发', en: 'Start here' },
    review: { zh: '遇见复习怪物', en: 'A review awaits' },
  },
  steps: [
    { no: '01', title: { zh: '知识长成地块', en: 'Ideas become land' }, desc: { zh: '学习留下的词条，铺成可以探索的地图。', en: 'Terms from your learning form an explorable map.' } },
    { no: '02', title: { zh: '用理解收复领地', en: 'Reclaim with understanding' }, desc: { zh: '到期复习化成怪物，答题让知识重新清晰。', en: 'Due reviews become monsters. Answer to reclaim their tiles.' } },
    { no: '03', title: { zh: '带上你的学习伙伴', en: 'Bring a learning partner' }, desc: { zh: '创建 AI 伙伴，聊知识、接求救单、交换卡牌。', en: 'Create AI partners, talk through ideas, take requests and trade cards.' } },
  ],
};

/** 首屏玩法示意，明确标注，不能冒充用户地图或真实战绩。 */
export function LandingContinent() {
  const { lang } = useLandingLang();
  const label = COPY.labels;
  return <figure className="landing-continent" aria-label={COPY.title[lang]}>
    <div className="lc-window"><span aria-hidden="true">▣</span><strong>{COPY.title[lang]}</strong><span className="lc-window-tag">EXPLORE / LEARN</span></div>
    <svg className="lc-map" viewBox="0 0 560 320" role="img" aria-label={COPY.note[lang]} shapeRendering="crispEdges">
      <rect width="560" height="320" fill="#dce9e9" />
      <path d="M0 40H560M0 80H560M0 120H560M0 160H560M0 200H560M0 240H560M0 280H560M40 0V320M80 0V320M120 0V320M160 0V320M200 0V320M240 0V320M280 0V320M320 0V320M360 0V320M400 0V320M440 0V320M480 0V320M520 0V320" stroke="#ccddde" />
      <path d="M60 108H100V68H260V88H420V128H480V248H440V280H280V260H120V228H60Z" fill="#849773" />
      <path d="M60 96H100V56H260V76H420V116H480V236H440V268H280V248H120V216H60Z" fill="#b8cf91" stroke="#607753" strokeWidth="4" />
      <path d="M100 136H440V176H180V216H140V176H100Z" fill="#e8d7aa" />
      <path d="M300 96V236H340V96Z" fill="#e8d7aa" />
      <path d="M105 64V128M185 64V128M265 88V128M345 88V128M425 128V228M105 184V208M185 184V240M265 184V240M345 184V260M100 96H400M80 196H140M195 216H425" stroke="#9ab47c" strokeWidth="2" />
      <g fill="#73995d"><path d="M80 98h8v-8h8v8h8v8H80ZM370 209h8v-8h8v8h8v8h-24ZM232 231h8v-8h8v8h8v8h-24Z" /></g>
      <g className="lc-hero-marker"><path d="M151 136v-8h20v8h8v24h-8v8h-20v-8h-8v-24Z" fill="#7854aa" stroke="#463660" strokeWidth="3" />
        <rect x="151" y="140" width="5" height="6" fill="#fff8df" /><rect x="165" y="140" width="5" height="6" fill="#fff8df" />
      </g>
      <g className="lc-monster"><path d="M303 147v-8h26v8h8v20h-8v7h-26v-7h-8v-20Z" fill="#d6965e" stroke="#89582f" strokeWidth="3" />
        <rect x="304" y="150" width="5" height="5" fill="#423527" /><rect x="324" y="150" width="5" height="5" fill="#423527" /><path d="M308 164h16" stroke="#423527" strokeWidth="3" />
      </g>
      <g fill="#f9f6e9" stroke="#758169" strokeWidth="2"><rect x="116" y="75" width="130" height="30" /><rect x="356" y="94" width="74" height="30" /><rect x="211" y="206" width="76" height="30" /></g>
      <g fill="#344333" fontSize="13" textAnchor="middle" fontFamily="system-ui,sans-serif" shapeRendering="auto">
        <text x="181" y="95">{label.light[lang]}</text><text x="393" y="114">{label.cell[lang]}</text><text x="249" y="226">{label.energy[lang]}</text>
      </g>
      <path d="M60 28h12m-6-6v12M482 55h12m-6-6v12M497 265h12m-6-6v12" stroke="#6c989d" strokeWidth="3" />
      <g fill="#334435" fontSize="12" fontFamily="system-ui,sans-serif" shapeRendering="auto">
        <text x="99" y="194">{label.player[lang]}</text><text x="298" y="194">{label.review[lang]}</text>
      </g>
    </svg>
    <figcaption>{COPY.note[lang]}</figcaption>
    <ol className="lc-steps">{COPY.steps.map((step) => <li key={step.no}>
      <span>{step.no}</span><div><strong>{step.title[lang]}</strong><p>{step.desc[lang]}</p></div>
    </li>)}</ol>
  </figure>;
}
