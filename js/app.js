/* ==========================================================================
   ポートフォリオのフロントエンド。
   data/notion_data.json（Notion = ヘッドレス CMS）と
   data/github_data.json（GitHub API）を読み込んで描画する。
   ビルドは不要で、静的ホスティングのまま動く。
   ========================================================================== */

'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* --- テーマ ------------------------------------------------------------- */
const Theme = {
  get() { return document.documentElement.getAttribute('data-theme') || 'light'; },
  set(v) {
    document.documentElement.setAttribute('data-theme', v);
    try { localStorage.setItem('theme', v); } catch (e) { /* noop */ }
    document.dispatchEvent(new CustomEvent('themechange'));
  },
  toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); }
};

$('#theme-toggle').addEventListener('click', () => Theme.toggle());

/** CSS 変数の実値を取得する（Chart.js は CSS 変数を解釈できないため） */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** rgba 文字列を作る（16進カラー + 不透明度） */
function alpha(hex, a) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(n, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${a})`;
}

/* --- 汎用ヘルパー ------------------------------------------------------- */
const toYear = v => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 1900 ? n : null;
};

const escapeHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 本人の氏名を太字にする（Notion 側は素のテキストで持っているため表示側で装飾） */
const NAME_PATTERNS = ['熊谷将也', '熊谷 将也', 'Masaya Kumagai', 'M. Kumagai', 'M.Kumagai'];
function emphasizeName(html) {
  let out = html || '';
  for (const p of NAME_PATTERNS) {
    out = out.split(p).join(`<b>${p}</b>`);
  }
  return out;
}

/** Notion 由来の HTML から href="..." を素の状態でも安全に外部リンク化する */
function normalizeLinks(html) {
  return (html || '').replace(/<a\s+href=([^\s>]+)([^>]*)>/gi, (m, href, rest) => {
    const clean = href.replace(/^['"]|['"]$/g, '');
    if (!/^https?:\/\//i.test(clean)) return m;
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">`;
  });
}

const fmt = n => (n ?? 0).toLocaleString('ja-JP');

/** 淡色の下限。ダークでは薄すぎると背景に沈むため強めにする */
const softAlpha = () => (Theme.get() === 'dark' ? 0.62 : 0.42);

/* --- 発表カテゴリの正規化 ------------------------------------------------ */
// Notion 側の表記ゆれ（国際会議 / 国際学会）を吸収する
function presScope(cat) { return String(cat || '').startsWith('国内') ? '国内' : '国際'; }

/**
 * 発表形式。Notion には Category（グルーピング用）と Type（Oral / Poster）の
 * 両方があり、まれに食い違うため実値である Type を優先する。
 */
function presForm(item) {
  const t = String(item?.type || '');
  if (/poster/i.test(t)) return 'ポスター';
  if (/oral/i.test(t)) return '口頭';
  return String(item?.category || '').includes('ポスター') ? 'ポスター' : '口頭';
}



/* --- 研究テーマ（キーワード）の抽出 -------------------------------------- */
// 論文・学会発表のタイトルと OSS の説明 / topics を突き合わせて上位テーマを出す。
// タイトルは日英・略称が混ざるので、正規表現で 1 つの概念に寄せる。
// 新しい分野に踏み出したらここに 1 行足せば、以降は自動で順位に反映される。
const TOPIC_RULES = [
  [/materials informatics|マテリアルズ ?インフォマティクス/i,       'Materials Informatics'],
  [/thermoelectric|熱電/i,                                          'Thermoelectrics'],
  [/machine learning|deep learning|neural network|機械学習|深層学習/i, 'Machine Learning'],
  [/large language model|\bLLM\b|大規模言語モデル|\bGPT\b/i,          'LLM'],
  [/provenance|PROV-?(DM|O)\b|来歴/i,                               'Provenance'],
  [/starrydata/i,                                                   'Starrydata'],
  [/database|dataset|データベース|データセット/i,                   'Database'],
  [/curation|キュレーション|データ収集|データ整備/i,                 'Data Curation'],
  [/nuclear|uranium|原子力|核燃料|原子炉/i,                          'Nuclear Materials'],
  [/thermal conductivity|熱伝導/i,                                  'Thermal Conductivity'],
  [/crystal structure|結晶構造/i,                                   'Crystal Structure'],
  [/\bMCP\b|model context protocol/i,                               'MCP'],
  [/knowledge (management|graph)|ナレッジ|知識グラフ|zettelkasten/i,  'Knowledge Management'],
  [/\bRDF\b|SPARQL|linked data|semantic web|ontolog|オントロジー/i,   'Semantic Web / RDF'],
  [/web (system|application|app|site)|webシステム|webアプリ|webサイト|self-?host/i, 'Web Development'],
  [/synthesis|合成/i,                                               'Materials Synthesis'],
  [/visuali[sz]|可視化/i,                                           'Visualization'],
  [/skutterudite|clathrate|half-?heusler|クラスレート/i,             'Functional Materials'],
];

/** 業績と OSS を走査して、重み付きスコアの高いテーマを返す */
function extractTopics(limit = 10) {
  // 論文と OSS の topics は本人が明示的に付けた情報なので重みを大きくする
  const docs = [];
  (DATA.notion['Publications '] || []).forEach(p => p.title && docs.push({ t: p.title, w: 3 }));
  (DATA.notion['Presentations'] || []).forEach(p => p.title && docs.push({ t: p.title, w: 2 }));
  (DATA.github?.repos || []).forEach(r => {
    if (r.description) docs.push({ t: r.description, w: 2 });
    (r.topics || []).forEach(t => docs.push({ t: t.replace(/-/g, ' '), w: 3 }));
  });

  const stats = new Map();
  docs.forEach(d => {
    // 同じ文書内で同じテーマを二重に数えない
    const hits = new Set();
    TOPIC_RULES.forEach(([re, label]) => { if (re.test(d.t)) hits.add(label); });
    hits.forEach(label => {
      const cur = stats.get(label) || { score: 0, count: 0 };
      stats.set(label, { score: cur.score + d.w, count: cur.count + 1 });
    });
  });

  return Array.from(stats.entries())
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* --- 発表先・投稿先の正規化 --------------------------------------------- */
// Notion に入っている学会名は「第21回日本熱電学会学術講演会(TSJ2024)」のように
// 回数や略称を含み表記もゆれるため、学会コミュニティ単位に寄せる。
// 上から順に最初にマッチしたものを採用する（順序に意味がある）。
const VENUE_RULES = [
  [/熱電学会|TSJ/,                                  '日本熱電学会'],
  [/Thermoelectric|ICT ?\/ ?ECT|ICT ?20|ECT ?20/i,  '国際熱電会議 (ICT/ECT/ACT)'],
  [/応用物理学会|JSAP/,                             '応用物理学会'],
  [/原子力学会|Atomic Energy Society/i,             '日本原子力学会'],
  [/金属学会|Materials Transactions/i,              '日本金属学会'],
  // 「TMS2025」のように略称と年が続くため \b では拾えない
  [/TMS ?\d|\bTMS\b|Minerals, ?Metals and Materials Society/i, 'TMS'],
  [/熱物性/,                                        '日本熱物性学会'],
  [/\bMRS\b|MRM|IUMRS|Materials Research Society/i, 'MRS / MRM / IUMRS'],
  [/情報処理学会|IPSJ|インターネットと運用技術|IOT|ITRC|情報(科学)?技術フォーラム|FIT ?\d|\bFIT\b/,
                                                    '情報処理学会系 (IPSJ / IOT)'],
  [/人工知能学会|JSAI/,                             '人工知能学会'],
  [/粉体|粉末冶金/,                                 '粉体粉末冶金協会'],
  [/電気関係学会関西連合/,                          '電気関係学会関西連合大会'],
  [/MGE|Materials Genome/i,                        'MGE (Materials Genome)'],
  [/MaDIS|NIMS/,                                   'NIMS / MaDIS'],
];

// 略称と正式名で二重に数えないためのジャーナル名の寄せ
const JOURNAL_ALIASES = [
  [/^J\. ?Nucl\. ?Sci\. ?Technol|Journal of Nuclear Science and Technology/i,
   'J. Nuclear Science and Technology'],
  [/^Chem\. ?Mater/i,                'Chemistry of Materials'],
  [/Materials transactions/i,        'Materials Transactions'],
];

/** 学会名を学会コミュニティ名に寄せる */
function venueOf(event) {
  const e = String(event || '').trim();
  if (!e) return null;
  for (const [re, label] of VENUE_RULES) {
    if (re.test(e)) return label;
  }
  return 'その他';
}

/** 掲載誌名を正規化する */
function journalOf(journal) {
  const j = String(journal || '').trim();
  if (!j) return null;
  for (const [re, label] of JOURNAL_ALIASES) {
    if (re.test(j)) return label;
  }
  return j;
}

/* ========================================================================== */

const charts = {};
// 年別コントリビューションの軸。桁が違いすぎるため既定は対数
let ghYearLogScale = true;
let DATA = { notion: null, github: null };

Promise.all([
  fetch('./data/notion_data.json').then(r => r.json()).catch(() => null),
  fetch('./data/github_data.json').then(r => r.json()).catch(() => null),
]).then(([notion, github]) => {
  DATA.notion = notion || {};
  DATA.github = github || null;
  render();
});

function render() {
  renderHero();
  renderKpis();
  renderGithub();
  renderCareer();
  renderLists();
  renderContact();
  buildCharts();
  setupNavHighlight();

  $('#year').textContent = new Date().getFullYear();
  if (DATA.github?.generated_at) {
    const d = new Date(DATA.github.generated_at);
    $('#updated').textContent = `最終更新: ${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  document.addEventListener('themechange', () => {
    Object.values(charts).forEach(c => c && c.destroy());
    buildCharts();
    renderHeatmap();
  });

  // ヒートマップはセル幅をコンテナの実寸から決めるので、幅が変わったら描き直す
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHeatmap, 150);
  });
}

/* --- ヒーロー ----------------------------------------------------------- */
function renderHero() {
  const profile = DATA.notion['Profile'] || [];

  if (DATA.github?.user?.avatar_url) {
    const img = $('#avatar');
    img.src = DATA.github.user.avatar_url;
    img.alt = '熊谷将也のプロフィール画像';
  }

  // 所属：1 行目が期間、以降が組織名（Notion の書式に合わせて分解する）
  const affil = profile.filter(p => p.category === '所属').map(p => {
    const lines = String(p.text).split('\n');
    const period = lines[0].replace(/<[^>]+>/g, '').trim();
    const body = normalizeLinks(lines.slice(1).join(' ')).replace(/<\/li>/g, '');
    return { period, body: body || period };
  });
  $('#affiliations').innerHTML = affil.map(a =>
    `<li><span class="period">${escapeHtml(a.period)}</span><strong>${a.body}</strong></li>`
  ).join('');

  // リンク：Notion の「リンク」カテゴリ + GitHub + Contact の SNS
  const linkHtml = [];
  if (DATA.github?.user?.html_url) {
    linkHtml.push(`<a class="pill" href="${DATA.github.user.html_url}" target="_blank" rel="noopener noreferrer"><svg><use href="#i-github"/></svg>GitHub</a>`);
  }
  profile.filter(p => p.category === 'リンク').forEach(p => {
    const m = normalizeLinks(p.text).match(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/i);
    if (m) linkHtml.push(`<a class="pill" href="${m[1]}" target="_blank" rel="noopener noreferrer"><svg><use href="#i-link"/></svg>${escapeHtml(m[2].replace(/<[^>]+>/g, ''))}</a>`);
  });
  (DATA.notion['Contact'] || []).forEach(c => {
    const m = normalizeLinks(c.text).match(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/i);
    if (m) linkHtml.push(`<a class="pill" href="${m[1]}" target="_blank" rel="noopener noreferrer"><svg><use href="#i-link"/></svg>${escapeHtml(c.category)}</a>`);
  });
  $('#links').innerHTML = linkHtml.join('');

  renderTopics();
}

/** 主な研究テーマのタグ。スコアの高い順に濃くする */
function renderTopics() {
  const topics = extractTopics(10);
  if (!topics.length) { $('#topics-wrap').style.display = 'none'; return; }

  const max = topics[0].score;
  $('#topics').innerHTML = topics.map(t => {
    // 上位ほど濃く。0.22〜1.0 の範囲に収めて薄すぎる帯を作らない
    const w = 0.22 + 0.78 * (t.score / max);
    return `<span class="topic" style="--topic-w:${w.toFixed(2)}" title="${t.count} 件の業績・OSS に登場">` +
      `${escapeHtml(t.label)}<i>${t.count}</i></span>`;
  }).join('');
}

/* --- KPI ---------------------------------------------------------------- */
function renderKpis() {
  const n = DATA.notion;
  const pubs = n['Publications '] || [];
  const pres = n['Presentations'] || [];
  const awards = n['Awards'] || [];
  const gh = DATA.github;

  const firstAuthor = pubs.filter(p => p.first).length;
  const intl = pres.filter(p => presScope(p.category) === '国際').length;

  const items = [
    { v: pubs.length, label: 'Publications', sub: `筆頭著者 ${firstAuthor} 件`, color: 'var(--c-pub)' },
    { v: pres.length, label: 'Presentations', sub: `うち国際 ${intl} 件`, color: 'var(--c-pres)' },
    { v: awards.length, label: 'Awards', sub: '受賞', color: 'var(--c-award)' },
    { v: gh ? gh.totals.repos : '–', label: 'OSS Repos', sub: gh ? `${gh.languages.length} 言語` : '', color: 'var(--c-oss)' },
    { v: gh ? gh.totals.contributions : '–', label: 'Contributions', sub: 'GitHub 累計', color: 'var(--c-art)' },
  ];

  $('#kpis').innerHTML = items.map(i => `
    <div class="kpi" style="--kpi-color:${i.color}">
      <div class="kpi-value">${typeof i.v === 'number' ? fmt(i.v) : i.v}</div>
      <div class="kpi-label">${i.label}</div>
      <div class="kpi-sub">${i.sub}</div>
    </div>`).join('');
}

/* --- GitHub ------------------------------------------------------------- */
const LANG_COLORS = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Vue: '#41b883',
  HTML: '#e34c26', CSS: '#563d7c', 'Jupyter Notebook': '#DA5B0B', 'C++': '#f34b7d',
  Dockerfile: '#384d54', Shell: '#89e051', Rust: '#dea584', Go: '#00ADD8',
};
const langColor = l => LANG_COLORS[l] || '#8b95a8';

function renderGithub() {
  const gh = DATA.github;
  if (!gh) {
    $('#oss').style.display = 'none';
    return;
  }

  const y = gh.contributions.yearly || [];
  const thisYear = y.length ? y[y.length - 1] : null;
  if (thisYear) {
    $('#gh-summary').textContent =
      `公開リポジトリ ${gh.totals.repos} 件、累計 ${fmt(gh.totals.contributions)} コントリビューション。` +
      `${thisYear.year} 年だけで ${fmt(thisYear.total)} 件（コミット ${fmt(thisYear.commits)} / PR ${fmt(thisYear.pull_requests)}）。`;
  }

  // 説明のあるものを「主要」として先に出し、残りは折りたたむ
  const major = gh.repos.filter(r => r.description);
  const minor = gh.repos.filter(r => !r.description);

  const card = (r, minorFlag) => `
    <a class="card repo${minorFlag ? ' is-minor' : ''}" href="${r.html_url}" target="_blank" rel="noopener noreferrer">
      <div class="repo-name"><svg><use href="#i-repo"/></svg>${escapeHtml(r.name)}</div>
      ${r.description ? `<p class="repo-desc">${escapeHtml(r.description)}</p>` : ''}
      ${r.topics?.length ? `<div class="repo-topics">${r.topics.slice(0, 5).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="repo-meta">
        ${r.language ? `<span><i class="dot" style="background:${langColor(r.language)}"></i>${escapeHtml(r.language)}</span>` : ''}
        ${r.stars ? `<span><svg style="width:12px;height:12px;margin-right:4px"><use href="#i-star"/></svg>${r.stars}</span>` : ''}
        <span class="spacer">${escapeHtml(r.pushed_at)}</span>
      </div>
    </a>`;

  $('#repos').innerHTML = major.map(r => card(r, false)).join('');

  if (minor.length) {
    const btn = document.createElement('button');
    btn.className = 'more-btn';
    btn.type = 'button';
    btn.textContent = `過去のリポジトリをすべて表示（${minor.length} 件）`;
    btn.addEventListener('click', () => {
      const shown = btn.dataset.shown === '1';
      $('#repos').innerHTML = shown
        ? major.map(r => card(r, false)).join('')
        : gh.repos.map(r => card(r, !r.description)).join('');
      btn.dataset.shown = shown ? '0' : '1';
      btn.textContent = shown
        ? `過去のリポジトリをすべて表示（${minor.length} 件）`
        : '主要リポジトリのみ表示';
    });
    $('#repos').after(btn);
  }

  renderHeatmap();
  setupGhScaleToggle();
}

function renderHeatmap() {
  const cal = DATA.github?.contributions?.calendar || [];
  const el = $('#heatmap');
  if (!cal.length) { $('#heatmap-wrap').style.display = 'none'; return; }

  const GAP_RATIO = 0.27;      // セルに対する隙間の比率
  const TOP = 16, LEFT = 22;   // 月ラベルと曜日ラベルに使う領域

  // 週の先頭（日曜）が列になるようにオフセットを取る
  const firstDow = new Date(cal[0].date + 'T00:00:00').getDay();
  const cols = Math.ceil((firstDow + cal.length) / 7);

  // セルはコンテナの実寸から決める。広い画面では最大 13px まで伸ばし、
  // 狭い画面では 6px まで縮めて 1 年分が切れずに収まるようにする。
  const avail = (el.clientWidth || 0) - LEFT - 2;
  const fit = avail > 0 ? avail / (cols * (1 + GAP_RATIO)) : 11;
  // 下限 3.5px（小さくても濃淡は読めるので、切るより縮める）
  // 上限 16px（広い画面で右に余白を残さず幅を使い切る）
  const CELL = Math.max(3.5, Math.min(16, Math.floor(fit * 10) / 10));
  const GAP = Math.max(0.8, +(CELL * GAP_RATIO).toFixed(1));
  const step = CELL + GAP;

  const w = LEFT + cols * step;
  const h = TOP + 7 * step;
  const max = Math.max(...cal.map(d => d.count), 1);
  const level = c => c === 0 ? 0 : c <= max * 0.08 ? 1 : c <= max * 0.25 ? 2 : c <= max * 0.55 ? 3 : 4;

  let cells = '';
  cal.forEach((d, i) => {
    const idx = firstDow + i;
    const x = LEFT + Math.floor(idx / 7) * step;
    const yy = TOP + (idx % 7) * step;
    cells += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${CELL}" height="${CELL}" ` +
      `rx="${(CELL * 0.22).toFixed(1)}" fill="var(--heat-${level(d.count)})">` +
      `<title>${d.date}: ${d.count} contributions</title></rect>`;
  });

  // 月ラベル。セルが小さいときは間引いて重なりを防ぐ
  const labelEvery = step < 8 ? 3 : step < 10 ? 2 : 1;
  let months = '';
  let lastMonth = -1, shown = 0;
  cal.forEach((d, i) => {
    const dt = new Date(d.date + 'T00:00:00');
    const idx = firstDow + i;
    if (dt.getMonth() !== lastMonth && idx % 7 === 0) {
      lastMonth = dt.getMonth();
      if (shown++ % labelEvery === 0) {
        months += `<text x="${(LEFT + Math.floor(idx / 7) * step).toFixed(1)}" y="11" ` +
          `font-size="9.5" fill="var(--text-muted)">${dt.getMonth() + 1}月</text>`;
      }
    }
  });

  const dowLabels = ['', '月', '', '水', '', '金', '']
    .map((t, i) => t ? `<text x="0" y="${(TOP + i * step + CELL * 0.85).toFixed(1)}" ` +
      `font-size="9.5" fill="var(--text-muted)">${t}</text>` : '')
    .join('');

  // viewBox と width を一致させ、はみ出すぶんだけ CSS 側で横スクロールさせる
  el.innerHTML = `<svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" ` +
    `width="${w.toFixed(1)}" height="${h.toFixed(1)}" role="img" ` +
    `aria-label="直近1年のGitHubコントリビューション">${months}${dowLabels}${cells}</svg>`;

  renderHeatStats(cal);
}

/** ヒートマップの下に置く要約（合計・稼働日・最長連続） */
function renderHeatStats(cal) {
  const total = cal.reduce((a, d) => a + d.count, 0);
  const activeDays = cal.filter(d => d.count > 0).length;

  let streak = 0, best = 0;
  for (const d of cal) {
    streak = d.count > 0 ? streak + 1 : 0;
    if (streak > best) best = streak;
  }
  const busiest = cal.reduce((a, b) => (b.count > a.count ? b : a), cal[0]);

  const stats = [
    ['コントリビューション', fmt(total)],
    ['稼働日', `${activeDays} / ${cal.length} 日`],
    ['最長連続', `${best} 日`],
    ['最も多かった日', `${busiest.date.slice(5).replace('-', '/')}（${fmt(busiest.count)} 件）`],
  ];

  $('#heat-stats').innerHTML = stats.map(([k, v]) =>
    `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

/* --- キャリア年表 -------------------------------------------------------- */
function renderCareer() {
  const profile = DATA.notion['Profile'] || [];
  const bio = profile.filter(p => p.category === '略歴').map(p => normalizeLinks(p.text)).join('');
  $('#bio').innerHTML = bio || '<p class="empty">準備中</p>';

  // 年ごとに 1 行へ集約する。節目（所属・受賞）は固有名詞を残し、
  // 業績は件数だけの圧縮サマリーにする。
  const years = new Map();
  const bucket = y => {
    if (!years.has(y)) {
      years.set(y, { affiliations: [], awards: [], pubs: 0, pres: 0, presIntl: 0, oss: [] });
    }
    return years.get(y);
  };

  // 所属
  profile.filter(p => p.category === '所属').forEach(p => {
    const lines = String(p.text).split('\n');
    const period = lines[0].replace(/<[^>]+>/g, '').trim();
    const yr = toYear((period.match(/(\d{4})/) || [])[1]);
    if (!yr) return;
    const label = normalizeLinks(lines.slice(1).join(' ')).replace(/<\/li>/g, '').trim() || period;
    bucket(yr).affiliations.push({ label, period });
  });

  // 受賞（年が入っていないものは高専ロボコン当時としてまとめる）
  (DATA.notion['Awards'] || []).forEach(a => {
    const yr = toYear(a.year) ?? 2006;
    const label = a.url
      ? `<a href="${a.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title || '')}</a>`
      : escapeHtml(a.title || '');
    bucket(yr).awards.push(label);
  });

  // 論文・学会発表は件数のみ
  (DATA.notion['Publications '] || []).forEach(p => {
    const yr = toYear(p.year);
    if (yr) bucket(yr).pubs += 1;
  });
  (DATA.notion['Presentations'] || []).forEach(p => {
    const yr = toYear(p.year);
    if (!yr) return;
    const b = bucket(yr);
    b.pres += 1;
    if (presScope(p.category) === '国際') b.presIntl += 1;
  });

  // OSS は公開年ごとのリポジトリ名
  (DATA.github?.repos || []).forEach(r => {
    const yr = toYear(r.created_at?.slice(0, 4));
    if (yr) bucket(yr).oss.push(r.name);
  });

  const rows = Array.from(years.entries()).sort((a, b) => b[0] - a[0]);

  $('#timeline').innerHTML = rows.map(([year, v]) => {
    // 節目：所属と受賞。これがある年はドットを強調する
    const milestones = [
      ...v.affiliations.map(a => `${a.label}<span class="tl-period">${escapeHtml(a.period)}</span>`),
      ...v.awards.map(a => `${a}<span class="tl-period">受賞</span>`),
    ];

    const metrics = [
      v.pubs && ['論文', `${v.pubs} 本`, 'var(--c-pub)'],
      v.pres && ['発表', v.presIntl ? `${v.pres} 件（国際 ${v.presIntl}）` : `${v.pres} 件`, 'var(--c-pres)'],
      v.oss.length && ['OSS', `${v.oss.length} 本`, 'var(--c-oss)'],
    ].filter(Boolean);

    const color = milestones.length ? 'var(--accent)' : 'var(--text-muted)';

    return `
    <div class="tl-item" style="--tl-color:${color}">
      <div class="tl-year">${year}</div>
      ${milestones.length ? `<div class="tl-title">${milestones.join('')}</div>` : ''}
      ${metrics.length ? `<div class="tl-metrics">${metrics.map(([k, val, c]) =>
        `<span class="tl-metric" style="--m-color:${c}"><b>${k}</b>${val}</span>`).join('')}</div>` : ''}
      ${v.oss.length ? `<div class="tl-desc">${escapeHtml(summarize(v.oss, '本'))}</div>` : ''}
    </div>`;
  }).join('');
}

/** 重複を除いて先頭 3 件だけ並べ、残りは「他 N 誌」とする */
function summarize(values, unit, limit = 3) {
  const uniq = Array.from(new Set(values));
  const head = uniq.slice(0, limit).join(' / ');
  return uniq.length > limit ? `${head} 他 ${uniq.length - limit} ${unit}` : head;
}

/* --- 一覧 --------------------------------------------------------------- */
function entryHtml(item, opts = {}) {
  const badges = [];
  let color = opts.color || 'var(--border-strong)';

  // 学会発表は「国内 / 国際」を左のバーの色に、「口頭 / ポスター」をバッジに割り当てる
  if (opts.kind === 'presentation' && item.category) {
    const scope = presScope(item.category);
    const form = presForm(item);
    color = scope === '国際' ? 'var(--c-pub)' : 'var(--c-pres)';
    badges.push(`<span class="badge is-scope-${scope === '国際' ? 'intl' : 'dom'}">${scope}</span>`);
    badges.push(`<span class="badge is-form-${form === 'ポスター' ? 'poster' : 'oral'}">${form}</span>`);
  }

  if (item.invited) badges.push('<span class="badge is-invited">Invited</span>');
  if (item.first) badges.push('<span class="badge is-first">First author</span>');

  const text = emphasizeName(normalizeLinks(item.text || ''));
  return `<li class="entry" style="--entry-color:${color}">` +
    `${badges.length ? `<span class="badge-row">${badges.join('')}</span>` : ''}${text}</li>`;
}

/** 年でグルーピングして描画する */
function renderYearGroups(container, items, color, kind) {
  const groups = {};
  items.forEach(i => { (groups[toYear(i.year) ?? '—'] ||= []).push(i); });
  const years = Object.keys(groups).sort((a, b) => (b === '—' ? -1 : a === '—' ? 1 : b - a));

  if (!items.length) { container.innerHTML = '<p class="empty">該当する項目がありません。</p>'; return; }

  container.innerHTML = years.map(y => `
    <div class="year-group">
      <div class="year-label">${y}</div>
      <ul class="entry-list">${groups[y].map(i => entryHtml(i, { color, kind })).join('')}</ul>
    </div>`).join('');
}

function renderLists() {
  const n = DATA.notion;

  const pubs = n['Publications '] || [];
  $('#count-pub').textContent = `(${pubs.length})`;
  renderYearGroups($('#list-pub'), pubs, 'var(--c-pub)');

  // 学会発表：カテゴリで絞り込めるようにする
  const pres = n['Presentations'] || [];
  $('#count-pres').textContent = `(${pres.length})`;
  const cats = ['すべて', ...Array.from(new Set(pres.map(p => p.category).filter(Boolean)))];
  $('#filter-pres').innerHTML = cats.map((c, i) =>
    `<button class="chip${i === 0 ? ' is-active' : ''}" type="button" data-cat="${escapeHtml(c)}">${escapeHtml(c)}` +
    `${i === 0 ? ` (${pres.length})` : ` (${pres.filter(p => p.category === c).length})`}</button>`
  ).join('');
  $('#filter-pres').addEventListener('click', ev => {
    const btn = ev.target.closest('.chip');
    if (!btn) return;
    $$('#filter-pres .chip').forEach(b => b.classList.toggle('is-active', b === btn));
    const cat = btn.dataset.cat;
    renderYearGroups($('#list-pres'), cat === 'すべて' ? pres : pres.filter(p => p.category === cat),
      'var(--c-pres)', 'presentation');
  });
  renderYearGroups($('#list-pres'), pres, 'var(--c-pres)', 'presentation');

  const simple = (sel, items, color) => {
    const el = $(sel);
    el.innerHTML = items.length
      ? items.map(i => entryHtml(i, { color })).join('')
      : '<p class="empty">準備中</p>';
  };
  simple('#list-works', n['Works'] || [], 'var(--c-oss)');
  simple('#list-others', n['Others'] || [], 'var(--text-muted)');
  simple('#list-art', n['Articles'] || [], 'var(--c-art)');
  simple('#list-award', n['Awards'] || [], 'var(--c-award)');
}

/* --- 連絡先 ------------------------------------------------------------- */
function renderContact() {
  const items = DATA.notion['Contact'] || [];
  $('#contact-list').innerHTML = items.map(c => `
    <div class="card contact-item">
      <div class="k">${escapeHtml(c.category || 'Contact')}</div>
      <div class="v">${normalizeLinks(c.text)}</div>
    </div>`).join('');
}

/* --- グラフ ------------------------------------------------------------- */
function chartDefaults() {
  const text = cssVar('--text-secondary');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--border');
  const surface = cssVar('--bg-elevated');
  return { text, muted, grid, surface };
}

function baseOptions(d, extra = {}) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: d.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } }
      },
      tooltip: {
        backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
        borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10,
        cornerRadius: 8, boxPadding: 4, usePointStyle: true,
      }
    },
    scales: {
      x: { stacked: true, grid: { display: false }, border: { color: d.grid }, ticks: { color: d.muted, font: { size: 10.5 } } },
      y: { stacked: true, beginAtZero: true, grid: { color: d.grid }, border: { display: false }, ticks: { color: d.muted, precision: 0, font: { size: 10.5 } } }
    }
  }, extra);
}

function buildCharts() {
  const d = chartDefaults();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  buildOutputChart(d);
  buildPresDoughnut(d);
  buildPresYearChart(d);
  buildLangChart(d);
  buildGithubYearChart(d);
  buildVenueChart(d);
  buildJournalChart(d);
}

/** 参加学会（学会コミュニティ別・国内/国際の積み上げ） */
function buildVenueChart(d) {
  const pres = DATA.notion['Presentations'] || [];
  const byVenue = new Map();
  pres.forEach(p => {
    const v = venueOf(p.event);
    if (!v) return;
    if (!byVenue.has(v)) byVenue.set(v, { 国内: 0, 国際: 0 });
    byVenue.get(v)[presScope(p.category)] += 1;
  });
  if (!byVenue.size) return;

  // 「その他」は内訳が混ざったまとめなので常に末尾へ置く
  const rows = Array.from(byVenue.entries())
    .sort((a, b) => {
      if (a[0] === 'その他') return 1;
      if (b[0] === 'その他') return -1;
      return (b[1].国内 + b[1].国際) - (a[1].国内 + a[1].国際);
    });

  $('#venue-note').textContent =
    `${rows.filter(r => r[0] !== 'その他').length} コミュニティ・のべ ${pres.length} 件`;

  charts.venue = new Chart($('#chart-venue'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r[0]),
      datasets: [
        { label: '国内', data: rows.map(r => r[1].国内), backgroundColor: alpha(cssVar('--c-pres'), .82) },
        { label: '国際', data: rows.map(r => r[1].国際), backgroundColor: cssVar('--c-pub') },
      ].map(ds => Object.assign(ds, { borderRadius: 3, borderSkipped: false, maxBarThickness: 18 }))
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: d.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, cornerRadius: 8, usePointStyle: true,
        }
      },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: d.grid }, border: { display: false }, ticks: { color: d.muted, precision: 0, font: { size: 10.5 } } },
        y: { stacked: true, grid: { display: false }, border: { color: d.grid }, ticks: { color: d.text, font: { size: 11 }, autoSkip: false } }
      }
    }
  });
}

/** 投稿先（掲載誌別・上位のみ） */
function buildJournalChart(d) {
  const pubs = DATA.notion['Publications '] || [];
  const byJournal = new Map();
  pubs.forEach(p => {
    const j = journalOf(p.journal);
    if (!j) return;
    byJournal.set(j, (byJournal.get(j) || 0) + 1);
  });
  if (!byJournal.size) return;

  const all = Array.from(byJournal.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = all.slice(0, 10);

  $('#journal-note').textContent =
    `のべ ${all.length} 誌・会議録${all.length > rows.length ? `（上位 ${rows.length} 件を表示）` : ''}`;

  charts.journal = new Chart($('#chart-journal'), {
    type: 'bar',
    data: {
      labels: rows.map(r => r[0].length > 34 ? r[0].slice(0, 33) + '…' : r[0]),
      datasets: [{
        label: '論文数',
        data: rows.map(r => r[1]),
        backgroundColor: cssVar('--c-pub'),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 18,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, cornerRadius: 8,
          // ラベルは省略表示しているのでツールチップでは正式名を出す
          callbacks: { title: items => rows[items[0].dataIndex][0] }
        }
      },
      scales: {
        x: { beginAtZero: true, grid: { color: d.grid }, border: { display: false }, ticks: { color: d.muted, precision: 0, font: { size: 10.5 } } },
        y: { grid: { display: false }, border: { color: d.grid }, ticks: { color: d.text, font: { size: 11 }, autoSkip: false } }
      }
    }
  });
}

/** 年別アウトプット（積み上げ棒） */
function buildOutputChart(d) {
  const n = DATA.notion;
  const series = [
    { key: 'Publications ', label: '論文', color: cssVar('--c-pub') },
    { key: 'Presentations', label: '学会発表', color: cssVar('--c-pres') },
    { key: 'Articles', label: '記事・解説', color: cssVar('--c-art') },
    { key: 'Awards', label: '受賞', color: cssVar('--c-award') },
  ];

  const years = new Set();
  series.forEach(s => (n[s.key] || []).forEach(i => { const y = toYear(i.year); if (y) years.add(y); }));
  const labels = Array.from(years).sort((a, b) => a - b);

  const datasets = series.map(s => ({
    label: s.label,
    data: labels.map(y => (n[s.key] || []).filter(i => toYear(i.year) === y).length),
    backgroundColor: s.color,
    borderRadius: 3,
    borderSkipped: false,
    maxBarThickness: 30,
  }));

  charts.output = new Chart($('#chart-output'), {
    type: 'bar',
    data: { labels, datasets },
    options: baseOptions(d, {
      plugins: {
        legend: { position: 'bottom', labels: { color: d.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, cornerRadius: 8, usePointStyle: true,
          callbacks: {
            footer: items => `合計 ${items.reduce((a, b) => a + b.parsed.y, 0)} 件`
          }
        }
      }
    })
  });
}

/** 学会発表の内訳（ドーナツ） */
function buildPresDoughnut(d) {
  const pres = DATA.notion['Presentations'] || [];
  const keys = ['国内 / 口頭', '国内 / ポスター', '国際 / 口頭', '国際 / ポスター'];
  const a = softAlpha();
  const colors = [
    alpha(cssVar('--c-pres'), a), cssVar('--c-pres'),
    alpha(cssVar('--c-pub'), a), cssVar('--c-pub'),
  ];
  const counts = keys.map(k => {
    const [scope, form] = k.split(' / ');
    return pres.filter(p => presScope(p.category) === scope && presForm(p) === form).length;
  });

  charts.pres = new Chart($('#chart-pres'), {
    type: 'doughnut',
    data: { labels: keys, datasets: [{ data: counts, backgroundColor: colors, borderColor: cssVar('--bg-elevated'), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { color: d.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, cornerRadius: 8,
          callbacks: {
            label: c => {
              const total = c.dataset.data.reduce((a, b) => a + b, 0);
              return ` ${c.label}: ${c.parsed} 件 (${Math.round(c.parsed / total * 100)}%)`;
            }
          }
        }
      }
    }
  });
}

/** 学会発表の年別推移（国内 / 国際） */
function buildPresYearChart(d) {
  const pres = DATA.notion['Presentations'] || [];
  const years = Array.from(new Set(pres.map(p => toYear(p.year)).filter(Boolean))).sort((a, b) => a - b);
  const mk = (scope, color) => ({
    label: scope,
    data: years.map(y => pres.filter(p => toYear(p.year) === y && presScope(p.category) === scope).length),
    backgroundColor: color, borderRadius: 3, borderSkipped: false, maxBarThickness: 26,
  });

  charts.presYear = new Chart($('#chart-pres-year'), {
    type: 'bar',
    data: { labels: years, datasets: [mk('国内', alpha(cssVar('--c-pres'), .82)), mk('国際', cssVar('--c-pub'))] },
    options: baseOptions(d)
  });
}

/** OSS の使用言語（横棒） */
function buildLangChart(d) {
  const langs = (DATA.github?.languages || []).slice(0, 8);
  if (!langs.length) return;

  charts.lang = new Chart($('#chart-lang'), {
    type: 'bar',
    data: {
      labels: langs.map(l => l.name),
      datasets: [{
        label: 'リポジトリ数',
        data: langs.map(l => l.count),
        backgroundColor: langs.map(l => langColor(l.name)),
        borderColor: cssVar('--border-strong'), borderWidth: 1,
        borderRadius: 4, borderSkipped: false, maxBarThickness: 20,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, cornerRadius: 8,
        }
      },
      scales: {
        x: { beginAtZero: true, grid: { color: d.grid }, border: { display: false }, ticks: { color: d.muted, precision: 0, font: { size: 10.5 } } },
        y: { grid: { display: false }, border: { color: d.grid }, ticks: { color: d.text, font: { size: 11 } } }
      }
    }
  });
}

/**
 * GitHub の年別コントリビューション。
 * 直近が過去の 40 倍以上あり線形では過去が潰れるため既定を対数軸にする。
 * 対数軸では棒の長さが加算的にならないので積み上げは使わない
 * （積み上げたままだと合計の見た目が実際の合計と一致せず誤読を招く）。
 */
function buildGithubYearChart(d) {
  const yearly = (DATA.github?.contributions?.yearly || []).filter(y => y.total > 0);
  if (!yearly.length) return;

  const mk = (label, key, color) => ({
    label, data: yearly.map(y => y[key]), backgroundColor: color,
    borderRadius: 3, borderSkipped: false, maxBarThickness: 22,
  });

  const datasets = [
    mk('コミット', 'commits', cssVar('--c-oss')),
    mk('プルリクエスト', 'pull_requests', cssVar('--c-pub')),
    mk('Issue', 'issues', cssVar('--c-pres')),
    mk('レビュー', 'reviews', cssVar('--c-art')),
  ].filter(ds => ds.data.some(v => v > 0));

  charts.ghYear = new Chart($('#chart-gh-year'), {
    type: 'bar',
    data: { labels: yearly.map(y => y.year), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: d.text, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } } },
        tooltip: {
          backgroundColor: d.surface, titleColor: cssVar('--text'), bodyColor: d.text,
          borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10,
          cornerRadius: 8, usePointStyle: true,
          callbacks: { footer: items => `合計 ${fmt(yearly[items[0].dataIndex].total)} 件` }
        }
      },
      scales: {
        x: { grid: { display: false }, border: { color: d.grid }, ticks: { color: d.muted, font: { size: 10.5 } } },
        y: ghYearLogScale
          ? {
              // 下端を 1 未満にしないと値 1 の年（2013・2024）が高さ 0 で消える
              type: 'logarithmic', min: 0.6,
              grid: { color: d.grid }, border: { display: false },
              // 対数軸の既定は目盛りが多すぎるので 10 のべき乗だけ出す
              ticks: {
                color: d.muted, font: { size: 10.5 },
                callback: v => (Math.log10(v) % 1 === 0 ? fmt(v) : ''),
              }
            }
          : {
              beginAtZero: true, grid: { color: d.grid }, border: { display: false },
              ticks: { color: d.muted, precision: 0, font: { size: 10.5 } }
            }
      }
    }
  });
}

/** 対数 / 線形の切り替え。どちらで読んでいるか分かるようにボタンに出す */
function setupGhScaleToggle() {
  const btn = $('#gh-scale-toggle');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  const sync = () => { btn.textContent = ghYearLogScale ? '対数目盛' : '線形目盛'; };
  sync();
  btn.addEventListener('click', () => {
    ghYearLogScale = !ghYearLogScale;
    sync();
    charts.ghYear?.destroy();
    buildGithubYearChart(chartDefaults());
  });
}

/* --- ナビのハイライト ---------------------------------------------------- */
function setupNavHighlight() {
  const links = $$('#nav a');
  const sections = links
    .map(a => ({ a, el: document.querySelector(a.getAttribute('href')) }))
    .filter(x => x.el);
  if (!sections.length) return;

  let queued = false;
  const update = () => {
    queued = false;
    // 画面上部から 1/3 の位置にある節を「いま読んでいる節」とみなす。
    // ヘッダー直下を基準にすると、前の節の余白が残っている間ズレて見える。
    const line = window.scrollY + window.innerHeight / 3;
    let current = null;
    for (const sec of sections) {
      if (sec.el.getBoundingClientRect().top + window.scrollY <= line) current = sec;
    }
    // 最下部まで来たら最後の節を選ぶ（末尾の節が短いと選ばれないため）
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      current = sections[sections.length - 1];
    }
    links.forEach(a => a.classList.toggle('is-active', !!current && a === current.a));
  };

  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
}
