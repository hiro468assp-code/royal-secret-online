# カードイラストの差し替え

カード画像は `public/assets/cards/` にまとまっています。新しい画像を同じファイル名の WebP（縦長推奨・現在は 480×720px）として上書きすれば、HTMLやゲーム処理を変更せずに差し替えられます。

| 数字 | カード | ファイル |
|---:|---|---|
| 1 | 兵士 | `soldier.webp` |
| 2 | 道化 | `jester.webp` |
| 3 | 騎士 | `knight.webp` |
| 4 | 僧侶 | `priest.webp` |
| 5 | 魔術師 | `wizard.webp` |
| 6 | 将軍 | `general.webp` |
| 7 | 大臣 | `minister.webp` |
| 8 | 姫 | `princess.webp` |

画像は手札、公開済みカード、道化の確認画面、残り枚数画面、ルール一覧で共通利用します。ファイル名を変える場合だけ、`public/app.js` 冒頭の `cardArtPaths` を更新してください。

## 生成に使ったプロンプト

共通指定：

> Original browser card game portrait illustration. Richly detailed original royal-fantasy palace atmosphere, subtle heraldic architecture, no recognizable franchise elements. Premium painterly digital illustration, elegant storybook realism, cohesive collectible card art series. Vertical portrait, centered full character, readable at small card size, generous edge space for a card frame, no border. Dramatic soft cinematic light, jewel tones with warm antique-gold accents. No text, numbers, logos, watermark, card border, or copyrighted character likeness.

カード別の主題：

- 兵士：月明かりの王宮門前で槍を持つ、磨かれた鋼の鎧の若い衛兵
- 道化：深紅と紫の衣装で、小鏡とカードを手にする謎めいた宮廷道化
- 騎士：王宮の中庭で剣と青い外套をまとう、堂々とした高潔な騎士
- 僧侶：象牙色と緑の法衣で、光る守護の印を掲げる穏やかな王宮司祭
- 魔術師：濃紺のローブで、片手に黄金の魔法光を呼び出す宮廷魔術師
- 将軍：赤と金の装飾鎧で、儀礼用の指揮杖を持つ王国の将軍
- 大臣：濃緑の錦織の衣を着て、封印された文書を持つ威厳ある大臣
- 姫：光あふれる玉座の間に立つ、象牙色とローズゴールドの衣装の王女

