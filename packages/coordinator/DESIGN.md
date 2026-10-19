---
version: alpha
name: Coordinator Dashboard
description: 以真实任务队列为中心的协同观察台
colors:
  canvas: '#101820'
  surface: '#17232d'
  raised: '#1c2b37'
  line: '#30424f'
  text: '#e6edf1'
  muted: '#9aabb6'
  accent: '#82b8d2'
  good: '#8ec9aa'
  warn: '#e4bd77'
  bad: '#e28d88'
  focus: '#f2cf81'
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  mono:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
rounded:
  DEFAULT: '5px'
spacing:
  panel: '16px'
  gap: '10px'
components:
  panel: {}
  button: {}
  table: {}
---
# Coordinator Dashboard

## Overview

面向当前项目负责人，在本机开发时查看任务、阻塞和验收链路。中文 UI，日期为 zh-CN / Asia/Taipei（UTC+8）。单页只读产品界面，无其他既有网页可复用。明确采用蓝灰仪表台语言，任务队列为主要阅读面；四角色与契约/审计解释队列的上下文。不提供执行或验收按钮。

## Colors

以上值映射到 `web/dashboard.css :root` 同名变量。CSS 是运行态唯一所有者，变更 token 同时更新本文件。good 表示在线；warn 表示离线/过期；bad 表示请求失败，全部配文字。surface/raised/line 区分层级。

## Typography

系统字体支持中文，不下载字体；标识符和数值使用系统等宽字体。正文13px，标题18px，主标题26–36px。长标识符允许换行，不截断关键状态。

## Layout

页面使用全宽容器，左右边距 16–24px。1600px 以上摘要通栏，下方任务队列主列和 380–460px 右栏，右栏依次为会话、契约、审计，均为单列；1024–1599px 单列、会话卡自适应、契约与审计并排；780–1023px 会话严格两列、契约与审计单列；780px 以下任务队列为四行紧凑卡片、摘要两行、详情单列；520px 以下左右边距保持 16px。文档自然滚动，宽表格自己横向滚动且可键盘聚焦，不以隐藏溢出遮盖内容。首屏加载和刷新提示保留稳定区域。

## Elevation & Depth

使用色阶与1px边框，不使用阴影和模糊。每个观测面保留明确标题。

## Shapes

5px圆角，强调结构分组；不使用大型装饰性图形。

## Components

`dashboard.html` owns landmarks, `dashboard.css` owns tokens/focus/responsive/scrollbars, `dashboard.js` owns shared state rendering and polling. GET `/api/snapshot` 每2秒刷新，8秒超时。失败保留最后成功快照并标为过期；首次失败单独提示。无原生弹窗、写接口、外部资源或 localStorage。列表返回量有界，显示已返回数量/总数和截断。未知实际模型、Token、费用明确标注。原生按钮/表格，明显 focus-visible，语义 live region，forced-colors 和 reduced-motion。规范所有滚动条，不隐藏它们。

## Do's and Don'ts

- 用任务与协议证据解释状态，最终验收由用户完成。
- 未知或离线不可呈现为绿色完成；动画不承担状态含义。
- 不把请求模型当实际执行模型，不显示凭据或原始消息正文。
