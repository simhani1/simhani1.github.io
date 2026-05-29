<%*
const fallbackTitle = tp.file.title
  .replace(/^\d{4}-\d{2}-\d{2}-/, "")
  .replace(/-/g, " ")
  .trim();
const inputTitle = await tp.system.prompt("글 제목을 입력하세요", fallbackTitle);
const title = (inputTitle || fallbackTitle || "Untitled").trim();
const fileTitle = title
  .replace(/[\\/:*?"<>|]/g, "")
  .replace(/\s+/g, "-");
await tp.file.rename(`${tp.date.now("YYYY-MM-DD")}-${fileTitle}`);
tR += `---
title: ${JSON.stringify(title)}
date: ${tp.date.now("YYYY-MM-DD HH:mm:ss")} +0900
tags: []
---`;
%>

## 들어가며


## 본문


## 정리


## 레퍼런스
