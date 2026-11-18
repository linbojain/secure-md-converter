# 安全文件轉 Markdown（Secure Document → Markdown Converter）

在瀏覽器本機把 PDF、DOCX、XLSX、PPTX、HTML、EPUB、CSV/TSV、TXT、JSON、XML 轉成 Markdown。

- 所有轉檔程式都內嵌在 `index.html`，不依賴外部 CDN
- 內容安全政策（CSP）設定 `connect-src 'none'`，頁面無法對外連線
- 不使用 Cookie / localStorage，不保存任何資料

## 使用

直接開啟 GitHub Pages 網址，或下載 `index.html` 後離線用瀏覽器開啟。

## 重新建置（更新函式庫版本時）

```bash
npm install
npm run build
```

## 第三方授權（Third-party licenses）

| 函式庫 | 授權 |
|---|---|
| pdf.js（Mozilla） | Apache-2.0 |
| mammoth | BSD-2-Clause |
| JSZip | MIT 或 GPL-3.0（雙授權，此處採 MIT） |
| Turndown / turndown-plugin-gfm | MIT |
