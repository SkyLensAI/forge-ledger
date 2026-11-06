## 💻 工程师

## 一句话

B 的价值是真实的，但**90% 的人会做错**：他们以为这是"提炼"问题（把对话变知识卡），其实提炼毫无护城河——**真正的产品是"维护"**，是让沉淀下来的资产**不腐烂、有出处、能按任务取用**。谁解决了腐化，谁才拿到这个品类。

---

## 一、为什么 B 是三个方向里最实的

**1）用户已经在手动做这件事了。** 需求侧信号在竞品里全是现成的：Foldif 做高亮、旁注、Book Builder，还自动检测 TODO/决策/问题 [1]；Ophel 做 Prompt 词库 [2]；ChatEngram 把对话同步进 Obsidian/Notion [3]。这些都不是"存档"，都是"把对话变成还能再用的东西"。

**2）"让模型替我维护知识"是大众级愿望。** Karpathy 那份 12KB 的 llm-wiki gist 拿到约 **1600 万次浏览、1061 条评论** [4]。这不是小众极客兴趣。

**3）产出可以外化、可以交付。** 资产能变成 SOP、文档、战斗手册、团队技能，而不只是"更整齐的记录"。一旦能给别人看、给团队用，定价锚点就完全不一样了。（会议记录→行动项这条线能收到钱，也是同一个道理。）

---

## 二、做错的地方：把它当成"提取"问题

**提取是廉价的。** 一次 LLM 调用就能把一段对话变成漂亮的知识卡，任何人都能做，今天就能做。没有护城河。

真正的失败模式是**腐化（rot / drift）**，而且它是**静默的**：

- Karpathy 那 1061 条评论被整理过一遍，同样的失败反复出现，聚类成 **4 大类、14 种失效模式**：**垃圾会复利**（错误条目变成先验、摘要丢掉出处、只写不读）；**笔记与现实脱节**（静默被取代、索引漂移、孤儿页、断言活得比它描述的系统还长）；**相关性是任务相对的**（一个大语料库里，每个任务都继承其他所有任务的噪音）；**这个模式假设"只有一个你"**（没有权限、没有并发、没有敏感信息分级）[4]。
- 有生产数据把 **POC 之后约 60% 的 RAG 失败归因于数据新鲜度，而不是检索质量**；家酿知识大脑大致在 **500–1000 条事实**之间开始漂移 [5]。（标注一下：这个数字来自卖该能力的厂商，有立场，但方向和其他证据一致。）
- "把整个大脑预加载进上下文"是明确错误的路子——那只是更大的上下文窗口，会 context rot；正确做法是**检索 + 新鲜度/出处层**（这条是什么时候确认的、谁写的）[6]。
- 一个已经跑了两个月的人给出的解药很具体：把每条事实分类为 **state（就地替换，带日期）**或 **event（只追加）**，并且**用 hook + 审计强制执行，而不是靠一句礼貌的指令** [7]。

**所以真正的工作量在：schema + 生命周期管理 + 出处追溯 + 冲突消解。** 这是脏活，恰恰也是别人不愿意做、而做出来就难被抄的部分。

---

## 三、平台既是你的竞争者，也是你最好的渠道

这一点必须现在就纳入设计，否则你做出来的东西 12 个月后会被官方功能覆盖：

- **作为竞争者**：Claude Skills 本质就是"把工作流打包成可复用的指令/脚本/资源"，通过 progressive disclosure 按需加载；官方明确把"**组织知识捕获——把公司的工作流、最佳实践、机构知识打包给 Claude 一致使用**"当作卖点，Team/Enterprise 还能由管理员为全员下发技能 [8]。也就是说，"对话/工作流 → 可复用资产"这件事已经被平台内化了，而且做得很正统。
- **作为渠道**：Claude Marketplace 已有 **2000+ connectors/plugins**，开发者可以按 MCP + Agent Skills 提交上架，也可以申请把 AI 产品挂牌，**企业能用已经承诺的 Anthropic 花费来买** [9]。

**战略含义：不要做"另一个界面里的资产库"，要做"能进这些生态的资产生产与维护管线"。** 你的资产最终必须能在 ChatGPT / Claude / Cursor / 内部 agent 里被调用，这和上一轮说的"注入"是同一件事的两面。

---

## 四、具体形态：我会把它定义成一个"编译 + 维护"系统

注意它不是笔记应用，也不是会话管理器。五层：

1. **摄取层**：对话只是来源之一，必须和邮件、会议、文档并列——否则你只是一家聊天记录管理器。全量导出导入 + 增量采集 + 手工投喂。
2. **编译层（Compile）**：把原始对话编译成**带类型的资产**：决策（decision + 日期）、状态/事实（state）、流程（SOP/playbook）、可复用指令（skill/prompt）、待办与监控项。核心是 Karpathy 那套的精髓——**编译一次，然后维护**，而不是每次从原始文档重新检索 [7]。
3. **维护层（这才是产品本体）**：
   - state vs event 分类，就地替换 / 追加 [7]
   - 每条事实带**出处**（哪段对话、哪个模型、何时）与**最后确认时间** [6]
   - **冲突检测**：新对话与旧状态矛盾时主动追问确认（"你 3 月定的是 A，这次说 B，替换吗？"）
   - **健康检查 / lint**：孤儿页、索引漂移、过期断言 [4]
   - **敏感度分级与权限**——这是单人模式走向团队的分叉点，缺了就没法做 B 端 [4]
4. **取用层**：按任务检索 + 精准注入回任意模型（跨模型上下文）。
5. **可交付层**：一键产出 SOP 文档 / 知识卡 / 团队技能（比如直接生成 Agent Skill 的目录结构）[8]。

---

## 五、商业模式

- **记账单位从"存储/导出"换成"资产"**：付费点是**维护**（新鲜度、冲突消解、审计）和**协作**（团队资产、权限、下发/上架）。
- **核心功能绝不锁**：这个品类最大的差评来源就是付费墙摩擦——156 条相关评价，均分只有 **2.13**，其中 **67% 是 1–2 星**；而用户最认的是**本地/私有处理**和**一个工具覆盖所有平台** [10]。
- **团队版是真钱**：组织知识捕获是平台已经在卖的叙事 [8]，你要么做它的上游编译器，要么通过 marketplace 用客户已承诺预算结算 [9]。

---

## 六、怎么用最小实验证伪它（三天能搭，三周能出结论）

不要问"用户觉得有用吗"，要问"用户愿意改变每周工作流吗"：

1. **腐烂实验**：找 5 个重度用户，各喂 30 段对话进来，两周后测**知识卡里有多少条与现实不符**。>20% → 维护是真痛点，值得做；≈0 → 他们的会话领域本来就不需要长期资产，那就不该做 B，该退回做 A。
2. **复用计数**：资产被再次**取用/注入**的次数。这是本方向**唯一重要的北极星**。这个数字低，说明你造了个收藏夹。
3. **交付物测试**：产物直接给**别人**看（同事、客户），而不是给自己看。能交付 → 定价可以高一个数量级。

**出现任一信号就砍**：用户只想要"导出成 Markdown"；用户不愿意为它写任何 schema/分类；用户只消费对话、从不消费资产。

---

## 七、结论

**B 的护城河是"让资产不腐烂"这套脏活，不是"把对话变漂亮"。**

只做提炼和归档，你会变成又一个免费插件——这个品类里免费已经很多了 [11]。做出 schema、出处、冲突消解、按任务注入，你做的就是**个人与团队的上下文基础设施**——那才撑得起订阅价，也才撑得起团队单。
[1] [ChatGPT、Claude、Gemini 文件夹 — 保存与整理 AI 聊天 | Foldif](https://foldif.com/zh)

[2] [Ophel — AI 对话大纲 · 会话管理 · Prompt 词库](https://ophel.app/zh/)

[3] [ChatEngram vs AI Toolbox vs ExportGPT: Which AI Chat History Tool Should You Use? | ChatEngram](https://chatengram.com/best-practices/chatengram-vs-ai-toolbox-vs-exportgpt)

[4] [Knowledge bases for AI agents: 14 ways they rot](https://omiid.me/notebook/66/knowledge-bases-for-ai-agents-14-ways-they-rot)

[5] [Context drift: why home-built brains go stale after a few hundred facts, and how to catch it | Tandem](https://usetandem.ai/blog/context-drift-home-built-brains)

[6] [Why Isn't Your AI Second Brain Working? | Hjarni](https://hjarni.com/blog/ai-second-brain-not-working)

[7] [My LLM wiki started to rot, so I gave it one rule · Artur Tyloch](https://tyloch.biz/posts/llm-wiki-second-brain-rot/)

[8] [What are skills? | Claude Help Center](https://support.claude.com/en/articles/12512176-what-are-skills)

[9] [Claude Marketplace: plugins and connectors, products and agents, and service partners | Claude by Anthropic](https://claude.com/resources/articles/claude-marketplace)

[10] [We Read 4,241 Reviews of AI Chat Export Tools. | Chat2Doc](https://chat2doc.net/en/blog/we-read-4241-reviews-of-ai-chat-export-tools)

[11] [AI知识管家 - 让每一次 AI 对话都有价值](https://aichatkeeper.com/zh/)