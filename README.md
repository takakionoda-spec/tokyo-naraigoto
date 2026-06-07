# TOKYO習い事.com — 湾岸・世田谷・練馬 子どもの習い事ポータル

本番ドメイン: **https://tokyo-naraigoto.com**

完全無料・完全自動運用の地域習い事ポータル。アーキテクチャの選定理由は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

- フロント: **Astro + Tailwind CSS v4**（静的生成・教室ごとにSEOページ自動生成）
- ホスティング: **Cloudflare Pages**（無料・帯域無制限・商用OK）
- データ: **リポジトリ内JSON**（`src/data/classrooms.json`）
- 自動更新: **GitHub Actions**（10日毎cron）+ **Gemini Flash 無料枠**
- フォーム: **Formspree 無料枠**（パートナー申込・修正/削除受付）

## ローカルで動かす

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # dist/ に静的サイト生成
```

## デプロイ手順（初回のみ・約15分）

### 1. GitHubリポジトリ作成
パブリックリポジトリ（Actions無料無制限のため）を作成してpush。

### 2. Cloudflare Pages 接続
1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. このリポジトリを選択し、以下を設定
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output directory: `dist`
3. Deploy。以後、**pushのたびに自動デプロイ**される

### 3. Gemini APIキー（無料）
1. [Google AI Studio](https://aistudio.google.com) でAPIキーを発行（クレカ不要）
2. GitHubリポジトリ → Settings → Secrets and variables → Actions → New repository secret
   - Name: `GEMINI_API_KEY` / Value: 発行したキー

### 4. Formspree（無料・月50件）
1. [formspree.io](https://formspree.io) で無料登録しフォームを作成
2. 発行されたID（例 `xkgwabcd`）で `src/pages/index.astro` 内の `YOUR_FORM_ID` を置換

### 5. クローラの巡回先を登録
`data/sources.json` に実際の巡回先URLを追加（教室公式サイト、自治体の子育て・生涯学習ページなど）。
**robots.txtは自動チェック**されるが、各サイトの利用規約も確認すること。

### 6. 動作確認
GitHubリポジトリ → Actions → auto-update → **Run workflow** で手動実行。
`classrooms.json` にcommitが入り、Cloudflare Pagesが自動で再デプロイされれば完成。
以後は**10日毎に全自動**で回り続ける。

## 運用（ほぼ何もしない）

| イベント | やること |
|---|---|
| 10日毎の自動更新 | 何もしない（Actions→commit→自動デプロイ） |
| パートナー申込メールが届いた | 入金確認後、該当教室の `"partner": false` を `true` に変更してcommit（スマホのGitHubアプリからでも可能） |
| 修正・削除依頼が届いた | JSONの該当項目を編集 or 削除してcommit |
| AIが変なデータを入れた | `git revert` で即復旧 |

## 費用

| 項目 | 月額 |
|---|---|
| Cloudflare Pages / GitHub Actions / Formspree | 0円 |
| Gemini Flash（10日毎・数十リクエスト） | 0円（無料枠内） |
| ドメイン（任意。`*.pages.dev` なら不要） | 約100円〜 |

## 法務・マナーの注意

- クローリングは**公開情報のみ・robots.txt尊重・4秒間隔**で実施（実装済み）
- 掲載はタイトル・事実情報＋AIによる**独自の紹介文**（コピーではない）で構成
- 削除依頼への無料対応窓口を常設（フォーム実装済み）
- 特定商取引法に基づく表記は有料販売（パートナー）開始時に追加すること
