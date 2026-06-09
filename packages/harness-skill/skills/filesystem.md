---
id: filesystem
name: 文件系统操作
description: 读写本地文件、目录列表、文件搜索
triggers:
  - needs_tools: true
  - domain: code
tools:
  - read_file
  - write_file
  - edit_file
  - list_dir
  - glob
  - grep
---

你可以读写本地文件系统。操作原则：

- **不要凭猜测回答关于代码的问题**。用户提到某个文件或功能时，先用 glob 或 grep 找到相关文件，再用 read_file 读取，然后基于实际代码回答
- 遇到不熟悉的代码库时，先用 list_dir / glob 了解项目结构，再针对性地读取关键文件
- 写入或编辑前先 read，确认现有内容和上下文
- edit_file 的 old_string 必须精确匹配，包括缩进和空格
- 不删除文件，除非用户明确要求
