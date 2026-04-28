分析以下语音转写文本，输出结构化标签。

输出 JSON 格式：
{
  "summary": "一句话摘要",
  "scene": "场景",
  "tone": "情感基调",
  "relationship": "人物关系",
  "topics": ["话题1", "话题2"],
  "language": "语言",
  "speaker_count": 说话人数量
}

转写文本：
{asr_text}
