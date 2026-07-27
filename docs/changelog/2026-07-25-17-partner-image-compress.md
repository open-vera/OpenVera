# 2026-07-25 · 17:xx — Partner 大图附件压缩预览

## 变更

| 模块 | 内容 |
|---|---|
| `apps/partner/src/utils/attachments.ts` | 超过 1.5MB 的图片附件自动缩放/JPEG 压缩生成 `dataUrl`，修复「过大，未生成可预览的缩略图」 |
| `apps/partner/tests/unit/utils/attachments.test.ts` | 覆盖缩放计算、压缩说明与无 Canvas 回退 |

## Roadmap 同步

无

## 遗留事项

- 极端分辨率/体积仍可能压不进预算，此时仍回退为无缩略图元数据附件
