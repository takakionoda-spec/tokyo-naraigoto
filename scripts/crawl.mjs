/**
 * TOKYO習い事.com 自動クローラ
 * GitHub Actions から10日毎に実行される。
 *
 * 流れ:
 *   1. data/sources.json のURLを巡回し、本文テキストを抽出
 *   2. Gemini(無料枠) に渡し、教室情報を構造化JSONで抽出
 *      （エリア/カテゴリ判定・ニーズタグ付与・200字紹介文の生成）
 *   3. 既存データと重複排除して src/data/classrooms.json に追記
 *
 * 必要な環境変数: GEMINI_API_KEY（https://aistudio.google.com で無料発行）
 * 依存パッケージ: なし（Node 20+ 標準のfetchのみ）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(ROOT, 'src/data/classrooms.json');
const SOURCES_PATH = path.join(ROOT, 'data/sources.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 15); // 1回の実行で増やす上限
const MAX_CHARS_PER_PAGE = 18000;

const AREAS = ['wangan', 'setagaya', 'nerima'];
const CATEGORIES = ['learning', 'language', 'sports', 'other'];
const NICHES = ['international', 'sports', 'juken'];

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY が未設定です。GitHub Secrets に登録してください。');
  process.exit(1);
}

// ---------- ユーティリティ ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTMLから本文らしきテキストを抽出（script/style除去 → タグ除去 → 空白整理） */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS_PER_PAGE);
}

/** robots.txt の Disallow を簡易チェック（User-agent: * のみ対象） */
async function isAllowedByRobots(url) {
  try {
    const u = new URL(url);
    const res = await fetch(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return true;
    const txt = await res.text();
    let applies = false;
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (/^user-agent:\s*\*/i.test(line)) applies = true;
      else if (/^user-agent:/i.test(line)) applies = false;
      else if (applies) {
        const m = line.match(/^disallow:\s*(\S*)/i);
        if (m && m[1] && u.pathname.startsWith(m[1])) return false;
      }
    }
    return true;
  } catch {
    return true; // robots.txt取得失敗時は許可扱い（タイムアウト等）
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TokyoNaraigotoBot/1.0 (+https://tokyo-naraigoto.com; local kids-lesson portal)' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text());
}

/** 教室名の正規化キー（重複判定用） */
const nameKey = (name) =>
  name.replace(/[\s　・,、。．.\-–—()（）「」『』]/g, '').toLowerCase();

const slugify = (name, area) => {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = [...name].reduce((h, ch) => ((h * 31 + ch.codePointAt(0)) >>> 0), 0).toString(36);
  return `${area}-${ascii || 'classroom'}-${hash}`.slice(0, 64);
};

// ---------- Gemini ----------
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.log(`  Gemini rate limit。${attempt * 30}秒待機...`);
        await sleep(attempt * 30000);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Geminiの応答が空です');
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(5000 * attempt);
    }
  }
}

function buildPrompt(pageText, sourceUrl, areaHint) {
  return `あなたは東京の子ども向け習い事ポータル「TOKYO習い事.com」のデータ整備担当です。
以下のWebページ本文から、0歳〜12歳の子ども向け「習い事教室・スクール・塾」の情報を抽出し、JSON配列で出力してください。
教室情報が見つからない場合は空配列 [] を返してください。広告・求人・大人向け講座は除外してください。

【最重要ルール】出力の単位は「教室・スクール・施設」であり、「クラス・コース・レベル・曜日・学年区分」ではありません。
- 同一の教室/スクール/施設が複数のクラスやコース（例: ベビー/幼児/初級/中級/選手、月曜クラス/水曜クラス）を持つ場合、必ず1件にまとめること
- 例: スイミングスクールに「親子ベビー」「幼児」「アドバンス」があっても出力は「○○スイミングスクール」1件のみ。コース構成はdescriptionの中で要約する
- 1つの総合スポーツクラブ内に水泳・ダンス・体操など明確に異なる競技スクールが併設されている場合のみ、競技単位で分けてよい（最大でも3件まで）
- 1ページからの出力は最大5件まで

各要素のスキーマ（全フィールド必須）:
{
  "name": "教室・スクールの正式名称（施設名を含む。例: 'スポーツクラブNAS勝どき キッズスイムスクール'。'幼児クラス'のようなコース名単体は不可）",
  "area": "${AREAS.join(' | ')} のいずれか。湾岸=豊洲/勝どき/有明/月島/晴海/東雲など中央区・江東区湾岸部、setagaya=世田谷区、nerima=練馬区。判定根拠の住所・駅名がなければエリアヒント "${areaHint}" を使う。3エリア外の教室は出力しない",
  "category": "${CATEGORIES.join(' | ')} のいずれか。learning=学習塾・知育・プログラミング・そろばん等の学び、language=英語等の語学、sports=スポーツ、other=音楽・アート等その他",
  "niche": "[${NICHES.join(', ')}] から該当するものの配列（なければ[]）。international=インターナショナルスクールに通う/目指す家庭向き、sports=スポーツでのびのび育てたい家庭向き、juken=中学受験を予定・検討中の家庭向き",
  "address": "住所（番地まで不明なら町名まで）",
  "station": "最寄り駅と徒歩分数（不明なら最寄り駅のみ、それも不明なら'要問い合わせ'）",
  "ages": "対象年齢（例: '3歳〜小学6年生'。不明なら'要問い合わせ'）",
  "price": "料金の目安（不明なら'要問い合わせ'）",
  "description": "保護者向けの紹介文。教室の特徴・強み・どんな家庭に向くかを、ページ本文の事実のみに基づいて日本語180〜220文字で書く。誇張や創作は禁止",
  "url": "教室の公式URL（不明なら出典ページのURL '${sourceUrl}'）"
}

出典ページURL: ${sourceUrl}

--- ページ本文 ---
${pageText}`;
}

function validate(item) {
  return (
    item &&
    typeof item.name === 'string' && item.name.length >= 2 &&
    AREAS.includes(item.area) &&
    CATEGORIES.includes(item.category) &&
    Array.isArray(item.niche) && item.niche.every((n) => NICHES.includes(n)) &&
    typeof item.description === 'string' && item.description.length >= 50
  );
}

// ---------- メイン ----------
async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const { sources } = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const existingKeys = new Set(db.map((c) => nameKey(c.name)));
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;

  for (const src of sources) {
    if (added >= MAX_NEW_PER_RUN) break;
    console.log(`\n▶ ${src.url}`);
    try {
      if (!(await isAllowedByRobots(src.url))) {
        console.log('  robots.txt により巡回をスキップ');
        continue;
      }
      const text = await fetchPage(src.url);
      if (text.length < 200) {
        console.log('  本文が短すぎるためスキップ');
        continue;
      }
      const items = await callGemini(buildPrompt(text, src.url, src.areaHint || 'wangan'));
      if (!Array.isArray(items)) {
        console.log('  応答が配列でないためスキップ');
        continue;
      }
      for (const item of items) {
        if (added >= MAX_NEW_PER_RUN) break;
        if (!validate(item)) { console.log(`  ✕ 不正データを破棄: ${item?.name ?? '?'}`); continue; }
        const key = nameKey(item.name);
        if (existingKeys.has(key)) { console.log(`  − 重複スキップ: ${item.name}`); continue; }
        db.push({
          id: slugify(item.name, item.area),
          name: item.name.trim(),
          area: item.area,
          category: item.category,
          niche: [...new Set(item.niche)],
          address: String(item.address || '要問い合わせ').trim(),
          station: String(item.station || '要問い合わせ').trim(),
          ages: String(item.ages || '要問い合わせ').trim(),
          price: String(item.price || '要問い合わせ').trim(),
          description: item.description.trim().slice(0, 230),
          url: String(item.url || src.url).trim(),
          partner: false, // 有料パートナー化は人間がフォーム受付後にtrueへ変更
          addedAt: today,
        });
        existingKeys.add(key);
        added++;
        console.log(`  ✓ 追加: ${item.name} [${item.area}/${item.category}]`);
      }
      await sleep(4000); // 巡回先・APIへの負荷配慮
    } catch (e) {
      console.error(`  ! エラー（このソースをスキップ）: ${e.message}`);
    }
  }

  if (added > 0) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
    console.log(`\n完了: ${added}件追加（合計 ${db.length}件）`);
  } else {
    console.log('\n完了: 新規追加なし');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
